import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FILE = resolve(ROOT, "data/mentor.json");

export interface MentorGoal {
  target_role: string;            // e.g. "Senior AI Engineer at FAANG"
  target_salary_monthly?: number; // ILS
  target_timeline_months: number; // 3, 6, 12...
  current_obstacles: string;
  commitments_per_week: string;   // free text: "10 hours study, 5 applications"
  why: string;                    // motivation
}

export interface MentorMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface MentorCheckin {
  at: string;
  summary: string;
}

export interface MentorState {
  goal: MentorGoal | null;
  conversations: MentorMessage[];
  checkins: MentorCheckin[];
  created_at: string;
  updated_at: string;
}

const DEFAULT: MentorState = {
  goal: null,
  conversations: [],
  checkins: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function ensure() {
  const dir = resolve(ROOT, "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadMentor(): MentorState {
  ensure();
  if (!existsSync(FILE)) return { ...DEFAULT };
  try {
    return { ...DEFAULT, ...JSON.parse(readFileSync(FILE, "utf-8")) };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveMentor(s: MentorState): void {
  ensure();
  s.updated_at = new Date().toISOString();
  writeFileSync(FILE, JSON.stringify(s, null, 2), "utf-8");
}

export function setGoal(goal: MentorGoal): MentorState {
  const s = loadMentor();
  s.goal = goal;
  saveMentor(s);
  return s;
}

export function addMessage(role: "user" | "assistant", content: string): MentorState {
  const s = loadMentor();
  s.conversations.push({ role, content, at: new Date().toISOString() });
  // Keep only last 30 messages
  if (s.conversations.length > 30) s.conversations = s.conversations.slice(-30);
  saveMentor(s);
  return s;
}

export function clearConversations(): void {
  const s = loadMentor();
  s.conversations = [];
  saveMentor(s);
}

export function addCheckin(summary: string): void {
  const s = loadMentor();
  s.checkins.push({ at: new Date().toISOString(), summary });
  if (s.checkins.length > 50) s.checkins = s.checkins.slice(-50);
  saveMentor(s);
}
