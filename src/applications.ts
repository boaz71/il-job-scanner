// Application record per job — what was prepared and sent, with which profile/CV.
// One file per job in data/applications/ (keeps tracked-jobs.json small, and a
// write to one application never rewrites the others).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import type { Job } from "./types.js";
import type { JobVerification } from "./verify.js";
import type { StoredProfile } from "./profiles.js";
import { addTracked, updateTracked, type TrackedJob } from "./tracker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
// APPLICATIONS_DIR override exists for tests only.
const DIR = process.env.APPLICATIONS_DIR || resolve(ROOT, "data/applications");

export type DocKind = "cv" | "letter";

export interface ApplicationDoc {
  markdown: string;
  lang?: string;
  generated_at?: string;   // when the AI produced it
  saved_at: string;        // last save (generated or edited)
  edited: boolean;         // user changed the generated text
}

export interface ApplicationRecord {
  job_id: string;
  job: Job;                          // snapshot, refreshed on every save
  profile_id: string | null;         // profile the documents were made for
  cv_id: string | null;              // which of the profile's CVs was the base
  created_at: string;
  updated_at: string;
  cv?: ApplicationDoc;
  letter?: ApplicationDoc;
  // Filled by the submission flow (phase 3):
  verification?: JobVerification;    // snapshot at approval time
  approval?: { at: string; checklist: string[] };
  submission?: { opened_at?: string; submitted_at?: string; method: "manual"; apply_url?: string };
  confirmation?: { at: string; evidence: string };
  events: { at: string; type: string; note?: string }[];
}

// A step of the submission flow was attempted out of order (→ HTTP 409).
export class FlowError extends Error {}

// Job ids contain arbitrary source text — never use them as a path directly.
// Readable prefix + hash keeps names unique even when sanitizing collapses characters.
export function fileNameFor(jobId: string): string {
  const safe = jobId.replace(/[^\w-]/g, "_").slice(0, 60);
  const hash = createHash("sha256").update(jobId).digest("hex").slice(0, 10);
  return `${safe}-${hash}.json`;
}

function pathFor(jobId: string): string {
  return resolve(DIR, fileNameFor(jobId));
}

function writeAtomic(path: string, data: unknown): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function getApplication(jobId: string): ApplicationRecord | null {
  if (typeof jobId !== "string" || !jobId) return null;
  const path = pathFor(jobId);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

export function listApplications(): ApplicationRecord[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try { return JSON.parse(readFileSync(resolve(DIR, f), "utf-8")) as ApplicationRecord; } catch { return null; }
    })
    .filter((x): x is ApplicationRecord => x !== null)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function saveApplication(rec: ApplicationRecord): ApplicationRecord {
  rec.updated_at = new Date().toISOString();
  writeAtomic(pathFor(rec.job_id), rec);
  return rec;
}

function blank(job: Job, profileId: string | null, cvId: string | null): ApplicationRecord {
  const now = new Date().toISOString();
  return { job_id: job.id, job, profile_id: profileId, cv_id: cvId, created_at: now, updated_at: now, events: [] };
}

// Save a CV or cover letter for a job. Switching profile/CV starts the documents
// over — documents made for one CV must not be sent with another.
export function saveDocument(
  job: Job,
  kind: DocKind,
  doc: { markdown: string; lang?: string; generated: boolean },
  ctx: { profileId: string | null; cvId: string | null },
): ApplicationRecord {
  let rec = getApplication(job.id) ?? blank(job, ctx.profileId, ctx.cvId);
  // What was submitted is the record of what was sent — it must not change afterwards.
  if (rec.submission?.submitted_at) throw new FlowError("המועמדות כבר הוגשה — המסמכים נעולים");
  if (rec.profile_id !== ctx.profileId || rec.cv_id !== ctx.cvId) {
    rec.events.push({ at: new Date().toISOString(), type: "profile-changed", note: `${rec.profile_id ?? "—"} → ${ctx.profileId ?? "—"}` });
    rec = { ...rec, profile_id: ctx.profileId, cv_id: ctx.cvId, cv: undefined, letter: undefined };
  }
  const now = new Date().toISOString();
  const prev = rec[kind];
  rec[kind] = {
    markdown: doc.markdown,
    lang: doc.lang ?? prev?.lang,
    generated_at: doc.generated ? now : prev?.generated_at,
    saved_at: now,
    edited: !doc.generated,
  };
  rec.job = job;
  rec.events.push({ at: now, type: doc.generated ? `${kind}-generated` : `${kind}-edited` });
  // Approval covers specific documents — changing one requires approving again.
  if (rec.approval) {
    rec.approval = undefined;
    rec.events.push({ at: now, type: "approval-reset", note: `${kind} changed after approval` });
  }
  return saveApplication(rec);
}

