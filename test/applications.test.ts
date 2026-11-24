import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Must be set before applications.ts is imported (it reads the path at load time).
const dir = mkdtempSync(join(tmpdir(), "apps-test-"));
process.env.APPLICATIONS_DIR = dir;
const a = await import("../src/applications.js");
import type { Job } from "../src/types.js";

beforeEach(() => { for (const f of readdirSync(dir)) rmSync(join(dir, f)); });

const job = (id = "gh-acme-1"): Job => ({ id, title: "Dev", location: "TLV", department: "-", description: "",
  url: "https://boards.greenhouse.io/acme/jobs/1", company: "Acme", ats: "greenhouse", scanned_at: "2026-01-01T00:00:00.000Z" });
const ctxA = { profileId: "boaz-1", cvId: "cv-a" };

test("fileNameFor: no path characters, unique per id", () => {
  const evil = a.fileNameFor("../../etc/passwd");
  assert.ok(!evil.includes("/") && !evil.includes(".."), evil);
  assert.notEqual(a.fileNameFor("rok-a/b"), a.fileNameFor("rok-a_b"));
});

test("saveDocument: generated then edited; record persists with profile + CV", () => {
  a.saveDocument(job(), "cv", { markdown: "# CV v1", lang: "he", generated: true }, ctxA);
  const rec = a.saveDocument(job(), "cv", { markdown: "# CV v1 (edited)", generated: false }, ctxA);
  assert.equal(rec.cv!.markdown, "# CV v1 (edited)");
  assert.equal(rec.cv!.edited, true);
  assert.equal(rec.cv!.lang, "he");                    // kept from the generated version
  assert.ok(rec.cv!.generated_at);
  const loaded = a.getApplication("gh-acme-1")!;
  assert.equal(loaded.profile_id, "boaz-1");
  assert.equal(loaded.cv_id, "cv-a");
  assert.deepEqual(loaded.events.map((e) => e.type), ["cv-generated", "cv-edited"]);
});

test("cv and letter live side by side", () => {
  a.saveDocument(job(), "cv", { markdown: "cv", generated: true }, ctxA);
  const rec = a.saveDocument(job(), "letter", { markdown: "letter", generated: true }, ctxA);
  assert.equal(rec.cv!.markdown, "cv");
  assert.equal(rec.letter!.markdown, "letter");
});

test("switching profile or base CV drops documents made for the old one", () => {
  a.saveDocument(job(), "cv", { markdown: "cv for A", generated: true }, ctxA);
  a.saveDocument(job(), "letter", { markdown: "letter for A", generated: true }, ctxA);
  const rec = a.saveDocument(job(), "cv", { markdown: "cv for B", generated: true }, { profileId: "boaz-1", cvId: "cv-b" });
  assert.equal(rec.cv!.markdown, "cv for B");
  assert.equal(rec.letter, undefined);
  assert.equal(rec.cv_id, "cv-b");
  assert.ok(rec.events.some((e) => e.type === "profile-changed"));
});

test("listApplications newest first; missing / bad ids return null", async () => {
  a.saveDocument(job("gh-acme-1"), "cv", { markdown: "1", generated: true }, ctxA);
  await new Promise((r) => setTimeout(r, 5));   // distinct updated_at
  a.saveDocument(job("gh-acme-2"), "cv", { markdown: "2", generated: true }, ctxA);
  assert.deepEqual(a.listApplications().map((r) => r.job_id), ["gh-acme-2", "gh-acme-1"]);
  assert.equal(a.getApplication("nope"), null);
  assert.equal(a.getApplication(undefined as any), null);
  assert.ok(readdirSync(dir).every((f) => !f.endsWith(".tmp")));
});

// ── Submission flow ──
const open = { status: "open", checked_at: "2026-01-01T00:00:00.000Z", method: "ats-api", trust: "ats", source_ok: true, reason: "" } as any;

test("approve requires a saved CV and a job that isn't closed", () => {
  assert.throws(() => a.approveApplication("gh-acme-1", open, []), a.FlowError);
  a.saveDocument(job(), "cv", { markdown: "cv", generated: true }, ctxA);
  assert.throws(() => a.approveApplication("gh-acme-1", { ...open, status: "closed" }, []), /סגורה/);
  const rec = a.approveApplication("gh-acme-1", open, ["fit", "cv-reviewed"]);
  assert.deepEqual(rec.approval!.checklist, ["fit", "cv-reviewed"]);
  assert.equal(rec.verification!.status, "open");
});

test("editing a document after approval cancels the approval", () => {
  a.saveDocument(job(), "cv", { markdown: "cv", generated: true }, ctxA);
  a.approveApplication("gh-acme-1", open, []);
  const rec = a.saveDocument(job(), "letter", { markdown: "late letter", generated: false }, ctxA);
  assert.equal(rec.approval, undefined);
  assert.ok(rec.events.some((e) => e.type === "approval-reset"));
  assert.throws(() => a.markOpened("gh-acme-1"), a.FlowError);
});

test("open + submit only after approval; submitted documents are locked", () => {
  a.saveDocument(job(), "cv", { markdown: "cv", generated: true }, ctxA);
  assert.throws(() => a.markSubmitted("gh-acme-1", ""), a.FlowError);
  a.approveApplication("gh-acme-1", open, []);
  const opened = a.markOpened("gh-acme-1");
  assert.equal(opened.submission!.apply_url, "https://boards.greenhouse.io/acme/jobs/1");
  const sub = a.markSubmitted("gh-acme-1", "  Ref #123  ");
  assert.ok(sub.submission!.submitted_at && sub.submission!.opened_at);
  assert.equal(sub.confirmation!.evidence, "Ref #123");
  assert.equal(a.markSubmitted("gh-acme-1", "again").confirmation!.evidence, "Ref #123");  // idempotent
  assert.throws(() => a.saveDocument(job(), "cv", { markdown: "new", generated: false }, ctxA), /נעולים/);
  assert.throws(() => a.approveApplication("gh-acme-1", open, []), a.FlowError);
});

test("addEvidence: only after submission; appends to existing evidence", () => {
  a.saveDocument(job(), "cv", { markdown: "cv", generated: true }, ctxA);
  assert.throws(() => a.addEvidence("gh-acme-1", "ref"), a.FlowError);
  a.approveApplication("gh-acme-1", open, []);
  a.markSubmitted("gh-acme-1", "");
  assert.equal(a.addEvidence("gh-acme-1", " Ref #1 ").confirmation!.evidence, "Ref #1");
  assert.equal(a.addEvidence("gh-acme-1", "email: thanks").confirmation!.evidence, "Ref #1\nemail: thanks");
  assert.throws(() => a.addEvidence("gh-acme-1", "   "), /ריקה/);
});
