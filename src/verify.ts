// Job verification — is a job still open, is it from a real ATS, does the apply link work.
// No LLM. Results persist in data/job-status.json (only explicit checks + scan-diff
// closures; "seen in the latest scan" is derived on the fly, not stored).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { httpGet } from "./ats/http.js";
import type { AtsType, Company, Job } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
// JOB_STATUS_FILE override exists for tests only.
const FILE = process.env.JOB_STATUS_FILE || resolve(ROOT, "data/job-status.json");

export type VerifyStatus = "open" | "closed" | "unknown";
export type VerifyMethod = "ats-api" | "board-list" | "page" | "scan" | "scan-diff" | "none";

export interface JobVerification {
  status: VerifyStatus;
  checked_at: string;
  method: VerifyMethod;
  // "ats": checked at the employer's ATS. "aggregator": only at Remotive/RemoteOK.
  trust: "ats" | "aggregator";
  source_ok: boolean;          // job URL is on the domain expected for its source
  http_status?: number;
  apply_url?: string;
  apply_status?: number;       // HTTP status of apply_url (single-job checks only)
  reason: string;              // Hebrew, shown in the UI
}

const AGGREGATORS = new Set<AtsType>(["remotive", "remoteok"]);
const FRESH_MS = 6 * 60 * 60 * 1000;               // reuse a check for 6h unless forced
const PRUNE_MS = 90 * 24 * 60 * 60 * 1000;          // drop untracked entries after 90 days
const CHECK_TIMEOUT_MS = 12_000;
const UA = { "User-Agent": "Mozilla/5.0 (il-job-scanner job verification)" };

// ── Store ──

export function loadStatuses(): Record<string, JobVerification> {
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, "utf-8")); } catch { return {}; }
}

export function saveStatuses(map: Record<string, JobVerification>, keepIds: Set<string> = new Set()): void {
  const dir = dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const cutoff = Date.now() - PRUNE_MS;
  for (const [id, v] of Object.entries(map)) {
    if (!keepIds.has(id) && new Date(v.checked_at).getTime() < cutoff) delete map[id];
  }
  writeFileSync(FILE, JSON.stringify(map, null, 2), "utf-8");
}

// ── Source identification ──

function loadCompanies(): Company[] {
  try { return JSON.parse(readFileSync(resolve(ROOT, "companies.json"), "utf-8")).companies; }
  catch { return []; }
}

const PREFIX: Partial<Record<AtsType, string>> = { greenhouse: "gh", lever: "lv", ashby: "ab" };

