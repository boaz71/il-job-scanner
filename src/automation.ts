import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { runScan } from "./scanner.js";
import { matchJobs } from "./matcher.js";
import { getActiveProfile } from "./profiles.js";
import { loadConfig as loadNotif, sendTelegram } from "./notifications.js";
import type { ScoredJob, Job } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FILE = resolve(ROOT, "data/automation.json");
const SEEN_IDS_FILE = resolve(ROOT, "data/seen-job-ids.json");

export interface AutomationConfig {
  enabled: boolean;
  interval_hours: number;     // 1, 3, 6, 12, 24
  last_run?: string;
  next_run?: string;
}

const DEFAULT: AutomationConfig = { enabled: false, interval_hours: 6 };

function ensure() {
  const dir = resolve(ROOT, "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadAutomation(): AutomationConfig {
  ensure();
  if (!existsSync(FILE)) return { ...DEFAULT };
  try { return { ...DEFAULT, ...JSON.parse(readFileSync(FILE, "utf-8")) }; }
  catch { return { ...DEFAULT }; }
}

export function saveAutomation(c: AutomationConfig): void {
  ensure();
  writeFileSync(FILE, JSON.stringify(c, null, 2), "utf-8");
}

export function loadSeenIds(): Set<string> {
  ensure();
  if (!existsSync(SEEN_IDS_FILE)) return new Set();
  try {
    const arr: string[] = JSON.parse(readFileSync(SEEN_IDS_FILE, "utf-8"));
    return new Set(arr);
  } catch { return new Set(); }
}

export function saveSeenIds(ids: Set<string>): void {
  ensure();
  writeFileSync(SEEN_IDS_FILE, JSON.stringify([...ids]), "utf-8");
}

// Mark new jobs (not seen in any previous scan)
export function markNewJobs<T extends Job>(jobs: T[]): (T & { is_new?: boolean })[] {
  const seen = loadSeenIds();
  const next = new Set(seen);
  const result = jobs.map((j) => {
    const isNew = !seen.has(j.id);
    if (isNew) next.add(j.id);
    return { ...j, is_new: isNew };
  });
  saveSeenIds(next);
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function rescheduleAutomation(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const cfg = loadAutomation();
  if (!cfg.enabled) return;
  const ms = cfg.interval_hours * 60 * 60 * 1000;
  cfg.next_run = new Date(Date.now() + ms).toISOString();
  saveAutomation(cfg);

  timer = setTimeout(async () => {
    try {
      await runAutoScan();
    } catch (e) {
      console.error("Auto-scan failed:", e);
    } finally {
      rescheduleAutomation(); // chain
    }
  }, ms);
  console.log(`⏰ סריקה אוטומטית מתוזמנת ל-${cfg.next_run}`);
}

export async function runAutoScan(): Promise<{ total: number; new_count: number; alerted: number }> {
  console.log("🔄 סריקה אוטומטית מתחילה...");
  const result = await runScan({ archive: true });

  // Mark new jobs and re-score
  const active = getActiveProfile();
  let alerted = 0;
  let newCount = 0;

  if (active) {
    const flagged = markNewJobs(result.jobs);
    const scored = matchJobs(flagged, active.profile, active.profile.min_match_score || 0)
      .map((j, i) => ({ ...j, is_new: (flagged[result.jobs.findIndex((x) => x.id === j.id)] as any)?.is_new || false }));
    writeFileSync(resolve(ROOT, "data/scored-jobs.json"), JSON.stringify(scored, null, 2));

    newCount = scored.filter((j: any) => j.is_new).length;

    // Telegram alert
    const notif = loadNotif();
    if (notif.telegram?.enabled) {
      const allowed = notif.min_grade_for_alert === "A" ? ["A"] :
                      notif.min_grade_for_alert === "AB" ? ["A", "B"] : ["A", "B", "C"];
      const alerts = scored.filter((j: any) => j.is_new && allowed.includes(j.grade));
      if (alerts.length) {
        const msg = formatTelegramAlert(alerts);
        const r = await sendTelegram(msg, notif);
        if (r.ok) alerted = alerts.length;
      }
    }
  } else {
    markNewJobs(result.jobs);
  }

  // Update last run
  const cfg = loadAutomation();
  cfg.last_run = result.scanned_at;
  saveAutomation(cfg);

  console.log(`✅ סריקה אוטומטית הושלמה: ${result.jobs.length} משרות, ${newCount} חדשות, ${alerted} התראות נשלחו`);
  return { total: result.jobs.length, new_count: newCount, alerted };
}

function formatTelegramAlert(jobs: ScoredJob[]): string {
  const top = jobs.slice(0, 6);
  const lines = top.map((j) =>
    `<b>[${j.grade} · ${j.score}]</b> ${esc(j.title)}\n` +
    `🏢 ${esc(j.company)} · 📍 ${esc(j.location)}\n` +
    `<a href="${esc(j.url)}">פתח משרה</a>`
  );
  let msg = `🆕 <b>${jobs.length} משרות חדשות</b>\n\n${lines.join("\n\n")}`;
  if (jobs.length > top.length) msg += `\n\n<i>...ועוד ${jobs.length - top.length} משרות</i>`;
  return msg;
}

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
