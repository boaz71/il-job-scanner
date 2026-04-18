import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchGreenhouse } from "./ats/greenhouse.js";
import { fetchLever } from "./ats/lever.js";
import { fetchAshby } from "./ats/ashby.js";
import { fetchRemotive } from "./ats/remotive.js";
import { fetchRemoteOK } from "./ats/remoteok.js";
import { archiveScan } from "./scans.js";
import { markNewJobs } from "./automation.js";
import type { Company, Job } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export function loadCompanies(): Company[] {
  return JSON.parse(readFileSync(resolve(ROOT, "companies.json"), "utf-8")).companies;
}

async function fetchJobs(c: Company): Promise<Job[]> {
  switch (c.ats) {
    case "greenhouse": return fetchGreenhouse(c.token, c.name);
    case "lever": return fetchLever(c.token, c.name);
    case "ashby": return fetchAshby(c.token, c.name);
    case "remotive": return fetchRemotive(c.token, c.name);
    case "remoteok": return fetchRemoteOK(c.token, c.name);
  }
}

export interface ScanOptions {
  keyword?: string;
  location?: string;
  archive?: boolean;        // also save to data/scans/<id>.json
  onProgress?: (msg: string) => void;
}

export interface ScanResult {
  jobs: Job[];
  total_jobs: number;
  companies_scanned: number;
  errors: string[];
  archive_id?: string;
  scanned_at: string;
}

export async function runScan(opts: ScanOptions = {}): Promise<ScanResult> {
  const log = opts.onProgress || (() => {});
  const companies = loadCompanies();
  const allJobs: Job[] = [];
  const errors: string[] = [];

  for (let i = 0; i < companies.length; i += 4) {
    const batch = companies.slice(i, i + 4);
    await Promise.all(batch.map(async (c) => {
      try {
        const jobs = await fetchJobs(c);
        allJobs.push(...jobs);
        log(`✅ ${c.name}: ${jobs.length} משרות`);
      } catch (e: any) {
        errors.push(c.name);
        log(`❌ ${c.name}: ${e.message.slice(0, 50)}`);
      }
    }));
  }

  // Filter
  let filtered = allJobs;
  if (opts.keyword) {
    const kw = opts.keyword.toLowerCase();
    filtered = filtered.filter((j) =>
      `${j.title} ${j.department} ${j.description}`.toLowerCase().includes(kw)
    );
  }
  if (opts.location) {
    const loc = opts.location.toLowerCase();
    filtered = filtered.filter((j) => j.location.toLowerCase().includes(loc));
  }

  // Mark new jobs (those not seen in any previous scan)
  filtered = markNewJobs(filtered);

  // Save current
  const dataDir = resolve(ROOT, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(resolve(dataDir, "jobs.json"), JSON.stringify(filtered, null, 2));

  const scannedAt = new Date().toISOString();
  writeFileSync(resolve(dataDir, "scan-results.json"), JSON.stringify({
    scanned_at: scannedAt,
    total: allJobs.length,
    filtered: filtered.length,
    errors: errors.length,
    companies: companies.length,
  }, null, 2));

  // Archive
  let archiveId: string | undefined;
  if (opts.archive) {
    archiveId = archiveScan({
      scanned_at: scannedAt,
      total_jobs: filtered.length,
      companies_scanned: companies.length - errors.length,
      errors: errors.length,
      filters: { keyword: opts.keyword, location: opts.location },
      jobs: filtered,
    });
  }

  return {
    jobs: filtered,
    total_jobs: allJobs.length,
    companies_scanned: companies.length,
    errors,
    archive_id: archiveId,
    scanned_at: scannedAt,
  };
}

// ── CLI entry ──
async function cli() {
  const args = process.argv.slice(2);
  let keyword: string | undefined;
  let location: string | undefined;
  let addUrl: string | undefined;
  let archive = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--keyword") keyword = args[++i];
    if (args[i] === "--location") location = args[++i];
    if (args[i] === "--add") addUrl = args[++i];
    if (args[i] === "--archive") archive = true;
  }

  if (addUrl) {
    let ats: string | null = null;
    let token: string | null = null;
    if (addUrl.includes("greenhouse.io")) {
      ats = "greenhouse";
      token = addUrl.match(/greenhouse\.io\/(?:embed\/job_board\?for=)?([a-zA-Z0-9_-]+)/)?.[1] || null;
    } else if (addUrl.includes("lever.co")) {
      ats = "lever";
      token = addUrl.match(/lever\.co\/([a-zA-Z0-9_-]+)/)?.[1] || null;
    } else if (addUrl.includes("ashbyhq.com")) {
      ats = "ashby";
      token = addUrl.match(/ashbyhq\.com\/([a-zA-Z0-9_-]+)/)?.[1] || null;
    }
    if (!ats || !token) {
      console.error("\n❌ לא זוהה ATS\n");
      process.exit(1);
    }
    const path = resolve(ROOT, "companies.json");
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (data.companies.find((c: any) => c.token === token && c.ats === ats)) {
      console.log(`\n⚠️  ${token} כבר ברשימה\n`);
    } else {
      data.companies.push({ name: token, ats, token, hq: "—", sector: "—" });
      writeFileSync(path, JSON.stringify(data, null, 2));
      console.log(`\n✅ נוסף: ${token}\n`);
    }
    process.exit(0);
  }

  console.log("\n🇮🇱  סורק משרות מחברות טק ישראליות\n" + "─".repeat(55));
  const result = await runScan({
    keyword, location, archive,
    onProgress: (m) => console.log("  " + m),
  });
  console.log("─".repeat(55));
  console.log(`  📊  משרות: ${result.jobs.length}  |  שגיאות: ${result.errors.length}`);
  if (result.archive_id) console.log(`  🗄️  ארכיון: ${result.archive_id}`);
  console.log("─".repeat(55) + "\n");
}

// Only run CLI if invoked directly (not when imported)
const isMain = import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`
  || process.argv[1]?.endsWith("scanner.ts");
if (isMain) cli().catch(console.error);
