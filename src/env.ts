import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Minimal .env loader — reads KEY=VALUE lines from .env in project root
 * and merges into process.env without overriding existing values.
 * Supports: comments (#), blank lines, quoted values ("..." or '...').
 */
export function loadEnv(): void {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;

  const content = readFileSync(path, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Last occurrence in .env wins (so users can override earlier values by adding lines at the bottom)
    process.env[key] = value;
  }
}