// Split an ATS job id ("gh-{token}-{postingId}") into token + posting id.
// Tokens may contain "-", so prefer known tokens from companies.json (longest match).
export function parseAtsId(job: Pick<Job, "id" | "ats">, companies: Company[] = loadCompanies()):
  { token: string; postingId: string } | null {
  const prefix = PREFIX[job.ats];
  if (!prefix || !job.id.startsWith(prefix + "-")) return null;
  const rest = job.id.slice(prefix.length + 1);
  const known = companies
    .filter((c) => c.ats === job.ats && rest.startsWith(c.token + "-"))
    .sort((a, b) => b.token.length - a.token.length)[0];
  if (known) return { token: known.token, postingId: rest.slice(known.token.length + 1) };
  // Fallback: Greenhouse ids are numeric; Lever/Ashby ids are UUIDs.
  const m = job.ats === "greenhouse"
    ? rest.match(/^(.+)-(\d+)$/)
    : rest.match(/^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? { token: m[1], postingId: m[2] } : null;
}

// Is the job URL on a domain we expect for its source?
export function sourceOk(job: Pick<Job, "url" | "ats">): boolean {
  let host: string;
  try { host = new URL(job.url).hostname.toLowerCase(); } catch { return false; }
  switch (job.ats) {
    // Greenhouse boards often redirect to the company's own careers page with ?gh_jid=
    case "greenhouse": return host.endsWith("greenhouse.io") || /[?&]gh_jid=/.test(job.url);
    case "lever": return host.endsWith("lever.co");
    case "ashby": return host.endsWith("ashbyhq.com");
    case "remotive": return host.endsWith("remotive.com");
    case "remoteok": return host.endsWith("remoteok.com") || host.endsWith("remoteok.io");
  }
}

function base(job: Job): Pick<JobVerification, "trust" | "source_ok" | "apply_url"> {
  return {
    trust: AGGREGATORS.has(job.ats) ? "aggregator" : "ats",
    source_ok: sourceOk(job),
    apply_url: job.apply_url,
  };
}

// ── Effective status (what the UI shows) ──

// A stored check wins if it is at least as recent as the job's scan. Otherwise a job
// that came from the latest scan counts as open (it was listed on the board then).
export function effectiveStatus(job: Job, stored: JobVerification | undefined, inCurrentScan: boolean): JobVerification {
  const scannedAt = job.scanned_at || "";
  if (stored && (!inCurrentScan || job.is_restored || stored.checked_at >= scannedAt)) return stored;
  if (inCurrentScan && !job.is_restored) {
    const agg = AGGREGATORS.has(job.ats);
    return {
      ...base(job),
      status: "open",
      checked_at: scannedAt,
      method: "scan",
      reason: agg ? "הופיעה בפיד האגרגטור בסריקה האחרונה — לא אומתה במקור" : "הופיעה בלוח המשרות של החברה בסריקה האחרונה",
    };
  }
  return { ...base(job), status: "unknown", checked_at: "", method: "none", reason: "לא נבדקה עדיין" };
}

// ── Active checks ──

type BoardCache = Map<string, Promise<any[]>>;

async function checkPage(url: string): Promise<number> {
  return (await httpGet(url, { timeoutMs: CHECK_TIMEOUT_MS, headers: UA })).status;
}

async function checkAtsApi(job: Job, boards: BoardCache): Promise<Omit<JobVerification, keyof ReturnType<typeof base> | "checked_at">> {
  const ids = parseAtsId(job);
  if (!ids) return { status: "unknown", method: "none", reason: "לא ניתן לזהות את מזהה המשרה במקור" };
  const { token, postingId } = ids;

  if (job.ats === "greenhouse" || job.ats === "lever") {
    const url = job.ats === "greenhouse"
      ? `https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${postingId}`
      : `https://api.lever.co/v0/postings/${token}/${postingId}`;
    const { status } = await httpGet(url, { timeoutMs: CHECK_TIMEOUT_MS });
    if (status === 200) return { status: "open", method: "ats-api", http_status: status, reason: "המשרה פתוחה לפי ה-API של מערכת הגיוס" };
    if (status === 404 || status === 410) return { status: "closed", method: "ats-api", http_status: status, reason: "המשרה הוסרה ממערכת הגיוס (404)" };
    return { status: "unknown", method: "ats-api", http_status: status, reason: `תשובה לא צפויה ממערכת הגיוס (HTTP ${status})` };
  }

  // Ashby: no public single-job endpoint — check membership in the board (one fetch per token per batch).
  if (!boards.has(token)) {
    boards.set(token, httpGet(`https://api.ashbyhq.com/posting-api/job-board/${token}`, { timeoutMs: CHECK_TIMEOUT_MS, json: true })
      .then((r) => {
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        return r.body?.jobs || [];
      }));
  }
  const jobs = await boards.get(token)!;
  const found = jobs.find((j: any) => j.id === postingId);
  if (found && found.isListed !== false) return { status: "open", method: "board-list", http_status: 200, reason: "המשרה מופיעה בלוח המשרות של החברה" };
  return { status: "closed", method: "board-list", http_status: 200, reason: found ? "המשרה הוסתרה מלוח המשרות" : "המשרה כבר לא מופיעה בלוח המשרות של החברה" };
}

// Aggregators have no per-job API: only a missing page (404/410) proves closure.
async function checkAggregator(job: Job): Promise<Omit<JobVerification, keyof ReturnType<typeof base> | "checked_at">> {
  if (!job.url) return { status: "unknown", method: "none", reason: "אין קישור למשרה" };
  const status = await checkPage(job.url);
  if (status === 404 || status === 410) return { status: "closed", method: "page", http_status: status, reason: `דף המשרה באגרגטור הוסר (${status})` };
  if (status >= 200 && status < 300) return { status: "open", method: "page", http_status: status, reason: "דף המשרה באגרגטור זמין — לא אומתה במקור" };
  return { status: "unknown", method: "page", http_status: status, reason: `לא ניתן לאמת (HTTP ${status})` };
}

export async function verifyJob(job: Job, opts: { checkApplyLink?: boolean; boards?: BoardCache } = {}): Promise<JobVerification> {
  const boards = opts.boards ?? new Map();
  const checked_at = new Date().toISOString();
  let core;
  try {
    core = AGGREGATORS.has(job.ats) ? await checkAggregator(job) : await checkAtsApi(job, boards);
  } catch (e: any) {
    // Network error / timeout / board fetch failure — never conclude "closed" from these.
    core = { status: "unknown" as const, method: "none" as const, reason: `הבדיקה נכשלה: ${String(e?.message || e).slice(0, 80)}` };
  }
  const v: JobVerification = { ...base(job), ...core, checked_at };

  // Apply link: only for jobs the source says are open. A dead link downgrades to unknown,
  // never to closed (sites block bots; the ATS API is the authority on closure).
  if (opts.checkApplyLink && v.status === "open" && job.apply_url) {
    try {
      v.apply_status = await checkPage(job.apply_url);
      if (v.apply_status === 404 || v.apply_status === 410) {
        v.status = "unknown";
        v.reason = `המשרה פתוחה במקור אבל קישור ההגשה מחזיר ${v.apply_status}`;
      }
    } catch { /* unreachable apply page — keep the source's verdict */ }
  }
  if (!v.source_ok) v.reason += " · ⚠️ הקישור אינו בדומיין הצפוי למקור";
  return v;
}

// Verify several jobs (concurrency 4), reusing fresh checks unless forced. Persists results.
export async function verifyJobs(
  jobs: Job[],
  opts: { force?: boolean; checkApplyLink?: boolean; keepIds?: Set<string> } = {},
): Promise<Record<string, JobVerification>> {
  const map = loadStatuses();
  const out: Record<string, JobVerification> = {};
  const boards: BoardCache = new Map();
  const now = Date.now();
  const queue = jobs.filter((j) => {
    const prev = map[j.id];
    if (!opts.force && prev && prev.method !== "scan-diff" && now - new Date(prev.checked_at).getTime() < FRESH_MS) {
      out[j.id] = prev;
      return false;
    }
    return true;
  });

  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const job = queue[next++];
      out[job.id] = await verifyJob(job, { checkApplyLink: opts.checkApplyLink, boards });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

  // Re-read before merging so a concurrent scan's updates aren't lost.
  const latest = loadStatuses();
  for (const job of queue) latest[job.id] = out[job.id];
  saveStatuses(latest, opts.keepIds);
  return out;
}

// ── Passive check during a scan ──

// Jobs that were known before (previous jobs.json + tracked) but are missing from a
// successful fetch of their company's board are marked closed. Aggregator feeds are
// skipped: they aren't guaranteed to list every live job (RemoteOK returns recent ones).
// Jobs present in the scan clear any stale "closed" verdict.
export function applyScanDiff(
  known: Job[],
  scanned: Job[],
  okCompanies: Company[],
  keepIds: Set<string> = new Set(),
): { closed: string[]; reopened: string[] } {
  const map = loadStatuses();
  const present = new Set(scanned.map((j) => j.id));
  const companies = loadCompanies();
  const okTokens = new Set(okCompanies.filter((c) => !AGGREGATORS.has(c.ats)).map((c) => `${c.ats}:${c.token}`));
  const now = new Date().toISOString();
  const closed: string[] = [];
  const reopened: string[] = [];

  for (const id of present) {
    if (map[id]?.status === "closed") { delete map[id]; reopened.push(id); }
  }

  const seen = new Set<string>();
  for (const job of known) {
    if (seen.has(job.id) || present.has(job.id) || AGGREGATORS.has(job.ats)) continue;
    seen.add(job.id);
    const ids = parseAtsId(job, companies);
    if (!ids || !okTokens.has(`${job.ats}:${ids.token}`)) continue;  // company failed or unknown → no verdict
    if (map[job.id]?.status === "closed") continue;
    map[job.id] = {
      ...base(job),
      status: "closed",
      checked_at: now,
      method: "scan-diff",
      reason: `המשרה לא הופיעה בסריקה האחרונה של ${job.company} (הסריקה הצליחה)`,
    };
    closed.push(job.id);
  }

  if (closed.length || reopened.length) saveStatuses(map, keepIds);
  return { closed, reopened };
}
