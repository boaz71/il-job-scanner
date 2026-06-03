import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import mammoth from "mammoth";
import type { Job, Profile } from "./types.js";
import { getCached, setCache } from "./cache.js";
import { logCost, checkBudget } from "./costs.js";
import { llmGenerate, type LLMMessage } from "./llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function model(): string {
  return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
}

// Cheap model for simple, templated tasks
function cheapModel(): string {
  return process.env.ANTHROPIC_MODEL_CHEAP || "claude-haiku-3-5";
}

// Wrapper that handles caching + cost tracking
// Helper for non-cached LLM calls — routes through llmGenerate with budget check
async function llmCall(opts: {
  type: string;
  maxTokens: number;
  messages: { role: "user" | "assistant"; content: string }[];
  system?: string;
  webSearch?: boolean;
  // Critical web-dependent features (live salary data, market trends, company
  // research) set this to keep web search + cloud provider even when the global
  // DISABLE_WEB_SEARCH switch is on. Without it, these would fall to the local
  // gateway model with no internet and fabricate data.
  forceWeb?: boolean;
}): Promise<string> {
  const budget = checkBudget();
  if (!budget.ok) throw new Error(budget.message || "הגעת לתקציב היומי");

  const webDisabled = process.env.DISABLE_WEB_SEARCH === "1";
  const useWebSearch = !!opts.webSearch && (!webDisabled || !!opts.forceWeb);

  const response = await llmGenerate({
    maxTokens: opts.maxTokens,
    messages: opts.messages,
    system: opts.system,
    webSearch: useWebSearch,
    forceProvider: useWebSearch ? "anthropic" : undefined,
  });

  logCost(opts.type, response.model, response.input_tokens, response.output_tokens, response.web_search_used, false);
  return response.text;
}

async function cachedGenerate(opts: {
  type: string;
  cacheKey: string[];
  model: string;       // legacy field — kept for backward compat
  maxTokens: number;
  messages: Anthropic.Messages.MessageParam[];
  system?: string;
  webSearch?: boolean;
  // Phase 1b pilot flag: opt this individual call into the Growbytes AI Gateway
  // transport via llm.ts's "gateway" provider. Honored only when the request
  // is gateway-eligible (no web search). If the gateway is unreachable,
  // llmGenerate's Phase 1a fallback engages automatically and the call lands
  // on the normal direct-provider path. Default behavior unchanged when unset.
  viaLlmRouter?: boolean;
}): Promise<string> {
  // Check cache first
  const cached = getCached(opts.type, ...opts.cacheKey);
  if (cached) {
    logCost(opts.type, opts.model, 0, 0, false, true);
    return cached;
  }

  const budget = checkBudget();
  if (!budget.ok) throw new Error(budget.message || "הגעת לתקציב היומי");

  const webDisabled = process.env.DISABLE_WEB_SEARCH === "1";
  const useWebSearch = opts.webSearch && !webDisabled;

  // Convert messages
  const messages: LLMMessage[] = opts.messages.map(m => ({
    role: m.role as "user" | "assistant",
    content: typeof m.content === "string" ? m.content : "",
  }));

  // Routing logic:
  // - viaLlmRouter pilot flag (Phase 1b) → force "gateway" when eligible
  // - Web search needed → Anthropic (only one with native support)
  // - Otherwise → cheap provider (LLM_CHEAP_PROVIDER) — Gemini/Ollama/Anthropic-Haiku
  const preferGateway = !!opts.viaLlmRouter && !useWebSearch;
  const forceProvider = preferGateway
    ? "gateway"
    : (useWebSearch ? "anthropic" : undefined);

  const response = await llmGenerate({
    maxTokens: opts.maxTokens,
    messages,
    system: opts.system,
    webSearch: useWebSearch,
    forceProvider,
  });

  logCost(opts.type, response.model, response.input_tokens, response.output_tokens, response.web_search_used, false);
  setCache(opts.type, response.text, response.web_search_used, ...opts.cacheKey);
  return response.text;
}

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.includes("PUT-YOUR-KEY-HERE")) {
    throw new Error("חסר ANTHROPIC_API_KEY ב-environment (ערוך את .env והפעל מחדש את npm run web)");
  }
  return new Anthropic({ apiKey });
}

// Web search tool for getting current information
const WEB_SEARCH_TOOL = { type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 3 };

// Extract final text from a response that may contain web search results
function extractText(msg: Anthropic.Messages.Message): string {
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

const TODAY = () => new Date().toLocaleDateString("he-IL", { year: "numeric", month: "long", day: "numeric" });

// ── Parse CV file (.pdf/.docx/.txt/.md) ──
export async function parseCV(buffer: Buffer, filename: string): Promise<string> {
  const ext = filename.toLowerCase().split(".").pop() || "";

  if (ext === "txt" || ext === "md") {
    return buffer.toString("utf-8");
  }

  if (ext === "docx") {
    const r = await mammoth.extractRawText({ buffer });
    return r.value;
  }

  if (ext === "pdf") {
    // Use pdfjs-dist legacy build for Node
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
    const pdf = await loadingTask.promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it: any) => it.str).join(" "));
    }
    return pages.join("\n\n");
  }

  throw new Error(`פורמט לא נתמך: .${ext}. השתמש ב-PDF / DOCX / TXT / MD`);
}

// ── Save CV text to disk ──
export function saveCV(text: string): void {
  writeFileSync(resolve(ROOT, "data/cv.txt"), text, "utf-8");
}

