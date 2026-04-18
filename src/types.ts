export type AtsType = "greenhouse" | "lever" | "ashby" | "remotive" | "remoteok";

export interface Company {
  name: string;
  ats: AtsType;
  token: string;
  hq: string;
  sector: string;
}

export interface Job {
  id: string;
  title: string;
  location: string;
  department: string;
  description: string;
  url: string;
  company: string;
  ats: AtsType;
  scanned_at: string;
  is_new?: boolean;
  is_restored?: boolean;
  restored_from?: string;   // scan id
  restored_at?: string;     // ISO timestamp
}

export interface ScoredJob extends Job {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  reasons: string[];
}

export interface Profile {
  name: string;
  title: string;
  skills: { primary: string[]; secondary: string[]; interested_in: string[] };
  experience_years: number;
  location: { preferred: string[]; remote_ok: boolean };
  job_types: string[];
  keywords_boost: string[];
  keywords_exclude: string[];
  min_match_score: number;
}
