import type { Job } from "../types.js";
import { fetchJson, toIso } from "./http.js";

export async function fetchGreenhouse(token: string, company: string): Promise<Job[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
  const data = await fetchJson(url);
  return (data.jobs || []).map((j: any) => ({
    id: `gh-${token}-${j.id}`,
    title: j.title || "",
    location: j.location?.name || "—",
    department: j.departments?.[0]?.name || "—",
    description: j.content || "",
    url: j.absolute_url || "",
    apply_url: j.absolute_url || undefined,
    posted_at: toIso(j.first_published),
    updated_at: toIso(j.updated_at),
    company,
    ats: "greenhouse" as const,
    scanned_at: new Date().toISOString(),
  }));
}
