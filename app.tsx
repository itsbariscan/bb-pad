// bb-plugin-pad — frontend. One Workflowy-style outline docked on the right
// side of every bb screen. The server owns the file; this panel applies each
// edit optimistically with the same outline functions and sends the op.
//
// The outline is organized by topic. Click a bullet to zoom into that note
// (a breadcrumb leads back out); the chevron beside it folds its children.
//
// Keys inside a note: Enter new note · Tab / Shift+Tab indent · ⌘↑/⌘↓ move ·
// ⌘Enter done (struck through, dimmed, sinks below open siblings) · ⌘. fold · Backspace on an empty note deletes it · Esc leaves.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  applyOps,
  cloneNodes,
  dateKey,
  ancestors,
  hasChildren,
  newId,
  subtreeEnd,
  type PadNode,
  type PadOp,
} from "@/lib/outline";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

const WIDTH = 340;
const STRIP = 28;
/** bb's own phone breakpoint (md). Below it Pad is a full-screen sheet. */
const NARROW = 768;
const EDIT_DELAY_MS = 400;
const OPEN_KEY = "bb-pad:open";
const FOLD_KEY = "bb-pad:folded";
const ZOOM_KEY = "bb-pad:zoom";
/** Paper's ink (#18181b / #e4e4e7), never pure black or white; other themes fall back to their sidebar text. */
const INK = "var(--ink, var(--sidebar-foreground))";

// ---------------------------------------------------------------------------
// Commands reach the mounted overlay through these handlers.

let focusHandler: (() => void) | null = null;
let toggleHandler: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Local preferences.

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: preferences just do not persist */
  }
}

function useStored<T>(key: string, initial: () => T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readJson(key, initial()));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeJson(key, next);
    },
    [key],
  );
  return [value, set];
}

// ---------------------------------------------------------------------------
// Document state: optimistic local copy, serialized op queue, debounced edits.

