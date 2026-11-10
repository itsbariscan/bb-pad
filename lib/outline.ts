// Pad's outline model, shared by the server (the single writer) and the panel
// (optimistic updates). The file is the source of truth: one continuous
// outline, organized by topic, every note carrying its full time stamp.
//
//   - 2026-10-22 13:31 Project ideas
//     - 2026-10-22 13:19 Plan the next release
//   - [x] 2026-10-22 11:20 done note → sample-project
//
// Every line becomes a node. Lines the parser does not understand stay as
// `raw` nodes and are written back verbatim, so hand edits survive. Files
// from v0.1 grouped notes under `## YYYY-MM-DD` day headings; parse() folds
// the heading's date into each note's stamp and drops the heading.

export type NodeKind = "item" | "raw";

export interface PadNode {
  id: string;
  kind: NodeKind;
  /** Indent level; 0 for day and raw nodes. */
  depth: number;
  /** Item text, or the raw line verbatim. */
  text: string;
  done: boolean;
  /** "HH:MM", "YYYY-MM-DD HH:MM", or "" for an unstamped item. */
  stamp: string;
}

export type PadOp =
  /** Add a top-level note at the end of the outline. */
  | { op: "append"; id: string; text: string }
  /** Add a note directly after node `after`, at `depth` (clamped). */
  | { op: "insert"; id: string; after: string; depth: number; text: string }
  | { op: "edit"; id: string; text: string }
  | { op: "done"; id: string; done: boolean }
  /** Indent (+1) or outdent (-1) a note with its children. */
  | { op: "indent"; id: string; delta: 1 | -1 }
  /** Swap a note (with its children) with its previous or next sibling. */
  | { op: "move"; id: string; dir: 1 | -1 }
  /** Remove one note; its children move up a level. */
  | { op: "remove"; id: string };

const DAY_RE = /^## (\d{4}-\d{2}-\d{2})\s*$/;
const ITEM_RE =
  /^([ \t]*)- (\[[xX]\] )?(?:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}|\d{2}:\d{2})(?= |$) ?)?(.*)$/;
const MAX_TEXT = 4000;

