import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { ScoredJob } from "./types.js";
import { listScans } from "./scans.js";
import { listTracked, type TrackedStatus } from "./tracker.js";
import { listProfiles } from "./profiles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export interface DashboardStats {
  totals: {
    scans: number;
    profiles: number;
    tracked_jobs: number;
    current_jobs: number;
  };
  scoring: {
    avg_score: number;
    grade_distribution: Record<string, number>;
  };
  by_status: Record<TrackedStatus, number>;
  by_source: Record<string, number>;
  top_companies: { company: string; count: number }[];
  recent_scans: { id: string; scanned_at: string; total_jobs: number }[];
  applications_timeline: { date: string; count: number }[];
}

export function buildStats(): DashboardStats {
  const scans = listScans();
  const tracked = listTracked();
  const profiles = listProfiles();

  let currentJobs: ScoredJob[] = [];
  const path = resolve(ROOT, "data/scored-jobs.json");
  if (existsSync(path)) {
    try { currentJobs = JSON.parse(readFileSync(path, "utf-8")); } catch {}
  }

  const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  let scoreSum = 0;
  for (const j of currentJobs) {
    grades[j.grade || "F"] = (grades[j.grade || "F"] || 0) + 1;
    scoreSum += j.score || 0;
  }

  const byStatus: Record<TrackedStatus, number> = {
    interested: 0, applied: 0, interview: 0, offer: 0, rejected: 0,
  };
  for (const t of tracked) byStatus[t.status]++;

  const bySource: Record<string, number> = {};
  for (const j of currentJobs) {
    bySource[j.ats] = (bySource[j.ats] || 0) + 1;
  }

  const companyCounts: Record<string, number> = {};
  for (const j of currentJobs) {
    companyCounts[j.company] = (companyCounts[j.company] || 0) + 1;
  }
  const topCompanies = Object.entries(companyCounts)
    .map(([company, count]) => ({ company, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const timeline: Record<string, number> = {};
  for (const t of tracked) {
    if (t.applied_at) {
      const day = t.applied_at.slice(0, 10);
      timeline[day] = (timeline[day] || 0) + 1;
    }
  }
  const appsTimeline = Object.entries(timeline)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);

  return {
    totals: {
      scans: scans.length,
      profiles: profiles.length,
      tracked_jobs: tracked.length,
      current_jobs: currentJobs.length,
    },
    scoring: {
      avg_score: currentJobs.length ? Math.round(scoreSum / currentJobs.length) : 0,
      grade_distribution: grades,
    },
    by_status: byStatus,
    by_source: bySource,
    top_companies: topCompanies,
    recent_scans: scans.slice(0, 5).map((s) => ({
      id: s.id, scanned_at: s.scanned_at, total_jobs: s.total_jobs,
    })),
    applications_timeline: appsTimeline,
  };
}