function usePad() {
  const rpc = useRpc<typeof rpcContract>();
  const [nodes, setNodes] = useState<PadNode[] | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const local = useRef<PadNode[]>([]);
  const queue = useRef<PadOp[]>([]);
  const inFlight = useRef(false);
  const edits = useRef(new Map<string, string>());
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((next: PadNode[]) => {
    local.current = next;
    setNodes(next);
  }, []);

  /** Server state plus edits not sent yet. */
  const adopt = useCallback(
    (server: PadNode[]) => {
      const next = cloneNodes(server);
      const pending: PadOp[] = [...edits.current].map(([id, text]) => ({ op: "edit", id, text }));
      if (pending.length > 0) applyOps(next, pending, new Date());
      show(next);
    },
    [show],
  );

  const refetch = useCallback(() => {
    rpc.call("pad_get").then(
      (doc) => {
        setPath(doc.path);
        setError(null);
        if (!inFlight.current && queue.current.length === 0) adopt(doc.nodes);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, adopt]);

  const flush = useCallback(() => {
    if (inFlight.current || queue.current.length === 0) return;
    const ops = queue.current.splice(0, 200);
    inFlight.current = true;
    rpc.call("pad_apply", { ops }).then(
      (doc) => {
        inFlight.current = false;
        setError(null);
        if (queue.current.length === 0) adopt(doc.nodes);
        else flush();
      },
      (cause) => {
        inFlight.current = false;
        setError(cause instanceof Error ? cause.message : String(cause));
        queue.current = [];
        refetch();
      },
    );
  }, [rpc, adopt, refetch]);

  const drainEdits = useCallback((): PadOp[] => {
    if (editTimer.current !== null) {
      clearTimeout(editTimer.current);
      editTimer.current = null;
    }
    const ops: PadOp[] = [...edits.current].map(([id, text]) => ({ op: "edit", id, text }));
    edits.current.clear();
    return ops;
  }, []);

  /** Apply structural ops now (after any pending text edits) and send them. */
  const commit = useCallback(
    (ops: PadOp[]) => {
      const all = [...drainEdits(), ...ops];
      if (all.length === 0) return;
      const next = cloneNodes(local.current);
      applyOps(next, ops, new Date());
      show(next);
      queue.current.push(...all);
      flush();
    },
    [drainEdits, flush, show],
  );

  /** Typing: show at once, send after a pause. */
  const edit = useCallback(
    (id: string, text: string) => {
      const next = cloneNodes(local.current);
      applyOps(next, [{ op: "edit", id, text }], new Date());
      show(next);
      edits.current.set(id, text);
      if (editTimer.current !== null) clearTimeout(editTimer.current);
      editTimer.current = setTimeout(() => {
        editTimer.current = null;
        commit([]);
      }, EDIT_DELAY_MS);
    },
    [commit, show],
  );

  const flushEdits = useCallback(() => commit([]), [commit]);

  useEffect(refetch, [refetch]);
  useRealtime("pad-changed", () => {
    if (!inFlight.current && queue.current.length === 0 && edits.current.size === 0) refetch();
  });
  useEffect(() => () => {
    // Unmount: do not drop typed text.
    if (edits.current.size > 0) {
      const ops: PadOp[] = [...edits.current].map(([id, text]) => ({ op: "edit", id, text }));
      edits.current.clear();
      void rpc.call("pad_apply", { ops }).catch(() => undefined);
    }
  }, [rpc]);

  return { nodes, path, error, commit, edit, flushEdits, local };
}

// ---------------------------------------------------------------------------
// Presentation helpers.

const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function RichText({ text }: { text: string }) {
  const arrow = text.indexOf(" →");
  const body = arrow === -1 ? text : text.slice(0, arrow);
  const mark = arrow === -1 ? "" : text.slice(arrow);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of body.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(body.slice(last, start));
    const url = match[0];
    let label = url;
    try {
      const u = new URL(url);
      label = `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
      if (label.length > 48) label = `${label.slice(0, 47)}…`;
    } catch {
      /* keep the raw url */
    }
    parts.push(
      <a
        key={`${start}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        data-pad-part="link"
        className="underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-(--ink)"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {label}
      </a>,
    );
    last = start + url.length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return (
    <>
      {parts}
      {mark ? (
        <span data-pad-part="mark" className="text-[11px] text-muted-foreground">
          {mark}
        </span>
      ) : null}
    </>
  );
}

/** "11:04" today, "yesterday 11:04", otherwise "20.10 11:04". */
function stampLabel(stamp: string): string {
  if (stamp.length <= 5) return stamp;
  const date = stamp.slice(0, 10);
  const time = stamp.slice(11);
  const now = new Date();
  if (date === dateKey(now)) return time;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date === dateKey(yesterday)) return `yesterday ${time}`;
  return `${date.slice(8, 10)}.${date.slice(5, 7)} ${time}`;
}

/** Grow a textarea to fit its text. */
function fit(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "0px";
  el.style.height = `${el.scrollHeight}px`;
}

function caretOnFirstLine(el: HTMLTextAreaElement): boolean {
  if (el.selectionStart !== el.selectionEnd) return false;
  const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
  return el.selectionStart === 0 || el.scrollHeight < line * 1.6;
}
function caretOnLastLine(el: HTMLTextAreaElement): boolean {
  if (el.selectionStart !== el.selectionEnd) return false;
  const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
  return el.selectionEnd === el.value.length || el.scrollHeight < line * 1.6;
}

// ---------------------------------------------------------------------------
// Visible rows.

type ItemRow = {
  kind: "item";
  node: PadNode;
  index: number;
  folded: boolean;
  parent: boolean;
  /** Indent level on screen: depth relative to the zoomed note. */
  level: number;
  /** Number of direct children (shown as the fold control). */
  children: number;
};
type Row = ItemRow | { kind: "raw"; node: PadNode };

/**
 * Rows on screen. Zoomed, only the zoomed note's subtree shows; a filter
 * searches the whole outline and lists matches flat.
 */
function visibleRows(nodes: readonly PadNode[], folded: ReadonlySet<string>, filter: string, zoom: number): Row[] {
  const rows: Row[] = [];
  const needle = filter.trim().toLocaleLowerCase("tr");
  if (needle !== "") {
    nodes.forEach((node, index) => {
      if (node.kind === "item" && node.text.toLocaleLowerCase("tr").includes(needle)) {
        rows.push({ kind: "item", node, index, folded: false, parent: false, level: 0, children: 0 });
      }
    });
    return rows;
  }
  const start = zoom === -1 ? 0 : zoom + 1;
  const end = zoom === -1 ? nodes.length : subtreeEnd(nodes, zoom);
  const base = zoom === -1 ? 0 : nodes[zoom].depth + 1;
  let i = start;
  while (i < end) {
    const node = nodes[i];
    if (node.kind === "raw") {
      if (node.text.trim() !== "") rows.push({ kind: "raw", node });
      i += 1;
      continue;
    }
    const parent = hasChildren(nodes, i);
    const isFolded = parent && folded.has(node.id);
    let children = 0;
    for (let j = i + 1; j < nodes.length && nodes[j].kind === "item" && nodes[j].depth > node.depth; j += 1) {
      if (nodes[j].depth === node.depth + 1) children += 1;
    }
    rows.push({ kind: "item", node, index: i, folded: isFolded, parent, level: node.depth - base, children });
    i = isFolded ? subtreeEnd(nodes, i) : i + 1;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The panel.

function PadOverlay() {
  const narrow = typeof window !== "undefined" && window.innerWidth < NARROW;
  // Desktop remembers open/closed; on a phone the sheet always starts closed.
  const [storedOpen, setStoredOpen] = useStored<boolean>(OPEN_KEY, () => true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [foldedList, setFoldedList] = useStored<string[]>(FOLD_KEY, () => []);
  const [zoomId, setZoomId] = useStored<string | null>(ZOOM_KEY, () => null);
  const [filter, setFilter] = useState("");
  /** The filter box stays hidden until ⌘F. */
  const [searching, setSearching] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const caretRequest = useRef<{ id: string; at: number | "end" } | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [isNarrow, setIsNarrow] = useState(narrow);
  const open = isNarrow ? sheetOpen : storedOpen;
  const setOpen = isNarrow ? setSheetOpen : setStoredOpen;
  const { nodes, path, error, commit, edit, flushEdits, local } = usePad();

  const folded = useMemo(() => new Set(foldedList), [foldedList]);
  const today = dateKey(new Date());
  const zoom = nodes && zoomId !== null ? nodes.findIndex((n) => n.id === zoomId && n.kind === "item") : -1;
  const zoomNode = zoom === -1 || !nodes ? null : nodes[zoom];
  const trail = zoom === -1 || !nodes ? [] : ancestors(nodes, zoom).map((i) => nodes[i]);
  const rows = useMemo(
    () => (nodes ? visibleRows(nodes, folded, filter, zoom) : []),
    [nodes, folded, filter, zoom],
  );
  const itemRows = useMemo(() => rows.filter((r): r is ItemRow => r.kind === "item"), [rows]);
  const titleRow: ItemRow | null =
    zoomNode && filter === "" ? { kind: "item", node: zoomNode, index: zoom, folded: false, parent: true, level: 0, children: 0 } : null;

  const zoomTo = useCallback(
    (id: string | null) => {
      setZoomId(id);
      setFocusId(null);
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = 0;
      });
    },
    [setZoomId],
  );

  // Track narrow layouts: there the panel floats instead of taking width.
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Reserve room on the right so bb's own layout never sits under the panel.
  const reserved = isNarrow ? 0 : open ? WIDTH : STRIP;
  useLayoutEffect(() => {
    const style = document.createElement("style");
    style.setAttribute("data-bb-pad", "reserve");
    style.textContent = `body.bb-app-shell > #root{margin-right:${reserved}px;transition:margin-right .15s ease}`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [reserved]);

  // bb desktop pins some header controls (its own right-panel toggle) to the
  // window edge, so the reserved margin does not move them and they end up
  // over Pad. Shift those to the left of Pad while it takes room; restore on
  // close or unmount.
  useEffect(() => {
    if (reserved === 0) return;
    const moved = new Map<HTMLElement, string>();
    const pinned = (el: HTMLElement) => {
      for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === "fixed") return true;
      }
      return false;
    };
    const scan = () => {
      const edge = window.innerWidth - reserved;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("button"))) {
        if (moved.has(el) || el.closest('[data-bb-pad],[role="menu"],[role="dialog"],[role="listbox"],[data-radix-popper-content-wrapper]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.top > 72 || r.right <= edge || !pinned(el)) continue;
        moved.set(el, el.style.translate);
        el.style.translate = `-${reserved}px 0`;
      }
    };
    scan();
    const timer = window.setInterval(scan, 1500);
    window.addEventListener("resize", scan);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", scan);
      for (const [el, original] of moved) el.style.translate = original;
    };
  }, [reserved]);

  // Commands from the palette / shortcuts.
  useEffect(() => {
    focusHandler = () => {
      setOpen(true);
      requestAnimationFrame(() => startNoteRef.current());
    };
    toggleHandler = () => setOpen(!open);
    return () => {
      focusHandler = null;
      toggleHandler = null;
    };
  }, [open, setOpen]);

  // Land the caret where the last action asked for it.
  useLayoutEffect(() => {
    const request = caretRequest.current;
    if (!request) return;
    const el = listRef.current?.querySelector<HTMLTextAreaElement>(`textarea[data-pad-id="${request.id}"]`);
    if (!el) return;
    caretRequest.current = null;
    el.focus();
    const at = request.at === "end" ? el.value.length : request.at;
    el.setSelectionRange(at, at);
  });

  // Start at the bottom, where today is.
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    if (scrolled.current || !nodes || !listRef.current) return;
    scrolled.current = true;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [nodes, open]);

  const focusNode = useCallback((id: string, at: number | "end") => {
    caretRequest.current = { id, at };
    setFocusId(id);
  }, []);

  const toggleFold = useCallback(
    (id: string) => {
      setFoldedList(folded.has(id) ? foldedList.filter((x) => x !== id) : [...foldedList, id]);
    },
    [folded, foldedList, setFoldedList],
  );

  /** Click on empty space: continue today's empty last note, or start one. */
  const startNote = useCallback(() => {
    const doc = local.current;
    if (filter !== "") setFilter("");
    const root = zoomId === null ? -1 : doc.findIndex((n) => n.id === zoomId);
    if (root !== -1) {
      // Zoomed: a new last child of the zoomed note.
      const end = subtreeEnd(doc, root);
      const last = doc[end - 1];
      if (end - 1 > root && last.text === "" && last.depth === doc[root].depth + 1) {
        focusNode(last.id, "end");
        return;
      }
      const id = newId();
      commit([{ op: "insert", id, after: last.id, depth: doc[root].depth + 1, text: "" }]);
      focusNode(id, 0);
      return;
    }
    const last = doc[doc.length - 1];
    if (last !== undefined && last.kind === "item" && last.depth === 0 && last.text === "") {
      focusNode(last.id, "end");
    } else {
      const id = newId();
      commit([{ op: "append", id, text: "" }]);
      focusNode(id, 0);
    }
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  }, [commit, filter, focusNode, local, zoomId]);
  const startNoteRef = useRef(startNote);
  startNoteRef.current = startNote;

  function onItemKey(event: KeyboardEvent<HTMLTextAreaElement>, row: ItemRow, isTitle = false) {
    const el = event.currentTarget;
    const doc = local.current;
    const index = doc.findIndex((n) => n.id === row.node.id);
    if (index === -1 || event.nativeEvent.isComposing) return;
    const node = doc[index];
    const mod = event.metaKey || event.ctrlKey;
    const position = itemRows.findIndex((r) => r.node.id === node.id);

    if (isTitle) {
      // The zoomed note's title: Enter starts its first child; ↓ enters the list.
      if (event.key === "Enter" && !event.shiftKey && !mod) {
        event.preventDefault();
        const caret = el.selectionStart;
        const id = newId();
        const ops: PadOp[] = [];
        if (el.value.slice(0, caret) !== node.text) ops.push({ op: "edit", id: node.id, text: el.value.slice(0, caret) });
        ops.push({ op: "insert", id, after: node.id, depth: node.depth + 1, text: el.value.slice(el.selectionEnd) });
        commit(ops);
        focusNode(id, 0);
      } else if (event.key === "ArrowDown" && caretOnLastLine(el) && itemRows[0]) {
        event.preventDefault();
        focusNode(itemRows[0].node.id, "end");
      } else if (event.key === "Escape") {
        event.preventDefault();
        el.blur();
      }
      return;
    }

    if (event.key === "Enter" && mod) {
      event.preventDefault();
      // Marking done sinks the note below its open siblings; the cursor stays
      // in place on the open sibling that moves up into its slot.
      const below = doc[subtreeEnd(doc, index)];
      commit([{ op: "done", id: node.id, done: !node.done }]);
      if (!node.done && below?.kind === "item" && below.depth === node.depth && !below.done) focusNode(below.id, "end");
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const caret = el.selectionStart;
      const before = el.value.slice(0, caret);
      const after = el.value.slice(el.selectionEnd);
      const id = newId();
      if (caret === 0 && el.value !== "") {
        // New empty note above this one.
        const prev = doc[index - 1];
        if (!prev) return;
        commit([{ op: "insert", id, after: prev.id, depth: node.depth, text: "" }]);
        focusNode(id, 0);
        return;
      }
      const intoChildren = hasChildren(doc, index) && !folded.has(node.id);
      const anchor = intoChildren ? node.id : doc[subtreeEnd(doc, index) - 1].id;
      const ops: PadOp[] = [];
      if (before !== node.text) ops.push({ op: "edit", id: node.id, text: before });
      ops.push({ op: "insert", id, after: anchor, depth: intoChildren ? node.depth + 1 : node.depth, text: after });
      commit(ops);
      focusNode(id, 0);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const at = el.selectionStart;
      // Zoomed: a direct child cannot leave the zoomed note.
      if (event.shiftKey && zoomNode && node.depth <= zoomNode.depth + 1) return;
      commit([{ op: "indent", id: node.id, delta: event.shiftKey ? -1 : 1 }]);
      focusNode(node.id, at);
      return;
    }
    if (event.key === "Backspace" && el.value === "" && !hasChildren(doc, index)) {
      event.preventDefault();
      const prev = itemRows[position - 1];
      commit([{ op: "remove", id: node.id }]);
      if (prev) focusNode(prev.node.id, "end");
      else setFocusId(null);
      return;
    }
    if (mod && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const at = el.selectionStart;
      commit([{ op: "move", id: node.id, dir: event.key === "ArrowUp" ? -1 : 1 }]);
      focusNode(node.id, at);
      return;
    }
    if (mod && event.key === ".") {
      event.preventDefault();
      if (hasChildren(doc, index)) toggleFold(node.id);
      return;
    }
    if (event.key === "ArrowUp" && !event.shiftKey && caretOnFirstLine(el)) {
      const prev = itemRows[position - 1] ?? titleRow;
      if (prev) {
        event.preventDefault();
        focusNode(prev.node.id, "end");
      }
      return;
    }
    if (event.key === "ArrowDown" && !event.shiftKey && caretOnLastLine(el)) {
      event.preventDefault();
      const next = itemRows[position + 1];
      if (next) focusNode(next.node.id, "end");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      el.blur();
    }
  }

  function onItemPaste(event: ClipboardEvent<HTMLTextAreaElement>, node: PadNode) {
    const pasted = event.clipboardData.getData("text/plain");
    if (!/[\r\n]/.test(pasted)) return;
    event.preventDefault();
    const el = event.currentTarget;
    const lines = pasted.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) return;
    const before = el.value.slice(0, el.selectionStart);
    const after = el.value.slice(el.selectionEnd);
    const ops: PadOp[] = [{ op: "edit", id: node.id, text: before + lines[0] }];
    let anchor = node.id;
    lines.slice(1).forEach((line, k) => {
      const id = newId();
      ops.push({ op: "insert", id, after: anchor, depth: node.depth, text: k === lines.length - 2 ? line + after : line });
      anchor = id;
    });
    if (lines.length === 1) ops[0] = { op: "edit", id: node.id, text: before + lines[0] + after };
    commit(ops);
    focusNode(anchor, "end");
  }

  function onPanelKey(event: KeyboardEvent<HTMLElement>) {
    const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
    if (event.key === "Escape" && !typing && zoomNode) {
      event.preventDefault();
      zoomTo(trail.length > 0 ? trail[trail.length - 1].id : null);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setSearching(true);
      requestAnimationFrame(() => {
        filterRef.current?.focus();
        filterRef.current?.select();
      });
    }
  }

  // --- collapsed strip ----------------------------------------------------
  if (!open) {
    // Phones: nothing floats over bb; Pad opens from the sidebar's Pad row
    // or the command palette.
    if (isNarrow) return null;
    const todayCount = nodes ? nodes.filter((n) => n.kind === "item" && n.stamp.startsWith(today)).length : 0;
    return (
      <button
        type="button"
        data-bb-pad="strip"
        aria-label="Open Pad"
        title="Open Pad"
        onClick={() => setOpen(true)}
        className="fixed right-0 top-0 z-[45] flex w-[28px] flex-col items-center gap-2 border-l border-sidebar-border bg-sidebar pt-2.5 font-mono [-webkit-app-region:no-drag] text-muted-foreground hover:text-foreground"
        style={{ height: "var(--bb-shell-height, 100dvh)" }}
      >
        <Icon name="PanelRight" className="size-[16px]" />
        <span className="text-[11px] [writing-mode:vertical-rl]">pad</span>
        {todayCount > 0 ? <span className="font-mono text-[10px]">{todayCount}</span> : null}
      </button>
    );
  }

  function renderItem(row: ItemRow, isTitle: boolean) {
    const { node } = row;
    const editing = focusId === node.id;
    const textClass = cn(
      "min-w-0 flex-1 py-0.5",
      isTitle && "text-[1.15em] font-medium",
      node.done && "text-muted-foreground line-through",
    );
    return (
      <div
        key={isTitle ? `title-${node.id}` : node.id}
        data-pad-part={isTitle ? "title" : "item"}
        data-done={node.done || undefined}
        className={cn(
          "group flex items-start rounded pr-1",
          isTitle ? "mb-1 px-1" : "hover:bg-sidebar-accent/60",
          node.done && !isTitle && "opacity-45 hover:opacity-80 focus-within:opacity-80",
        )}
        style={isTitle ? undefined : { paddingLeft: 4 + row.level * 18 }}
      >
        {isTitle ? null : (
          <>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => zoomTo(node.id)}
              className="mt-[3px] mr-1.5 flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-sidebar-accent hover:text-(--ink)"
            >
              <span
                data-pad-part="bullet"
                className={cn(
                  "block rounded-full bg-current",
                  row.folded ? "size-[7px] outline outline-[3px] outline-sidebar-border" : "size-[5px]",
                )}
              />
            </button>
          </>
        )}
        {editing ? (
          <textarea
            data-pad-id={node.id}
            rows={1}
            value={node.text}
            ref={fit}
            onChange={(e) => {
              edit(node.id, e.target.value.replace(/[\r\n]+/g, " "));
              fit(e.currentTarget);
            }}
            onKeyDown={(e) => onItemKey(e, row, isTitle)}
            onPaste={(e) => onItemPaste(e, node)}
            onBlur={() => {
              const doc = local.current;
              const at = doc.findIndex((n) => n.id === node.id);
              // A note left empty is not kept (a zoomed title is kept).
              if (!isTitle && at !== -1 && doc[at].text.trim() === "" && !hasChildren(doc, at)) {
                commit([{ op: "remove", id: node.id }]);
              } else {
                flushEdits();
              }
              setFocusId((current) => (current === node.id ? null : current));
            }}
            className={cn(textClass, "resize-none overflow-hidden bg-transparent outline-none")}
          />
        ) : (
          <div
            role="textbox"
            tabIndex={0}
            onMouseDown={(e) => {
              e.preventDefault();
              focusNode(node.id, "end");
            }}
            onFocus={() => focusNode(node.id, "end")}
            className={cn(textClass, "cursor-text whitespace-pre-wrap break-words", node.text === "" && "text-muted-foreground/50")}
          >
            {node.text === "" ? "\u00a0" : <RichText text={node.text} />}
          </div>
        )}
        {!isTitle && row.parent ? (
          <button
            type="button"
            tabIndex={-1}
            data-pad-part="fold"
            aria-label={row.folded ? `Expand (${row.children} children)` : `Fold (${row.children} children)`}
            title={row.folded ? "Expand (⌘.)" : "Fold (⌘.)"}
            onClick={() => toggleFold(node.id)}
            className={cn(
              "ml-1 mt-[2px] flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded px-1 text-[10px] tabular-nums hover:bg-sidebar-accent hover:text-(--ink)",
              row.folded ? "bg-sidebar-accent text-(--ink)" : "text-muted-foreground",
            )}
          >
            {row.children}
          </button>
        ) : null}
        <span data-pad-part="stamp" className="ml-1 mt-[3px] shrink-0 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">
          {stampLabel(node.stamp)}
        </span>
      </div>
    );
  }

  // --- open panel -------------------------------------------------------
  return (
    <aside
      data-bb-pad="panel"
      aria-label="Pad"
      onKeyDown={(e) => {
        onPanelKey(e);
        if (isNarrow && e.key === "Escape" && !e.defaultPrevented) setOpen(false);
      }}
      className={cn(
        // bb desktop's title bar is a fixed full-width layer at z-44; Pad sits
        // just above it so its header controls receive clicks.
        "fixed z-[45] flex flex-col bg-sidebar font-mono [-webkit-app-region:no-drag]",
        isNarrow ? "inset-0 z-[60]" : "right-0 top-0 border-l border-sidebar-border",
      )}
      style={
        isNarrow
          ? {
              height: "100dvh",
              paddingTop: "env(safe-area-inset-top)",
              paddingBottom: "env(safe-area-inset-bottom)",
              color: INK,
            }
          : { width: WIDTH, height: "var(--bb-shell-height, 100dvh)", color: INK }
      }
    >
      <header data-pad-part="header" className={cn("flex shrink-0 items-center gap-2 border-b border-sidebar-border pl-3 pr-1.5 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag] [&_input]:[-webkit-app-region:no-drag]", isNarrow ? "h-12" : "h-10")}>
        {zoomNode ? (
          <button
            type="button"
            data-pad-part="back"
            onClick={() => zoomTo(trail.length > 0 ? trail[trail.length - 1].id : null)}
            title="Back (Esc)"
            className="-ml-1.5 flex h-[28px] min-w-0 max-w-[60%] items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-sidebar-accent hover:text-(--ink)"
          >
            <Icon name="ArrowLeft" className="size-[14px] shrink-0" />
            <span className="truncate">{trail.length > 0 ? trail[trail.length - 1].text || "…" : "pad"}</span>
          </button>
        ) : (
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground" title={path}>
            pad
          </span>
        )}
        {searching || filter !== "" ? (
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setFilter("");
              setSearching(false);
            }
          }}
          onBlur={() => {
            if (filter === "") setSearching(false);
          }}
          placeholder="search notes…"
          aria-label="Search notes"
          className={cn(
            "min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 outline-none placeholder:text-muted-foreground/60 focus:border-sidebar-border",
            isNarrow ? "h-9 text-[16px]" : "h-6 text-[12px]",
          )}
        />
        ) : (
          <span className="flex-1" />
        )}
        {isNarrow ? (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="h-9 shrink-0 rounded-md px-3 text-[14px] text-(--ink) active:bg-sidebar-accent"
          >
            Close
          </button>
        ) : (
        <button
          type="button"
          aria-label="Hide Pad"
          title="Hide Pad (⌘⇧Y to reopen)"
          onClick={() => setOpen(false)}
          className="flex size-[28px] items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-(--ink)"
        >
          <Icon name="PanelRight" className="size-[16px]" />
        </button>
        )}
      </header>

      <div
        ref={listRef}
        data-pad-part="list"
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2",
          "flex flex-col",
          isNarrow ? "text-[16px] leading-[1.5]" : "text-[12.5px] leading-[1.6]",
        )}
      >
        {nodes === null ? (
          <p className="px-2 py-4 text-[12px] text-muted-foreground">{error ?? "Loading…"}</p>
        ) : null}
        {titleRow ? renderItem(titleRow, true) : null}
        {filter !== "" && rows.length === 0 ? (
          <p className="px-2 py-4 text-[12px] text-muted-foreground">No matching notes.</p>
        ) : null}
        {rows.map((row) =>
          row.kind === "raw" ? (
            <div key={row.node.id} data-pad-part="raw" className="truncate px-1 py-0.5 text-[11.5px] text-muted-foreground" title={row.node.text}>
              {row.node.text}
            </div>
          ) : (
            renderItem(row, false)
          ),
        )}
        {nodes !== null ? (
          <div
            data-pad-part="space"
            aria-label="New note"
            className="min-h-24 flex-1 cursor-text"
            onMouseDown={(e) => {
              e.preventDefault();
              startNote();
            }}
          >
            {rows.length === 0 && !filter ? (
              <p className="px-2 py-2 text-muted-foreground/70">{zoomNode ? "Click to write under this topic." : "Click to write."}</p>
            ) : null}
          </div>
        ) : null}
        {error && nodes !== null ? <p className="px-2 pb-2 text-[11px] text-destructive">{error}</p> : null}
      </div>

    </aside>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "pad", component: PadOverlay });
  app.commands.register({
    id: "pad-focus",
    title: "Pad: write a note",
    defaultShortcut: { key: "y", mod: true, shift: true },
    run: () => focusHandler?.(),
  });
  // A Pad row in bb's sidebar footer: the way in on phones, a toggle on desktop.
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "pad",
    label: "Pad",
    icon: "pad/pad",
    onActivate: () => toggleHandler?.(),
  });
  app.commands.register({
    id: "pad-toggle",
    title: "Pad: show or hide the panel",
    run: () => toggleHandler?.(),
  });
});
