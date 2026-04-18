import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Job, ScoredJob } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCANS_DIR = resolve(ROOT, "data/scans");

export interface ScanRecord {
  id: string;                  // ISO-like timestamp
  scanned_at: string;
  total_jobs: number;
  companies_scanned: number;
  errors: number;
  filters?: { keyword?: string; location?: string };
  jobs: Job[];
}

function ensureDir() {
  if (!existsSync(SCANS_DIR)) mkdirSync(SCANS_DIR, { recursive: true });
}

export function archiveScan(record: Omit<ScanRecord, "id">): string {
  ensureDir();
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const full: ScanRecord = { id, ...record };
  writeFileSync(resolve(SCANS_DIR, `${id}.json`), JSON.stringify(full, null, 2), "utf-8");
  return id;
}

export function listScans(): { id: string; scanned_at: string; total_jobs: number; companies_scanned: number; errors: number }[] {
  ensureDir();
  return readdirSync(SCANS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const r = JSON.parse(readFileSync(resolve(SCANS_DIR, f), "utf-8")) as ScanRecord;
        return {
          id: r.id,
          scanned_at: r.scanned_at,
          total_jobs: r.total_jobs,
          companies_scanned: r.companies_scanned,
          errors: r.errors,
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.scanned_at.localeCompare(a.scanned_at));
}

export function getScan(id: string): ScanRecord | null {
  ensureDir();
  const path = resolve(SCANS_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as ScanRecord;
}

export function deleteScan(id: string): boolean {
  ensureDir();
  const path = resolve(SCANS_DIR, `${id}.json`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
