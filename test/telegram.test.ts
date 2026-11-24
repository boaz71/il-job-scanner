import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "tg-test-"));
process.env.TELEGRAM_STATE_FILE = join(dir, "telegram.json");
const tg = await import("../src/telegram.js");
import type { Actions, OutMsg } from "../src/telegram.js";

const cfg = { telegram: { enabled: true, interactive: true, bot_token: "T", chat_id: "42" }, min_grade_for_alert: "A" } as any;
const realFetch = globalThis.fetch;
let sent: { method: string; body: any }[] = [];
let nextMessageId = 100;

beforeEach(() => {
  rmSync(process.env.TELEGRAM_STATE_FILE!, { force: true });
  sent = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const method = String(url).split("/").pop()!;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : Object.fromEntries((init.body as FormData).entries());
    sent.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }));
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

function fakeActions(log: string[]): Actions {
  const rec = (name: string) => async (...a: string[]): Promise<OutMsg[]> => { log.push([name, ...a].join(":")); return [{ text: `did ${name}` }]; };
  return { track: rec("track"), start: rec("start"), hide: rec("hide"), approve: rec("approve"), edit: rec("edit"),
    submitted: rec("submitted"), followup: rec("followup"), status: rec("status"), evidence: rec("evidence") };
}
function ctx(log: string[], answers: string[] = []) {
  return { cfg, actions: fakeActions(log), send: (m: OutMsg[]) => tg.deliver(m, cfg),
    answer: async (_id: string, text: string) => { answers.push(text); } };
}
const callbackData = (btnText: string) => {
  const kb = sent.find((s) => s.body.reply_markup)!.body.reply_markup.inline_keyboard.flat();
  return kb.find((b: any) => b.text.includes(btnText)).callback_data as string;
};

test("buttons carry short random tokens that route to the right action and job", async () => {
  await tg.deliver([tg.newJobsAlert([{ id: "gh-acme-1", title: "Dev", company: "Acme", location: "TLV", grade: "A", score: 90, url: "https://x" } as any])], cfg);
  const data = callbackData("🚀");
  assert.ok(data.length <= 64 && !data.includes("gh-acme-1"));
  const log: string[] = [], answers: string[] = [];
  const r = await tg.handleUpdate({ callback_query: { id: "cb1", data, message: { chat: { id: 42 } } } }, ctx(log, answers));
  assert.equal(r, "action:start");
  assert.deepEqual(log, ["start:gh-acme-1"]);
  assert.match(answers[0], /מכין קו״ח/);   // immediate toast before the slow work
});

test("updates from any other chat are ignored", async () => {
  await tg.deliver([{ text: "x", buttons: [[{ text: "ok", action: "track", jobId: "j" }]] }], cfg);
  const data = callbackData("ok");
  const log: string[] = [], answers: string[] = [];
  assert.equal(await tg.handleUpdate({ callback_query: { id: "c", data, message: { chat: { id: 999 } } } }, ctx(log, answers)), "unauthorized");
  assert.equal(await tg.handleUpdate({ message: { chat: { id: 999 }, text: "/status" } }, ctx(log)), "unauthorized");
  assert.deepEqual(log, []);
  assert.match(answers[0], /לא מורשה/);
});

test("unknown / expired tokens do nothing", async () => {
  const log: string[] = [], answers: string[] = [];
  assert.equal(await tg.handleUpdate({ callback_query: { id: "c", data: "nope", message: { chat: { id: 42 } } } }, ctx(log, answers)), "expired");
  assert.deepEqual(log, []);
});

test("commands: /status and /help (also /status@BotName)", async () => {
  const log: string[] = [];
  assert.equal(await tg.handleUpdate({ message: { chat: { id: 42 }, text: "/status@MyJobBot" } }, ctx(log)), "cmd:status");
  assert.equal(await tg.handleUpdate({ message: { chat: { id: 42 }, text: "/start" } }, ctx(log)), "cmd:help");
  assert.deepEqual(log, ["status"]);
  assert.ok(sent.some((s) => String(s.body.text).includes("/status")));
});

test("a reply to the 'submitted' message is stored as evidence for that job", async () => {
  await tg.deliver([{ text: "📤 תועד", awaitEvidenceFor: "gh-acme-1" }], cfg);
  const promptId = nextMessageId - 1;
  const log: string[] = [];
  const r = await tg.handleUpdate({ message: { chat: { id: 42 }, text: "Ref #123", reply_to_message: { message_id: promptId } } }, ctx(log));
  assert.equal(r, "evidence");
  assert.deepEqual(log, ["evidence:gh-acme-1:Ref #123"]);
  assert.equal(await tg.handleUpdate({ message: { chat: { id: 42 }, text: "hello" } }, ctx(log)), "unknown-text");
});

test("action errors become a message, not a crash", async () => {
  const log: string[] = [];
  const c = ctx(log);
  c.actions.track = async () => { throw new Error("boom <b>"); };
  await tg.deliver([{ text: "x", buttons: [[{ text: "t", action: "track", jobId: "j" }]] }], cfg);
  await tg.handleUpdate({ callback_query: { id: "c", data: callbackData("t"), message: { chat: { id: 42 } } } }, c);
  assert.ok(sent.some((s) => s.body.text === "❌ boom &lt;b&gt;"));
});

test("without two-way mode, callback buttons are dropped but URL buttons stay", async () => {
  const oneWay = { ...cfg, telegram: { ...cfg.telegram, interactive: false } };
  await tg.deliver([{ text: "x", buttons: [[{ text: "go", action: "track", jobId: "j" }], [{ text: "site", url: "https://acme.example" }]] }], oneWay);
  assert.deepEqual(sent[0].body.reply_markup.inline_keyboard, [[{ text: "site", url: "https://acme.example" }]]);
});

test("follow-up reminder is sent once per application, after 5 days", async () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const job = { id: "a", title: "Dev", company: "Acme" } as any;
  const tracked = [
    { id: "a", status: "applied", applied_at: "2026-11-14T00:00:00Z", job },
    { id: "b", status: "applied", applied_at: "2026-11-18T00:00:00Z", job: { ...job, id: "b" } },
    { id: "c", status: "interview", applied_at: "2026-11-01T00:00:00Z", job: { ...job, id: "c" } },
  ];
  assert.equal(await tg.sendFollowupReminders(tracked, now), 1);
  assert.equal(await tg.sendFollowupReminders(tracked, now), 0);
});
