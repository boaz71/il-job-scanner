import type { Job } from "../types.js";

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
  const res = await fetch(url, {
    headers: { "User-Agent": "il-job-scanner/1.0 (+local)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  // Skip the first metadata entry
  const jobs = data.slice(1);

  return jobs.map((j: any) => ({
    id: `rok-${j.id || j.slug || Math.random().toString(36).slice(2)}`,
    title: j.position || j.title || "",
    location: j.location || "Worldwide",
    department: Array.isArray(j.tags) ? j.tags.slice(0, 4).join(", ") : "—",
    description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 4000),
    url: j.url || (j.id ? `https://remoteok.com/remote-jobs/${j.id}` : ""),
    company: j.company || "—",
    ats: "remoteok" as const,
    scanned_at: new Date().toISOString(),
  }));
}
