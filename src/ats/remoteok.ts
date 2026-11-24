import type { Job } from "../types.js";
import { fetchJson, toIso } from "./http.js";

/**
 * RemoteOK — public API for remote tech jobs.
 * https://remoteok.com/api
 * The first item in the response is metadata, so we skip it.
 *
 * `tag` is optional, e.g. "javascript", "react", "backend", "fullstack".
 */
export async function fetchRemoteOK(tag: string, label: string): Promise<Job[]> {
  const url = tag && tag !== "all"
    ? `https://remoteok.com/api?tag=${encodeURIComponent(tag)}`
    : "https://remoteok.com/api";
  const data = await fetchJson(url, {
    headers: { "User-Agent": "il-job-scanner/1.0 (+local)" },
  });
  if (!Array.isArray(data)) return [];
  // Skip the first metadata entry
  // Without id/slug there is no stable identity across scans — skip.
  const jobs = data.slice(1).filter((j: any) => j.id || j.slug);

  return jobs.map((j: any) => ({
    id: `rok-${j.id || j.slug}`,
    title: j.position || j.title || "",
    location: j.location || "Worldwide",
    department: Array.isArray(j.tags) ? j.tags.slice(0, 4).join(", ") : "—",
    description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 4000),
    url: j.url || (j.id ? `https://remoteok.com/remote-jobs/${j.id}` : ""),
    apply_url: j.apply_url || undefined,
    posted_at: toIso(j.epoch ?? j.date),
    company: j.company || "—",
    ats: "remoteok" as const,
    scanned_at: new Date().toISOString(),
  }));
}