// ── Submission flow (nothing here sends anything — the user applies on the employer's page) ──

export function approveApplication(jobId: string, verification: JobVerification, checklist: string[]): ApplicationRecord {
  const rec = getApplication(jobId);
  if (!rec?.cv) throw new FlowError("צריך לשמור קורות חיים מותאמים לפני אישור");
  if (rec.submission?.submitted_at) throw new FlowError("המועמדות כבר הוגשה");
  if (verification.status === "closed") throw new FlowError("המשרה סגורה — אי אפשר לאשר הגשה");
  const now = new Date().toISOString();
  rec.verification = verification;
  rec.approval = { at: now, checklist };
  rec.events.push({ at: now, type: "approved", note: `verification: ${verification.status}` });
  return saveApplication(rec);
}

export function markOpened(jobId: string): ApplicationRecord {
  const rec = getApplication(jobId);
  if (!rec?.approval) throw new FlowError("צריך לאשר לפני פתיחת דף ההגשה");
  const now = new Date().toISOString();
  rec.submission = { ...rec.submission, method: "manual", opened_at: now, apply_url: rec.job.apply_url || rec.job.url };
  rec.events.push({ at: now, type: "apply-page-opened" });
  return saveApplication(rec);
}

export function markSubmitted(jobId: string, evidence: string): ApplicationRecord {
  const rec = getApplication(jobId);
  if (!rec?.approval) throw new FlowError("צריך לאשר לפני סימון כהוגש");
  if (rec.submission?.submitted_at) return rec;
  const now = new Date().toISOString();
  rec.submission = { ...rec.submission, method: "manual", submitted_at: now, apply_url: rec.submission?.apply_url || rec.job.apply_url || rec.job.url };
  const ev = evidence.trim().slice(0, 4000);
  if (ev) rec.confirmation = { at: now, evidence: ev };
  rec.events.push({ at: now, type: "submitted", note: ev ? "with evidence" : "no evidence" });
  return saveApplication(rec);
}

// Mark submitted and move the job to "applied" in the tracker — never backwards
// from interview/offer/rejected. Shared by the web UI and Telegram.
export function recordSubmission(jobId: string, evidence: string): { application: ApplicationRecord; tracked: TrackedJob | null } {
  const application = markSubmitted(jobId, evidence);
  const t = addTracked(application.job);
  const tracked = t.status === "interested"
    ? updateTracked(t.id, { status: "applied", applied_at: application.submission!.submitted_at })
    : t;
  return { application, tracked };
}

// Attach evidence (reference number, confirmation email) after submitting.
export function addEvidence(jobId: string, evidence: string): ApplicationRecord {
  const rec = getApplication(jobId);
  if (!rec?.submission?.submitted_at) throw new FlowError("המועמדות עוד לא סומנה כהוגשה");
  const ev = evidence.trim().slice(0, 4000);
  if (!ev) throw new FlowError("הראיה ריקה");
  const now = new Date().toISOString();
  rec.confirmation = rec.confirmation
    ? { at: rec.confirmation.at, evidence: `${rec.confirmation.evidence}\n${ev}`.slice(0, 4000) }
    : { at: now, evidence: ev };
  rec.events.push({ at: now, type: "evidence-added" });
  return saveApplication(rec);
}

// Which profile + base CV generated documents belong to.
export function docContextFor(p: StoredProfile): { profileId: string; cvId: string | null } {
  const idx = Math.min(p.primary_cv_index || 0, Math.max(0, p.cvs.length - 1));
  return { profileId: p.id, cvId: p.cvs[idx]?.id ?? null };
}
