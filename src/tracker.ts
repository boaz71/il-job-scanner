import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Job, ScoredJob } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FILE = resolve(ROOT, "data/tracked-jobs.json");

export type TrackedStatus = "interested" | "applied" | "interview" | "offer" | "rejected";

export interface TrackedJob {
  id: string;            // job.id
  job: Job | ScoredJob;  // snapshot
  status: TrackedStatus;
  added_at: string;
  applied_at?: string;
  notes: string;
  history: { at: string; from: TrackedStatus | null; to: TrackedStatus }[];
}

function ensure() {
  const dir = resolve(ROOT, "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(FILE)) writeFileSync(FILE, "[]", "utf-8");
}

export function listTracked(): TrackedJob[] {
  ensure();
  return JSON.parse(readFileSync(FILE, "utf-8"));
}

function save(items: TrackedJob[]) {
  ensure();
  writeFileSync(FILE, JSON.stringify(items, null, 2), "utf-8");
}

export function addTracked(job: Job | ScoredJob): TrackedJob {
  const items = listTracked();
  const existing = items.find((t) => t.id === job.id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const t: TrackedJob = {
    id: job.id, job,
    status: "interested",
    added_at: now,
    notes: "",
    history: [{ at: now, from: null, to: "interested" }],
  };
  items.push(t);
  save(items);
  return t;
}

export function updateTracked(id: string, patch: Partial<Pick<TrackedJob, "status" | "notes" | "applied_at">>): TrackedJob | null {
  const items = listTracked();
  const t = items.find((x) => x.id === id);
  if (!t) return null;
  if (patch.status && patch.status !== t.status) {
    t.history.push({ at: new Date().toISOString(), from: t.status, to: patch.status });
    if (patch.status === "applied" && !t.applied_at) t.applied_at = new Date().toISOString();
    t.status = patch.status;
  }
  if (patch.notes !== undefined) t.notes = patch.notes;
  if (patch.applied_at !== undefined) t.applied_at = patch.applied_at;
  save(items);
  return t;
}

export function removeTracked(id: string): boolean {
  const items = listTracked();
  const next = items.filter((x) => x.id !== id);
  if (next.length === items.length) return false;
  save(next);
  return true;
}

export function isTracked(id: string): boolean {
  return listTracked().some((t) => t.id === id);
}
