import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchGreenhouse } from "../src/ats/greenhouse.js";
import { fetchLever } from "../src/ats/lever.js";
import { fetchAshby } from "../src/ats/ashby.js";
import { fetchRemotive } from "../src/ats/remotive.js";
import { fetchRemoteOK } from "../src/ats/remoteok.js";
import { toIso } from "../src/ats/http.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(body: unknown, status = 200) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

test("greenhouse maps apply_url and dates", async () => {
  mockFetch({ jobs: [{ id: 7, title: "Dev", absolute_url: "https://boards.greenhouse.io/x/jobs/7",
    updated_at: "2026-01-02T10:00:00-05:00", first_published: "2026-01-01T00:00:00Z" }] });
  const [j] = await fetchGreenhouse("x", "X");
  assert.equal(j.id, "gh-x-7");
  assert.equal(j.apply_url, "https://boards.greenhouse.io/x/jobs/7");
  assert.equal(j.posted_at, "2026-01-01T00:00:00.000Z");
  assert.equal(j.updated_at, "2026-01-02T15:00:00.000Z");
});

test("lever maps applyUrl and createdAt (epoch ms)", async () => {
  mockFetch([{ id: "abc", text: "Dev", hostedUrl: "https://jobs.lever.co/x/abc",
    applyUrl: "https://jobs.lever.co/x/abc/apply", createdAt: 1767225600000 }]);
  const [j] = await fetchLever("x", "X");
  assert.equal(j.id, "lv-x-abc");
  assert.equal(j.apply_url, "https://jobs.lever.co/x/abc/apply");
  assert.equal(j.posted_at, "2026-01-01T00:00:00.000Z");
});

test("ashby ids are stable and skip unlisted / id-less jobs", async () => {
  const board = { jobs: [
    { title: "No id" },
    { id: "u1", title: "Unlisted", isListed: false },
    { id: "a1", title: "Dev", isListed: true, jobUrl: "https://jobs.ashbyhq.com/x/a1",
      applyUrl: "https://jobs.ashbyhq.com/x/a1/application", publishedAt: "2026-01-01T00:00:00Z" },
  ] };
  mockFetch(board);
  const first = await fetchAshby("x", "X");
  mockFetch({ jobs: [...board.jobs].reverse() });
  const second = await fetchAshby("x", "X");
  assert.deepEqual(first.map((j) => j.id), ["ab-x-a1"]);
  assert.deepEqual(second.map((j) => j.id), ["ab-x-a1"]);
  assert.equal(first[0].apply_url, "https://jobs.ashbyhq.com/x/a1/application");
});

test("remoteok ids are stable and skip entries without id/slug", async () => {
  const feed = [{ legal: "meta" }, { position: "No id" }, { id: "42", position: "Dev", epoch: 1767225600,
    apply_url: "https://remoteok.com/l/42" }];
  mockFetch(feed);
  const a = await fetchRemoteOK("all", "R");
  mockFetch(feed);
  const b = await fetchRemoteOK("all", "R");
  assert.deepEqual(a.map((j) => j.id), ["rok-42"]);
  assert.deepEqual(b.map((j) => j.id), ["rok-42"]);
  assert.equal(a[0].posted_at, "2026-01-01T00:00:00.000Z");
  assert.equal(a[0].apply_url, "https://remoteok.com/l/42");
});

test("remotive maps publication_date", async () => {
  mockFetch({ jobs: [{ id: 5, title: "Dev", publication_date: "2026-01-01T00:00:00Z" }] });
  const [j] = await fetchRemotive("software-dev", "R");
  assert.equal(j.id, "rmt-5");
  assert.equal(j.posted_at, "2026-01-01T00:00:00.000Z");
});

test("non-2xx responses throw HTTP <status>", async () => {
  mockFetch({}, 404);
  await assert.rejects(fetchGreenhouse("gone", "G"), /HTTP 404/);
});

test("timeouts surface as a readable error", async () => {
  globalThis.fetch = (async (_u: any, init?: RequestInit) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  })) as typeof fetch;
  // AbortSignal.timeout's timer is unref'd; a real socket would keep the loop alive.
  const keepAlive = setTimeout(() => {}, 5000);
  const { fetchJson } = await import("../src/ats/http.js");
  try {
    await assert.rejects(fetchJson("https://example.invalid", {}, 50), /timeout after/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("toIso handles ISO, epoch s/ms and junk", () => {
  assert.equal(toIso("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z");
  assert.equal(toIso(1767225600), "2026-01-01T00:00:00.000Z");
  assert.equal(toIso(1767225600000), "2026-01-01T00:00:00.000Z");
  assert.equal(toIso("not a date"), undefined);
  assert.equal(toIso(undefined), undefined);
});