let counter = 0;
export function newId(): string {
  counter = (counter + 1) % 1_000_000;
  return `${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

function indentLevel(ws: string): number {
  let spaces = 0;
  for (const ch of ws) spaces += ch === "\t" ? 2 : 1;
  return Math.floor(spaces / 2);
}

export function parse(source: string): PadNode[] {
  const text = source.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const nodes: PadNode[] = [];
  let legacyDate: string | null = null;
  for (const line of lines) {
    const day = DAY_RE.exec(line);
    if (day) {
      // v0.1 day heading: remember its date, drop it and the blank line before it.
      legacyDate = day[1];
      const last = nodes[nodes.length - 1];
      if (last && last.kind === "raw" && last.text.trim() === "") nodes.pop();
      continue;
    }
    const item = ITEM_RE.exec(line);
    if (item) {
      let stamp = item[3] ?? "";
      if (stamp.length === 5 && legacyDate !== null) stamp = `${legacyDate} ${stamp}`;
      nodes.push({
        id: newId(),
        kind: "item",
        depth: indentLevel(item[1]),
        text: item[4],
        done: item[2] !== undefined,
        stamp,
      });
      continue;
    }
    nodes.push({ id: newId(), kind: "raw", depth: 0, text: line, done: false, stamp: "" });
  }
  return normalize(nodes);
}

export function lineOf(node: PadNode): string {
  if (node.kind === "raw") return node.text;
  const body = [node.stamp, node.text].filter((part) => part !== "").join(" ");
  return `${"  ".repeat(node.depth)}- ${node.done ? "[x] " : ""}${body}`;
}

export function serialize(nodes: readonly PadNode[]): string {
  return nodes.length === 0 ? "" : `${nodes.map(lineOf).join("\n")}\n`;
}

/** Keep every item at most one level deeper than the item above it. */
export function normalize(nodes: PadNode[]): PadNode[] {
  let prev = -1;
  for (const node of nodes) {
    if (node.kind !== "item") {
      prev = -1;
      continue;
    }
    if (node.depth > prev + 1) node.depth = prev + 1;
    if (node.depth < 0) node.depth = 0;
    prev = node.depth;
  }
  return nodes;
}

/**
 * Carry ids from the previous parse over to a fresh one, matching identical
 * lines in order, so an external edit does not reset the panel's focus.
 */
export function reconcile(previous: readonly PadNode[], next: PadNode[]): PadNode[] {
  const pool = new Map<string, string[]>();
  for (const node of previous) {
    const key = lineOf(node);
    const ids = pool.get(key);
    if (ids) ids.push(node.id);
    else pool.set(key, [node.id]);
  }
  for (const node of next) {
    const ids = pool.get(lineOf(node));
    const id = ids?.shift();
    if (id !== undefined) node.id = id;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Dates

const pad2 = (n: number) => String(n).padStart(2, "0");
export function dateKey(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}
export function timeKey(at: Date): string {
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

export function stampOf(at: Date): string {
  return `${dateKey(at)} ${timeKey(at)}`;
}

/** The note's "YYYY-MM-DD HH:MM" ("" or a bare "HH:MM" for hand-written lines). */
export function fullStamp(nodes: readonly PadNode[], index: number): string {
  return nodes[index].stamp;
}

/** Indexes of a node's ancestors, outermost first. */
export function ancestors(nodes: readonly PadNode[], index: number): number[] {
  const out: number[] = [];
  let depth = nodes[index].depth;
  for (let i = index - 1; i >= 0 && depth > 0; i -= 1) {
    const node = nodes[i];
    if (node.kind !== "item") break;
    if (node.depth < depth) {
      out.unshift(i);
      depth = node.depth;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structure helpers

/** Index one past the last descendant of nodes[index]. */
export function subtreeEnd(nodes: readonly PadNode[], index: number): number {
  const depth = nodes[index].depth;
  let end = index + 1;
  while (end < nodes.length && nodes[end].kind === "item" && nodes[end].depth > depth) end += 1;
  return end;
}

export function hasChildren(nodes: readonly PadNode[], index: number): boolean {
  const next = nodes[index + 1];
  return next !== undefined && next.kind === "item" && next.depth > nodes[index].depth;
}

function previousSibling(nodes: readonly PadNode[], index: number): number {
  const depth = nodes[index].depth;
  for (let i = index - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node.kind !== "item" || node.depth < depth) return -1;
    if (node.depth === depth) return i;
  }
  return -1;
}

function nextSibling(nodes: readonly PadNode[], index: number): number {
  const end = subtreeEnd(nodes, index);
  const node = nodes[end];
  if (node === undefined || node.kind !== "item" || node.depth !== nodes[index].depth) return -1;
  return end;
}

/**
 * Done notes sink below their open siblings. A note just marked done goes to
 * the end of its sibling group; one marked open again goes just above the
 * first done sibling. The note travels with its children.
 */
function settleDone(nodes: PadNode[], index: number): void {
  const node = nodes[index];
  let first = index;
  for (let prev = previousSibling(nodes, first); prev !== -1; prev = previousSibling(nodes, prev)) first = prev;
  const siblings: number[] = [];
  for (let i = first; i !== -1; i = nextSibling(nodes, i)) siblings.push(i);
  const block = subtreeEnd(nodes, index) - index;
  let target: number;
  if (node.done) {
    target = subtreeEnd(nodes, siblings[siblings.length - 1]);
  } else {
    const firstDone = siblings.find((i) => i !== index && nodes[i].done);
    if (firstDone === undefined || firstDone > index) return;
    target = firstDone;
  }
  if (target === index || target === index + block) return;
  const moved = nodes.splice(index, block);
  nodes.splice(target > index ? target - block : target, 0, ...moved);
}

function cleanText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").slice(0, MAX_TEXT);
}

// ---------------------------------------------------------------------------
// Operations. Each returns true when it changed the document. Unknown ids are
// ignored, so a stale client op never corrupts the file.

export function applyOp(nodes: PadNode[], op: PadOp, now: Date): boolean {
  const index = "id" in op ? nodes.findIndex((n) => n.id === op.id) : -1;
  switch (op.op) {
    case "append": {
      if (index !== -1) return false;
      nodes.push({
        id: op.id,
        kind: "item",
        depth: 0,
        text: cleanText(op.text),
        done: false,
        stamp: stampOf(now),
      });
      return true;
    }
    case "insert": {
      if (index !== -1) return false;
      const after = nodes.findIndex((n) => n.id === op.after);
      if (after === -1) return false;
      const at = after + 1;
      const above = nodes[after];
      const max = above.kind === "item" ? above.depth + 1 : 0;
      nodes.splice(at, 0, {
        id: op.id,
        kind: "item",
        depth: Math.max(0, Math.min(op.depth, max)),
        text: cleanText(op.text),
        done: false,
        stamp: stampOf(now),
      });
      normalize(nodes);
      return true;
    }
    case "edit": {
      const node = nodes[index];
      if (node === undefined || node.kind !== "item") return false;
      const text = cleanText(op.text);
      if (node.text === text) return false;
      node.text = text;
      return true;
    }
    case "done": {
      const node = nodes[index];
      if (node === undefined || node.kind !== "item" || node.done === op.done) return false;
      node.done = op.done;
      settleDone(nodes, index);
      return true;
    }
    case "indent": {
      const node = nodes[index];
      if (node === undefined || node.kind !== "item") return false;
      if (op.delta === 1 && previousSibling(nodes, index) === -1) return false;
      if (op.delta === -1 && node.depth === 0) return false;
      const end = subtreeEnd(nodes, index);
      for (let i = index; i < end; i += 1) nodes[i].depth += op.delta;
      normalize(nodes);
      return true;
    }
    case "move": {
      const node = nodes[index];
      if (node === undefined || node.kind !== "item") return false;
      if (op.dir === -1) {
        const prev = previousSibling(nodes, index);
        if (prev === -1) return false;
        const block = nodes.splice(index, subtreeEnd(nodes, index) - index);
        nodes.splice(prev, 0, ...block);
        return true;
      }
      const next = nextSibling(nodes, index);
      if (next === -1) return false;
      const nextBlock = nodes.splice(next, subtreeEnd(nodes, next) - next);
      nodes.splice(index, 0, ...nextBlock);
      return true;
    }
    case "remove": {
      const node = nodes[index];
      if (node === undefined || node.kind !== "item") return false;
      const end = subtreeEnd(nodes, index);
      for (let i = index + 1; i < end; i += 1) nodes[i].depth -= 1;
      nodes.splice(index, 1);
      normalize(nodes);
      return true;
    }
  }
}

export function applyOps(nodes: PadNode[], ops: readonly PadOp[], now: Date): boolean {
  let changed = false;
  for (const op of ops) changed = applyOp(nodes, op, now) || changed;
  return changed;
}

export function cloneNodes(nodes: readonly PadNode[]): PadNode[] {
  return nodes.map((node) => ({ ...node }));
}
