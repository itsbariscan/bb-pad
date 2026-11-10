import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewLifecycle, REVIEW_RETRY_MS, REVIEW_STATE_KEY } from "../lib/review-lifecycle.ts";
import { collectReview } from "../lib/review.ts";
import { parse } from "../lib/outline.ts";

function fixture() {
  let time = new Date(2026, 9, 22, 10).getTime();
  const state = new Map<string, unknown>();
  const calls = { list: 0, metadata: 0, spawn: 0, send: 0, update: 0, writes: 0 };
  const threads: any[] = [];
  const sent: any[] = [];
  const spawned: any[] = [];
  const metadata = new Map<string, any>();
  let spawnMode: "ok" | "fail" | "lost" = "ok";
  let listFails = false;
  let metadataFails = false;
  const nodes = parse(Array.from({ length: 16 }, (_, i) => `- 2026-10-01 09:${String(i).padStart(2, "0")} note ${i}`).join("\n") + "\n");
  const host = {
    file: "/test/pad.md",
    now: () => new Date(time),
    notes: async (now: Date, includeToday: boolean) => collectReview(nodes, { now, includeToday }),
    projectId: async () => "project",
    kv: {
      get: async (key: string) => state.get(key),
      set: async (key: string, value: unknown) => { calls.writes++; state.set(key, structuredClone(value)); },
    },
    threads: {
      list: async ({ offset, limit }: any) => { calls.list++; if (listFails) throw Error("list failed"); return threads.slice(offset, offset + limit); },
      experimental_listPluginMetadata: async ({ threadIds }: any) => {
        calls.metadata++; if (metadataFails) throw Error("metadata failed");
        return { threads: threadIds.filter((id: string) => metadata.has(id)).map((id: string) => ({ threadId: id, metadata: metadata.get(id) })) };
      },
      spawn: async (args: any) => {
        calls.spawn++; spawned.push(args);
        if (spawnMode === "fail") throw Error("spawn failed");
        const id = `thread-${calls.spawn}`;
        threads.push({ id, projectId: args.projectId, archivedAt: null, deletedAt: null, status: "idle", hasPendingInteraction: false, queuedWork: "none" });
        metadata.set(id, args.pluginMetadata);
        if (spawnMode === "lost") throw Error("response lost");
        return { id };
      },
      send: async (args: any) => { calls.send++; sent.push(args); },
      updatePluginMetadata: async ({ threadId, set }: any) => { calls.update++; metadata.set(threadId, set); },
    },
  } as unknown as Parameters<typeof createReviewLifecycle>[0];
  return { host, state, calls, threads, metadata, sent, spawned, advance: (ms: number) => { time += ms; }, spawnMode: (mode: typeof spawnMode) => { spawnMode = mode; }, failList: () => { listFails = true; }, failMetadata: () => { metadataFails = true; } };
}
const automatic = { includeToday: false, automatic: true };

test("legacy state does not strand notes; next day resumes the open idle review", async () => {
  const f = fixture();
  f.state.set("reviewedThrough", "2026-10-21");
  f.state.set("reviewDay", "2026-10-22");
  const lifecycle = createReviewLifecycle(f.host);
  assert.match(await lifecycle.start(automatic), /Started .*16 pending notes/);
  assert.equal((f.state.get(REVIEW_STATE_KEY) as any).reviewDay, "2026-10-22");
  f.advance(24 * 60 * 60_000);
  assert.match(await lifecycle.start(automatic), /Resumed .*16 pending notes/);
  assert.equal(f.calls.spawn, 1);
  assert.equal(f.calls.send, 1);
});

test("failed spawns do not claim the day; cooldown and limit survive restart", async () => {
  const f = fixture(); f.spawnMode("fail");
  for (let i = 0; i < 3; i++) {
    await assert.rejects(createReviewLifecycle(f.host).start(automatic), /spawn failed/);
    assert.equal((f.state.get(REVIEW_STATE_KEY) as any).reviewDay, undefined);
    if (i < 2) {
      assert.match(await createReviewLifecycle(f.host).start(automatic), /cooldown/);
      f.advance(REVIEW_RETRY_MS);
    }
  }
  f.advance(REVIEW_RETRY_MS);
  assert.match(await createReviewLifecycle(f.host).start(automatic), /limit reached/);
  assert.equal(f.calls.spawn, 3);
  f.advance(24 * 60 * 60_000); f.spawnMode("ok");
  assert.match(await createReviewLifecycle(f.host).start(automatic), /Started/);
});

test("simultaneous manual and scheduled requests share one spawn", async () => {
  const f = fixture(); const lifecycle = createReviewLifecycle(f.host);
  await Promise.all([lifecycle.start({ includeToday: false }), lifecycle.start(automatic)]);
  assert.equal(f.calls.spawn, 1);
  assert.equal(f.threads.length, 1);
});

test("an idle legacy review is resumed instead of duplicated", async () => {
  const f = fixture();
  f.threads.push({ id: "legacy", projectId: "project", archivedAt: null, deletedAt: null, status: "idle", hasPendingInteraction: false, queuedWork: "none" });
  f.metadata.set("legacy", { kind: "daily-review" });
  assert.match(await createReviewLifecycle(f.host).start(automatic), /Resumed review thread legacy/);
  assert.equal(f.calls.spawn, 0); assert.equal(f.calls.send, 1);
});