export function loadCV(): string | null {
  const p = resolve(ROOT, "data/cv.txt");
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

// ── Extract profile from CV using Claude ──
export async function extractProfile(cvText: string): Promise<Profile> {
  const fullText = await llmCall({
    type: "extract-profile",
    maxTokens: 1500,
    messages: [
      {
        role: "user",
        content: `קראתי את קורות החיים הבאים וצריך לחלץ מהם פרופיל מובנה בפורמט JSON.

קורות חיים:
---
${cvText}
---

החזר JSON בלבד (בלי הסברים), בדיוק לפי הסכמה:
{
  "name": "שם מלא",
  "title": "תפקיד נוכחי/מבוקש באנגלית",
  "skills": {
    "primary": ["עד 6 טכנולוגיות/שפות עיקריות שהמועמד שולט בהן מצוין"],
    "secondary": ["עד 8 טכנולוגיות משניות/כלים שהמועמד מכיר"],
    "interested_in": ["עד 6 תחומים שהמועמד היה רוצה לעסוק בהם"]
  },
  "experience_years": 5,
  "location": {
    "preferred": ["Tel Aviv", "תל אביב", "Herzliya", "הרצליה", "Ramat Gan", "רמת גן", "Israel"],
    "remote_ok": true
  },
  "job_types": ["Full-time"],
  "keywords_boost": ["מילות מפתח שהמועמד היה רוצה למצוא במשרה, למשל senior/backend/fullstack/AI"],
  "keywords_exclude": ["intern", "junior", "student", "part-time"],
  "min_match_score": 30
}

חשוב: השם נשאר בשפת המקור. טכנולוגיות באנגלית. החזר רק JSON תקין.`,
      },
    ],
  });

  const match = fullText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("לא נמצא JSON בתשובה");

  return JSON.parse(match[0]) as Profile;
}

export function saveProfile(p: Profile): void {
  writeFileSync(resolve(ROOT, "profile.json"), JSON.stringify(p, null, 2), "utf-8");
}

// ── Analyze profile for market insights ──
export interface ProfileInsightsResult {
  market_score: number;
  level: string;
  estimated_salary: { monthly_min: number; monthly_max: number; note: string };
  suggested_roles: { title: string; salary_range: string }[];
  strengths: string[];
  gaps: string[];
  hot_skills_in_profile: string[];
  market_summary: string;
}

export async function analyzeProfile(cvText: string): Promise<ProfileInsightsResult> {
  const fullText = await llmCall({
    type: "profile-insights",
    maxTokens: 3000,
    webSearch: true,
    forceWeb: true,
    messages: [
      {
        role: "user",
        content: `התאריך היום: ${TODAY()}.

אתה אנליסט שוק העבודה ההייטק הישראלי. **חפש באינטרנט** נתונים עדכניים על שכר מפתחים בישראל, מגמות שוק העבודה, וטכנולוגיות חמות ב-2025-2026.

נתח את קורות החיים הבאים והחזר תובנות שוק **מבוססות על נתונים עדכניים**.

קורות חיים:
---
${cvText}
---

החזר JSON תקין בלבד (בלי הסברים, בלי backticks), בדיוק לפי הסכמה:
{
  "market_score": 75,
  "level": "Senior",
  "estimated_salary": {
    "monthly_min": 28000,
    "monthly_max": 42000,
    "note": "טווח ברוטו ב-ש\"ח לחודש בחברות בגודל בינוני-גדול במרכז"
  },
  "suggested_roles": [
    { "title": "Senior Backend Engineer", "salary_range": "₪30-42K" },
    { "title": "Full Stack Tech Lead", "salary_range": "₪35-48K" }
  ],
  "strengths": ["3-5 חוזקות בולטות בעברית"],
  "gaps": ["2-4 פערים או דברים שכדאי להוסיף בעברית"],
  "hot_skills_in_profile": ["טכנולוגיות חמות שכבר יש בפרופיל"],
  "market_summary": "פסקה אחת קצרה (3-4 משפטים) על מיצוב המועמד בשוק הישראלי הנוכחי, האם הוא נחשק, איך לחזק"
}

הנחיות:
- market_score: 0-100. 70+ = שוק חם, 50-70 = סביר, מתחת 50 = קשה
- level: בחר אחד מ: Junior / Mid / Senior / Staff / Principal / Lead
- שכר: טווחים ריאליים לשוק הישראלי 2026, ברוטו, חודשי
- כל הטקסטים החופשיים בעברית
- החזר JSON בלבד.`,
      },
    ],
  });

  const match = fullText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("לא נמצא JSON בתשובה");
  return JSON.parse(match[0]) as ProfileInsightsResult;
}

// ── Generate tailored resume for a specific job ──
export type Lang = "he" | "en" | "auto";

function langLabel(l: Lang): string {
  if (l === "he") return "עברית בלבד";
  if (l === "en") return "English only";
  return "שפת המקור של קורות החיים";
}

export async function generateTailoredCV(cvText: string, job: Job, lang: Lang = "auto"): Promise<string> {
  return llmCall({
    type: "cv-tailored",
    maxTokens: 3000,
    messages: [
      {
        role: "user",
        content: `קורות חיים מקוריים של המועמד:
---
${cvText}
---

משרה:
חברה: ${job.company}
תפקיד: ${job.title}
מיקום: ${job.location}
מחלקה: ${job.department}
תיאור:
${job.description.replace(/<[^>]+>/g, " ").slice(0, 4000)}

המשימה:
צור גרסה מותאמת של קורות החיים למשרה הזו. הדגש ניסיון, כישורים וטכנולוגיות רלוונטיים במיוחד. סדר מחדש ועדיפות את הסעיפים כך שהרלוונטי ביותר יהיה ראשון. אל תמציא ניסיון או כישורים שאינם בקורות החיים המקוריים.

שפה: ${langLabel(lang)}.

פורמט: Markdown נקי וקריא. החזר רק את קורות החיים המעוצבים, בלי הקדמות או הסברים.`,
      },
    ],
  });
}

// ── Generate interview preparation for a job ──
export async function generateInterviewPrep(cvText: string, job: Job): Promise<string> {
  return llmCall({
    type: "interview-prep",
    maxTokens: 4000,
    webSearch: true,
    messages: [
      {
        role: "user",
        content: `התאריך היום: ${TODAY()}.

**חפש באינטרנט מידע עדכני על חברת ${job.company}** — חדשות אחרונות, תהליך ראיונות, ביקורות עובדים, שאלות ראיון נפוצות.

קורות חיים של המועמד:
---
${cvText}
---

המשרה:
חברה: ${job.company}
תפקיד: ${job.title}
מיקום: ${job.location}
מחלקה: ${job.department}
תיאור המשרה:
${job.description.replace(/<[^>]+>/g, " ").slice(0, 4000)}

המשימה:
הכן מסמך הכנה מקיף לראיון עבור המשרה הזו, **מבוסס על מידע עדכני שמצאת**. המסמך צריך להיות מותאם לחברה ולמשרה הספציפית, וגם לרקע של המועמד מקורות החיים.

חלק את המסמך לסעיפים הבאים בדיוק (פורמט Markdown, בעברית):

# הכנה לראיון: ${job.title} @ ${job.company}

## 🎯 סקירת המשרה
2-3 משפטים על מה התפקיד דורש, על איזה stack/דומיין יתמקדו, ומה חשוב להבליט.

## 📚 שאלות טכניות צפויות
8-10 שאלות טכניות שסבירות בראיון לתפקיד הזה. לכל שאלה, ספק תשובה תמציתית של 2-4 משפטים שיכולה לעזור למועמד להיזכר. התמקד בטכנולוגיות שמופיעות בתיאור המשרה.

## 🏗️ שאלת System Design צפויה
- שאלה אופיינית לרמה ולדומיין של המשרה
- 5-7 נקודות שחשוב לכלול בתשובה (scalability, DB choice, caching, וכו')

## 💼 שאלות התנהגותיות (Behavioral)
5-6 שאלות התנהגותיות אופייניות לחברה הזו (חפש את התרבות מהתיאור). לכל שאלה הצע מסגרת קצרה לתשובה בגישת STAR (Situation-Task-Action-Result), וחבר לרקע הספציפי של המועמד מהקו"ח.

## 🔍 על ${job.company} — מה כדאי לדעת
- מה החברה עושה
- טכנולוגיות עיקריות שלה
- אתגרים עסקיים/טכניים נוכחיים
- ערכים/תרבות אם רמוז בתיאור
(אם אינך בטוח לגבי החברה — ציין זאת)

## ❓ שאלות חכמות לשאול את המראיין
5-6 שאלות מעמיקות שיגרמו למועמד להיראות מקצועי ומעוניין באמת. כללי שאלות על: התפקיד הספציפי, הצוות, אתגרים, growth path, תהליכי הנדסה.

## ⚡ נקודות החיבור שלך
3-5 נקודות ספציפיות לחיבור בין הקו"ח של המועמד למשרה. למשל: "יש לך ניסיון ב-X שמתאים בדיוק לדרישה Y במשרה". זו תשובה ל-"למה אתה?".

## 🔥 רענון טכני מהיר
רשימה של 5-8 קונספטים/טכנולוגיות שכדאי לרענן לפני הראיון, על בסיס תיאור המשרה. תן 1-2 משפטי תקציר לכל אחד.

הנחיות:
- כתוב הכל בעברית (חוץ משמות טכנולוגיים).
- ענייני, מקצועי, פרקטי. ללא קלישאות.
- אל תמציא עובדות על החברה אם אינך בטוח.
- החזר רק את המסמך, ללא הקדמה.`,
      },
    ],
  });
}

// ── Skill gap analysis for a specific job ──
export async function analyzeSkillGap(cvText: string, job: Job): Promise<string> {
  return llmCall({
    type: "skill-gap",
    maxTokens: 2500,
    webSearch: true,
    messages: [{
      role: "user",
      content: `התאריך היום: ${TODAY()}.

**חפש באינטרנט** קורסים ומשאבי למידה עדכניים לטכנולוגיות הרלוונטיות, ומגמות דרישות בשוק.

קורות חיים:
---
${cvText}
---

משרה:
חברה: ${job.company}
תפקיד: ${job.title}
תיאור:
${job.description.replace(/<[^>]+>/g, " ").slice(0, 4000)}

המשימה:
נתח את הפער בין קורות החיים של המועמד לדרישות המשרה. החזר ניתוח מובנה ב-Markdown בעברית, עם הסעיפים:

# ניתוח פערים: ${job.title} @ ${job.company}

## ✅ מה כן יש לך
3-5 תחומים בהם אתה כבר עומד בדרישה. ציין במפורש מה במשרה ומה ב-CV.

## ⚠️ פערים מרכזיים
3-6 דרישות שלא רואים ב-CV. לכל פער: מה חסר, רמת קריטיות (קריטי/חשוב/נחמד-לדעת), והאם זה learnable מהר או דורש שנים.

## 📚 תוכנית למידה ממוקדת
לכל פער שניתן לסגור בחודשים בודדים — תן המלצה ספציפית: קורס ב-Udemy/Coursera/YouTube/חינמי, פרויקט פרקטי לעשות, ספר/תיעוד מומלץ. עם שמות אמיתיים אם אתה בטוח (אחרת תוכן כללי).

## 🎯 שורה תחתונה
- האם להגיש (כן/לא/כדאי לחכות)
- מה הסיכוי המוערך לעבור (אחוזים)
- אסטרטגיה מומלצת בהגשה — איך להציג את הפערים בצורה חיובית

ענייני, פרקטי, ללא קלישאות. החזר רק את המסמך.`,
    }],
  });
}

// ── Salary negotiation prep ──
export async function generateSalaryPrep(cvText: string, job: Job): Promise<string> {
  return llmCall({
    type: "salary-prep",
    maxTokens: 2500,
    webSearch: true,
    forceWeb: true,
    messages: [{
      role: "user",
      content: `התאריך היום: ${TODAY()}.

**חפש באינטרנט** נתוני שכר עדכניים למפתחים בישראל, סקרי שכר 2025-2026, ומידע על תנאים בחברת ${job.company}.

אתה יועץ קריירה מומחה למשא ומתן על שכר בשוק הטק הישראלי.

קורות חיים:
---
${cvText}
---

משרה:
חברה: ${job.company}
תפקיד: ${job.title}
מיקום: ${job.location}
תיאור:
${job.description.replace(/<[^>]+>/g, " ").slice(0, 3000)}

המשימה:
הכן מסמך הכנה למשא ומתן על שכר עבור המשרה הזו, מותאם לרמת המועמד מהקו"ח. פורמט Markdown בעברית.

# הכנה למו"מ שכר: ${job.title} @ ${job.company}

## 💰 טווחי שכר בשוק (₪/חודש ברוטו)
- **השוק הרחב לתפקיד הזה:** טווח X-Y
- **חברות בגודל של ${job.company} (אם ידוע):** טווח X-Y
- **דרגה מוערכת של המועמד:** Junior/Mid/Senior/Staff/Principal עם הסבר 1-2 משפטים

## 🎯 מה לדרוש
- **רף מינימלי (Walk-away):** ₪X
- **יעד ריאלי:** ₪Y (זה מה לפתוח איתו)
- **שאיפה אופטימית:** ₪Z (אם הצדק עבר)

## 🎁 רכיבים מעבר לשכר חודשי
רשימה של 6-8 רכיבים לבקש: ימי חופשה, RSU/אופציות + לוח הבשלה, בונוס שנתי, רכב/החזר נסיעות, קרן השתלמות, פיצויים מוגדלים, סיוע בלימודים, רימוט/היברידי. עם המלצה ספציפית לכל אחד.

## 💬 ניסוח לפתיחה
2-3 משפטים שאפשר להגיד מילה במילה כשהמראיין שואל "מה הציפיות שלך?". מעוגן בערך השוק שלך, לא במצב הנוכחי.

## ❓ שאלות לשאול לפני שאתה נוקב במספר
4-6 שאלות שיעזרו לך לאסוף מידע לפני שאתה מתחייב.

## 🛡️ תגובות לטקטיקות נפוצות
4-5 תרחישים: "המספר גבוה מדי", "אין לנו תקציב לזה", "תחילה תוכיח את עצמך ונדבר תוספת", "הצענו לאחרים פחות". איך להגיב לכל אחד.

## 🚩 דגלים אדומים בשיחה
3-4 סימנים שאומרים שזו עסקה גרועה ורצוי ללכת — מצדיקים פנייה לחברה אחרת.

ענייני, ישיר, בעל מספרים אמיתיים. בלי קלישאות. החזר רק את המסמך.`,
    }],
  });
}

// ── Mock interview chat ──
export interface MockMessage { role: "user" | "assistant"; content: string }

export async function mockInterviewReply(
  cvText: string,
  job: Job,
  history: MockMessage[]
): Promise<string> {
  const anthropic = client();
  const systemPrompt = `אתה מראיין טכני בכיר בחברת ${job.company}, מראיין מועמד למשרה: "${job.title}".

על המשרה:
${job.description.replace(/<[^>]+>/g, " ").slice(0, 3000)}

על המועמד (מקורות החיים שלו):
${cvText.slice(0, 3000)}

הנחיות לראיון:
- שאל שאלות אחת בכל פעם (לא רשימה).
- מערב שאלות טכניות (60%), system design (15%), behavioral (15%), ושאלות "למה אנחנו" (10%).
- התחל ב-icebreaker קצר אם זו ההודעה הראשונה.
- כשהמועמד עונה, תן feedback קצר (1-2 משפטים) על התשובה — מה היה טוב ומה היה חסר/שגוי. ואז עבור לשאלה הבאה.
- אם תשובה גרועה במיוחד, תקן במפורש בעדינות.
- אם תשובה מעולה, ציין זאת.
- שמור על טון מקצועי וחם, לא קר.
- אחרי 8-10 שאלות, סכם את הראיון: חוזקות, נקודות לשיפור, סיכוי משוער לעבור (אחוזים).
- הכל בעברית.
- אל תכתוב "אני מראיין", פשוט תפעל כמראיין.`;

  const budget = checkBudget();
  if (!budget.ok) throw new Error(budget.message || "הגעת לתקציב היומי");

  const messages: LLMMessage[] = history.length === 0
    ? [{ role: "user", content: "בוא נתחיל את הראיון." }]
    : history.map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

  const response = await llmGenerate({
    maxTokens: 1000,
    system: systemPrompt,
    messages,
  });
  logCost("mock-interview", response.model, response.input_tokens, response.output_tokens, false, false);
  return response.text;
}

// ── Company deep dive (with web search for current data) ──
export async function companyDeepDive(companyName: string, jobsContext: string): Promise<string> {
  return llmCall({
    type: "company-dive",
    maxTokens: 4000,
    webSearch: true,
    forceWeb: true,
    messages: [{
      role: "user",
      content: `התאריך היום: ${TODAY()}.

חפש באינטרנט מידע עדכני על חברת "${companyName}" — חדשות אחרונות, מצב עסקי נוכחי, פיטורים/גיוסים, שכר, ביקורות עובדים, וכל מידע רלוונטי מ-2025-2026.

משרות פתוחות כרגע במערכת שלנו (לקונטקסט):
${jobsContext.slice(0, 2000)}

לאחר החיפוש, הכן מסמך Markdown בעברית:

# 🏢 ${companyName} — סקירה מעמיקה (עדכני ל-${TODAY()})

## 📋 על החברה
- מה החברה עושה (2-3 משפטים)
- שנת הקמה, גודל, מצב (ציבורית/פרטית/נרכשה)
- משקיעים / שווי / סיבוב גיוס אחרון
- מיקום משרדים בישראל
- **חדשות אחרונות** (2025-2026)

## 🛠️ Stack טכנולוגי
- שפות ו-frameworks עיקריים
- תשתיות (AWS/GCP/Azure, K8s, etc.)
- אתגרים טכניים מעניינים

## 🎭 תרבות ו-DNA
- סגנון עבודה
- היברידי/משרד/remote — **מה המדיניות הנוכחית?**
- ביקורות עובדים (Glassdoor/LinkedIn)
- מה מייחד אותם

## 💰 שכר ותנאים
- **טווחי שכר עדכניים** לתפקידים טכניים (אם נמצא)
- אופציות/RSU
- תנאים מיוחדים

## 📈 מצב עסקי נוכחי (2025-2026)
- **פיטורים או גיוסים אחרונים?**
- מגמת צמיחה
- אתגרים עסקיים
- תחרות
- רווחיות / הכנסות (אם ציבורית)

## 🎯 טיפים לראיון ב-${companyName}
- מה הם מחפשים (לפי המשרות)
- תהליך הראיון (שלבים, משך)
- שאלות שכדאי להכין
- איך לעשות רושם

## ⚖️ יתרונות וחסרונות
יתרונות (4-5) וחסרונות (3-4) מנקודת מבט של מועמד.

**חשוב:** ציין מקורות למידע שמצאת. אם מידע מסוים לא עדכני — ציין את זה.`,
    }],
  });
}

// ── LinkedIn outreach message ──
export async function generateLinkedInOutreach(cvText: string, job: Job): Promise<string> {
  return cachedGenerate({
    type: "linkedin",
    cacheKey: [job.id],
    model: cheapModel(),
    maxTokens: 1000,
    messages: [{
      role: "user",
      content: `קורות חיים:
---
${cvText.slice(0, 2000)}
---

משרה:
חברה: ${job.company}
תפקיד: ${job.title}
מיקום: ${job.location}

המשימה:
צור 3 הודעות LinkedIn מותאמות. כל הודעה צריכה להיות קצרה (3-5 שורות), מקצועית, ולא "spammy". פורמט Markdown.

# הודעות LinkedIn: ${job.title} @ ${job.company}

## 1️⃣ הודעה ל-Recruiter / Talent Acquisition
הודעה קצרה ב**אנגלית** (recruiters מעדיפים אנגלית). מזכירה את המשרה הספציפית, חיבור קצר לניסיון, ובקשה לשיחה.

## 2️⃣ הודעה ל-Hiring Manager / Team Lead
הודעה ב**אנגלית**, יותר טכנית. מדברת על אתגר ספציפי שהמועמד יכול לפתור, לא רק "אני מחפש עבודה".

## 3️⃣ הודעה ל-עובד/ת בחברה (בקשת referral)
הודעה ב**עברית** (כי בד"כ ישראלים). קצרה, ישירה, לא מתנצלת. מבקשת referral בצורה מכובדת.

---

## 💡 טיפים לפנייה
3-4 טיפים קצרים: מתי הכי טוב לשלוח, איך לעקוב, מה לא לעשות.

הנחיות: ריאליסטי, לא sycophantic, לא גנרי. כל הודעה צריכה להיות מותאמת למשרה ולרקע הספציפיים.`,
    }],
  });
}

// ── Follow-up email ──
// Phase 1b pilot: this is the only function that opts into the AI Gateway
// transport via viaLlmRouter. Quality-degradation risk is lowest here because
// the user edits the resulting email before sending. See docs/phase1b for the
// rationale and test plan.
export async function generateFollowUp(cvText: string, job: Job, daysSinceApplied: number): Promise<string> {
  return cachedGenerate({
    type: "followup",
    cacheKey: [job.id, String(daysSinceApplied)],
    model: cheapModel(),
    maxTokens: 800,
    messages: [{
      role: "user",
      content: `קורות חיים של המועמד:
---
${cvText.slice(0, 1500)}
---

משרה שהוגשה אליה:
חברה: ${job.company}
תפקיד: ${job.title}

הוגש לפני ${daysSinceApplied} ימים ולא התקבלה תגובה.

צור מייל follow-up קצר ומקצועי. פורמט Markdown.

# Follow-Up: ${job.title} @ ${job.company}

## 📧 מייל באנגלית
Subject line + body. קצר (4-6 שורות), מנומס, מזכיר את ההגשה, מוסיף ערך קטן (לא רק "מה המצב?").

## 📧 מייל בעברית
אותו דבר בעברית, לגרסה ישראלית.

## ⏰ המלצת תזמון
- מתי לשלוח (יום + שעה)
- אם לא עונים — מתי לנסות שוב
- מתי לוותר

קצר וענייני. אל תהיה desperate.`,
    }],
  });
}

// ── Job comparison (no AI needed, just structured data) ──
export function compareJobs(jobs: Job[]): string {
  if (!jobs.length) return "אין משרות להשוואה";

  const rows: [string, ...string[]][] = [
    ["🏷️ תפקיד", ...jobs.map(j => j.title)],
    ["🏢 חברה", ...jobs.map(j => j.company)],
    ["📍 מיקום", ...jobs.map(j => j.location)],
    ["📂 מחלקה", ...jobs.map(j => j.department || "—")],
    ["🌐 מקור", ...jobs.map(j => j.ats)],
    ["📊 ציון", ...jobs.map(j => String((j as any).score ?? "—"))],
    ["🏅 דרגה", ...jobs.map(j => (j as any).grade ?? "—")],
    ["📝 סיבות", ...jobs.map(j => ((j as any).reasons || []).join(", ") || "—")],
    ["🔗 קישור", ...jobs.map(j => j.url)],
  ];

  // Extract key tech from description
  const techKeywords = ["React", "Node.js", "TypeScript", "Python", "Java", "Go", "Rust", "C#", ".NET", "AWS", "Azure", "GCP", "Docker", "Kubernetes", "SQL", "MongoDB", "Redis", "Kafka", "GraphQL"];
  const techRow: string[] = jobs.map(j => {
    const desc = `${j.title} ${j.description}`.toLowerCase();
    return techKeywords.filter(t => desc.includes(t.toLowerCase())).join(", ") || "—";
  });
  rows.push(["🛠️ טכנולוגיות", ...techRow]);

  const colWidth = Math.max(20, ...rows.flatMap(r => r.map(c => c.length)));
  let md = `# השוואת ${jobs.length} משרות\n\n`;
  md += `| ${rows[0].map((_, i) => i === 0 ? "**קטגוריה**" : `**משרה ${i}**`).join(" | ")} |\n`;
  md += `|${rows[0].map(() => "---").join("|")}|\n`;
  for (const row of rows) {
    md += `| ${row.map(c => c.length > 60 ? c.slice(0, 57) + "..." : c).join(" | ")} |\n`;
  }
  return md;
}

// ── AI Opportunities report ──
export async function generateAIOpportunities(cvText: string | null): Promise<string> {
  const profileContext = cvText
    ? `\nרקע המועמד (מקורות חיים):\n---\n${cvText.slice(0, 2000)}\n---\nהתאם את ההמלצות לרקע הספציפי הזה.\n`
    : "\nאין פרופיל מועמד — תן המלצות כלליות.\n";

  return cachedGenerate({
    type: "ai-opportunities",
    cacheKey: [cvText ? "with-profile" : "general"],
    model: model(),
    maxTokens: 5000,
    webSearch: true,
    messages: [{
      role: "user",
      content: `התאריך היום: ${TODAY()}.

**חפש באינטרנט** מידע עדכני על:
- משרות AI/ML חמות בישראל ובעולם (2025-2026)
- קורסים וcertifications חדשים ב-AI
- כלי AI שכדאי ללמוד
- מגמות שכר ב-AI
- חברות שמגייסות AI engineers בישראל
${profileContext}

הכן מסמך Markdown מקיף בעברית:

# 🤖 הזדמנויות AI — עדכני ל-${TODAY()}

## 🔥 תפקידי AI הכי מבוקשים עכשיו

### בישראל
רשימה של 8-10 תפקידי AI שמגייסים בישראל כרגע. לכל אחד:
- **שם התפקיד** + טווח שכר משוער (₪/חודש)
- מה הוא דורש (1-2 משפטים)
- חברות שמגייסות לתפקיד הזה (אם מצאת)

### גלובלי (Remote)
5-8 תפקידי AI remote שפתוחים למועמדים בישראל/worldwide. עם טווחי שכר ב-$.

## 📚 לימודים והסמכות — מה שווה ב-2025-2026

### קורסים חינמיים
5-6 קורסים חינמיים (או כמעט) שכדאי לעשות עכשיו. שם מלא + פלטפורמה + קישור אם יש + כמה זמן לוקח + למה שווה.

### הסמכות בתשלום ששוות את הכסף
4-5 certifications שמעסיקים באמת מחפשים. עלות + ROI מוערך.

### פרויקטים שיבנו לך פורטפוליו
5-6 רעיונות לפרויקטים ב-AI שאפשר לבנות ולהציג בראיונות. לכל פרויקט: מה לבנות, איזה טכנולוגיות, כמה זמן, ואיך זה עוזר בקריירה.

## 🛠️ כלי AI שחובה לדעת ב-2026

רשימת 10-12 כלים/frameworks שמעסיקים מחפשים:
- **שם הכלי** — מה הוא עושה — למה חם עכשיו — קישור ללמידה
- כולל: LLM APIs, frameworks (LangChain/LlamaIndex/CrewAI/etc.), vector DBs, fine-tuning, deployment, evaluation

## 💰 שכר AI בישראל — נתונים עדכניים

טבלה עם טווחי שכר לפי רמה ותפקיד:
| תפקיד | Junior | Mid | Senior | Staff/Lead |
|---|---|---|---|---|
| ML Engineer | | | | |
| AI/LLM Engineer | | | | |
| Data Scientist | | | | |
| MLOps | | | | |
| AI Product Manager | | | | |

ציין מקורות לנתוני השכר.

## 🏢 חברות שמגייסות AI בישראל (עכשיו)
10-15 חברות שמגייסות כרגע תפקידי AI — מקור: לינקדאין, Greenhouse, חדשות.

## 🎯 המלצות אישיות
${cvText ? "בהתבסס על הרקע של המועמד — 5-7 המלצות ספציפיות: מה ללמוד, לאיזה תפקידים להגיש, מה לחזק, מה חסר." : "5-7 המלצות כלליות למי שרוצה להיכנס לתחום ה-AI."}

## 🔮 מגמות 2026-2027
5-6 תחזיות לגבי שוק ה-AI: מה יהיה חם, מה ייעלם, איפה הכסף.

---
*מבוסס על חיפוש אינטרנט עדכני. ציין מקורות בסוף כל סעיף.*`,
    }],
  });
}

// ── WLB (Work-Life Balance) company ranking ──
export async function generateWLBRanking(): Promise<string> {
  return cachedGenerate({
    type: "wlb-ranking",
    cacheKey: ["v1"],
    model: model(),
    maxTokens: 5000,
    webSearch: true,
    messages: [{
      role: "user",
      content: `התאריך היום: ${TODAY()}.

**חפש באינטרנט** מידע עדכני על:
- דירוג Work-Life Balance בחברות הייטק בישראל
- ביקורות עובדים ב-Glassdoor, LinkedIn, AllJobs
- מדיניות עבודה מרחוק/היברידית עדכנית
- שעות עבודה, חופשות, burnout
- סקרי שביעות רצון עובדים 2025-2026

הכן דירוג של 25-30 חברות טק בישראל לפי Work-Life Balance. פורמט Markdown בעברית.

# ⚖️ דירוג Work-Life Balance — חברות טק בישראל (${TODAY()})

## 🏆 מתודולוגיה
הסבר קצר (3-4 משפטים) על מה מבוסס הדירוג: Glassdoor, ביקורות עובדים, מדיניות חברה, שעות עבודה, חופשות, מדיניות hybrid/remote. ציין שזה אומדן מבוסס מידע ציבורי.

## 🥇 Tier 1 — WLB מצוין (ציון 9-10)
לכל חברה:
### X. שם החברה
- **ציון WLB:** X/10
- **מדיניות hybrid/remote:** (כמה ימים במשרד, מרחוק, גמישות)
- **שעות עבודה:** (טיפוסי, crunch, overtime)
- **חופשות:** (ימי חופש, unlimited PTO?)
- **יתרונות WLB:** (2-3 דברים ספציפיים)
- **חסרונות:** (1-2 אם יש)
- **ציטוט עובד:** (משפט אחד מביקורת אם מצאת)

## 🥈 Tier 2 — WLB טוב (ציון 7-8.5)
אותו פורמט.

## 🥉 Tier 3 — WLB סביר (ציון 5-6.5)
אותו פורמט.

## ⚠️ Tier 4 — WLB מאתגר (ציון מתחת 5)
אותו פורמט — חברות ידועות כתובעניות.

## 📊 טבלת סיכום

| # | חברה | ציון WLB | Hybrid/Remote | שעות | חופש שנתי | הערה |
|---|---|---|---|---|---|---|
| 1 | ... | X/10 | ... | ... | ... | ... |
(כל 25-30 החברות בטבלה אחת)

## 💡 מה לבדוק לפני שמקבלים הצעה
5-7 שאלות ספציפיות לשאול בראיון כדי להבין את ה-WLB האמיתי (לא מה שכתוב באתר):
- "מה השעה הממוצעת שאנשים הולכים הביתה?"
- "כמה פעמים בשנה יש crunch?"
- וכו'

## 🔍 מקורות
ציין את המקורות שמצאת (Glassdoor, LinkedIn, כתבות, סקרים).

---
**חשוב:** ציין בבירור כשמידע לא ודאי. עדיף לכתוב "לא ברור" מאשר להמציא. ציין מקורות ספציפיים.`,
    }],
  });
}

// ── Structured CV extraction ──
function parseJsonFromText(text: string): any {
  // Strip markdown code fences if present
  let clean = text.trim();
  const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) clean = fenceMatch[1].trim();
  // Find first { and last } to handle surrounding text
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) clean = clean.slice(start, end + 1);
  return JSON.parse(clean);
}

