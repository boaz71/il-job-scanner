// Where each tracked job stands and what to do next — shared by the mentor's
// context and the tracker cards, so both give the same advice.
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { listTracked, type TrackedJob, type TrackedStatus } from "./tracker.js";
import { listApplications, type ApplicationRecord } from "./applications.js";
import { loadStatuses, effectiveStatus, type VerifyStatus } from "./verify.js";
import type { Job } from "./types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type FlowStage = "none" | "cv" | "approved" | "submitted";

export interface PipelineItem {
  id: string;
  title: string;
  company: string;
  status: TrackedStatus;
  stage: FlowStage;
  verification: VerifyStatus;
  days_since_applied: number | null;
  days_in_status: number;
  next_step: string | null;   // null when there's nothing to do (rejected)
}

const FOLLOWUP_AFTER_DAYS = 5;   // same threshold as the tracker card's follow-up hint
const SECOND_FOLLOWUP_DAYS = 14;

const daysSince = (iso: string | undefined, now: number) =>
  iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86400000)) : null;

function stageOf(app: ApplicationRecord | undefined): FlowStage {
  if (app?.submission?.submitted_at) return "submitted";
  if (app?.approval) return "approved";
  if (app?.cv) return "cv";
  return "none";
}

export function nextStep(item: Omit<PipelineItem, "next_step">): string | null {
  switch (item.status) {
    case "interested":
      if (item.verification === "closed") return "המשרה נסגרה — להסיר מהמעקב";
      if (item.stage === "none") return "להכין קו״ח מותאמים (🚀 הגשה)";
      if (item.stage === "cv") return "לסיים מכתב ולאשר הגשה";
      if (item.stage === "approved") return "להגיש באתר החברה ולסמן 'הגשתי'";
      return "לעדכן את הסטטוס במעקב ל'הגשתי'";
    case "applied": {
      const d = item.days_since_applied ?? 0;
      if (d < FOLLOWUP_AFTER_DAYS) return `לחכות לתשובה (follow-up בעוד ${FOLLOWUP_AFTER_DAYS - d} ימים)`;
      if (d < SECOND_FOLLOWUP_DAYS) return "לשלוח follow-up";
      return "follow-up נוסף, או לסמן כנדחה אם אין תשובה";
    }
    case "interview": return "להתכונן לראיון — הכנה + ראיון דמה";
    case "offer": return "להתכונן למו״מ שכר ולהחליט";
    case "rejected": return null;
  }
}

export function buildPipeline(
  tracked: TrackedJob[],
  apps: Map<string, ApplicationRecord>,
  verificationOf: (t: TrackedJob) => VerifyStatus,
  now = Date.now(),
): PipelineItem[] {
  const order: Record<TrackedStatus, number> = { offer: 0, interview: 1, applied: 2, interested: 3, rejected: 4 };
  return tracked
    .map((t) => {
      const base = {
        id: t.id,
        title: t.job.title,
        company: t.job.company,
        status: t.status,
        stage: stageOf(apps.get(t.id)),
        verification: verificationOf(t),
        days_since_applied: daysSince(t.applied_at, now),
        days_in_status: daysSince(t.history.at(-1)?.at ?? t.added_at, now) ?? 0,
      };
      return { ...base, next_step: nextStep(base) };
    })
    .sort((a, b) => order[a.status] - order[b.status] || b.days_in_status - a.days_in_status);
}

// Compact text for the mentor's system prompt (capped — the prompt must stay small).
export function pipelineForPrompt(items: PipelineItem[], max = 15): string {
  const active = items.filter((i) => i.next_step);
  if (!active.length) return "אין משרות פעילות בתהליך.";
  const lines = active.slice(0, max).map((i) => {
    const parts = [`${i.title} @ ${i.company}`, i.status];
    if (i.days_since_applied !== null) parts.push(`${i.days_since_applied} ימים מאז הגשה`);
    else parts.push(`${i.days_in_status} ימים בסטטוס`);
    if (i.verification === "closed") parts.push("המשרה נסגרה");
    return `- ${parts.join(" · ")} → ${i.next_step}`;
  });
  if (active.length > max) lines.push(`- ...ועוד ${active.length - max} משרות`);
  return lines.join("\n");
}

// Tracked jobs with their flow stage, verification and next step, from the data files.
export function loadPipeline(): PipelineItem[] {
  const stored = loadStatuses();
  // Same source as the web UI: scored jobs, or the raw scan when nothing was scored yet.
  const scored = resolve(ROOT, "data/scored-jobs.json");
  const path = existsSync(scored) ? scored : resolve(ROOT, "data/jobs.json");
  let currentJobs: Job[] = [];
  try { if (existsSync(path)) currentJobs = JSON.parse(readFileSync(path, "utf-8")); } catch {}
  const current = new Map(currentJobs.map((j) => [j.id, j]));
  const apps = new Map(listApplications().map((a) => [a.job_id, a]));
  return buildPipeline(listTracked(), apps, (t) => {
    const cur = current.get(t.id);
    return effectiveStatus(cur ?? t.job, stored[t.id], !!cur).status;
  });
}
