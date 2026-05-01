# 🔍 IL Job Scanner

> **Stack:** TypeScript + Node.js  
> **Status:** Active  
> **Category:** Job Search Automation

סורק משרות טק ישראלי — סורק משרות מחברות טק ישראליות דרך APIs ציבוריים של מערכות ATS, ללא scraping, ללא proxies, ללא אימות.

## ✨ Features

- 🏢 **Multi-ATS Support** — Greenhouse, Lever, Ashby
- 🎯 **Smart Matching** — ציון התאמה A-F לפי פרופיל אישי
- 🔑 **Keyword Filtering** — סינון לפי מיקום / מילות מפתח
- ➕ **Easy Company Add** — הוספת חברות חדשות בפקודה אחת
- 📄 **CV Tailoring** — התאמת CV אוטומטית (בפיתוח)

## 🚀 Quick Start

```bash
npm install
npm run scan        # סריקת כל החברות
npm run match       # ציון התאמה למשרות
npm run web         # ממשק ווב
```

## 📁 Structure

```
├── companies.json      ← 20 חברות + tokens
├── profile.json        ← פרופיל המשתמש
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

## 🎯 Supported ATS APIs

| ATS | Auth |
|-----|------|
| Greenhouse | ללא |
| Lever | ללא |
| Ashby | ללא |

## 🗺️ Roadmap

- [x] שלב 1: סריקה בסיסית
- [ ] שלב 2: חיבור טלגרם
- [ ] שלב 3: התאמת CV אוטומטית
- [ ] שלב 4: הגשה semi-auto עם אישור בטלגרם
- [ ] שלב 5: cron — סריקה אוטומטית כל 6 שעות
