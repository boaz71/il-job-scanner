import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FILE = resolve(ROOT, "data/costs.json");

// Approximate token costs ($/1M tokens) — Anthropic pricing 2026
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5":  { input: 3, output: 15 },
  "claude-sonnet-4-6":  { input: 3, output: 15 },
  "claude-haiku-3-5":   { input: 0.8, output: 4 },
  "claude-haiku-3.5":   { input: 0.8, output: 4 },
};
const WEB_SEARCH_COST_PER_QUERY = 0.01; // rough estimate

export interface CostEntry {
  at: string;
  type: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  web_search: boolean;
  cached: boolean;
  estimated_cost: number;
}

export interface CostSummary {
  total_calls: number;
  total_cached: number;
  total_cost: number;
  saved_by_cache: number;
  by_type: Record<string, { calls: number; cost: number }>;
  last_7_days: number;
  entries: CostEntry[];
}

function ensure() {
  const dir = resolve(ROOT, "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(): CostEntry[] {
  ensure();
  if (!existsSync(FILE)) return [];
  try { return JSON.parse(readFileSync(FILE, "utf-8")); }
  catch { return []; }
}

function save(entries: CostEntry[]) {
  ensure();
  writeFileSync(FILE, JSON.stringify(entries, null, 2), "utf-8");
}

export function logCost(type: string, model: string, inputTokens: number, outputTokens: number, webSearch: boolean, cached: boolean): CostEntry {
  const pricing = PRICING[model] || PRICING["claude-sonnet-4-5"];
  let cost = 0;
  if (!cached) {
    cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
    if (webSearch) cost += WEB_SEARCH_COST_PER_QUERY;
  }
  const entry: CostEntry = {
    at: new Date().toISOString(),
    type, model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    web_search: webSearch,
    cached,
    estimated_cost: Math.round(cost * 10000) / 10000,
  };
  const entries = load();
  entries.push(entry);
  // Keep last 500 entries
  if (entries.length > 500) entries.splice(0, entries.length - 500);
  save(entries);
  return entry;
}

export function getSummary(): CostSummary {
  const entries = load();
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  let totalCost = 0;
  let savedByCache = 0;
  let totalCached = 0;
  const byType: Record<string, { calls: number; cost: number }> = {};
  let last7 = 0;

  for (const e of entries) {
    totalCost += e.estimated_cost;
    if (e.cached) {
      totalCached++;
      // Estimate what it would have cost
      const pricing = PRICING[e.model] || PRICING["claude-sonnet-4-5"];
      savedByCache += (e.input_tokens * pricing.input + e.output_tokens * pricing.output) / 1_000_000;
    }
    if (!byType[e.type]) byType[e.type] = { calls: 0, cost: 0 };
    byType[e.type].calls++;
    byType[e.type].cost += e.estimated_cost;
    if (now - new Date(e.at).getTime() < week) last7 += e.estimated_cost;
  }

  return {
    total_calls: entries.length,
    total_cached: totalCached,
    total_cost: Math.round(totalCost * 10000) / 10000,
    saved_by_cache: Math.round(savedByCache * 10000) / 10000,
    by_type: byType,
    last_7_days: Math.round(last7 * 10000) / 10000,
    entries: entries.slice(-20).reverse(),
  };
}
