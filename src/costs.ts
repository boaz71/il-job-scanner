import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FILE = resolve(ROOT, "data/costs.json");

// Approximate token costs ($/1M tokens)
const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-sonnet-4-5":   { input: 3, output: 15 },
  "claude-sonnet-4-6":   { input: 3, output: 15 },
  "claude-haiku-3-5":    { input: 0.8, output: 4 },
  "claude-haiku-3.5":    { input: 0.8, output: 4 },
  // Gemini
  "gemini-1.5-flash":    { input: 0.075, output: 0.30 },
  "gemini-2.0-flash":    { input: 0.10, output: 0.40 },
  "gemini-2.5-flash":    { input: 0.15, output: 0.60 },
  // Ollama (local) — free
  "llama3.1:8b":         { input: 0, output: 0 },
  "llama3.2:3b":         { input: 0, output: 0 },
  "qwen2.5:7b":          { input: 0, output: 0 },
  "qwen2.5:14b":         { input: 0, output: 0 },
  "phi3.5":              { input: 0, output: 0 },
  "phi3.5:mini":         { input: 0, output: 0 },
};
const WEB_SEARCH_COST_PER_QUERY = 0.01;

function getPricing(model: string) {
  if (PRICING[model]) return PRICING[model];
  // Auto-detect: if model name starts with a known prefix
  if (model.startsWith("gemini")) return { input: 0.10, output: 0.40 };
  if (model.startsWith("claude-haiku")) return { input: 0.8, output: 4 };
  if (model.startsWith("claude")) return { input: 3, output: 15 };
  // Local models (Ollama uses :tag suffix usually)
  if (model.includes(":") || model.startsWith("llama") || model.startsWith("qwen") || model.startsWith("phi")) {
    return { input: 0, output: 0 };
  }
  return { input: 3, output: 15 }; // unknown — assume Sonnet pricing
}

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

export interface BudgetCheck {
  ok: boolean;
  daily_used: number;
  daily_limit: number;
  message?: string;
}

export function checkBudget(): BudgetCheck {
  const limit = Number(process.env.DAILY_BUDGET || "0");
  if (!limit || limit <= 0) return { ok: true, daily_used: 0, daily_limit: 0 };

  const entries = load();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const usedToday = entries
    .filter(e => new Date(e.at).getTime() >= todayStart)
    .reduce((sum, e) => sum + e.estimated_cost, 0);

  if (usedToday >= limit) {
    return {
      ok: false,
      daily_used: usedToday,
      daily_limit: limit,
      message: `הגעת לתקציב היומי של $${limit.toFixed(2)} (השתמשת ב-$${usedToday.toFixed(3)}). פעולות AI חסומות עד מחר. שנה ב-.env: DAILY_BUDGET=`,
    };
  }
  return { ok: true, daily_used: usedToday, daily_limit: limit };
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
  const pricing = getPricing(model);
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
