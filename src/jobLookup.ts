// Find a job by id wherever it still exists — so per-job features keep working
// after a job drops out of the latest scan (closed, filtered, below min score).
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Job } from "./types.js";
import { listTracked } from "./tracker.js";
import { listScans, getScan } from "./scans.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// current: scored-jobs.json (has score/grade) · scan: raw jobs.json (e.g. below min score)
// tracked: the tracker's snapshot · archive: newest archived scan that has it
export type JobSource = "current" | "scan" | "tracked" | "archive";

function readJobs(rel: string): Job[] {
  const path = resolve(ROOT, rel);
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return []; }
}

export function resolveJob(jobId: unknown): { job: Job; source: JobSource } | null {
  if (typeof jobId !== "string" || !jobId) return null;

  const scored = readJobs("data/scored-jobs.json").find((j) => j.id === jobId);
  if (scored) return { job: scored, source: "current" };
  const raw = readJobs("data/jobs.json").find((j) => j.id === jobId);
  if (raw) return { job: raw, source: "scan" };
  const tracked = listTracked().find((t) => t.id === jobId);
  if (tracked) return { job: tracked.job, source: "tracked" };

  for (const s of listScans()) {
    const hit = getScan(s.id)?.jobs.find((j) => j.id === jobId);
    if (hit) return { job: hit, source: "archive" };
  }
  return null;
}
