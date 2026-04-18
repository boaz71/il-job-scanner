import { loadEnv } from "./env.js";
loadEnv();

import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname, extname } from "path";
import { fileURLToPath } from "url";
import type { Job } from "./types.js";
import {
  parseCV,
  extractProfile,
  generateTailoredCV, generateCoverLetter, generateInterviewPrep,
  analyzeProfile,
  analyzeSkillGap, generateSalaryPrep, mockInterviewReply,
  companyDeepDive, generateLinkedInOutreach, generateFollowUp, compareJobs,
  generateAIOpportunities, generateWLBRanking,
  type Lang, type MockMessage,
} from "./cv.js";
import { markdownToDocx, markdownToPdf } from "./export.js";
import { runScan } from "./scanner.js";
import { matchJobs } from "./matcher.js";
import {
  listProfiles, getProfile, saveStoredProfile, deleteProfile,
  getActiveId, setActive, getActiveProfile,
  newProfileId, newCVId, syncActiveToLegacy, getPrimaryCVText,
  type StoredProfile,
} from "./profiles.js";
import { listScans, getScan, deleteScan } from "./scans.js";
import {
  listTracked, addTracked, updateTracked, removeTracked,
} from "./tracker.js";
import { buildStats } from "./dashboard.js";
import {
  loadConfig as loadNotif, saveConfig as saveNotif, sendTelegram,
} from "./notifications.js";
import {
  loadAutomation, saveAutomation, rescheduleAutomation, runAutoScan,
} from "./automation.js";
import { getSummary as getCostSummary } from "./costs.js";
import { getCacheStats, clearCache } from "./cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const PORT = 5173;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolveP(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJSON(res: ServerResponse, status: number, data: any) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function loadCurrentJobs(): Job[] {
  const scored = resolve(ROOT, "data/scored-jobs.json");
  const plain = resolve(ROOT, "data/jobs.json");
  const path = existsSync(scored) ? scored : plain;
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8"));
}

// Re-score current raw jobs against a profile and write scored-jobs.json
function rescoreActive(): number {
  const active = getActiveProfile();
  if (!active) return 0;
  const path = resolve(ROOT, "data/jobs.json");
  if (!existsSync(path)) return 0;
  const jobs: Job[] = JSON.parse(readFileSync(path, "utf-8"));
  const scored = matchJobs(jobs, active.profile, active.profile.min_match_score || 0);
  writeFileSync(resolve(ROOT, "data/scored-jobs.json"), JSON.stringify(scored, null, 2));
  return scored.length;
}

function parseMultipart(body: Buffer, contentType: string): { filename: string; content: Buffer } | null {
  const match = contentType.match(/boundary=(.+)$/);
  if (!match) return null;
  const boundary = Buffer.from(`--${match[1]}`);
  const end = Buffer.from(`--${match[1]}--`);

  const parts: Buffer[] = [];
  let start = body.indexOf(boundary);
  if (start < 0) return null;
  start += boundary.length;
  while (true) {
    const next = body.indexOf(boundary, start);
    const isEnd = body.indexOf(end, start);
    const cutoff = next < 0 ? isEnd : next;
    if (cutoff < 0) break;
    parts.push(body.subarray(start, cutoff));
    if (cutoff === isEnd) break;
    start = cutoff + boundary.length;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const header = part.subarray(0, headerEnd).toString("utf-8");
    const fn = header.match(/filename="([^"]+)"/);
    if (!fn) continue;
    let content = part.subarray(headerEnd + 4);
    if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
      content = content.subarray(0, content.length - 2);
    }
    return { filename: fn[1], content };
  }
  return null;
}