export async function extractStructuredCV(cvText: string, language: "en" | "he"): Promise<any> {
  const langInstructions = language === "en"
    ? "Extract all content in English. Translate Hebrew to English if needed."
    : "חלץ את כל התוכן בעברית. תרגם מאנגלית לעברית אם צריך.";

  return parseJsonFromText(await cachedGenerate({
    type: "structured-cv",
    cacheKey: [language, cvText.length.toString(), cvText.slice(0, 100).replace(/\s/g, "")],
    model: cheapModel(),
    maxTokens: 4000,
    messages: [{
      role: "user",
      content: `Extract the CV below into a structured JSON. ${langInstructions}

CV TEXT:
---
${cvText}
---

Return ONLY valid JSON matching this schema (no explanations, no markdown):

{
  "language": "${language}",
  "header": {
    "name": "Full Name",
    "title": "Current Job Title",
    "email": "...",
    "phone": "...",
    "location": "City, Country",
    "linkedin": "URL or username",
    "github": "URL or username",
    "website": "URL"
  },
  "summary": "2-4 sentence professional summary",
  "experience": [
    {
      "company": "Company Name",
      "title": "Job Title",
      "location": "City",
      "start_date": "Jan 2020",
      "end_date": "Present",
      "description": "1-2 sentence role description (optional)",
      "achievements": ["Bullet 1", "Bullet 2", "Bullet 3"],
      "technologies": ["React", "Node.js"]
    }
  ],
  "education": [
    {
      "institution": "University Name",
      "degree": "B.Sc.",
      "field": "Computer Science",
      "location": "City",
      "start_date": "2015",
      "end_date": "2019",
      "gpa": "3.8",
      "honors": "Cum Laude"
    }
  ],
  "skills": [
    { "category": "Languages", "skills": ["JavaScript", "Python"] },
    { "category": "Frameworks", "skills": ["React", "Express"] },
    { "category": "Tools", "skills": ["Docker", "Git"] }
  ],
  "projects": [
    { "name": "Project", "description": "...", "url": "...", "technologies": [], "date": "2023" }
  ],
  "certifications": [
    { "name": "AWS Certified", "issuer": "AWS", "date": "2022", "url": "..." }
  ],
  "languages": [
    { "name": "English", "level": "Native" }
  ]
}

Rules:
- Preserve dates as written ("Jan 2020 - Present", "2020-2023", etc.)
- Extract ALL achievements as separate bullets — do not merge
- Group skills logically (Languages, Frameworks, DBs, DevOps, etc.)
- Empty arrays [] for missing sections, do not omit fields
- Only include optional fields if you find them in the CV
- ${language === "en" ? "Use professional English" : "השתמש בעברית מקצועית"}`,
    }],
  }));
}

