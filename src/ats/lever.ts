import type { Job } from "../types.js";
import { fetchJson, toIso } from "./http.js";

export async function fetchLever(token: string, company: string): Promise<Job[]> {
  const url = `https://api.lever.co/v0/postings/${token}?mode=json`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) return [];
  return data.map((j: any) => ({
    id: `lv-${token}-${j.id}`,
    title: j.text || "",
    location: j.categories?.location || "—",
    department: j.categories?.team || j.categories?.department || "—",
    description: j.descriptionPlain || "",
    url: j.hostedUrl || "",
    apply_url: j.applyUrl || undefined,
    posted_at: toIso(j.createdAt),
    company,
    ats: "lever" as const,
    scanned_at: new Date().toISOString(),
  }));
}
