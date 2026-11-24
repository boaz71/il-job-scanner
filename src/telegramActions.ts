// What each Telegram button / command does — built on the same functions as the web
// submission flow, so the same rules apply (applications.ts enforces them).
import { resolveJob } from "./jobLookup.js";
import { addTracked, listTracked } from "./tracker.js";
import { verifyJobs } from "./verify.js";
import { getActiveProfile, getPrimaryCVText } from "./profiles.js";
import { generateTailoredCV, generateFollowUp } from "./cv.js";
import { markdownToDocx } from "./export.js";
import {
  getApplication, saveDocument, approveApplication, recordSubmission, addEvidence, docContextFor, FlowError,
} from "./applications.js";
import { hideJob } from "./hiddenJobs.js";
import { loadPipeline } from "./pipeline.js";
import { loadConfig } from "./notifications.js";
import { esc, type Actions, type OutMsg } from "./telegram.js";
import type { Job } from "./types.js";

const keepTracked = () => new Set(listTracked().map((t) => t.id));
const jobLine = (j: Job) => `<b>${esc(j.title)}</b>\n🏢 ${esc(j.company)}`;

function mustJob(jobId: string): Job {
  const j = resolveJob(jobId)?.job;
  if (!j) throw new Error("המשרה לא נמצאה");
  return j;
}