// ── Smart add: incorporate free text into structured CV ──
export async function cvSmartAdd(structured: any, userText: string, language: "en" | "he"): Promise<{ updated: any; summary: string }> {
  const langInstr = language === "en" ? "Output in English." : "פלט בעברית.";
  const result = await cachedGenerate({
    type: "cv-smart-add",
    cacheKey: [language, userText.slice(0, 100), JSON.stringify(structured.header).slice(0, 100), Date.now().toString()],
    model: cheapModel(),
    maxTokens: 4000,
    messages: [{
      role: "user",
      content: `You are a CV editor. The user has a structured CV in ${language === "en" ? "English" : "Hebrew"} and wants to add this information intelligently to the right place(s).

USER INPUT (free text):
"""
${userText}
"""

CURRENT STRUCTURED CV:
${JSON.stringify(structured, null, 2)}

Your task:
1. Analyze the user's free text — figure out what they want to add (new job? new bullet to existing job? new skill? new project? update summary?)
2. Modify the structured CV to incorporate this — in the right place(s)
3. Be conservative: only add/modify what's clearly stated, don't invent
4. Keep existing data intact unless explicitly contradicted

Return STRICTLY this JSON shape (no markdown, no code fences):
{
  "updated": <the full modified structured CV in the SAME schema>,
  "summary": "<1-2 sentence Hebrew summary of what you changed and where>"
}

${langInstr}`,
    }],
  });
  const parsed = parseJsonFromText(result);
  return parsed;
}

