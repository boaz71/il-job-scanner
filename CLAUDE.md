# IL Job Scanner — סורק משרות טק ישראלי

## Quick Start

```bash
npm install
npm run scan            # סריקת כל החברות
npm run match           # ציון התאמה למשרות
```

## מה זה?

סוכן שסורק משרות מחברות טק ישראליות דרך **APIs ציבוריים של מערכות ATS**.
ללא scraping, ללא proxies, ללא אימות. Node.js + TypeScript.

## APIs

| ATS | Endpoint | Auth |
|-----|----------|------|
| Greenhouse | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | ללא |
| Lever | `GET https://api.lever.co/v0/postings/{token}?mode=json` | ללא |
| Ashby | `GET https://api.ashbyhq.com/posting-api/job-board/{token}` | ללא |

ה-token = שם החברה מה-URL. למשל `boards.greenhouse.io/wix` → token=`wix`

## מבנה

```
├── CLAUDE.md           ← הוראות (אתה כאן)
├── companies.json      ← 20 חברות + tokens
├── profile.json        ← פרופיל המשתמש (ערוך!)
├── src/
│   ├── scanner.ts      ← סורק ראשי
│   ├── matcher.ts      ← ציון התאמה A-F
│   ├── types.ts
│   └── ats/
│       ├── greenhouse.ts
│       ├── lever.ts
│       └── ashby.ts
└── data/               ← output
    ├── jobs.json
    └── scan-results.json
```

## פקודות

```bash
npm run scan                                    # סרוק הכל
npm run scan -- --keyword "backend"             # סנן לפי מילת מפתח
npm run scan -- --location "tel aviv"           # סנן לפי מיקום
npm run scan -- --add "boards.greenhouse.io/x"  # הוסף חברה
npm run match                                   # חשב ציוני התאמה
```

## הוספת חברה

1. מצא את דף הקריירה של החברה
2. חפש ב-source את: `greenhouse.io`, `lever.co`, `ashbyhq.com`
3. הרץ: `npm run scan -- --add "https://boards.greenhouse.io/newcompany"`

או ערוך ידנית את `companies.json`.

## profile.json

ערוך את הפרופיל לפני הרצת `match`:
- `skills.primary` — הטכנולוגיות העיקריות שלך (משקל גבוה)
- `skills.secondary` — טכנולוגיות משניות
- `keywords_boost` — מילות מפתח שמעלות ציון
- `keywords_exclude` — מילים שמורידות ציון (intern, junior וכו')
- `location.preferred` — ערים מועדפות

## שלבים הבאים

- [ ] שלב 1: סריקה בסיסית (מוכן ✅)
- [ ] שלב 2: חיבור טלגרם (claude code channels / בוט עצמאי)
- [ ] שלב 3: התאמת CV אוטומטית לכל משרה
- [ ] שלב 4: הגשה semi-auto עם אישור בטלגרם
- [ ] שלב 5: cron — סריקה אוטומטית כל 6 שעות
