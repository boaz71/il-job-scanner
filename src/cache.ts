import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CACHE_DIR = resolve(ROOT, "data/cache");

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days default
const TTL_SEARCH_MS = 2 * 24 * 60 * 60 * 1000; // 2 days for web-search results

function ensure() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function hashKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

export function getCached(type: string, ...keyParts: string[]): string | null {
  ensure();
  const key = hashKey([type, ...keyParts]);
  const path = resolve(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    const ttl = data.webSearch ? TTL_SEARCH_MS : TTL_MS;
    if (Date.now() - data.created > ttl) {
      unlinkSync(path);
      return null;
    }
    return data.content;
  } catch {
    return null;
  }
}

export function setCache(type: string, content: string, webSearch: boolean, ...keyParts: string[]): void {
  ensure();
  const key = hashKey([type, ...keyParts]);
  const path = resolve(CACHE_DIR, `${key}.json`);
  writeFileSync(path, JSON.stringify({
    type,
    created: Date.now(),
    webSearch,
    content,
  }), "utf-8");
}

export function getCacheStats(): { entries: number; sizeKB: number } {
  ensure();
  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith(".json"));
  let totalSize = 0;
  for (const f of files) {
    try { totalSize += statSync(resolve(CACHE_DIR, f)).size; } catch {}
  }
  return { entries: files.length, sizeKB: Math.round(totalSize / 1024) };
}

export function clearCache(): number {
  ensure();
  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith(".json"));
  for (const f of files) {
    try { unlinkSync(resolve(CACHE_DIR, f)); } catch {}
  }
  return files.length;
}
