// Application record per job — what was prepared and sent, with which profile/CV.
// One file per job in data/applications/ (keeps tracked-jobs.json small, and a
// write to one application never rewrites the others).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import type { Job } from "./types.js";
import type { JobVerification } from "./verify.js";

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
  return saveApplication(rec);
}