// ── Analyze CV and return feedback ──
export async function cvAnalyze(structured: any, language: "en" | "he"): Promise<string> {
  return cachedGenerate({
    type: "cv-analyze",
    cacheKey: [language, JSON.stringify(structured).length.toString(), structured.header?.name || "", Date.now().toString().slice(0, 8)],
    model: model(),
    maxTokens: 3000,
    webSearch: false,
    messages: [{
      role: "user",
      content: `אתה יועץ קורות חיים מומחה לשוק ההייטק הישראלי 2026. נתח את ה-CV הזה (גרסה ${language === "en" ? "אנגלית" : "עברית"}) וספק משוב מקצועי בעברית בפורמט Markdown.

CV מובנה:
${JSON.stringify(structured, null, 2)}

הכן דוח עם הסעיפים:

# 📊 ניתוח קורות החיים

## 🎯 ציון כללי
ציון X/100 + 2-3 משפטים על הרושם הכללי.

## 💪 חוזקות
3-5 דברים שעובדים טוב.

## ⚠️ חולשות ומה לתקן
3-6 בעיות ספציפיות עם המלצה מדויקת לכל אחת. למשל:
- "תיאור משרה X חסר מספרים — הוסף KPIs"
- "summary ארוך מדי — צמצם ל-3 משפטים"

## 📋 בדיקה לפי סעיף
לכל סעיף ב-CV (header / summary / experience / education / skills / projects / certifications):
- ✅/⚠️/❌ סטטוס
- הערה ספציפית אם יש בעיה

## 🤖 ATS-Friendliness
ציון X/10. סמן בעיות שיכולות להיתקע ב-ATS:
- מילות מפתח חסרות
- פורמט בעייתי
- מבנה לא סטנדרטי

## ⚡ פעולות מיידיות (Top 5)
5 שינויים ספציפיים שיגרמו להבדל המשמעותי ביותר. ממוספרים, פרקטיים, עם דוגמה לפני/אחרי אם רלוונטי.

## 🎨 ניסוח חזק יותר
2-3 דוגמאות לbullets שהיית יכול לחזק. הראה "לפני → אחרי".

ענייני, ישיר, מבוסס דוגמאות. החזר רק את הניתוח.`,
    }],
  });
}

