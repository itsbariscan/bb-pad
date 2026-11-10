import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOps, parse, serialize } from "../lib/outline.ts";
import { collectReview, isSettled, reviewPrompt } from "../lib/review.ts";

const now = new Date(2026, 9, 22, 11, 4);

test("only explicit trailing resolution markers settle notes", () => {
  for (const marker of ["[pad:task:project]", "[pad:knowledge:project]", "[pad:keep]", "[pad:drop]"]) {
    assert.equal(isSettled(`note ${marker}  `), true, marker);
  }
  for (const legacy of ["Sample task → workspace/project", "note → kb:project", "note ✕"]) {
    assert.equal(isSettled(legacy), true, legacy);
  }
  for (const text of ["A → B", "API → MCP flow idea", "note → project", "note [pad:task:]", "note [pad:keep] more", "note [pad:drop:project]"]) {
    assert.equal(isSettled(text), false, text);
  }
});

test("old, unstamped and plain-arrow notes stay pending; legacy drops stay settled; today is optional", () => {
  const nodes = parse(`- 2020-01-01 09:00 old → project
- 2026-10-20 10:00 legacy ✕
- unstamped
- 2026-10-21 10:00 done [pad:keep]
- 2026-10-21 10:01 routed [pad:task:project]
- [x] 2026-10-21 10:02 checkbox
- 2026-10-22 10:00 today
- 2026-10-23 10:00 future
`);
  const select = (includeToday: boolean) => collectReview(nodes, { now, includeToday }).map((n) => n.text);
  assert.deepEqual(select(false), ["old → project", "unstamped"]);
  assert.deepEqual(select(true), ["old → project", "unstamped", "today"]);
});

test("review prompt requires approval and successful action before marking every decision", () => {
  const prompt = reviewPrompt([], { file: "/x/pad.md", now });
  for (const marker of ["[pad:task:<project>]", "[pad:knowledge:<project>]", "[pad:keep]", "[pad:drop]"]) assert.ok(prompt.includes(marker));
  assert.match(prompt, /After an approved action has successfully completed/);
  assert.match(prompt, /Do not mark an action that failed or was not approved/);
});

test("a kept note remains on disk, stays resolved after reparse, and can be reopened", () => {
  const nodes = parse("- 2026-10-01 09:00 A → B is worth keeping\n- 2026-10-01 09:01 unanswered\n");
  applyOps(nodes, [{ op: "edit", id: nodes[0].id, text: `${nodes[0].text} [pad:keep]` }], now);
  const disk = serialize(nodes);
  assert.match(disk, /A → B is worth keeping \[pad:keep\]/);
  const reparsed = parse(disk);
  assert.deepEqual(collectReview(reparsed, { now, includeToday: false }).map((n) => n.text), ["unanswered"]);
  applyOps(reparsed, [{ op: "edit", id: reparsed[0].id, text: "A → B is worth keeping" }], now);
  assert.equal(collectReview(reparsed, { now, includeToday: false }).length, 2);
});
