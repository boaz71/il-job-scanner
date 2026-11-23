// Shared HTTP helper for ATS adapters — one place for timeout + error shape.

const DEFAULT_TIMEOUT_MS = 20_000;

export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    if (e?.name === "TimeoutError") throw new Error(`timeout after ${timeoutMs / 1000}s`);
    throw e;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Normalize a date-ish API value (ISO string / epoch ms / epoch s) to ISO, or undefined.
export function toIso(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  let d: Date;
  if (typeof v === "number") d = new Date(v < 1e12 ? v * 1000 : v);
  else d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}
