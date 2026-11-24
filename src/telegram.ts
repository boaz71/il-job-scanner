// Two-way Telegram: buttons on alerts, approving a prepared application from the phone,
// /status, follow-up reminders. Long polling (getUpdates) — no public URL needed.
//
// Same rules as the web flow: actions call the functions in applications.ts, so
// approval/submission checks are enforced once. Nothing is ever submitted to an
// employer from here — "📤 הגשתי" only records what the user did on the employer's site.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import {
  loadConfig, sendTelegram, sendTelegramDocument, telegramApi,
  type NotificationConfig, type TelegramKeyboard,
} from "./notifications.js";
import type { Job, ScoredJob } from "./types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// TELEGRAM_STATE_FILE override exists for tests only.
const STATE_FILE = process.env.TELEGRAM_STATE_FILE || resolve(ROOT, "data/telegram.json");
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FOLLOWUP_AFTER_DAYS = 5;
export const START_COST_HINT = "~$0.05";

// ── State: update offset, button tokens, messages awaiting evidence, sent reminders ──

export type Action = "track" | "start" | "hide" | "approve" | "edit" | "submitted" | "followup";

interface TgState {
  offset: number;
  tokens: Record<string, { action: Action; jobId: string; at: string }>;
  awaiting: Record<string, { jobId: string; at: string }>;   // message_id → job (reply = evidence)
  reminded: Record<string, string>;                           // jobId → when the follow-up reminder was sent
}

function loadState(): TgState {
  const empty: TgState = { offset: 0, tokens: {}, awaiting: {}, reminded: {} };
  if (!existsSync(STATE_FILE)) return empty;
  try { return { ...empty, ...JSON.parse(readFileSync(STATE_FILE, "utf-8")) }; } catch { return empty; }
}

function saveState(s: TgState): void {
  const cutoff = Date.now() - TOKEN_TTL_MS;
  for (const map of [s.tokens, s.awaiting] as Record<string, { at: string }>[]) {
    for (const [k, v] of Object.entries(map)) if (new Date(v.at).getTime() < cutoff) delete map[k];
  }
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf-8");
}

// callback_data is limited to 64 bytes and is echoed back by Telegram — use a random
// short token instead of the job id, and look it up on click.
function tokenFor(action: Action, jobId: string): string {
  const s = loadState();
  const token = randomBytes(6).toString("base64url");
  s.tokens[token] = { action, jobId, at: new Date().toISOString() };
  saveState(s);
  return token;
}

// ── Outgoing messages ──

export type Btn = { text: string; action: Action; jobId: string } | { text: string; url: string };
export interface OutMsg {
  text: string;
  buttons?: Btn[][];
  document?: { filename: string; content: Buffer };
  awaitEvidenceFor?: string;   // replies to this message are evidence for that job
}

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function deliver(msgs: OutMsg[], cfg: NotificationConfig = loadConfig()): Promise<void> {
  const interactive = !!cfg.telegram?.interactive;
  for (const m of msgs) {
    // Callback buttons only work while the poller listens — otherwise send without them.
    const rows = (m.buttons || [])
      .map((row) => row.filter((b) => "url" in b || interactive)
        .map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: tokenFor(b.action, b.jobId) })))
      .filter((row) => row.length);
    const keyboard: TelegramKeyboard | undefined = rows.length ? rows : undefined;
    if (m.document) {
      const r = await sendTelegramDocument(m.document.filename, m.document.content, m.text, keyboard, cfg);
      if (!r.ok) console.error("Telegram sendDocument failed:", r.error);
      continue;
    }
    const r = await sendTelegram(m.text.slice(0, 4000), cfg, keyboard);
    if (!r.ok) console.error("Telegram sendMessage failed:", r.error);
    if (r.ok && m.awaitEvidenceFor && r.message_id) {
      const s = loadState();
      s.awaiting[String(r.message_id)] = { jobId: m.awaitEvidenceFor, at: new Date().toISOString() };
      saveState(s);
    }
  }
}

