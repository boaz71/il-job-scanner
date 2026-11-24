import type { Job } from "../types.js";
import { fetchJson, toIso } from "./http.js";

export async function fetchAshby(token: string, company: string): Promise<Job[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${token}`;
  const data = await fetchJson(url);
  return (data.jobs || [])
    // No id → no stable identity across scans; unlisted → not publicly open.
    .filter((j: any) => j.id && j.isListed !== false)
    .map((j: any) => ({
      id: `ab-${token}-${j.id}`,
      title: j.title || "",
      location: j.location || "—",
      department: j.department || "—",
      description: j.descriptionPlain || j.descriptionHtml || "",
      url: j.jobUrl || "",
      apply_url: j.applyUrl || undefined,
      posted_at: toIso(j.publishedAt),
      company,
      ats: "ashby" as const,
      scanned_at: new Date().toISOString(),
    }));
}
