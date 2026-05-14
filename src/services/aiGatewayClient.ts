/**
 * Growbytes AI Gateway client (Phase 0 — scaffolding only).
 *
 * Provides a thin, provider-agnostic wrapper over the local AI Gateway at
 * AI_GATEWAY_URL (default: http://127.0.0.1:5055). Feature code should depend
 * on this client rather than on `@anthropic-ai/sdk` directly.
 *
 * This file is intentionally NOT wired into any existing call site yet. The
 * existing Anthropic SDK usage in src/cv.ts remains untouched.
 *
 * Endpoints used (see growbytes-ai-gateway skill):
 *   GET  /health
 *   POST /api/ai/chat       body: { taskType, input }
 *   POST /api/ai/code-help  body: { input }
 *
 * The gateway URL is read from process.env.AI_GATEWAY_URL. .env loading is
 * the caller's responsibility (the server entry point already calls loadEnv()).
 */

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:5055";
const DEFAULT_TIMEOUT_MS = 120_000;

/** Task types accepted by the gateway's /api/ai/chat endpoint. */
export type AiTaskType =
  | "direct"
  | "classify"
  | "json-extraction"
  | "code-help"
  | "simple-summary"
  | "architecture"
  | "resume-tailoring"
  | "unknown";

/** Shape of a successful gateway response. */
export interface AiGatewayResponse {
  success: boolean;
  provider: string;
  model: string;
  taskType: string;
  durationMs: number;
  result?: string;
  rawResult?: string;
  data?: unknown;
  error?: string;
}

/** Shape of the /health response. */
export interface AiGatewayHealth {
  status: string;
  service: string;
  provider: string;
  model: string;
}

export interface AskOptions {
  /** Override the gateway base URL for this call (optional). */
  baseUrl?: string;
  /** Per-call timeout in milliseconds (default 120s). */
  timeoutMs?: number;
  /** Optional AbortSignal — composed with the timeout. */
  signal?: AbortSignal;
}

function getBaseUrl(override?: string): string {
  const url = override || process.env.AI_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  return url.replace(/\/+$/, "");
}

/**
 * Compose an AbortSignal with a timeout. Returns the composed signal and a
 * cleanup function to clear the timer.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort((signal as any)?.reason);
  if (signal) {
    if (signal.aborted) controller.abort((signal as any).reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`AI Gateway request timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

async function postJson<T>(path: string, body: unknown, opts: AskOptions = {}): Promise<T> {
  const url = `${getBaseUrl(opts.baseUrl)}${path}`;
  const { signal, cleanup } = withTimeout(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`AI Gateway error ${response.status} at ${path}: ${errorText || response.statusText}`);
    }

    return (await response.json()) as T;
  } finally {
    cleanup();
  }
}

/**
 * Probe the gateway's /health endpoint. Returns the parsed body on success.
 * Throws if the gateway is unreachable or returns a non-2xx status.
 */
export async function checkHealth(opts: AskOptions = {}): Promise<AiGatewayHealth> {
  const url = `${getBaseUrl(opts.baseUrl)}/health`;
  const { signal, cleanup } = withTimeout(opts.signal, opts.timeoutMs ?? 5_000);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`AI Gateway /health returned ${response.status}: ${errorText || response.statusText}`);
    }
    return (await response.json()) as AiGatewayHealth;
  } finally {
    cleanup();
  }
}

/**
 * Lightweight availability check that never throws. Useful for feature flags.
 */
export async function isGatewayAvailable(opts: AskOptions = {}): Promise<boolean> {
  try {
    const h = await checkHealth({ timeoutMs: 2_000, ...opts });
    return h.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Generic AI chat call. Prefer passing an explicit `taskType` rather than
 * relying on the gateway's automatic classification.
 */
export async function askAi(
  taskType: AiTaskType,
  input: string,
  opts: AskOptions = {},
): Promise<AiGatewayResponse> {
  return postJson<AiGatewayResponse>("/api/ai/chat", { taskType, input }, opts);
}

/**
 * Code-help shortcut. Use for small, precise code generation / explanation /
 * utility refactors. Do not use for security-sensitive or production-critical
 * code without human review.
 */
export async function askCodeHelp(
  input: string,
  opts: AskOptions = {},
): Promise<AiGatewayResponse> {
  return postJson<AiGatewayResponse>("/api/ai/code-help", { input }, opts);
}

/**
 * Resolve the current gateway base URL (for logging / diagnostics).
 */
export function gatewayBaseUrl(): string {
  return getBaseUrl();
}
