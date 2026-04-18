import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Job, Profile, ScoredJob } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Build a word-boundary regex for a technical term.
// Handles dots (.NET), hashes (C#), pluses (C++), and spaces.
function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Left: must be start-of-string or non-word (but allow dot inside for things like ".net")
  // Right: must be end or non-word char
  const left = /^[\w]/.test(term) ? "(?:^|[^\\w.#+])" : "(?:^|[^\\w])";
  const right = /[\w]$/.test(term) ? "(?:$|[^\\w.#+])" : "(?:$|[^\\w])";
  return new RegExp(`${left}${escaped}${right}`, "i");
}

function hits(text: string, term: string): boolean {
  return termRegex(term).test(text);
}

export function scoreJob(job: Job, p: Profile): ScoredJob {
  return score(job, p);
}

export function matchJobs(jobs: Job[], profile: Profile, minScore: number = 0): ScoredJob[] {
  return jobs
    .map((j) => score(j, profile))
    .filter((j) => j.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

function score(job: Job, p: Profile): ScoredJob {
  let s = 0;
  const reasons: string[] = [];
  const title = job.title;
  const body = `${job.department} ${job.description}`;
  const full = `${title} ${body}`;

  // Primary skills: +20 if in title, +12 if only in body
  for (const sk of p.skills.primary) {
    if (hits(title, sk)) { s += 20; reasons.push(`✓ ${sk}`); }
    else if (hits(body, sk)) { s += 12; reasons.push(`✓ ${sk}`); }
  }
  // Secondary: +8 (body or title)
  for (const sk of p.skills.secondary) {
    if (hits(full, sk)) { s += 8; reasons.push(`~ ${sk}`); }
  }
  // Interests: +4
  for (const sk of p.skills.interested_in) {
    if (hits(full, sk)) { s += 4; reasons.push(`★ ${sk}`); }
  }
  // Keywords boost: +10 in title, +5 in body
  for (const kw of p.keywords_boost) {
    if (hits(title, kw)) { s += 10; reasons.push(`↑ ${kw}`); }
    else if (hits(body, kw)) { s += 5; }
  }
  // Excludes: hard penalty if in title
  for (const kw of p.keywords_exclude) {
    if (hits(title, kw)) { s -= 50; reasons.push(`✗ ${kw}`); }
  }

  const loc = job.location.toLowerCase();
  const isRemoteSource = job.ats === "remotive" || job.ats === "remoteok";
  if (p.location.preferred.some((l) => loc.includes(l.toLowerCase()))) {
    s += 15; reasons.push("📍 מיקום");
  } else if ((loc.includes("remote") || loc.includes("worldwide") || isRemoteSource) && p.location.remote_ok) {
    s += 12; reasons.push("🌐 Remote");
  } else if (loc) {
    s -= 10;
  }

  // Normalize to 0-100 with soft curve (80+ is really good)
  const raw = Math.max(-50, s);
  const normalized = raw <= 0 ? 0 : Math.min(100, Math.round(raw * 0.9));

  const grade: ScoredJob["grade"] =
    normalized >= 75 ? "A" :
    normalized >= 55 ? "B" :
    normalized >= 35 ? "C" :
    normalized >= 15 ? "D" : "F";

  return { ...job, score: normalized, grade, reasons };
}

// ── Colors ──
const C: Record<string, string> = { A: "\x1b[32m", B: "\x1b[36m", C: "\x1b[33m", D: "\x1b[90m", F: "\x1b[31m" };
const R = "\x1b[0m";

async function main() {
  const profile: Profile = JSON.parse(readFileSync(resolve(ROOT, "profile.json"), "utf-8"));
  const jobs: Job[] = JSON.parse(readFileSync(resolve(ROOT, "data/jobs.json"), "utf-8"));

  console.log(`\n🎯  מחשב התאמה ל-${jobs.length} משרות עבור ${profile.name}\n`);

  const scored = jobs
    .map((j) => score(j, profile))
    .filter((j) => j.score >= profile.min_match_score)
    .sort((a, b) => b.score - a.score);

  writeFileSync(resolve(ROOT, "data/scored-jobs.json"), JSON.stringify(scored, null, 2));

  console.log(`  נמצאו ${scored.length} משרות עם ציון ${profile.min_match_score}+\n`);
  console.log("─".repeat(60));

  scored.slice(0, 25).forEach((j) => {
    const c = C[j.grade] || "";
    console.log(`  ${c}[${j.grade}] ${String(j.score).padStart(3)}${R}  ${j.title}`);
    console.log(`       ${j.company} · ${j.location} · ${j.department}`);
    if (j.reasons.length) console.log(`       ${j.reasons.join("  ")}`);
    console.log(`       ${j.url}\n`);
  });

  // Summary
  const g: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  scored.forEach((j) => g[j.grade]++);
  console.log("─".repeat(60));
  console.log(`  📊  A: ${g.A}  |  B: ${g.B}  |  C: ${g.C}  |  D: ${g.D}`);
  console.log("─".repeat(60) + "\n");
}

const isMain = process.argv[1]?.endsWith("matcher.ts");
if (isMain) main().catch(console.error);