// ── Improve CV based on analysis ──
export async function cvImproveFromAnalysis(structured: any, analysisText: string, language: "en" | "he"): Promise<{ improved: any; summary: string }> {
  const result = await cachedGenerate({
    type: "cv-improve",
    cacheKey: [language, structured.header?.name || "", analysisText.slice(0, 100), Date.now().toString().slice(0, 10)],
    model: model(),
    maxTokens: 5000,
    messages: [{
      role: "user",
      content: `אתה עורך CV מקצועי. יש לך CV מובנה וניתוח מקצועי שלו. המשימה שלך: ליצור גרסה משופרת של ה-CV שמתקנת את הבעיות שהוצגו בניתוח.

CV מקורי:
${JSON.stringify(structured, null, 2)}

ניתוח מקצועי:
"""
${analysisText}
"""

הוראות שיפור:
1. **ישם את ההמלצות מהניתוח** — בעיקר ה-"Top 5 פעולות" וה-"ניסוח חזק יותר"
2. **חזק bullets חלשים** — הפוך פסיביים לאקטיביים, הוסף מספרים אם רמוז במקור
3. **שפר תקציר** אם הניתוח אמר שהוא חלש/ארוך
4. **שמור על מבנה ה-JSON זהה** לחלוטין
5. **אל תמציא** — רק תחזק את מה שכבר קיים. אם אין מספרים בקו"ח המקורי — אל תוסיף "increased revenue by 200%" סתם
6. שפה: ${language === "en" ? "English" : "עברית"}
7. שמור את כל הסעיפים והפריטים — רק שפר אותם

החזר JSON תקין בפורמט הזה (ללא markdown fences):
{
  "improved": <ה-CV המשופר במלואו, באותה סכמה>,
  "summary": "<פסקה קצרה בעברית: מה שיפרת ולמה>"
}`,
    }],
  });
  return parseJsonFromText(result);
}

