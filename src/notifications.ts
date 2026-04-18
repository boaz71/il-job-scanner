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
  };
  min_grade_for_alert: "A" | "AB" | "ABC";
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

export async function sendTelegram(message: string, c?: NotificationConfig): Promise<{ ok: boolean; error?: string }> {
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
      }),
    });
    const data: any = await res.json();
    if (!data.ok) return { ok: false, error: data.description || "Telegram error" };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
