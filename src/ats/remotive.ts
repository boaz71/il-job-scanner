import type { Job } from "../types.js";

/**
 * Remotive — public API for global remote jobs.
 * https://remotive.com/api/remote-jobs
 *
 * `category` is one of:
 *   software-dev, customer-support, design, marketing, sales,
 *   data, devops-sysadmin, finance-legal, hr, qa, writing, product, etc.
 * Pass empty string for ALL.
 */
export async function fetchRemotive(category: string, label: string): Promise<Job[]> {
  const url = category && category !== "all"
    ? `https://remotive.com/api/remote-jobs?category=${encodeURIComponent(category)}`
    : "https://remotive.com/api/remote-jobs";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const jobs = data.jobs || [];
  return jobs.map((j: any) => ({
    id: `rmt-${j.id}`,
    title: j.title || "",
    location: j.candidate_required_location || "Worldwide",
    department: j.category || "—",
    description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 4000),
    url: j.url || "",
    company: j.company_name || "—",
    ats: "remotive" as const,
    scanned_at: new Date().toISOString(),
  }));
}
