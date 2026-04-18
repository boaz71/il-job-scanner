import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import mammoth from "mammoth";
import type { Job, Profile } from "./types.js";
import { getCached, setCache } from "./cache.js";
import { logCost } from "./costs.js";

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
async function cachedGenerate(opts: {
  type: string;
  cacheKey: string[];
  model: string;
  maxTokens: number;
  messages: Anthropic.Messages.MessageParam[];
  system?: string;
  webSearch?: boolean;
}): Promise<string> {
  // Check cache first
  const cached = getCached(opts.type, ...opts.cacheKey);
  if (cached) {
    logCost(opts.type, opts.model, 0, 0, false, true);
    return cached;
  }

  const anthropic = client();
  const tools = opts.webSearch ? [WEB_SEARCH_TOOL] : undefined;
  const msg = await anthropic.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: opts.messages,
    ...(opts.system ? { system: opts.system } : {}),
    ...(tools ? { tools } : {}),
  });

  const text = extractText(msg);
  logCost(opts.type, opts.model, msg.usage.input_tokens, msg.usage.output_tokens, !!opts.webSearch, false);
  setCache(opts.type, text, !!opts.webSearch, ...opts.cacheKey);
  return text;
}

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.includes("PUT-YOUR-KEY-HERE")) {
    throw new Error("חסר ANTHROPIC_API_KEY ב-environment (ערוך את .env והפעל מחדש את npm run web)");
  }
  return new Anthropic({ apiKey });
}

// Web search tool for getting current information
const WEB_SEARCH_TOOL = { type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 5 };

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
  const anthropic = client();
  const msg = await anthropic.messages.create({
    model: model(),
    max_tokens: 1500,
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

  const fullText = extractText(msg);
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
  const anthropic = client();
  const msg = await anthropic.messages.create({
    model: model(),
    max_tokens: 3000,
    tools: [WEB_SEARCH_TOOL],
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

  const fullText = extractText(msg);
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
  const anthropic = client();
  const msg = await anthropic.messages.create({
    model: model(),
    max_tokens: 3000,
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
  const content = msg.content[0];
  if (content.type !== "text") throw new Error("תשובה לא תקינה");
  return content.text;
}

// ── Generate interview preparation for a job ──
export async function generateInterviewPrep(cvText: string, job: Job): Promise<string> {
  const anthropic = client();
  const msg = await anthropic.messages.create({
    model: model(),
    max_tokens: 4000,
    tools: [WEB_SEARCH_TOOL],
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
  const content = msg.content[0];
  if (content.type !== "text") throw new Error("תשובה לא תקינה");
  return content.text;
}

// ── Skill gap analysis for a specific job ──
export async function analyzeSkillGap(cvText: string, job: Job): Promise<string> {
  const anthropic = client();
  const msg = await anthropic.messages.create({
    model: model(),
    max_tokens: 2500,
    tools: [WEB_SEARCH_TOOL],
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
  return extractText(msg);
}

// ── Salary negotiation prep ──
export async function generateSalaryPrep(cvText: string, job: Job): Promise<string> {
  const anthropic = client();
  const msg = await anthropic.messages.create({
    model: model(),
    max_tokens: 2500,
    tools: [WEB_SEARCH_TOOL],
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
  return extractText(msg);
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

  const messages = history.length === 0
    ? [{ role: "user" as const, content: "בוא נתחיל את הראיון." }]
    : history;

  const msg = await anthropic.messages.create({
    model: model(),
    max_tokens: 1000,
    system: systemPrompt,
    messages,
  });
  return extractText(msg);
}

// ── Company deep dive (with web search for current data) ──
export async function companyDeepDive(companyName: string, jobsContext: string): Promise<string> {
  const anthropic = client();
  const msg = await anthropic.messages.create({
    model: model(),
    max_tokens: 4000,
    tools: [WEB_SEARCH_TOOL],
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
  return extractText(msg);
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
