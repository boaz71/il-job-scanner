import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FILE = resolve(ROOT, "data/notifications.json");

export interface NotificationConfig {
  telegram?: {
    bot_token: string;
    chat_id: string;
    enabled: boolean;
    interactive?: boolean;   // two-way: buttons + commands (long polling, see telegram.ts)
  };
  min_grade_for_alert: "A" | "AB" | "ABC";
  app_url?: string;          // optional base URL of the web UI, for "open on computer" links
}

const DEFAULT: NotificationConfig = { min_grade_for_alert: "A" };

function ensure() {
  const dir = resolve(ROOT, "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): NotificationConfig {
  ensure();
  if (!existsSync(FILE)) return DEFAULT;
  try { return { ...DEFAULT, ...JSON.parse(readFileSync(FILE, "utf-8")) }; }
  catch { return DEFAULT; }
}

export function saveConfig(c: NotificationConfig): void {
  ensure();
  writeFileSync(FILE, JSON.stringify(c, null, 2), "utf-8");
}

// Inline keyboard as Telegram expects it (callback_data ≤ 64 bytes, or a URL button).
export type TelegramKeyboard = ({ text: string; callback_data: string } | { text: string; url: string })[][];

// Raw Bot API call. Throws on network errors; returns Telegram's JSON (check .ok).
export async function telegramApi(method: string, body: Record<string, unknown>, c?: NotificationConfig, timeoutMs = 20_000): Promise<any> {
  const cfg = c || loadConfig();
  if (!cfg.telegram?.bot_token) throw new Error("טלגרם לא הוגדר");
  const res = await fetch(`https://api.telegram.org/bot${cfg.telegram.bot_token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

export async function sendTelegramDocument(
  filename: string, content: Buffer, caption: string, keyboard?: TelegramKeyboard, c?: NotificationConfig,
): Promise<{ ok: boolean; error?: string }> {
  const cfg = c || loadConfig();
  if (!cfg.telegram?.bot_token || !cfg.telegram?.chat_id) return { ok: false, error: "טלגרם לא הוגדר" };
  try {
    const form = new FormData();
    form.append("chat_id", cfg.telegram.chat_id);
    form.append("caption", caption.slice(0, 1024));
    form.append("parse_mode", "HTML");
    if (keyboard) form.append("reply_markup", JSON.stringify({ inline_keyboard: keyboard }));
    form.append("document", new Blob([new Uint8Array(content)]), filename);
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegram.bot_token}/sendDocument`, {
      method: "POST", body: form, signal: AbortSignal.timeout(60_000),
    });
    const data: any = await res.json();
    return data.ok ? { ok: true } : { ok: false, error: data.description || "Telegram error" };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function sendTelegram(message: string, c?: NotificationConfig, keyboard?: TelegramKeyboard): Promise<{ ok: boolean; error?: string; message_id?: number }> {
  const cfg = c || loadConfig();
  if (!cfg.telegram?.bot_token || !cfg.telegram?.chat_id) {
    return { ok: false, error: "טלגרם לא הוגדר" };
  }
  try {
    const url = `https://api.telegram.org/bot${cfg.telegram.bot_token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.telegram.chat_id,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: false,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      }),
    });
    const data: any = await res.json();
    if (!data.ok) return { ok: false, error: data.description || "Telegram error" };
    return { ok: true, message_id: data.result?.message_id };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