// ── Compact CV — reduce content to fit 2 pages ──
export async function cvCompact(structured: any, language: "en" | "he"): Promise<any> {
  const result = await cachedGenerate({
    type: "cv-compact",
    cacheKey: [language, JSON.stringify(structured).length.toString(), structured.header?.name || ""],
    model: model(),
    maxTokens: 4000,
    messages: [{
      role: "user",
      content: `You are a CV optimization expert. Compress this structured CV to fit in 2 pages maximum (DOCX/PDF) while keeping ALL important information.

CURRENT CV:
${JSON.stringify(structured, null, 2)}

Compression rules:
1. Keep the EXACT same JSON schema and structure
2. Cut down achievements: keep top 3-4 per job (most impactful)
3. Tighten descriptions: shorter, punchier sentences
4. Remove or shorten older experience (>10 years ago) — keep just title + company + dates
5. Remove redundant skills mentioned in experience already
6. Tighten summary to 2-3 sentences max
7. Keep all dates, companies, titles, key achievements
8. Skills section: keep top categories only
9. Education: keep degree + institution + year, drop GPA/honors unless prestigious
10. Output language: ${language === "en" ? "English" : "Hebrew"}

DO NOT invent content. Only condense what exists.

Return STRICTLY valid JSON in the same schema (no markdown fences, no commentary).`,
    }],
  });
  return parseJsonFromText(result);
}

// ── Translate structured CV to another language ──
export async function translateStructuredCV(structured: any, toLanguage: "en" | "he"): Promise<any> {
  const target = toLanguage === "en" ? "English" : "Hebrew";
  return parseJsonFromText(await cachedGenerate({
    type: "translated-cv",
    cacheKey: [toLanguage, JSON.stringify(structured).length.toString(), structured.header?.name || ""],
    model: cheapModel(),
    maxTokens: 4000,
    messages: [{
      role: "user",
      content: `Translate this structured CV JSON to ${target}. Keep the SAME JSON structure, only translate text content.

DO NOT translate:
- Email, phone, URLs (linkedin, github, website)
- Technology names (React, Node.js, AWS, etc.)
- Company names (keep original)
- Brand names

DO translate:
- Job titles
- Descriptions, achievements, summary
- Education degrees and fields
- Locations (cities/countries to ${target})
- Skill category names
- Project descriptions
- Certification names (only if commonly translated)

Source CV:
${JSON.stringify(structured, null, 2)}

Return ONLY valid JSON. Set "language": "${toLanguage}".`,
    }],
  }));
}

// ── Render structured CV to Markdown ──
export function structuredCVToMarkdown(s: any): string {
  const isHe = s.language === "he";
  const t = isHe ? heLabels : enLabels;
  let md = "";

  // Header
  md += `# ${s.header.name}\n\n`;
  md += `**${s.header.title}**\n\n`;
  const contact = [
    s.header.email && `📧 ${s.header.email}`,
    s.header.phone && `📱 ${s.header.phone}`,
    s.header.location && `📍 ${s.header.location}`,
    s.header.linkedin && `💼 ${s.header.linkedin}`,
    s.header.github && `🐙 ${s.header.github}`,
    s.header.website && `🌐 ${s.header.website}`,
  ].filter(Boolean).join(" · ");
  if (contact) md += `${contact}\n\n---\n\n`;

  // Summary
  if (s.summary) md += `## ${t.summary}\n\n${s.summary}\n\n`;

  // Experience
  if (s.experience?.length) {
    md += `## ${t.experience}\n\n`;
    for (const e of s.experience) {
      md += `### ${e.title} — ${e.company}\n`;
      md += `*${e.start_date} – ${e.end_date}${e.location ? ` · ${e.location}` : ""}*\n\n`;
      if (e.description) md += `${e.description}\n\n`;
      if (e.achievements?.length) {
        for (const a of e.achievements) md += `- ${a}\n`;
        md += "\n";
      }
      if (e.technologies?.length) md += `**${t.tech}:** ${e.technologies.join(", ")}\n\n`;
    }
  }

  // Education
  if (s.education?.length) {
    md += `## ${t.education}\n\n`;
    for (const e of s.education) {
      md += `### ${e.degree}${e.field ? ` ${t.in} ${e.field}` : ""}\n`;
      md += `**${e.institution}**${e.location ? ` · ${e.location}` : ""} · *${e.start_date} – ${e.end_date}*\n`;
      const extras = [e.gpa && `GPA: ${e.gpa}`, e.honors].filter(Boolean).join(" · ");
      if (extras) md += `${extras}\n`;
      md += "\n";
    }
  }

  // Skills
  if (s.skills?.length) {
    md += `## ${t.skills}\n\n`;
    for (const cat of s.skills) {
      md += `**${cat.category}:** ${cat.skills.join(", ")}\n\n`;
    }
  }

  // Projects
  if (s.projects?.length) {
    md += `## ${t.projects}\n\n`;
    for (const p of s.projects) {
      md += `### ${p.name}${p.date ? ` (${p.date})` : ""}\n`;
      md += `${p.description}\n`;
      if (p.url) md += `🔗 ${p.url}\n`;
      if (p.technologies?.length) md += `**${t.tech}:** ${p.technologies.join(", ")}\n`;
      md += "\n";
    }
  }

  // Certifications
  if (s.certifications?.length) {
    md += `## ${t.certifications}\n\n`;
    for (const c of s.certifications) {
      md += `- **${c.name}** — ${c.issuer} *(${c.date})*${c.url ? ` · ${c.url}` : ""}\n`;
    }
    md += "\n";
  }

  // Languages
  if (s.languages?.length) {
    md += `## ${t.languages}\n\n`;
    for (const l of s.languages) md += `- **${l.name}**: ${l.level}\n`;
    md += "\n";
  }

  return md;
}

const enLabels = {
  summary: "Professional Summary",
  experience: "Experience",
  education: "Education",
  skills: "Skills",
  projects: "Projects",
  certifications: "Certifications",
  languages: "Languages",
  tech: "Technologies",
  in: "in",
};
const heLabels = {
  summary: "תקציר מקצועי",
  experience: "ניסיון תעסוקתי",
  education: "השכלה",
  skills: "כישורים",
  projects: "פרויקטים",
  certifications: "הסמכות",
  languages: "שפות",
  tech: "טכנולוגיות",
  in: "ב-",
};

