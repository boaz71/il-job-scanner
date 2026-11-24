// Jobs the user marked "not relevant" (from Telegram). Hidden from the job list by default.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FILE = resolve(ROOT, "data/hidden-jobs.json");

export function listHidden(): Record<string, string> {   // jobId → hidden_at
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, "utf-8")); } catch { return {}; }
}

function save(map: Record<string, string>) {
  const dir = dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify(map, null, 2), "utf-8");
}

export function hideJob(jobId: string): void {
  const map = listHidden();
  if (!map[jobId]) { map[jobId] = new Date().toISOString(); save(map); }
}

export function unhideJob(jobId: string): boolean {
  const map = listHidden();
  if (!map[jobId]) return false;
  delete map[jobId];
  save(map);
  return true;
}