// "Open on computer" — a text link (Telegram rejects local/LAN addresses in URL buttons).
function computerLink(jobId: string): string {
  const base = (loadConfig().app_url || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return "פתח את הממשק במחשב ← 🚀 הגשה על המשרה.";
  return `<a href="${esc(base)}/#flow=${encodeURIComponent(jobId)}">🖥️ פתח את מסלול ההגשה במחשב</a>`;
}

async function cvReviewMessage(job: Job, cvMarkdown: string, note = ""): Promise<OutMsg> {
  const file = `CV-${job.company}-${job.title}`.replace(/[^\w֐-׿-]+/g, "_").slice(0, 80) + ".docx";
  return {
    document: { filename: file, content: await markdownToDocx(cvMarkdown) },
    text: `📝 <b>קו״ח מותאמים</b> — ${esc(job.title)} · ${esc(job.company)}\n${note}`
      + `\nקרא את הקובץ. "קראתי ומאשר" = קראת את קורות החיים, והבנת שההגשה נעשית על ידך באתר החברה.`,
    buttons: [
      [{ text: "✅ קראתי ומאשר", action: "approve", jobId: job.id }],
      [{ text: "✏️ אערוך במחשב", action: "edit", jobId: job.id }],
    ],
  };
}

const inProgress = new Set<string>();   // one "start" per job at a time (double taps)

export function createTelegramActions(): Actions {
  return {
    async track(jobId) {
      const job = mustJob(jobId);
      addTracked(job);
      return [{ text: `⭐ נוסף למעקב\n${jobLine(job)}` }];
    },

    async hide(jobId) {
      const job = mustJob(jobId);
      hideJob(jobId);
      return [{ text: `🙈 הוסתרה מרשימת המשרות: ${esc(job.title)} · ${esc(job.company)}` }];
    },

    async start(jobId) {
      if (inProgress.has(jobId)) return [{ text: "⏳ כבר מכין את המשרה הזו..." }];
      inProgress.add(jobId);
      try {
        const job = mustJob(jobId);
        addTracked(job);
        const v = (await verifyJobs([job], { force: true, checkApplyLink: true, keepIds: keepTracked() }))[jobId];
        if (v.status === "closed") return [{ text: `⛔ המשרה נסגרה — לא ממשיכים.\n${jobLine(job)}\n${esc(v.reason)}` }];
        let app = getApplication(jobId);
        if (app?.submission?.submitted_at) return [{ text: `📤 כבר סימנת שהגשת למשרה הזו.\n${jobLine(job)}` }];
        if (!app?.cv) {
          const active = getActiveProfile();
          if (!active) return [{ text: "❌ אין פרופיל פעיל — הגדר פרופיל בממשק." }];
          const markdown = await generateTailoredCV(getPrimaryCVText(active), job, "auto");   // budget-checked
          app = saveDocument(job, "cv", { markdown, generated: true }, docContextFor(active));
        }
        const note = v.status === "unknown"
          ? `❔ לא ניתן לאמת שהמשרה פתוחה — אישור יתאפשר רק במחשב.`
          : `✅ המשרה פתוחה (${esc(v.reason)})`;
        return [await cvReviewMessage(job, app.cv!.markdown, note)];
      } finally {
        inProgress.delete(jobId);
      }
    },

    async approve(jobId) {
      const job = mustJob(jobId);
      const app = getApplication(jobId);
      if (!app?.cv) return [{ text: "❌ אין קו״ח שמורים למשרה הזו — לחץ 🚀 קודם." }];
      if (app.submission?.submitted_at) return [{ text: "📤 המועמדות כבר סומנה כהוגשה." }];
      const v = (await verifyJobs([job], { checkApplyLink: true, keepIds: keepTracked() }))[jobId];
      // "Unknown" needs an explicit acknowledgement — that's a decision for the full UI.
      if (v.status === "unknown") return [{ text: `❔ לא ניתן לאמת שהמשרה פתוחה (${esc(v.reason)}).\nאשר במחשב: ${computerLink(jobId)}` }];
      try {
        approveApplication(jobId, v, ["telegram: read-cv-docx", "telegram: manual-submit-ack"]);
      } catch (e) {
        if (e instanceof FlowError) return [{ text: `❌ ${esc(e.message)}` }];
        throw e;
      }
      const url = job.apply_url || job.url;
      return [{
        text: `✅ <b>אושר.</b> עכשיו הגש באתר החברה עם קורות החיים מהקובץ.\n${jobLine(job)}\n\nאחרי שהגשת — לחץ "📤 הגשתי".`,
        buttons: [
          ...(/^https?:\/\//.test(url) ? [[{ text: "🔗 לדף ההגשה", url }]] : []),
          [{ text: "📤 הגשתי", action: "submitted" as const, jobId }],
        ],
      }];
    },

    async edit(jobId) {
      return [{ text: `✏️ ${computerLink(jobId)}\nשם אפשר לערוך את קורות החיים, להוסיף מכתב ולאשר.` }];
    },

    async submitted(jobId) {
      const job = mustJob(jobId);
      try {
        recordSubmission(jobId, "");
      } catch (e) {
        if (e instanceof FlowError) return [{ text: `❌ ${esc(e.message)}` }];
        throw e;
      }
      return [{
        text: `📤 <b>תועד</b> — המשרה עברה ל"הגשתי" במעקב.\n${jobLine(job)}\n\n↩️ אפשר להשיב להודעה הזו עם מספר אסמכתא או מייל האישור.`,
        awaitEvidenceFor: jobId,
      }];
    },

    async evidence(jobId, text) {
      addEvidence(jobId, text);
      return [{ text: "🧾 הראיה נשמרה בתיק ההגשה." }];
    },

    async followup(jobId) {
      const t = listTracked().find((x) => x.id === jobId);
      if (!t) return [{ text: "❌ המשרה כבר לא במעקב." }];
      const active = getActiveProfile();
      if (!active) return [{ text: "❌ אין פרופיל פעיל." }];
      const days = t.applied_at ? Math.floor((Date.now() - new Date(t.applied_at).getTime()) / 86400000) : 7;
      const text = await generateFollowUp(getPrimaryCVText(active), t.job, days);
      return [{ text: `📧 <b>Follow-up</b> — ${esc(t.job.title)} · ${esc(t.job.company)}\n\n${esc(text)}` }];
    },

    async status() {
      const items = loadPipeline().filter((i) => i.next_step);
      if (!items.length) return [{ text: "אין משרות בתהליך. 🆕 משרות חדשות יגיעו בהתראה." }];
      const lines = items.slice(0, 15).map((i) =>
        `• <b>${esc(i.title)}</b> · ${esc(i.company)}${i.verification === "closed" ? " ⛔" : ""}\n   ➡️ ${esc(i.next_step)}`);
      if (items.length > 15) lines.push(`<i>...ועוד ${items.length - 15}</i>`);
      return [{ text: `📋 <b>הצעדים הבאים</b>\n\n${lines.join("\n")}` }];
    },
  };
}
