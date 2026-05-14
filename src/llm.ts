// Unified LLM interface — routes to Anthropic / Gemini / Ollama based on env.
// Optional Growbytes AI Gateway transport behind LLM_PREFER_GATEWAY=1.
import Anthropic from "@anthropic-ai/sdk";
import { askAi } from "./services/aiGatewayClient.js";

export type Provider = "anthropic" | "gemini" | "ollama" | "gateway";

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  maxTokens: number;
  messages: LLMMessage[];
  system?: string;
  webSearch?: boolean;        // only Anthropic supports natively
  forceProvider?: Provider;   // override routing
}

export interface LLMResponse {
  text: string;
  input_tokens: number;
  output_tokens: number;
  provider: Provider;
  model: string;
  web_search_used: boolean;
}

// ── Routing logic ──
// forceProvider          → respected first
// Web search             → always Anthropic (only one with native support)
// LLM_PREFER_GATEWAY=1   → Growbytes AI Gateway for eligible single-turn calls
// Cheap ops              → LLM_CHEAP_PROVIDER (default: gemini if key set, else anthropic)
// Else                   → anthropic (default)

// Gateway only handles single-turn calls without a system prompt or hosted tools.
function gatewayEligible(req: LLMRequest): boolean {
  if (req.webSearch) return false;
  if (req.system) return false;
  if (req.messages.length !== 1) return false;
  return true;
}

// Direct-provider picker — never returns "gateway". Used both for the default
// path (when LLM_PREFER_GATEWAY is unset) and as the fallback path when a
// gateway call fails at runtime.
function pickNonGatewayProvider(req: LLMRequest): Provider {
  if (req.forceProvider && req.forceProvider !== "gateway") return req.forceProvider;
  if (req.webSearch) return "anthropic";
  const cheap = (process.env.LLM_CHEAP_PROVIDER || "").toLowerCase() as Provider;
  if (cheap === "gemini" && process.env.GEMINI_API_KEY) return "gemini";
  if (cheap === "ollama") return "ollama";
  if (cheap === "anthropic") return "anthropic";
  // Auto fallback
  if (process.env.GEMINI_API_KEY) return "gemini";
  return "anthropic";
}

function pickProvider(req: LLMRequest): Provider {
  if (req.forceProvider) return req.forceProvider;
  if (req.webSearch) return "anthropic";
  if (process.env.LLM_PREFER_GATEWAY === "1" && gatewayEligible(req)) {
    return "gateway";
  }
  return pickNonGatewayProvider(req);
}

// ── Anthropic ──
async function callAnthropic(req: LLMRequest): Promise<LLMResponse> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.includes("PUT-YOUR-KEY-HERE")) {
    throw new Error("חסר ANTHROPIC_API_KEY");
  }
  const client = new Anthropic({ apiKey: key });
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const tools = req.webSearch
    ? [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 3 }]
    : undefined;

  const msg = await client.messages.create({
    model,
    max_tokens: req.maxTokens,
    messages: req.messages.map(m => ({ role: m.role, content: m.content })),
    ...(req.system ? { system: req.system } : {}),
    ...(tools ? { tools } : {}),
  });

  const text = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("\n\n");
  return {
    text,
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    provider: "anthropic",
    model,
    web_search_used: !!req.webSearch,
  };
}

// ── Gemini ──
async function callGeminiOnce(req: LLMRequest, model: string, key: string): Promise<{ res: Response; data: any | null }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const contents = req.messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body: any = {
    contents,
    generationConfig: { maxOutputTokens: req.maxTokens },
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, data: null };
}

