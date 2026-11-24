import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPipeline, nextStep, pipelineForPrompt } from "../src/pipeline.js";
import type { TrackedJob } from "../src/tracker.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();

function tracked(id: string, status: TrackedJob["status"], opts: { applied?: number; since?: number } = {}): TrackedJob {
  return {
    id, status, notes: "", added_at: daysAgo(30),
    applied_at: opts.applied !== undefined ? daysAgo(opts.applied) : undefined,
    history: [{ at: daysAgo(opts.since ?? 3), from: null, to: status }],
    job: { id, title: `Job ${id}`, company: "Acme", location: "TLV", department: "-", description: "", url: "", ats: "greenhouse", scanned_at: daysAgo(1) },
  };
}
const base = { id: "x", title: "t", company: "c", verification: "open" as const, days_since_applied: null, days_in_status: 0 };

test("interested: next step follows the submission flow stage", () => {
  assert.match(nextStep({ ...base, status: "interested", stage: "none" })!, /קו״ח/);
  assert.match(nextStep({ ...base, status: "interested", stage: "cv" })!, /לאשר/);
  assert.match(nextStep({ ...base, status: "interested", stage: "approved" })!, /להגיש/);
  assert.match(nextStep({ ...base, status: "interested", stage: "none", verification: "closed" })!, /נסגרה/);
});

test("applied: wait, then follow-up at 5 days, second follow-up at 14", () => {
  assert.match(nextStep({ ...base, status: "applied", stage: "submitted", days_since_applied: 2 })!, /בעוד 3 ימים/);
  assert.equal(nextStep({ ...base, status: "applied", stage: "submitted", days_since_applied: 5 }), "לשלוח follow-up");
  assert.match(nextStep({ ...base, status: "applied", stage: "submitted", days_since_applied: 20 })!, /נוסף/);
  assert.equal(nextStep({ ...base, status: "rejected", stage: "none" }), null);
});

test("buildPipeline: stage from application record, ordered by progress", () => {
  const apps = new Map<string, any>([
    ["a", { cv: {} }],
    ["b", { cv: {}, approval: {}, submission: { submitted_at: daysAgo(6) } }],
  ]);
  const items = buildPipeline(
    [tracked("a", "interested"), tracked("b", "applied", { applied: 6 }), tracked("c", "interview"), tracked("d", "rejected")],
    apps, (t) => (t.id === "a" ? "closed" : "open"), NOW);
  assert.deepEqual(items.map((i) => i.id), ["c", "b", "a", "d"]);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId.a.stage, "cv");
  assert.equal(byId.a.next_step, "המשרה נסגרה — להסיר מהמעקב");
  assert.equal(byId.b.stage, "submitted");
  assert.equal(byId.b.days_since_applied, 6);
  assert.equal(byId.b.next_step, "לשלוח follow-up");
  assert.equal(byId.d.next_step, null);
});

test("pipelineForPrompt: names jobs, skips rejected, caps length", () => {
  const items = buildPipeline(
    Array.from({ length: 20 }, (_, i) => tracked(String(i), i === 0 ? "rejected" : "interested")),
    new Map(), () => "open", NOW);
  const text = pipelineForPrompt(items, 5);
  assert.equal(text.split("\n").length, 6);
  assert.match(text, /Job 1 @ Acme · interested/);
  assert.doesNotMatch(text, /Job 0 @/);
  assert.match(text, /ועוד 14 משרות/);
  assert.equal(pipelineForPrompt([]), "אין משרות פעילות בתהליך.");
});
