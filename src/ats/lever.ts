import type { Job } from "../types.js";

export async function fetchLever(token: string, company: string): Promise<Job[]> {
  const url = `https://api.lever.co/v0/postings/${token}?mode=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((j: any) => ({
    id: `lv-${token}-${j.id}`,
    title: j.text || "",
    location: j.categories?.location || "—",
    department: j.categories?.team || j.categories?.department || "—",
    description: j.descriptionPlain || "",
    url: j.hostedUrl || "",
    company,
    ats: "lever" as const,
    scanned_at: new Date().toISOString(),
  }));
}