function extractMultipartField(body: Buffer, contentType: string, fieldName: string): string | null {
  const match = contentType.match(/boundary=(.+)$/);
  if (!match) return null;
  const boundary = `--${match[1]}`;
  const text = body.toString("utf-8");
  const parts = text.split(boundary);
  for (const part of parts) {
    if (part.includes(`name="${fieldName}"`) && !part.includes("filename=")) {
      const valueMatch = part.match(/\r\n\r\n([\s\S]*?)(\r\n)?$/);
      if (valueMatch) return valueMatch[1].trim();
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const fullUrl = req.url || "/";
  const [pathname, queryStr] = fullUrl.split("?");
  const query = new URLSearchParams(queryStr || "");
  const method = req.method || "GET";

  try {
    // ── Profiles ──
    if (pathname === "/api/profiles" && method === "GET") {
      const profiles = listProfiles().map((p) => ({
        id: p.id,
        label: p.label,
        created_at: p.created_at,
        avatar: p.avatar || null,
        cvs: (p.cvs || []).map(c => ({ id: c.id, filename: c.filename, label: c.label, added_at: c.added_at, chars: c.text.length })),
        primary_cv_index: p.primary_cv_index || 0,
        title: p.profile.title,
        active: p.id === getActiveId(),
        has_insights: !!p.insights,
      }));
      return sendJSON(res, 200, { profiles, active: getActiveId() });
    }

    if (pathname === "/api/profiles/active" && method === "GET") {
      const active = getActiveProfile();
      return sendJSON(res, 200, { active });
    }

    if (pathname === "/api/profiles/activate" && method === "POST") {
      const body = await readBody(req);
      const { id } = JSON.parse(body.toString("utf-8"));
      if (!getProfile(id)) return sendJSON(res, 404, { error: "פרופיל לא נמצא" });
      setActive(id);
      syncActiveToLegacy();
      const rescored = rescoreActive();
      return sendJSON(res, 200, { ok: true, rescored });
    }

    if (pathname === "/api/profiles/delete" && method === "POST") {
      const body = await readBody(req);
      const { id } = JSON.parse(body.toString("utf-8"));
      const ok = deleteProfile(id);
      return sendJSON(res, ok ? 200 : 404, { ok });
    }

    if (pathname === "/api/profiles/upload" && method === "POST") {
      const body = await readBody(req);
      const ct = req.headers["content-type"] || "";
      const part = parseMultipart(body, ct);
      if (!part) return sendJSON(res, 400, { error: "לא נמצא קובץ" });
      const cvText = await parseCV(part.content, part.filename);
      const profile = await extractProfile(cvText);
      const label = profile.name + (profile.title ? ` · ${profile.title}` : "");
      const id = newProfileId(label);
      const now = new Date().toISOString();
      const stored: StoredProfile = {
        id, label,
        created_at: now,
        cvs: [{
          id: newCVId(),
          filename: part.filename,
          text: cvText,
          label: "קו\"ח ראשי",
          added_at: now,
        }],
        primary_cv_index: 0,
        profile,
      };
      saveStoredProfile(stored);
      if (!getActiveId()) {
        setActive(id);
        syncActiveToLegacy();
        rescoreActive();
      }
      return sendJSON(res, 200, { ok: true, id, label, chars: cvText.length });
    }

    // ── Avatar upload ──
    if (pathname === "/api/profiles/avatar" && method === "POST") {
      const body = await readBody(req);
      const ct = req.headers["content-type"] || "";
      const { id } = Object.fromEntries(new URLSearchParams(fullUrl.split("?")[1] || ""));
      const profileId = id || JSON.parse(body.toString("utf-8")).id;
      const stored = getProfile(profileId);
      if (!stored) return sendJSON(res, 404, { error: "פרופיל לא נמצא" });

      if (ct.includes("multipart")) {
        const part = parseMultipart(body, ct);
        if (!part) return sendJSON(res, 400, { error: "לא נמצא קובץ" });
        const ext = part.filename.split(".").pop()?.toLowerCase() || "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/png";
        stored.avatar = `data:${mime};base64,${part.content.toString("base64")}`;
      } else {
        const { avatar } = JSON.parse(body.toString("utf-8"));
        stored.avatar = avatar; // expect data URI
      }
      saveStoredProfile(stored);
      return sendJSON(res, 200, { ok: true });
    }

    // ── Add CV to existing profile ──
    if (pathname === "/api/profiles/cv/add" && method === "POST") {
      const body = await readBody(req);
      const ct = req.headers["content-type"] || "";
      const part = parseMultipart(body, ct);
      if (!part) return sendJSON(res, 400, { error: "לא נמצא קובץ" });

      // Profile ID comes as form field or query param
      // Try extracting from multipart fields
      let profileId = query.get("id") || "";
      if (!profileId) {
        // Check if there's a text field 'id' in multipart
        const idField = extractMultipartField(body, ct, "id");
        profileId = idField || "";
      }
      if (!profileId) return sendJSON(res, 400, { error: "חסר profile id" });

      const stored = getProfile(profileId);
      if (!stored) return sendJSON(res, 404, { error: "פרופיל לא נמצא" });

      const cvText = await parseCV(part.content, part.filename);
      const cvLabel = part.filename.replace(/\.[^.]+$/, "");
      stored.cvs.push({
        id: newCVId(),
        filename: part.filename,
        text: cvText,
        label: cvLabel,
        added_at: new Date().toISOString(),
      });
      saveStoredProfile(stored);
      return sendJSON(res, 200, { ok: true, cv_count: stored.cvs.length, chars: cvText.length });
    }

    // ── Remove CV from profile ──
    if (pathname === "/api/profiles/cv/remove" && method === "POST") {
      const body = await readBody(req);
      const { profileId, cvId } = JSON.parse(body.toString("utf-8"));
      const stored = getProfile(profileId);
      if (!stored) return sendJSON(res, 404, { error: "פרופיל לא נמצא" });
      if (stored.cvs.length <= 1) return sendJSON(res, 400, { error: "לא ניתן למחוק את ה-CV האחרון" });
      stored.cvs = stored.cvs.filter(c => c.id !== cvId);
      if (stored.primary_cv_index >= stored.cvs.length) stored.primary_cv_index = 0;
      saveStoredProfile(stored);
      return sendJSON(res, 200, { ok: true, cv_count: stored.cvs.length });
    }

    // ── Set primary CV ──
    if (pathname === "/api/profiles/cv/primary" && method === "POST") {
      const body = await readBody(req);
      const { profileId, cvId } = JSON.parse(body.toString("utf-8"));
      const stored = getProfile(profileId);
      if (!stored) return sendJSON(res, 404, { error: "פרופיל לא נמצא" });
      const idx = stored.cvs.findIndex(c => c.id === cvId);
      if (idx < 0) return sendJSON(res, 404, { error: "CV לא נמצא" });
      stored.primary_cv_index = idx;
      // Re-extract profile from new primary CV
      const newProfile = await extractProfile(stored.cvs[idx].text);
      stored.profile = newProfile;
      stored.label = newProfile.name + (newProfile.title ? ` · ${newProfile.title}` : "");

      // Re-run insights if they existed before
      let newInsights = null;
      if (stored.insights) {
        try {
          newInsights = await analyzeProfile(stored.cvs[idx].text);
          stored.insights = newInsights;
        } catch {
          // If insights fail, keep old ones but mark as stale
          stored.insights = { ...stored.insights, market_summary: stored.insights.market_summary + "\n\n⚠️ תובנות אלו מבוססות על CV קודם — לחץ 'חשב תובנות שוק' לעדכון." };
        }
      }

      saveStoredProfile(stored);
      if (getActiveId() === profileId) {
        syncActiveToLegacy();
        rescoreActive();
      }
      return sendJSON(res, 200, { ok: true, profile: newProfile, insights_updated: !!newInsights });
    }

    if (pathname === "/api/profiles/insights" && method === "POST") {
      const body = await readBody(req);
      const { id } = JSON.parse(body.toString("utf-8"));
      const stored = id ? getProfile(id) : getActiveProfile();
      if (!stored) return sendJSON(res, 404, { error: "פרופיל לא נמצא" });
      const insights = await analyzeProfile(getPrimaryCVText(stored));
      stored.insights = insights;
      saveStoredProfile(stored);
      return sendJSON(res, 200, { ok: true, insights });
    }

    // ── Scan ──
    if (pathname === "/api/scan" && method === "POST") {
      const body = await readBody(req);
      const opts = body.length ? JSON.parse(body.toString("utf-8")) : {};
      const result = await runScan({
        keyword: opts.keyword,
        location: opts.location,
        archive: true,
      });
      // Re-score if active profile exists
      let scoredCount = 0;
      if (getActiveProfile()) {
        scoredCount = rescoreActive();
      }
      return sendJSON(res, 200, {
        ok: true,
        scanned_at: result.scanned_at,
        total_jobs: result.jobs.length,
        errors: result.errors,
        archive_id: result.archive_id,
        scored_count: scoredCount,
      });
    }

    // ── Scans archive ──
    if (pathname === "/api/scans" && method === "GET") {
      return sendJSON(res, 200, { scans: listScans() });
    }

    if (pathname === "/api/scans/get" && method === "GET") {
      const id = query.get("id");
      if (!id) return sendJSON(res, 400, { error: "חסר id" });
      const scan = getScan(id);
      if (!scan) return sendJSON(res, 404, { error: "לא נמצא" });
      return sendJSON(res, 200, scan);
    }

    if (pathname === "/api/scans/delete" && method === "POST") {
      const body = await readBody(req);
      const { id } = JSON.parse(body.toString("utf-8"));
      const ok = deleteScan(id);
      return sendJSON(res, ok ? 200 : 404, { ok });
    }

    // ── Generation ──
    if (pathname === "/api/generate/cv" && method === "POST") {
      const body = await readBody(req);
      const { jobId, lang } = JSON.parse(body.toString("utf-8"));
      const active = getActiveProfile();
      if (!active) return sendJSON(res, 400, { error: "אין פרופיל פעיל" });
      const job = loadCurrentJobs().find((j) => j.id === jobId);
      if (!job) return sendJSON(res, 404, { error: "משרה לא נמצאה" });
      const text = await generateTailoredCV(getPrimaryCVText(active), job, (lang as Lang) || "auto");
      return sendJSON(res, 200, { ok: true, text, job: { title: job.title, company: job.company } });
    }

    if (pathname === "/api/generate/letter" && method === "POST") {
      const body = await readBody(req);
      const { jobId, lang } = JSON.parse(body.toString("utf-8"));
      const active = getActiveProfile();
      if (!active) return sendJSON(res, 400, { error: "אין פרופיל פעיל" });
      const job = loadCurrentJobs().find((j) => j.id === jobId);
      if (!job) return sendJSON(res, 404, { error: "משרה לא נמצאה" });
      const text = await generateCoverLetter(getPrimaryCVText(active), job, (lang as Lang) || "auto");
      return sendJSON(res, 200, { ok: true, text, job: { title: job.title, company: job.company } });
    }

    if (pathname === "/api/generate/interview" && method === "POST") {
      const body = await readBody(req);
      const { jobId } = JSON.parse(body.toString("utf-8"));
      const active = getActiveProfile();
      if (!active) return sendJSON(res, 400, { error: "אין פרופיל פעיל" });
      const job = loadCurrentJobs().find((j) => j.id === jobId);
      if (!job) return sendJSON(res, 404, { error: "משרה לא נמצאה" });
      const text = await generateInterviewPrep(getPrimaryCVText(active), job);
      return sendJSON(res, 200, { ok: true, text, job: { title: job.title, company: job.company } });
    }

    if (pathname === "/api/generate/skill-gap" && method === "POST") {
      const body = await readBody(req);
      const { jobId } = JSON.parse(body.toString("utf-8"));
      const active = getActiveProfile();
      if (!active) return sendJSON(res, 400, { error: "אין פרופיל פעיל" });
      const job = loadCurrentJobs().find((j) => j.id === jobId);
      if (!job) return sendJSON(res, 404, { error: "משרה לא נמצאה" });
      const text = await analyzeSkillGap(getPrimaryCVText(active), job);
      return sendJSON(res, 200, { ok: true, text, job: { title: job.title, company: job.company } });
    }

    if (pathname === "/api/generate/salary" && method === "POST") {
      const body = await readBody(req);
      const { jobId } = JSON.parse(body.toString("utf-8"));
      const active = getActiveProfile();
      if (!active) return sendJSON(res, 400, { error: "אין פרופיל פעיל" });
      const job = loadCurrentJobs().find((j) => j.id === jobId);
      if (!job) return sendJSON(res, 404, { error: "משרה לא נמצאה" });
      const text = await generateSalaryPrep(getPrimaryCVText(active), job);
      return sendJSON(res, 200, { ok: true, text, job: { title: job.title, company: job.company } });
    }

    // ── Mock interview chat ──
    if (pathname === "/api/mock-interview" && method === "POST") {
      const body = await readBody(req);
      const { jobId, history } = JSON.parse(body.toString("utf-8"));
      const active = getActiveProfile();
      if (!active) return sendJSON(res, 400, { error: "אין פרופיל פעיל" });
      const job = loadCurrentJobs().find((j) => j.id === jobId);
      if (!job) return sendJSON(res, 404, { error: "משרה לא נמצאה" });
      const text = await mockInterviewReply(getPrimaryCVText(active), job, (history || []) as MockMessage[]);
      return sendJSON(res, 200, { ok: true, text });
    }

    // ── Tracker ──
    if (pathname === "/api/tracker" && method === "GET") {
      return sendJSON(res, 200, { tracked: listTracked() });
    }
    if (pathname === "/api/tracker/add" && method === "POST") {
      const body = await readBody(req);
      const { jobId } = JSON.parse(body.toString("utf-8"));
      const job = loadCurrentJobs().find((j) => j.id === jobId);
      if (!job) return sendJSON(res, 404, { error: "משרה לא נמצאה" });
      const t = addTracked(job);
      return sendJSON(res, 200, { ok: true, tracked: t });
    }
    if (pathname === "/api/tracker/update" && method === "POST") {
      const body = await readBody(req);
      const { id, status, notes, applied_at } = JSON.parse(body.toString("utf-8"));
      const t = updateTracked(id, { status, notes, applied_at });
      if (!t) return sendJSON(res, 404, { error: "לא נמצא" });
      return sendJSON(res, 200, { ok: true, tracked: t });
    }
    if (pathname === "/api/tracker/remove" && method === "POST") {
      const body = await readBody(req);
      const { id } = JSON.parse(body.toString("utf-8"));
      const ok = removeTracked(id);
      return sendJSON(res, ok ? 200 : 404, { ok });
    }

    // ── Dashboard ──
    if (pathname === "/api/dashboard" && method === "GET") {
      return sendJSON(res, 200, buildStats());
    }

    // ── Notifications + Automation ──
    if (pathname === "/api/automation" && method === "GET") {
      return sendJSON(res, 200, {
        notifications: loadNotif(),
        automation: loadAutomation(),
      });
    }
    if (pathname === "/api/automation/notifications" && method === "POST") {
      const body = await readBody(req);
      const cfg = JSON.parse(body.toString("utf-8"));
      saveNotif(cfg);
      return sendJSON(res, 200, { ok: true, notifications: loadNotif() });
    }
    if (pathname === "/api/automation/test-telegram" && method === "POST") {
      const r = await sendTelegram("✅ <b>IL Job Scanner</b>\nהבדיקה עברה — ההתראות מוכנות.");
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (pathname === "/api/automation/cron" && method === "POST") {
      const body = await readBody(req);
      const { enabled, interval_hours } = JSON.parse(body.toString("utf-8"));
      const cfg = loadAutomation();
      cfg.enabled = !!enabled;
      if (interval_hours) cfg.interval_hours = Math.max(1, Math.min(24, Number(interval_hours)));
      saveAutomation(cfg);
      rescheduleAutomation();
      return sendJSON(res, 200, { ok: true, automation: loadAutomation() });
    }
    if (pathname === "/api/automation/run-now" && method === "POST") {
      const r = await runAutoScan();
      return sendJSON(res, 200, { ok: true, ...r });
    }

    // ── Export ──
    if ((pathname === "/api/export/docx" || pathname === "/api/export/pdf") && method === "POST") {
      const body = await readBody(req);
      const { content, filename } = JSON.parse(body.toString("utf-8"));
      if (!content) return sendJSON(res, 400, { error: "חסר content" });
      const isPdf = pathname.endsWith("pdf");
      const buf = isPdf ? await markdownToPdf(content) : await markdownToDocx(content);
      const safeFilename = (filename || (isPdf ? "document.pdf" : "document.docx"))
        .replace(/[^\w.\u0590-\u05ff-]+/g, "_");
      res.writeHead(200, {
        "Content-Type": isPdf
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
        "Content-Length": String(buf.length),
      });
      res.end(buf);
      return;
    }

    // ── Company deep dive ──
    if (pathname === "/api/generate/company-dive" && method === "POST") {
      const body = await readBody(req);
      const { company } = JSON.parse(body.toString("utf-8"));
      if (!company) return sendJSON(res, 400, { error: "חסר company" });
      const allJobs = loadCurrentJobs();
      const companyJobs = allJobs.filter(j => j.company === company);
      const jobsSummary = companyJobs.slice(0, 15)
        .map(j => `- ${j.title} (${j.location}) [${j.department}]`).join("\n");
      const text = await companyDeepDive(company, jobsSummary || "אין משרות כרגע");
      return sendJSON(res, 200, { ok: true, text, company });
    }

    // ── LinkedIn outreach ──
    if (pathname === "/api/generate/linkedin" && method === "POST") {
      const body = await readBody(req);
      const { jobId } = JSON.parse(body.toString("utf-8"));
      const active = getActiveProfile();
      if (!active) return sendJSON(res, 400, { error: "אין פרופיל פעיל" });
      const job = loadCurrentJobs().find((j) => j.id === jobId);
      if (!job) return sendJSON(res, 404, { error: "משרה לא נמצאה" });
      const text = await generateLinkedInOutreach(getPrimaryCVText(active), job);
      return sendJSON(res, 200, { ok: true, text, job: { title: job.title, company: job.company } });
    }

    // ── Follow-up email ──
    if (pathname === "/api/generate/followup" && method === "POST") {
      const body = await readBody(req);
      const { jobId } = JSON.parse(body.toString("utf-8"));
      const active = getActiveProfile();
      if (!active) return sendJSON(res, 400, { error: "אין פרופיל פעיל" });
      // Find in tracked jobs to get applied_at
      const tracked = listTracked();
      const t = tracked.find(x => x.id === jobId);
      if (!t) return sendJSON(res, 404, { error: "משרה לא במעקב" });
      const daysSince = t.applied_at
        ? Math.floor((Date.now() - new Date(t.applied_at).getTime()) / 86400000)
        : 7;
      const text = await generateFollowUp(getPrimaryCVText(active), t.job, daysSince);
      return sendJSON(res, 200, { ok: true, text, job: { title: t.job.title, company: t.job.company }, days: daysSince });
    }

    // ── Job comparison ──
    if (pathname === "/api/compare" && method === "POST") {
      const body = await readBody(req);
      const { jobIds } = JSON.parse(body.toString("utf-8"));
      if (!Array.isArray(jobIds) || jobIds.length < 2) {
        return sendJSON(res, 400, { error: "בחר לפחות 2 משרות להשוואה" });
      }
      const allJobs = loadCurrentJobs();
      const selected = jobIds.map(id => allJobs.find(j => j.id === id)).filter(Boolean);
      if (selected.length < 2) return sendJSON(res, 400, { error: "חלק מהמשרות לא נמצאו" });
      const text = compareJobs(selected as any);
      return sendJSON(res, 200, { ok: true, text });
    }

    // ── Restore jobs from archived scan ──
    if (pathname === "/api/scans/restore" && method === "POST") {
      const body = await readBody(req);
      const { id, jobIds } = JSON.parse(body.toString("utf-8"));
      const scan = id ? getScan(id) : null;
      if (!scan) return sendJSON(res, 404, { error: "סריקה לא נמצאה" });

      // Load current jobs
      const curPath = resolve(ROOT, "data/jobs.json");
      const current: Job[] = existsSync(curPath)
        ? JSON.parse(readFileSync(curPath, "utf-8"))
        : [];
      const currentIds = new Set(current.map(j => j.id));

      // Filter which jobs to restore
      let toRestore = scan.jobs;
      if (Array.isArray(jobIds) && jobIds.length) {
        const idSet = new Set(jobIds as string[]);
        toRestore = toRestore.filter(j => idSet.has(j.id));
      }

      // Add only jobs that don't already exist, mark as restored
      let added = 0;
      const now = new Date().toISOString();
      for (const j of toRestore) {
        if (!currentIds.has(j.id)) {
          current.push({ ...j, is_restored: true, restored_from: id, restored_at: now });
          currentIds.add(j.id);
          added++;
        }
      }

      writeFileSync(curPath, JSON.stringify(current, null, 2));

      // Re-score if active profile exists
      let scoredCount = 0;
      if (getActiveProfile()) {
        scoredCount = rescoreActive();
      }

      return sendJSON(res, 200, { ok: true, added, total: current.length, scored: scoredCount });
    }

    // ── AI Opportunities ──
    if (pathname === "/api/ai-opportunities" && method === "GET") {
      const force = query.get("force") === "1";
      if (!force) {
        // Try cache first without calling AI
        const { getCached: getC } = await import("./cache.js");
        const cacheKey = getActiveProfile() ? "with-profile" : "general";
        const cached = getC("ai-opportunities", cacheKey);
        if (cached) return sendJSON(res, 200, { ok: true, text: cached, cached: true });
      }
      const active = getActiveProfile();
      const text = await generateAIOpportunities(active?.cv_text || null);
      return sendJSON(res, 200, { ok: true, text, cached: false });
    }

    // ── WLB directory ──
    if (pathname === "/api/wlb-directory" && method === "GET") {
      const wlbPath = resolve(ROOT, "data/wlb-directory.json");
      if (!existsSync(wlbPath)) return sendJSON(res, 200, { companies: [] });
      return sendJSON(res, 200, { companies: JSON.parse(readFileSync(wlbPath, "utf-8")) });
    }

    // ── WLB deep report (AI + web search) ──
    if (pathname === "/api/wlb-ranking" && method === "GET") {
      const force = query.get("force") === "1";
      if (!force) {
        const { getCached: getC } = await import("./cache.js");
        const cached = getC("wlb-ranking", "v1");
        if (cached) return sendJSON(res, 200, { ok: true, text: cached, cached: true });
      }
      const text = await generateWLBRanking();
      return sendJSON(res, 200, { ok: true, text, cached: false });
    }

    // ── Costs & cache ──
    if (pathname === "/api/costs" && method === "GET") {
      const summary = getCostSummary();
      const cache = getCacheStats();
      return sendJSON(res, 200, { ...summary, cache });
    }
    if (pathname === "/api/cache/clear" && method === "POST") {
      const removed = clearCache();
      return sendJSON(res, 200, { ok: true, removed });
    }

    // ── Companies directory ──
    if (pathname === "/api/companies-directory" && method === "GET") {
      const dirPath = resolve(ROOT, "data/companies-directory.json");
      if (!existsSync(dirPath)) return sendJSON(res, 200, { companies: [] });
      return sendJSON(res, 200, { companies: JSON.parse(readFileSync(dirPath, "utf-8")) });
    }

    // ── Company brief for NotebookLM ──
    if (pathname === "/api/company-brief" && method === "GET") {
      const name = query.get("name");
      if (!name) return sendJSON(res, 400, { error: "חסר name" });
      const dirPath = resolve(ROOT, "data/companies-directory.json");
      if (!existsSync(dirPath)) return sendJSON(res, 404, { error: "אין מאגר חברות" });
      const companies = JSON.parse(readFileSync(dirPath, "utf-8"));
      const c = companies.find((x: any) => x.name === name);
      if (!c) return sendJSON(res, 404, { error: "חברה לא נמצאה" });
      // Get jobs for this company
      const allJobs = loadCurrentJobs();
      const companyJobs = allJobs.filter(j => j.company === name || c.name.includes(j.company));
      const jobsList = companyJobs.slice(0, 20).map(j => `- ${j.title} (${j.location}) [${j.department}]`).join("\n");
      const brief = buildCompanyBrief(c, jobsList);
      // Return as downloadable text
      const buf = Buffer.from(brief, "utf-8");
      const safeName = name.replace(/[^\w\u0590-\u05ff]+/g, "_");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeName + "-brief.md")}`,
        "Content-Length": String(buf.length),
      });
      res.end(buf);
      return;
    }

    if (pathname === "/api/company-briefs-all" && method === "GET") {
      const dirPath = resolve(ROOT, "data/companies-directory.json");
      if (!existsSync(dirPath)) return sendJSON(res, 404, { error: "אין מאגר חברות" });
      const companies = JSON.parse(readFileSync(dirPath, "utf-8"));
      const allJobs = loadCurrentJobs();
      let fullDoc = "# 25 חברות טק מובילות בישראל — סיכום מקיף\n\n";
      fullDoc += `> נוצר אוטומטית ע\"י IL Job Scanner · ${new Date().toLocaleDateString("he-IL")}\n\n`;
      fullDoc += "---\n\n";
      for (const c of companies) {
        const companyJobs = allJobs.filter((j: any) => j.company === c.name || c.name.includes(j.company));
        const jobsList = companyJobs.slice(0, 10).map((j: any) => `- ${j.title} (${j.location})`).join("\n");
        fullDoc += buildCompanyBrief(c, jobsList) + "\n\n---\n\n";
      }
      const buf = Buffer.from(fullDoc, "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("25-Israeli-Tech-Companies-Brief.md")}`,
        "Content-Length": String(buf.length),
      });
      res.end(buf);
      return;
    }

    // ── Portfolio ideas ──
    if (pathname === "/api/portfolio" && method === "GET") {
      const pPath = resolve(ROOT, "data/portfolio-ideas.json");
      if (!existsSync(pPath)) return sendJSON(res, 200, { categories: [], portfolio_tips: {} });
      return sendJSON(res, 200, JSON.parse(readFileSync(pPath, "utf-8")));
    }

    // ── LeetCode ──
    if (pathname === "/api/leetcode" && method === "GET") {
      const lcPath = resolve(ROOT, "data/leetcode.json");
      if (!existsSync(lcPath)) return sendJSON(res, 200, { categories: [], study_plans: {} });
      return sendJSON(res, 200, JSON.parse(readFileSync(lcPath, "utf-8")));
    }

    // ── Static ──
    let path: string;
    if (pathname === "/" || pathname === "/index.html") {
      path = resolve(ROOT, "web/index.html");
    } else if (pathname === "/jobs.json") {
      const scored = resolve(ROOT, "data/scored-jobs.json");
      const plain = resolve(ROOT, "data/jobs.json");
      path = existsSync(scored) ? scored : plain;
    } else {
      path = resolve(ROOT, "web" + pathname);
    }

    if (!existsSync(path)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = extname(path);
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain; charset=utf-8" });
    res.end(readFileSync(path));
  } catch (err: any) {
    console.error(err);
    sendJSON(res, 500, { error: err.message || String(err) });
  }
});

