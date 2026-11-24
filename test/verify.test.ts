import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Must be set before verify.ts is imported (it reads the path at load time).
const dir = mkdtempSync(join(tmpdir(), "verify-test-"));
process.env.JOB_STATUS_FILE = join(dir, "job-status.json");
const v = await import("../src/verify.js");
import type { Company, Job } from "../src/types.js";

const realFetch = globalThis.fetch;
let calls: string[] = [];
beforeEach(() => { calls = []; rmSync(process.env.JOB_STATUS_FILE!, { force: true }); });
afterEach(() => { globalThis.fetch = realFetch; });

// routes: url substring → status (+ optional JSON body)
function mockRoutes(routes: Record<string, { status: number; body?: unknown } | Error>) {
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    calls.push(u);
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) throw new Error("unmocked " + u);
    const r = routes[key];
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

function job(p: Partial<Job>): Job {
  return { id: "", title: "Dev", location: "TLV", department: "-", description: "", url: "", company: "Co",
    ats: "greenhouse", scanned_at: "2026-01-01T00:00:00.000Z", ...p };
}
const companies: Company[] = [
  { name: "Melio", ats: "greenhouse", token: "melio-payments", hq: "", sector: "" },
  { name: "Melio short", ats: "greenhouse", token: "melio", hq: "", sector: "" },
];

test("parseAtsId: hyphenated tokens, longest known token wins, regex fallback", () => {
  assert.deepEqual(v.parseAtsId({ id: "gh-melio-payments-123", ats: "greenhouse" }, companies),
    { token: "melio-payments", postingId: "123" });
  assert.deepEqual(v.parseAtsId({ id: "gh-unknown-co-77", ats: "greenhouse" }, []),
    { token: "unknown-co", postingId: "77" });
  const uuid = "0b5d3c1a-1111-2222-3333-444455556666";
  assert.deepEqual(v.parseAtsId({ id: `lv-acme-inc-${uuid}`, ats: "lever" }, []), { token: "acme-inc", postingId: uuid });
  assert.equal(v.parseAtsId({ id: "rmt-5", ats: "remotive" }, []), null);
});

test("sourceOk: expected domains, Greenhouse gh_jid redirect allowed", () => {
  assert.equal(v.sourceOk({ ats: "greenhouse", url: "https://boards.greenhouse.io/x/jobs/1" }), true);
  assert.equal(v.sourceOk({ ats: "greenhouse", url: "https://careers.acme.com/job?gh_jid=1" }), true);
  assert.equal(v.sourceOk({ ats: "lever", url: "https://jobs.lever.co/x/abc" }), true);
  assert.equal(v.sourceOk({ ats: "ashby", url: "https://evil.example/ashby" }), false);
  assert.equal(v.sourceOk({ ats: "lever", url: "not a url" }), false);
});

test("greenhouse: 200 open, 404 closed, 500 unknown, network error unknown", async () => {
  const j = job({ id: "gh-acme-1", url: "https://boards.greenhouse.io/acme/jobs/1" });
  mockRoutes({ "/boards/acme/jobs/1": { status: 200, body: {} } });
  assert.equal((await v.verifyJob(j)).status, "open");
  assert.ok(calls[0].endsWith("boards-api.greenhouse.io/v1/boards/acme/jobs/1"));
  mockRoutes({ "/boards/acme/jobs/1": { status: 404 } });
  const closed = await v.verifyJob(j);
  assert.equal(closed.status, "closed");
  assert.equal(closed.http_status, 404);
  mockRoutes({ "/boards/acme/jobs/1": { status: 500 } });
  assert.equal((await v.verifyJob(j)).status, "unknown");
  mockRoutes({ "/boards/acme/jobs/1": new Error("ECONNRESET") });
  const err = await v.verifyJob(j);
  assert.equal(err.status, "unknown");
  assert.match(err.reason, /ECONNRESET/);
});

test("lever uses the single-posting endpoint", async () => {
  const uuid = "0b5d3c1a-1111-2222-3333-444455556666";
  mockRoutes({ [`/postings/acme/${uuid}`]: { status: 404 } });
  const r = await v.verifyJob(job({ id: `lv-acme-${uuid}`, ats: "lever", url: "https://jobs.lever.co/acme/x" }));
  assert.equal(r.status, "closed");
  assert.equal(r.trust, "ats");
});

