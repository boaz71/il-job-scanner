import type { Job } from "../types.js";

export async function fetchAshby(token: string, company: string): Promise<Job[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.jobs || []).map((j: any, i: number) => ({
    id: `ab-${token}-${j.id || i}`,
    title: j.title || "",
    location: j.location || "—",
    department: j.department || "—",
    description: j.descriptionPlain || j.descriptionHtml || "",
    url: j.jobUrl || "",
    company,
    ats: "ashby" as const,
    scanned_at: new Date().toISOString(),
  }));
}