// ── Mentor chat ──
export interface MentorContext {
  goal: any;
  cvText: string | null;
  trackedSummary: string;          // "5 interested, 2 applied, 1 interview"
  recentActivity: string;          // "3 משרות חדשות נוספו השבוע, 1 הוגשה"
  conversationHistory: { role: "user" | "assistant"; content: string }[];
}

export async function mentorReply(ctx: MentorContext, userMessage: string): Promise<string> {
  const anthropic = client();

  const goalText = ctx.goal ? `
**מטרת המועמד:**
- תפקיד יעד: ${ctx.goal.target_role}
- שכר יעד: ${ctx.goal.target_salary_monthly ? `₪${ctx.goal.target_salary_monthly.toLocaleString()}/חודש` : "לא צוין"}
- לוז: ${ctx.goal.target_timeline_months} חודשים
- מכשולים נוכחיים: ${ctx.goal.current_obstacles || "—"}
- מחויבות שבועית: ${ctx.goal.commitments_per_week || "—"}
- למה זה חשוב לו: ${ctx.goal.why || "—"}
` : "**אין מטרה מוגדרת — שאל את המועמד מה המטרה שלו.**";

  const cvSnippet = ctx.cvText ? `\n**קורות חיים בקצרה:**\n${ctx.cvText.slice(0, 1500)}\n` : "";

  const systemPrompt = `אתה מנטור קריירה אישי למפתח/ת בתעשיית ההייטק הישראלית. תאריך: ${TODAY()}.

${goalText}
${cvSnippet}
**סטטוס המעקב הנוכחי:** ${ctx.trackedSummary}
**פעילות אחרונה:** ${ctx.recentActivity}

**איך אתה צריך להתנהג:**
- כמו מנטור אמיתי, לא בוט. ישיר, חם אבל לא מתחנף.
- שאל שאלות חודרות כשצריך — אל תיתן עצות גנריות.
- תן סטפים קונקרטיים, לא רעיונות מעורפלים.
- כשהמועמד אומר "אני תקוע" — חקור למה לפני שתציע פתרונות.
- הזכר את המטרה שלו אם הוא נסחף לדברים לא רלוונטיים.
- אם הוא לא עשה כלום שבוע שלם — שאל למה, אל תתעלם.
- ציין מספרים ספציפיים מהמעקב כשרלוונטי ("יש לך 5 משרות במצב interested מ-3 שבועות, מה קורה?").
- שמור על תשובות קצרות יחסית — זו שיחה, לא הרצאה. (3-6 משפטים בד"כ).
- בסוף הודעה — שאל שאלה אחת ממוקדת (חוץ מאם זה ברור שלא צריך).
- בעברית.`;

  const messages = ctx.conversationHistory.length === 0
    ? [{ role: "user" as const, content: userMessage }]
    : [...ctx.conversationHistory.map(m => ({ role: m.role, content: m.content })), { role: "user" as const, content: userMessage }];

  const budget = checkBudget();
  if (!budget.ok) throw new Error(budget.message || "הגעת לתקציב היומי");

  const llmMessages: LLMMessage[] = messages.map(m => ({
    role: m.role as "user" | "assistant",
    content: typeof m.content === "string" ? m.content : "",
  }));
  const response = await llmGenerate({
    maxTokens: 800,
    system: systemPrompt,
    messages: llmMessages,
  });
  logCost("mentor", response.model, response.input_tokens, response.output_tokens, false, false);
  return response.text;
}

// ── GitHub portfolio analysis ──
export async function generateGitHubAnalysis(username: string, reposSummary: string, cvText: string | null): Promise<string> {
  const profileContext = cvText
    ? `\nרקע המועמד (מקורות חיים):\n---\n${cvText.slice(0, 1500)}\n---\nהתאם את ההמלצות לרקע הספציפי.\n`
    : "";

  // Cache key includes repo count + names hash so new repos bust the cache
  const repoFingerprint = String(reposSummary.split("\n").length) + "-" +
    reposSummary.slice(0, 200).replace(/[^a-zA-Z0-9]/g, "").slice(0, 30);

  return cachedGenerate({
    type: "github-analysis",
    cacheKey: [username, repoFingerprint],
    model: model(),
    maxTokens: 4000,
    webSearch: false,
    messages: [{
      role: "user",
      content: `התאריך היום: ${TODAY()}.

אתה מומחה portfolio review למפתחים. נתח את חשבון GitHub של **${username}** ודרג את הפרויקטים כ-portfolio.
${profileContext}
ריפוזיטוריז ציבוריים (לא forks):
${reposSummary}

הכן דוח Markdown בעברית:

# 🐙 סקירת Portfolio — ${username}

## 📊 ציון כללי
תן ציון X/100 לאיכות ה-portfolio הזה מנקודת מבט של מגייס. הסבר ב-2-3 משפטים.

## 🏆 Top 5 פרויקטים (מדורגים)
לכל פרויקט מהחמשת הטובים:
### X. שם הפרויקט
- **ציון:** X/10
- **שפה:** ...
- **למה טוב:** (1-2 משפטים)
- **מה לשפר:** (1-2 משפטים ספציפיים)
- **ערך בראיון:** (משפט אחד)

## ⚠️ פרויקטים שכדאי להסתיר או לשפר
רשימה של 3-5 ריפוזיטוריז שפוגעים ב-portfolio (למשל: TODO apps, ריפוז ריקים, קוד לא מסודר). עם הסבר למה ומה לעשות.

## 📋 מה חסר ב-Portfolio הזה
3-5 סוגי פרויקטים שמגייס היה רוצה לראות ואין. למשל: "אין פרויקט עם tests", "אין deployment", "אין backend project".

## 🎯 תוכנית פעולה — 30 ימים
5-7 צעדים קונקרטיים בסדר עדיפות. כל צעד = פעולה ספציפית + כמה זמן + למה.
למשל: "שבוע 1: הוסף README מפורט ל-3 הפרויקטים הטובים (2 שעות)"

## 💡 טיפים ל-GitHub Profile
3-4 שיפורים ל-profile עצמו: README.md, pinned repos, contribution graph, bio.

ענייני, ישיר, פרקטי. ללא קלישאות. אל תמציא ריפוזיטוריז שלא ברשימה.`,
    }],
  });
}

// ── Generate cover letter for a job (uses cheap model) ──
export async function generateCoverLetter(cvText: string, job: Job, lang: Lang = "auto"): Promise<string> {
  return cachedGenerate({
    type: "cover-letter",
    cacheKey: [job.id, lang],
    model: cheapModel(),
    maxTokens: 1500,
    messages: [
      {
        role: "user",
        content: `קורות חיים של המועמד:
---
${cvText}
---

משרה:
חברה: ${job.company}
תפקיד: ${job.title}
תיאור:
${job.description.replace(/<[^>]+>/g, " ").slice(0, 3000)}

המשימה:
כתוב מכתב פתיחה (cover letter) מותאם וממוקד. 3-4 פסקאות קצרות. טון מקצועי אבל אישי. הדגש 2-3 נקודות קשר ספציפיות בין הניסיון של המועמד לדרישות המשרה. אל תמציא עובדות.

שפה: ${langLabel(lang)}.

פורמט: Markdown. החזר רק את המכתב עצמו בלי הקדמה.`,
      },
    ],
  });
}