// New-jobs alert: numbered list + one button row per job.
export function newJobsAlert(jobs: ScoredJob[]): OutMsg {
  const top = jobs.slice(0, 6);
  const lines = top.map((j, i) =>
    `<b>${i + 1}. [${j.grade} · ${j.score}]</b> ${esc(j.title)}\n🏢 ${esc(j.company)} · 📍 ${esc(j.location)}\n<a href="${esc(j.url)}">פתח משרה</a>`);
  let text = `🆕 <b>${jobs.length} משרות חדשות</b>\n\n${lines.join("\n\n")}`;
  if (jobs.length > top.length) text += `\n\n<i>...ועוד ${jobs.length - top.length} משרות</i>`;
  return {
    text,
    buttons: top.map((j, i) => [
      { text: `${i + 1} ⭐ מעקב`, action: "track", jobId: j.id },
      { text: `${i + 1} 🚀 הגשה (${START_COST_HINT})`, action: "start", jobId: j.id },
      { text: `${i + 1} 🙈`, action: "hide", jobId: j.id },
    ]),
  };
}

// Reminders for applications without an answer after FOLLOWUP_AFTER_DAYS (once per job).
export async function sendFollowupReminders(
  tracked: { id: string; status: string; applied_at?: string; job: Job }[], now = Date.now(),
): Promise<number> {
  const s = loadState();
  const due = tracked.filter((t) => t.status === "applied" && t.applied_at && !s.reminded[t.id]
    && (now - new Date(t.applied_at).getTime()) / 86400000 >= FOLLOWUP_AFTER_DAYS);
  if (!due.length) return 0;
  for (const t of due) s.reminded[t.id] = new Date(now).toISOString();
  saveState(s);
  await deliver(due.map((t) => ({
    text: `⏰ <b>עברו ${Math.floor((now - new Date(t.applied_at!).getTime()) / 86400000)} ימים מאז שהגשת</b>\n${esc(t.job.title)} · ${esc(t.job.company)}\nשווה לשלוח follow-up.`,
    buttons: [[{ text: "📧 צור הודעת follow-up", action: "followup" as const, jobId: t.id }]],
  })));
  return due.length;
}

// ── Incoming updates ──

export interface Actions {
  track(jobId: string): Promise<OutMsg[]>;
  start(jobId: string): Promise<OutMsg[]>;
  hide(jobId: string): Promise<OutMsg[]>;
  approve(jobId: string): Promise<OutMsg[]>;
  edit(jobId: string): Promise<OutMsg[]>;
  submitted(jobId: string): Promise<OutMsg[]>;
  followup(jobId: string): Promise<OutMsg[]>;
  status(): Promise<OutMsg[]>;
  evidence(jobId: string, text: string): Promise<OutMsg[]>;
}

// Shown as the button's toast right away — some actions take a while.
const ACK: Record<Action, string> = {
  track: "⭐ מוסיף למעקב...", start: "🚀 מאמת ומכין קו״ח... (עד דקה)", hide: "🙈 מסתיר...",
  approve: "✅ מאמת ומאשר...", edit: "🖥️", submitted: "📤 מתעד...", followup: "📧 מכין follow-up...",
};

export const HELP = `🤖 <b>IL Job Scanner</b>
/status — הצעדים הבאים לכל משרה בתהליך
/help — העזרה הזו

בהתראות על משרות חדשות:
⭐ מעקב · 🚀 הכנת הגשה (אימות + קו״ח מותאמים) · 🙈 לא רלוונטי

ההגשה עצמה תמיד נעשית על ידך באתר החברה.`;

export interface Ctx {
  cfg: NotificationConfig;
  actions: Actions;
  send: (msgs: OutMsg[]) => Promise<void>;
  answer: (callbackId: string, text: string) => Promise<void>;
}

async function run(fn: () => Promise<OutMsg[]>): Promise<OutMsg[]> {
  try { return await fn(); }
  catch (e: any) { return [{ text: `❌ ${esc(e?.message || e)}` }]; }
}