// Auto-migrate legacy single-CV setup to multi-profile if no profiles yet
function autoMigrate() {
  const existing = listProfiles();
  if (existing.length) return;
  const cvPath = resolve(ROOT, "data/cv.txt");
  const profilePath = resolve(ROOT, "profile.json");
  if (!existsSync(cvPath) || !existsSync(profilePath)) return;
  try {
    const cvText = readFileSync(cvPath, "utf-8");
    const profile = JSON.parse(readFileSync(profilePath, "utf-8"));
    const label = (profile.name || "Default") + (profile.title ? ` · ${profile.title}` : "");
    const id = newProfileId(label);
    const now = new Date().toISOString();
    saveStoredProfile({
      id, label,
      created_at: now,
      cvs: [{ id: newCVId(), filename: "cv.txt (migrated)", text: cvText, label: "קו\"ח ראשי", added_at: now }],
      primary_cv_index: 0,
      cv_filename: "cv.txt (migrated)",
      cv_text: cvText,
      profile,
    });
    setActive(id);
    console.log(`📦 הועבר פרופיל קיים לארכיון: ${label}`);
  } catch (e: any) {
    console.warn("⚠️  לא ניתן להעביר פרופיל קיים:", e.message);
  }
}

function buildCompanyBrief(c: any, jobsList: string): string {
  return `## ${c.name}

**תחום:** ${c.sector}
**מיקום:** ${c.hq}
**גודל (ישראל):** ${c.employees_il}
**רמה:** ${c.tier}

### מה החברה עושה
${c.tips.split(".")[0]}.

### Stack טכנולוגי ותרבות
${c.tips}

### דף קריירה
${c.careers}

### אנשי קשר
- **LinkedIn Recruiters:** ${c.linkedin_search}
${c.email_pattern && c.email_pattern !== "—" ? `- **מייל כללי:** ${c.email_pattern}` : "- *אין מייל כללי פומבי — הגשה דרך אתר/LinkedIn*"}

### משרות פתוחות כרגע
${jobsList || "*אין משרות במאגר הנוכחי*"}

### נקודות מפתח לראיון
${c.tips.split(". ").map((t: string) => `- ${t.trim()}`).filter((t: string) => t.length > 3).join("\n")}
`;
}

autoMigrate();
rescheduleAutomation();

server.listen(PORT, () => {
  console.log(`\n🌐  http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes("PUT-YOUR-KEY")) {
    console.log(`⚠️   להפעלת פיצ'רי AI: ערוך את .env`);
  }
  console.log("");
});
