# IL Job Scanner — סורק משרות טק ישראלי

## Quick Start

```bash
npm install
npm run web             # ממשק ווב — http://localhost:5174
npm run scan            # סריקת כל החברות (CLI)
npm run match           # ציון התאמה למשרות (CLI)
```

## מה זה?

מערכת חיפוש עבודה שמלווה מועמד מאיתור משרה ועד הגשה, מעקב והכנה לראיון.
המשרות נאספות דרך **APIs ציבוריים של מערכות ATS** — ללא scraping, ללא proxies, ללא אימות.
Node.js + TypeScript (ESM), מורץ ישירות עם `tsx`, ללא build. ממשק ווב ב-vanilla JS עם 12 טאבים.

**עיקרון מנחה:** המערכת מכינה, מאמתת ומתעדת — היא **אף פעם לא מגישה מועמדות בשם המשתמש**.
ההגשה נעשית ע"י המשתמש באתר החברה, אחרי אישור מפורש.

טקסטים בממשק, הודעות ופרומפטים ל-AI — בעברית.

## פקודות

```bash
npm run web                                     # ממשק ווב (PORT משנה פורט)
npm run scan                                    # סרוק הכל
npm run scan -- --keyword "backend"             # סנן לפי מילת מפתח
npm run scan -- --location "tel aviv"           # סנן לפי מיקום
npm run scan -- --archive                       # שמור גם בארכיון data/scans/
npm run scan -- --add "boards.greenhouse.io/x"  # הוסף חברה
npm run match                                   # חשב ציוני התאמה
npm test                                        # טסטים (node:test, ללא רשת — fetch מדומה)
npx tsc --noEmit                                # בדיקת טיפוסים
```

טסט בודד: `node --import tsx --test test/verify.test.ts`.
בפרודקשן השרת רץ תחת PM2 (`ecosystem.config.cjs`) — נדרש כדי שהסריקה האוטומטית תרוץ.

## APIs

| ATS | Endpoint | אימות משרה בודדת |
|-----|----------|------------------|
| Greenhouse | `GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | `.../jobs/{id}` — 200 פתוחה / 404 נסגרה |
| Lever | `GET api.lever.co/v0/postings/{token}?mode=json` | `.../postings/{token}/{id}` — 200 / 404 |
| Ashby | `GET api.ashbyhq.com/posting-api/job-board/{token}` | אין endpoint בודד — בודקים הופעה ברשימה + `isListed` |
| Remotive / RemoteOK | אגרגטורים גלובליים, token = קטגוריה / `all` | בדיקת דף המשרה בלבד (אמינות נמוכה) |

ה-token = שם החברה מה-URL. למשל `boards.greenhouse.io/wix` → token=`wix`.
מזהה משרה: `gh-{token}-{id}`, `lv-…`, `ab-…`, `rmt-{id}`, `rok-{id}` — חייב להיות יציב בין סריקות.

## ארכיטקטורה

**אחסון:** קובצי JSON בלבד, תחת `data/` (ב-gitignore, נוצר אוטומטית). כל מודול קורא/כותב את הקובץ שלו.

**זרימה מרכזית:**
- `scanner.ts` — `runScan()` מושך את כל החברות (4 במקביל), **מחליף** את `data/jobs.json`, מסמן `is_new` (seen-ids), ומפעיל `applyScanDiff` שמסמן כ"נסגרה" משרה שנעלמה מלוח של חברה שהסריקה שלה הצליחה.
- `matcher.ts` — ציון מילות מפתח דטרמיניסטי (ללא AI) → `data/scored-jobs.json` (מסונן לפי `min_match_score`).
- `verify.ts` — אימות פתוחה/נסגרה/לא ידוע. כלל ברזל: שגיאת רשת / timeout / תשובה לא צפויה = `unknown`, **אף פעם** `closed`. תוצאות ב-`data/job-status.json`.
- `jobLookup.ts` — `resolveJob(id)`: scored → jobs.json → מעקב → ארכיון. כל פעולה על משרה בודדת משתמשת בו.
- `applications.ts` — תיק הגשה לכל משרה (`data/applications/`): קו"ח, מכתב, פרופיל, אישור, הגשה, ראיה, יומן אירועים. הכללים נאכפים כאן (`FlowError` → 409): אישור דורש קו"ח ומשרה לא סגורה; עריכה אחרי אישור מבטלת אותו; אחרי הגשה המסמכים נעולים.
- `tracker.ts` — קנבן (interested/applied/interview/offer/rejected), snapshot של המשרה.
- `pipeline.ts` — שלב + "הצעד הבא" לכל משרה במעקב; משמש את המנטור ואת כרטיסי המעקב.
- `automation.ts` — טיימר בתוך השרת: סריקה, ניקוד, התראת טלגרם על משרות חדשות, ובדיקה חוזרת של משרות במעקב, ותזכורות follow-up.
- `telegram.ts` — טלגרם דו-כיווני ב-long polling (`getUpdates`, ללא כתובת ציבורית). רק ה-`chat_id` המוגדר מורשה; כפתורים נושאים token אקראי (לא מזהה משרה), תוקף 7 ימים. ה-offset מתקדם **לפני** הטיפול בעדכון — פעולה בתשלום לא תחזור אחרי קריסה. `telegramActions.ts` — מה כל כפתור/פקודה עושה, דרך אותן פונקציות של `applications.ts`.

**שרת:** `server.ts` — `node:http` ללא framework, שרשרת `if (pathname === …)`. בקשות cross-origin נחסמות (בדיקת Origin מול Host). מגיש את `web/`.

**ממשק:** `web/app.js` — globals + `innerHTML` + `onclick` inline. חלון "🚀 מסלול הגשה" (8 שלבים) נפתח מכרטיס משרה / מעקב / מנטור. עיצוב: משתני CSS ב-`web/style.css`, כהה בלבד, RTL.

**AI:** `cv.ts` (כל הפיצ'רים) → `llm.ts` (ניתוב Anthropic / Gemini / Ollama / Gateway). תקציב יומי (`costs.ts`), cache לקובץ (`cache.ts`) — מפתח ה-cache כולל את טקסט הקו"ח כשהתוצאה תלויה בפרופיל.

## הוספת חברה

1. מצא את דף הקריירה של החברה
2. חפש ב-source את: `greenhouse.io`, `lever.co`, `ashbyhq.com`
3. הרץ: `npm run scan -- --add "https://boards.greenhouse.io/newcompany"`

או ערוך ידנית את `companies.json`. חברה שה-token שלה שבור מסומנת ❌ בפלט הסריקה.

## profile.json

הפרופיל הישן (ל-CLI `match`). בממשק הווב יש פרופילים מרובים ב-`data/profiles/`, והפרופיל הפעיל מסונכרן ל-`profile.json`.
- `skills.primary` / `skills.secondary` / `skills.interested_in`
- `keywords_boost` / `keywords_exclude`
- `location.preferred`, `min_match_score`

## שלבים

- [x] סריקה בסיסית
- [x] התאמת CV ומכתב לכל משרה (בתוך מסלול ההגשה)
- [x] הגשה semi-auto: אימות → קו"ח → מכתב → אישור → פתיחת דף ההגשה → תיעוד → מעקב
- [x] אימות משרות (פתוחה / נסגרה) + מנטור שמכיר את המשרות בתהליך
- [x] טלגרם דו-כיווני: כפתורים בהתראות (⭐ / 🚀 / 🙈), אישור הגשה מהטלפון, /status, תזכורות follow-up
- [~] סריקה אוטומטית כל 6 שעות — טיימר בתוך השרת, רץ רק כשהשרת פעיל