// Returns what happened (for tests / logs).
export async function handleUpdate(update: any, ctx: Ctx): Promise<string> {
  const cq = update.callback_query;
  const msg = update.message;
  const chatId = String(cq?.message?.chat?.id ?? msg?.chat?.id ?? "");
  // Only the configured chat may act. Anyone can message a bot.
  if (!chatId || chatId !== String(ctx.cfg.telegram?.chat_id ?? "")) {
    if (cq) await ctx.answer(cq.id, "⛔ לא מורשה");
    return "unauthorized";
  }

  if (cq) {
    const tok = loadState().tokens[String(cq.data)];
    if (!tok) { await ctx.answer(cq.id, "⌛ הכפתור פג תוקף — פתח את הממשק"); return "expired"; }
    await ctx.answer(cq.id, ACK[tok.action]);
    await ctx.send(await run(() => ctx.actions[tok.action](tok.jobId)));
    return `action:${tok.action}`;
  }

  const text = String(msg?.text ?? "").trim();
  if (!text) return "ignored";
  if (text.startsWith("/")) {
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    if (cmd === "/status") { await ctx.send(await run(() => ctx.actions.status())); return "cmd:status"; }
    await ctx.send([{ text: HELP }]);
    return "cmd:help";
  }
  const replyTo = msg?.reply_to_message?.message_id;
  const awaiting = replyTo !== undefined ? loadState().awaiting[String(replyTo)] : undefined;
  if (awaiting) {
    await ctx.send(await run(() => ctx.actions.evidence(awaiting.jobId, text)));
    return "evidence";
  }
  await ctx.send([{ text: "לא הבנתי 🙂 נסה /status או /help" }]);
  return "unknown-text";
}

// ── Poller ──

type PollerState = { state: "stopped" | "running" | "error"; error?: string; last_ok_at?: string };
let poller: PollerState = { state: "stopped" };
let generation = 0;
export const telegramStatus = (): PollerState => ({ ...poller });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// (Re)start listening according to the saved settings. Safe to call repeatedly.
export function startTelegram(actions: Actions): void {
  const gen = ++generation;
  const cfg = loadConfig();
  const t = cfg.telegram;
  if (!t?.enabled || !t.interactive || !t.bot_token || !t.chat_id) {
    poller = { state: "stopped" };
    return;
  }
  poller = { state: "running" };
  telegramApi("setMyCommands", { commands: [
    { command: "status", description: "הצעדים הבאים לכל משרה" },
    { command: "help", description: "עזרה" },
  ] }, cfg).catch(() => {});

  const ctx: Ctx = {
    cfg, actions,
    send: (msgs) => deliver(msgs, cfg),
    answer: async (id, text) => { await telegramApi("answerCallbackQuery", { callback_query_id: id, text }, cfg).catch(() => {}); },
  };

  (async () => {
    let backoff = 5_000;
    while (gen === generation) {
      try {
        const data = await telegramApi("getUpdates", {
          offset: loadState().offset, timeout: 25, allowed_updates: ["message", "callback_query"],
        }, cfg, 35_000);
        if (gen !== generation) return;
        if (!data.ok) {
          if (data.error_code === 409 || data.error_code === 401) {
            poller = { state: "error", error: data.error_code === 409
              ? "בוט זה כבר מאזין במקום אחר (שרת נוסף או webhook) — עצרתי"
              : "ה-token של הבוט לא תקין" };
            return;
          }
          throw new Error(data.description || `Telegram error ${data.error_code}`);
        }
        for (const u of data.result || []) {
          // Advance the offset before handling: a crash mid-action must not replay a
          // paid action (CV generation) on restart.
          const s = loadState(); s.offset = u.update_id + 1; saveState(s);
          try { console.log("📱 telegram:", await handleUpdate(u, ctx)); }
          catch (e) { console.error("Telegram update failed:", e); }
        }
        poller = { state: "running", last_ok_at: new Date().toISOString() };
        backoff = 5_000;
      } catch (e: any) {
        if (gen !== generation) return;
        poller = { ...poller, state: "error", error: String(e?.message || e) };
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  })();
}

export function stopTelegram(): void {
  generation++;
  poller = { state: "stopped" };
}