test("lost spawn response is recovered from thread metadata", async () => {
  const f = fixture(); f.spawnMode("lost");
  await assert.rejects(createReviewLifecycle(f.host).start(automatic), /response lost/);
  assert.equal((f.state.get(REVIEW_STATE_KEY) as any).reviewDay, undefined);
  f.advance(REVIEW_RETRY_MS);
  assert.match(await createReviewLifecycle(f.host).start(automatic), /Reused review thread/);
  assert.equal(f.calls.spawn, 1); assert.equal(f.calls.send, 0);
});

test("dry run renders pending notes without state writes or SDK calls", async () => {
  const f = fixture();
  assert.match(await createReviewLifecycle(f.host).start({ ...automatic, dryRun: true }), /note 0/);
  assert.deepEqual(f.calls, { list: 0, metadata: 0, spawn: 0, send: 0, update: 0, writes: 0 });
  assert.equal(f.state.size, 0);
});

test("archived and foreign-file reviews do not block a new review", async () => {
  const f = fixture();
  for (const [id, archivedAt, file] of [["archived", "2026-01-01", "/test/pad.md"], ["foreign", null, "/other/pad.md"]]) {
    f.threads.push({ id, projectId: "project", archivedAt, deletedAt: null, status: "idle", hasPendingInteraction: false, queuedWork: "none" });
    f.metadata.set(id as string, { kind: "daily-review", file });
  }
  assert.match(await createReviewLifecycle(f.host).start(automatic), /Started/);
  assert.equal(f.calls.spawn, 1);
});

test("thread discovery errors fail closed", async () => {
  for (const source of ["list", "metadata"] as const) {
    const f = fixture();
    if (source === "list") f.failList();
    else { f.threads.push({ id: "unknown" }); f.failMetadata(); }
    await assert.rejects(createReviewLifecycle(f.host).start(automatic), /failed/);
    assert.equal(f.calls.spawn, 0);
    assert.equal((f.state.get(REVIEW_STATE_KEY) as any).reviewDay, undefined);
  }
});

test("busy and interaction-blocked reviews defer without claiming the day, then resume after cooldown", async () => {
  for (const blocked of [
    { status: "running", hasPendingInteraction: false, queuedWork: "none" },
    { status: "idle", hasPendingInteraction: true, queuedWork: "none" },
    { status: "idle", hasPendingInteraction: false, queuedWork: "waiting" },
  ]) {
    const f = fixture();
    const thread = { id: "open", projectId: "project", archivedAt: null, deletedAt: null, ...blocked };
    f.threads.push(thread);
    f.metadata.set("open", { kind: "daily-review", file: "/test/pad.md" });
    const lifecycle = createReviewLifecycle(f.host);
    assert.match(await lifecycle.start(automatic), /waiting for it to become idle/);
    assert.equal(f.calls.spawn, 0); assert.equal(f.calls.send, 0);
    assert.equal((f.state.get(REVIEW_STATE_KEY) as any).reviewDay, undefined);
    assert.match(await lifecycle.start(automatic), /cooldown/);
    Object.assign(thread, { status: "idle", hasPendingInteraction: false, queuedWork: "none" });
    f.advance(REVIEW_RETRY_MS);
    assert.match(await lifecycle.start(automatic), /Resumed review thread open with 16 pending notes/);
    assert.equal((f.state.get(REVIEW_STATE_KEY) as any).reviewDay, "2026-10-22");
    assert.equal(f.calls.spawn, 0); assert.equal(f.calls.send, 1);
    assert.match(f.sent[0].input[0].text, /note 0/);
    assert.match(f.sent[0].input[0].text, /note 15/);
  }
});

test("an open review beyond the first full page is resumed", async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    f.threads.push({ id: `other-${i}`, projectId: "project", archivedAt: null, deletedAt: null, status: "idle", hasPendingInteraction: false, queuedWork: "none" });
  }
  f.threads.push({ id: "page-two", projectId: "project", archivedAt: null, deletedAt: null, status: "idle", hasPendingInteraction: false, queuedWork: "none" });
  f.metadata.set("page-two", { kind: "daily-review", file: "/test/pad.md" });
  assert.match(await createReviewLifecycle(f.host).start(automatic), /Resumed review thread page-two/);
  assert.equal(f.calls.list, 2); assert.equal(f.calls.spawn, 0); assert.equal(f.calls.send, 1);
  assert.match(f.sent[0].input[0].text, /note 15/);
});

test("an error-status review with failed work resumes", async () => {
  const f = fixture();
  f.threads.push({ id: "error", projectId: "project", archivedAt: null, deletedAt: null, status: "error", hasPendingInteraction: false, queuedWork: "failed" });
  f.metadata.set("error", { kind: "daily-review", file: "/test/pad.md" });
  assert.match(await createReviewLifecycle(f.host).start(automatic), /Resumed review thread error/);
  assert.equal(f.calls.spawn, 0); assert.equal(f.calls.send, 1);
  assert.match(f.sent[0].input[0].text, /note 0/);
});

test("automatic review does not launch outside review hours", async () => {
  for (const offset of [-4, 13]) {
    const f = fixture(); f.advance(offset * 60 * 60_000);
    assert.match(await createReviewLifecycle(f.host).start(automatic), /outside review hours/);
    assert.equal(f.calls.spawn, 0); assert.equal(f.calls.send, 0); assert.equal(f.calls.list, 0);
    assert.equal((f.state.get(REVIEW_STATE_KEY) as any).reviewDay, undefined);
  }
});