test("ashby: membership in board, unlisted = closed, one board fetch per batch", async () => {
  const uuidA = "aaaaaaaa-1111-2222-3333-444455556666";
  const uuidB = "bbbbbbbb-1111-2222-3333-444455556666";
  const uuidC = "cccccccc-1111-2222-3333-444455556666";
  mockRoutes({ "job-board/acme": { status: 200, body: { jobs: [{ id: uuidA }, { id: uuidB, isListed: false }] } } });
  const mk = (u: string) => job({ id: `ab-acme-${u}`, ats: "ashby", url: `https://jobs.ashbyhq.com/acme/${u}` });
  const r = await v.verifyJobs([mk(uuidA), mk(uuidB), mk(uuidC)]);
  assert.equal(r[`ab-acme-${uuidA}`].status, "open");
  assert.equal(r[`ab-acme-${uuidB}`].status, "closed");
  assert.equal(r[`ab-acme-${uuidC}`].status, "closed");
  assert.equal(calls.length, 1);
});

test("aggregator: only a 404 page closes; 200 is open with aggregator trust", async () => {
  const j = job({ id: "rmt-5", ats: "remotive", url: "https://remotive.com/remote-jobs/x-5" });
  mockRoutes({ "remotive.com": { status: 200 } });
  const open = await v.verifyJob(j);
  assert.equal(open.status, "open");
  assert.equal(open.trust, "aggregator");
  mockRoutes({ "remotive.com": { status: 403 } });
  assert.equal((await v.verifyJob(j)).status, "unknown");
  mockRoutes({ "remotive.com": { status: 404 } });
  assert.equal((await v.verifyJob(j)).status, "closed");
});

test("dead apply link downgrades open → unknown, never closed", async () => {
  const j = job({ id: "gh-acme-1", url: "https://boards.greenhouse.io/acme/jobs/1", apply_url: "https://apply.example/1" });
  mockRoutes({ "/boards/acme/jobs/1": { status: 200, body: {} }, "apply.example": { status: 404 } });
  const r = await v.verifyJob(j, { checkApplyLink: true });
  assert.equal(r.status, "unknown");
  assert.equal(r.apply_status, 404);
});

test("verifyJobs reuses fresh checks unless forced, and persists", async () => {
  const j = job({ id: "gh-acme-1", url: "https://boards.greenhouse.io/acme/jobs/1" });
  mockRoutes({ "/boards/acme/jobs/1": { status: 200, body: {} } });
  await v.verifyJobs([j]);
  await v.verifyJobs([j]);
  assert.equal(calls.length, 1);
  assert.equal(v.loadStatuses()["gh-acme-1"].status, "open");
  await v.verifyJobs([j], { force: true });
  assert.equal(calls.length, 2);
});

test("effectiveStatus: newer stored check wins; scanned job is open; restored/tracked-only is unknown", () => {
  const j = job({ id: "gh-acme-1", scanned_at: "2026-01-02T00:00:00.000Z" });
  const old = { status: "closed", checked_at: "2026-01-01T00:00:00.000Z" } as any;
  const fresh = { status: "closed", checked_at: "2026-01-03T00:00:00.000Z" } as any;
  assert.equal(v.effectiveStatus(j, old, true).status, "open");
  assert.equal(v.effectiveStatus(j, old, true).method, "scan");
  assert.equal(v.effectiveStatus(j, fresh, true).status, "closed");
  assert.equal(v.effectiveStatus({ ...j, is_restored: true }, undefined, true).status, "unknown");
  assert.equal(v.effectiveStatus(j, undefined, false).status, "unknown");
  assert.equal(v.effectiveStatus(j, old, false).status, "closed");
});

test("applyScanDiff: closes only jobs from boards that fetched OK; skips aggregators; reopens", () => {
  const ok: Company = { name: "Acme", ats: "greenhouse", token: "acme", hq: "", sector: "" };
  const known = [
    job({ id: "gh-acme-1", company: "Acme" }),          // gone, board OK → closed
    job({ id: "gh-acme-2", company: "Acme" }),          // still present
    job({ id: "gh-broken-3", company: "Broken" }),      // board failed → no verdict
    job({ id: "rmt-9", ats: "remotive" }),              // aggregator → no verdict
  ];
  const r = v.applyScanDiff(known, [job({ id: "gh-acme-2" })], [ok]);
  assert.deepEqual(r.closed, ["gh-acme-1"]);
  const map = v.loadStatuses();
  assert.equal(map["gh-acme-1"].method, "scan-diff");
  assert.equal(map["gh-broken-3"], undefined);
  assert.equal(map["rmt-9"], undefined);

  // The job comes back in a later scan → stale "closed" is cleared.
  const r2 = v.applyScanDiff([], [job({ id: "gh-acme-1" })], [ok]);
  assert.deepEqual(r2.reopened, ["gh-acme-1"]);
  assert.equal(v.loadStatuses()["gh-acme-1"], undefined);
});
