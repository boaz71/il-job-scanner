import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Profile } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PROFILES_DIR = resolve(ROOT, "data/profiles");
const ACTIVE_FILE = resolve(PROFILES_DIR, "_active.json");

// ── Multi-CV support ──
export interface ProfileCV {
  id: string;
  filename: string;
  text: string;
  label: string;          // e.g. "קו\"ח עברית", "English CV", "Short version"
  added_at: string;
}

export interface StoredProfile {
  id: string;
  label: string;
  created_at: string;
  avatar?: string;              // base64 data URI
  cvs: ProfileCV[];             // all CVs
  primary_cv_index: number;     // which CV is used for matching
  profile: Profile;
  insights?: ProfileInsights;

  // Legacy fields — auto-migrated on load
  cv_filename?: string;
  cv_text?: string;
}

export interface ProfileInsights {
  market_score: number;
  level: string;
  estimated_salary: {
    monthly_min: number;
    monthly_max: number;
    note: string;
  };
  suggested_roles: { title: string; salary_range: string }[];
  strengths: string[];
  gaps: string[];
  hot_skills_in_profile: string[];
  market_summary: string;
}

function ensureDir() {
  if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true });
}

function slug(s: string): string {
  return s.toLowerCase()
    .replace(/[^\w\u0590-\u05ff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "profile";
}

// Auto-migrate old single-CV profiles to multi-CV format
function migrateProfile(p: StoredProfile): StoredProfile {
  if (p.cvs && p.cvs.length > 0) return p; // already migrated

  p.cvs = [];
  p.primary_cv_index = 0;

  if (p.cv_text) {
    p.cvs.push({
      id: "cv-" + Date.now().toString(36),
      filename: p.cv_filename || "cv.txt",
      text: p.cv_text,
      label: "קו\"ח ראשי",
      added_at: p.created_at,
    });
  }
  return p;
}

// Get the primary CV text from a profile
export function getPrimaryCVText(p: StoredProfile): string {
  if (!p.cvs?.length) return p.cv_text || "";
  const idx = Math.min(p.primary_cv_index || 0, p.cvs.length - 1);
  return p.cvs[idx].text;
}

export function listProfiles(): StoredProfile[] {
  ensureDir();
  return readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => {
      try {
        const raw = JSON.parse(readFileSync(resolve(PROFILES_DIR, f), "utf-8")) as StoredProfile;
        const migrated = migrateProfile(raw);
        // Save migration if needed
        if (!raw.cvs || raw.cvs.length === 0) {
          writeFileSync(resolve(PROFILES_DIR, f), JSON.stringify(migrated, null, 2), "utf-8");
        }
        return migrated;
      } catch {
        return null;
      }
    })
    .filter((x): x is StoredProfile => x !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function getProfile(id: string): StoredProfile | null {
  ensureDir();
  const path = resolve(PROFILES_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8")) as StoredProfile;
  return migrateProfile(raw);
}

export function saveStoredProfile(p: StoredProfile): void {
  ensureDir();
  writeFileSync(resolve(PROFILES_DIR, `${p.id}.json`), JSON.stringify(p, null, 2), "utf-8");
}

export function deleteProfile(id: string): boolean {
  ensureDir();
  const path = resolve(PROFILES_DIR, `${id}.json`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  if (getActiveId() === id) {
    const remaining = listProfiles();
    setActive(remaining[0]?.id || null);
  }
  return true;
}

export function getActiveId(): string | null {
  ensureDir();
  if (!existsSync(ACTIVE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(ACTIVE_FILE, "utf-8")).id || null;
  } catch {
    return null;
  }
}

export function setActive(id: string | null): void {
  ensureDir();
  writeFileSync(ACTIVE_FILE, JSON.stringify({ id }), "utf-8");
}

export function getActiveProfile(): StoredProfile | null {
  const id = getActiveId();
  if (!id) return null;
  return getProfile(id);
}

export function newProfileId(label: string): string {
  return `${slug(label)}-${Date.now().toString(36)}`;
}

export function newCVId(): string {
  return "cv-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// Sync the active profile to the legacy single-file locations
export function syncActiveToLegacy(): void {
  const active = getActiveProfile();
  if (!active) return;
  writeFileSync(resolve(ROOT, "profile.json"), JSON.stringify(active.profile, null, 2), "utf-8");
  if (!existsSync(resolve(ROOT, "data"))) mkdirSync(resolve(ROOT, "data"), { recursive: true });
  writeFileSync(resolve(ROOT, "data/cv.txt"), getPrimaryCVText(active), "utf-8");
}
