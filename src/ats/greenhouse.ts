import type { Job } from "../types.js";

export async function fetchGreenhouse(token: string, company: string): Promise<Job[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.jobs || []).map((j: any) => ({
    id: `gh-${token}-${j.id}`,
    title: j.title || "",
    location: j.location?.name || "—",
    department: j.departments?.[0]?.name || "—",
    description: j.content || "",
    url: j.absolute_url || "",
    company,
    ats: "greenhouse" as const,
    scanned_at: new Date().toISOString(),
  }));
}
