// bb-plugin-pad — backend entry. Pad is one plain markdown outline on disk
// (`~/Pad/pad.md` by default). This server is its only writer: the
// panel, the `bb pad` command and the `pad_add` agent tool all go through it,
// so concurrent writes never lose a line. Hand edits made in any editor are
// picked up by a file watcher. The folder is a local git repo; changes are
// committed in small batches so every mistake can be undone. Nothing is
// pushed anywhere.
//
// Once a day the server opens one thread that walks the user through pending
// notes and routes only what the user approves.
import { execFile } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  applyOps,
  dateKey,
  ancestors,
  fullStamp,
  newId,
  parse,
  reconcile,
  serialize,
  type PadNode,
  type PadOp,
} from "./lib/outline.ts";
import { collectReview } from "./lib/review.ts";
import { createReviewLifecycle } from "./lib/review-lifecycle.ts";

const nodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["item", "raw"]),
  depth: z.number(),
  text: z.string(),
  done: z.boolean(),
  stamp: z.string(),
});

const id = z.string().min(1).max(64);
const text = z.string().max(4000);
const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append"), id, text }),
  z.object({ op: z.literal("insert"), id, after: id, depth: z.number().int().min(0).max(64), text }),
  z.object({ op: z.literal("edit"), id, text }),
  z.object({ op: z.literal("done"), id, done: z.boolean() }),
  z.object({ op: z.literal("indent"), id, delta: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({ op: z.literal("move"), id, dir: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({ op: z.literal("remove"), id }),
]);

const docSchema = z.object({ nodes: z.array(nodeSchema), path: z.string() });

export const rpcContract = defineRpcContract({
  pad_get: { input: z.null(), output: docSchema },
  pad_apply: { input: z.object({ ops: z.array(opSchema).min(1).max(200) }), output: docSchema },
});

/** Realtime channel: the document changed (from any writer). */
export const PAD_CHANGED = "pad-changed";

const COMMIT_DELAY_MS = 30_000;
const REVIEW_START_DELAY_MS = 2 * 60_000;
const REVIEW_CHECK_MS = 30 * 60_000;

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(path);
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile(cmd, args, { cwd, timeout: 15_000 }, (error, stdout) =>
      error ? fail(error) : done(stdout),
    );
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    folder: {
      type: "string",
      label: "Pad folder",
      description: "Holds pad.md and its git history. Reload the plugin after changing it.",
      default: "~/Pad",
    },
    review: {
      type: "boolean",
      label: "Daily review thread",
      description: "Once a day between 07:00 and 23:00, opens or resumes a review of pending notes until you resolve them.",
      default: false,
    },
    reviewProject: {
      type: "project",
      label: "Project for the daily review thread",
      description: "Choose a project before enabling daily review.",
    },
  });
  const config = await settings.get();
  const dir = expandHome(config.folder || "~/Pad");
  const file = join(dir, "pad.md");

  // -------------------------------------------------------------------------
  // Store: one in-memory document, serialized writes, atomic file replace.

  let nodes: PadNode[] = [];
  let lastText = "";
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  async function readDisk(): Promise<string> {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  /** Adopt the file's current content if someone else changed it. */
  async function syncFromDisk(): Promise<boolean> {
    const disk = await readDisk();
    if (disk === lastText) return false;
    nodes = reconcile(nodes, parse(disk));
    lastText = disk;
    return true;
  }

  async function writeDisk(next: string): Promise<void> {
    const tmp = join(dir, `.pad.md.${process.pid}.tmp`);
    await writeFile(tmp, next, "utf8");
    await rename(tmp, file);
    lastText = next;
  }

  function doc() {
    return { nodes, path: file };
  }

  async function apply(ops: readonly PadOp[]): Promise<ReturnType<typeof doc>> {
    return serial(async () => {
      const external = await syncFromDisk();
      const changed = applyOps(nodes, ops, new Date());
      if (changed) {
        await writeDisk(serialize(nodes));
        scheduleCommit();
      }
      if (changed || external) bb.realtime.publish(PAD_CHANGED, null);
      return doc();
    });
  }

  async function append(note: string): Promise<string> {
    const clean = note.replace(/\s+/g, " ").trim();
    if (clean === "") throw new Error("empty note");
    const noteId = newId();
    await apply([{ op: "append", id: noteId, text: clean }]);
    const index = nodes.findIndex((n) => n.id === noteId);
    return index === -1 ? clean : `${fullStamp(nodes, index)} ${clean}`;
  }

  await mkdir(dir, { recursive: true });
  if (!existsSync(file)) await writeFile(file, "", "utf8");
  await syncFromDisk();

  // -------------------------------------------------------------------------
  // Git history: a local repo, batched commits, never pushed.

  let gitReady = false;
  try {
    if (!existsSync(join(dir, ".git"))) await run("git", ["init", "-q"], dir);
    gitReady = true;
  } catch (error) {
    bb.log.warn(`git unavailable; pad history is off: ${String(error)}`);
  }


  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  async function commit(): Promise<void> {
    commitTimer = null;
    if (!gitReady) return;
    try {
      await run("git", ["add", "pad.md"], dir);
      const status = await run("git", ["status", "--porcelain", "pad.md"], dir);
      if (status.trim() === "") return;
      await run(
        "git",
        ["-c", "user.name=pad", "-c", "user.email=pad@localhost", "commit", "-q", "-m", `pad ${new Date().toISOString()}`],
        dir,
      );
    } catch (error) {
      bb.log.warn(`pad commit failed: ${String(error)}`);
    }
  }
  function scheduleCommit() {
    if (commitTimer !== null || disposed) return;
    commitTimer = setTimeout(() => void commit(), COMMIT_DELAY_MS);
  }

  // v0.1 files grouped notes under `## YYYY-MM-DD` headings. Commit that state,
  // then rewrite once in the topic-first format (full stamp on every note).
  if (/^## \d{4}-\d{2}-\d{2}\s*$/m.test(lastText)) {
    await commit();
    await writeDisk(serialize(nodes));
    await commit();
    bb.log.info("migrated pad.md from day headings to full stamps");
  }

  // -------------------------------------------------------------------------
  // Watch for hand edits (the directory, because an atomic replace swaps the
  // file's inode).

  let watcher: FSWatcher | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    watcher = watch(dir, (_event, name) => {
      if (name !== "pad.md") return;
      if (watchTimer !== null) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        void serial(async () => {
          if (await syncFromDisk()) {
            bb.realtime.publish(PAD_CHANGED, null);
            scheduleCommit();
          }
        }).catch((error) => bb.log.warn(`pad reload failed: ${String(error)}`));
      }, 120);
    });
  } catch (error) {
    bb.log.warn(`pad watcher unavailable: ${String(error)}`);
  }

  bb.onDispose(async () => {
    disposed = true;
    watcher?.close();
    if (watchTimer !== null) clearTimeout(watchTimer);
    if (commitTimer !== null) {
      clearTimeout(commitTimer);
      await commit();
    }
  });

  // -------------------------------------------------------------------------
  // RPC for the panel.

  bb.rpc.register(rpcContract, {
    pad_get: () => serial(async () => {
      await syncFromDisk();
      return doc();
    }),
    pad_apply: ({ ops }) => apply(ops),
  });

  // -------------------------------------------------------------------------
  // Agent tool: "save this note" from any thread.

  bb.agents.registerTool({
    name: "pad_add",
    description:
      "Add one note to the user's Pad (a plain-text outline on the right side of bb). Use when the user asks to note, jot down or remember something for later.",
    presentation: { label: { pending: "Adding to Pad", completed: "Added to Pad" } },
    parameters: z.object({
      text: z.string().min(1).max(1000).describe("The note, one line, in the user's language."),
    }),
    async execute({ text: note }) {
      const line = await append(`🤖 ${note}`);
      return `Added to Pad: ${line}`;
    },
  });

  // -------------------------------------------------------------------------
  // Daily review thread.

  async function reviewProjectId(): Promise<string | null> {
    return config.reviewProject || null;
  }

  const review = createReviewLifecycle({
    kv: bb.storage.kv,
    threads: bb.sdk.threads,
    file,
    projectId: reviewProjectId,
    notes: (now, includeToday) => serial(async () => {
      await syncFromDisk();
      return collectReview(nodes, { now, includeToday });
    }),
  });

  // Once per day, whenever bb is running at a reasonable hour: the machine
  // may be off or asleep at any fixed time, so check shortly after start
  // and then every half hour (which also catches wake from sleep).
  async function maybeReview(): Promise<void> {
    const result = await review.start({ includeToday: false, automatic: true });
    bb.log.info(`daily review: ${result}`);
  }

  if (config.review && config.reviewProject) {
    bb.background.service("daily-review", {
      async start(signal) {
        const sleep = (ms: number) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        await sleep(REVIEW_START_DELAY_MS);
        while (!signal.aborted) {
          await maybeReview().catch((error) => bb.log.warn(`daily review failed: ${String(error)}`));
          await sleep(REVIEW_CHECK_MS);
        }
      },
    });
  }

  // -------------------------------------------------------------------------
  // `bb pad` command.

  const usage = [
    "Usage:",
    '  bb pad add <note…>                         add a note to today',
    "  bb pad today                               print today's notes",
    "  bb pad show [--days N]                     print the last N days (default 3)",
    "  bb pad search <words…>                     find notes",
    '  bb pad mark --at "<YYYY-MM-DD HH:MM>" --text "<words in the note>" --mark "<mark>"',
    '                                             append a resolution mark (e.g. "[pad:keep]"); --at "" selects unstamped notes',
    "  bb pad review [--now] [--dry-run]          start the review thread now (--now includes today)",
    "  bb pad path                                print the file path",
  ].join("\n");

  function flag(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  }

  /** Notes written in the last N days, each with its parent chain for context. */
  function renderDays(days: number): string {
    const cutoff = dateKey(new Date(Date.now() - (days - 1) * 86_400_000));
    const keep = new Set<number>();
    nodes.forEach((node, i) => {
      if (node.kind !== "item" || node.stamp.slice(0, 10) < cutoff) return;
      keep.add(i);
      for (const a of ancestors(nodes, i)) keep.add(a);
    });
    const out = [...keep].sort((a, b) => a - b).map((i) => lineFor(nodes[i]));
    return out.length === 0 ? "No notes." : out.join("\n");
  }
  function lineFor(node: PadNode): string {
    return `${"  ".repeat(node.depth)}- ${node.done ? "[x] " : ""}${[node.stamp, node.text].filter(Boolean).join(" ")}`;
  }

  bb.cli.register({
    name: "pad",
    summary: "Pad: the user's plain-text notepad (add, read, search, mark notes)",
    commands: [
      { name: "add", summary: "Add a note to today", usage: "bb pad add <note…>" },
      { name: "today", summary: "Print today's notes", usage: "bb pad today" },
      { name: "show", summary: "Print recent days", usage: "bb pad show [--days N]" },
      { name: "search", summary: "Find notes", usage: "bb pad search <words…>" },
      {
        name: "mark",
        summary: "Append a routing mark to one note",
        usage: 'bb pad mark --at "<YYYY-MM-DD HH:MM>" --text "<words in the note>" --mark "<mark>"',
      },
      { name: "review", summary: "Start the daily review thread now", usage: "bb pad review [--now] [--dry-run]" },
      { name: "path", summary: "Print the pad file path", usage: "bb pad path" },
    ],
    async run(argv) {
      const [command, ...args] = argv;
      const ok = (stdout: string) => ({ exitCode: 0, stdout });
      const fail = (stderr: string) => ({ exitCode: 1, stderr });
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return ok(usage);
          case "add": {
            const note = args.join(" ").trim();
            if (note === "") return fail('Nothing to add. Usage: bb pad add "<note>"');
            return ok(`Added: ${await append(note)}`);
          }
          case "today":
            await serial(syncFromDisk);
            return ok(renderDays(1));
          case "show": {
            const days = Math.max(1, Math.min(60, Number(flag(args, "--days") ?? 3) || 3));
            await serial(syncFromDisk);
            return ok(renderDays(days));
          }
          case "search": {
            const words = args.map((w) => w.toLocaleLowerCase("tr")).filter(Boolean);
            if (words.length === 0) return fail("Usage: bb pad search <words…>");
            await serial(syncFromDisk);
            const hits: string[] = [];
            nodes.forEach((node, i) => {
              if (node.kind !== "item") return;
              const hay = node.text.toLocaleLowerCase("tr");
              if (words.every((w) => hay.includes(w))) hits.push(`${fullStamp(nodes, i)}  ${node.text}`);
            });
            return ok(hits.length === 0 ? "No match." : hits.slice(-200).join("\n"));
          }
          case "mark": {
            const at = flag(args, "--at");
            const fragment = flag(args, "--text")?.toLocaleLowerCase("tr");
            const mark = flag(args, "--mark")?.trim();
            if (at === undefined || !fragment || !mark) return fail(usage);
            let message = "";
            await serial(async () => {
              await syncFromDisk();
              const matches = nodes
                .map((node, i) => ({ node, i }))
                .filter(({ node, i }) => node.kind === "item" && fullStamp(nodes, i) === at && node.text.toLocaleLowerCase("tr").includes(fragment));
              if (matches.length !== 1) {
                message = matches.length === 0 ? "No note matches." : `${matches.length} notes match; use more words in --text.`;
                return;
              }
              const target = matches[0].node;
              if (target.text.trimEnd().endsWith(` ${mark}`) || target.text.trim() === mark) {
                message = "Already marked.";
                return;
              }
              const changed = applyOps(nodes, [{ op: "edit", id: target.id, text: `${target.text} ${mark}` }], new Date());
              if (changed) {
                await writeDisk(serialize(nodes));
                scheduleCommit();
                bb.realtime.publish(PAD_CHANGED, null);
              }
              message = `Marked: ${at} ${target.text}`;
            });
            return message.startsWith("Marked") || message === "Already marked." ? ok(message) : fail(message);
          }
          case "review":
            return ok(await review.start({ includeToday: args.includes("--now"), dryRun: args.includes("--dry-run") }));
          case "path":
            return ok(file);
        }
        return fail(usage);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.log.info(`loaded ${file} (${nodes.length} lines)`);
}