async function callGemini(req: LLMRequest): Promise<LLMResponse> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("חסר GEMINI_API_KEY ב-.env");
  const primary = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  // Fallback chain — try primary first, then progressively cheaper if overloaded
  const fallbacks = [primary];
  if (!primary.includes("flash-lite")) fallbacks.push("gemini-2.5-flash-lite");
  if (!primary.includes("1.5")) fallbacks.push("gemini-1.5-flash");

  let lastError = "";
  for (const model of fallbacks) {
    // Retry the same model up to 3 times on transient errors
    for (let attempt = 0; attempt < 3; attempt++) {
      const { res } = await callGeminiOnce(req, model, key);
      if (res.ok) {
        const data: any = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
        if (!text) {
          const reason = data.candidates?.[0]?.finishReason;
          lastError = `Gemini empty response (${reason || "unknown"})`;
          break;
        }
        return {
          text,
          input_tokens: data.usageMetadata?.promptTokenCount || 0,
          output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
          provider: "gemini",
          model,
          web_search_used: false,
        };
      }
      const errText = await res.text();
      lastError = `${res.status}: ${errText.slice(0, 150)}`;

      // 503/429 = retry. 404/400 = no point retrying same model
      if (res.status === 503 || res.status === 429) {
        const wait = (attempt + 1) * 1500;
        console.log(`Gemini ${model} ${res.status} — retry ${attempt + 1}/3 in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      break; // skip to next fallback model
    }
    console.log(`Gemini ${model} failed (${lastError}), trying next...`);
  }
  throw new Error(`Gemini API error after ${fallbacks.length} model attempts: ${lastError}`);
}

// ── Ollama ──
async function callOllama(req: LLMRequest): Promise<LLMResponse> {
  // Use 127.0.0.1 explicitly — Node 22 prefers IPv6 ::1 which Ollama doesn't bind to
  const baseUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const model = process.env.OLLAMA_MODEL || "llama3.1:8b";
  const url = `${baseUrl}/api/chat`;

  const messages = req.system
    ? [{ role: "system", content: req.system }, ...req.messages]
    : req.messages;

  let res: Response;
  // Long timeout — Ollama on CPU can take 5+ minutes for big prompts
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 min
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { num_predict: req.maxTokens, num_ctx: 4096 },
      }),
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(timeout);
    if (e.name === "AbortError") {
      throw new Error(`Ollama timeout (10 דקות). המודל ${model} איטי מדי במחשב הזה. נסה מודל קטן יותר (llama3.2:1b) או עבור ל-Gemini.`);
    }
    throw new Error(`Ollama לא נגיש ב-${baseUrl}. וודא ש-Ollama רץ ושהמודל ${model} מותקן (ollama pull ${model}). שגיאה: ${e.message}`);
  }
  clearTimeout(timeout);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama error ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data: any = await res.json();
  const text = data.message?.content || "";
  if (!text) throw new Error("Ollama empty response");
  return {
    text,
    input_tokens: data.prompt_eval_count || 0,
    output_tokens: data.eval_count || 0,
    provider: "ollama",
    model,
    web_search_used: false,
  };
}

// ── Growbytes AI Gateway (opt-in via LLM_PREFER_GATEWAY=1) ──
// Single-turn transport over the Growbytes AI Gateway at AI_GATEWAY_URL
// (default http://127.0.0.1:5055). Token counts are not surfaced by the
// current gateway response shape, so we report zeros and let the caller's
// cost layer treat gateway calls as untracked for now.
async function callGateway(req: LLMRequest): Promise<LLMResponse> {
  const input = req.messages[0]?.content ?? "";
  if (!input) throw new Error("Gateway call requires non-empty messages[0].content");
  const res = await askAi("direct", input);
  if (!res.success || !res.result) {
    throw new Error(`AI Gateway returned no result: ${res.error || "unknown error"}`);
  }
  return {
    text: res.result,
    input_tokens: 0,
    output_tokens: 0,
    provider: "gateway",
    model: res.model || "unknown",
    web_search_used: false,
  };
}

// ── Main entry ──
export async function llmGenerate(req: LLMRequest): Promise<LLMResponse> {
  const provider = pickProvider(req);

  // Gateway path: try first, fall back to direct providers if it fails.
  if (provider === "gateway") {
    try {
      return await callGateway(req);
    } catch (err: any) {
      console.warn(`AI Gateway failed (${err?.message || err}), falling back to direct provider`);
      const fallback = pickNonGatewayProvider(req);
      switch (fallback) {
        case "gemini":   return callGemini(req);
        case "ollama":   return callOllama(req);
        case "anthropic":
        default:         return callAnthropic(req);
      }
    }
  }

  switch (provider) {
    case "gemini":   return callGemini(req);
    case "ollama":   return callOllama(req);
    case "anthropic":
    default:         return callAnthropic(req);
  }
}

export function activeProviderForCheap(): Provider {
  // Reports the cheap-tier direct provider, independent of LLM_PREFER_GATEWAY.
  // (Gateway routing is a per-call eligibility decision, not a tier.)
  return pickNonGatewayProvider({ maxTokens: 0, messages: [], webSearch: false });
}
