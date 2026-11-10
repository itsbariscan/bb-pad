import { createHash } from "node:crypto";
import type { PluginBbSdk, PluginKvStorage } from "@get-bb/plugin-sdk";
import { dateKey } from "./outline.ts";
import { reviewPrompt, type ReviewNote } from "./review.ts";

export const REVIEW_STATE_KEY = "reviewLifecycle";
export const MAX_REVIEW_ATTEMPTS = 3;
export const REVIEW_RETRY_MS = 30 * 60_000;

interface ReviewState {
  version: 2;
  reviewDay?: string;
  attemptDay?: string;
  attempts: number;
  retryAt: number;
}

type Threads = Pick<PluginBbSdk["threads"],
  "list" | "experimental_listPluginMetadata" | "spawn" | "send" | "updatePluginMetadata">;

interface ReviewHost {
  kv: PluginKvStorage;
  threads: Threads;
  file: string;
  now?: () => Date;
  notes: (now: Date, includeToday: boolean) => Promise<ReviewNote[]>;
  projectId: () => Promise<string | null>;
}

/** One gate shared by the scheduler and CLI, with durable retry bookkeeping.
 * Delivery is not resolution: only explicit marks in the document settle notes.
 */
export function createReviewLifecycle(host: ReviewHost) {
  let queue: Promise<unknown> = Promise.resolve();

  async function loadState(): Promise<ReviewState> {
    const state = await host.kv.get<ReviewState>(REVIEW_STATE_KEY);
    if (state?.version === 2) return state;
    // v1's reviewedThrough was delivery, not approval, and reviewDay could be
    // a failed spawn. Neither is safe to import. Preserve the legacy keys for
    // diagnosis, but never consult them again; no document rewrite is needed.
    const migrated: ReviewState = { version: 2, attempts: 0, retryAt: 0 };
    await host.kv.set(REVIEW_STATE_KEY, migrated);
    return migrated;
  }

  async function findOpen(projectId: string) {
    // Check every page, including hidden threads. Metadata, never the title,
    // identifies a review. Legacy reviews have kind but no file field.
    for (let offset = 0; ; offset += 100) {
      const page = await host.threads.list({ projectId, archived: false, includeHidden: true, limit: 100, offset });
      if (page.length === 0) return null;
      const metadata = await host.threads.experimental_listPluginMetadata({ threadIds: page.map((t) => t.id) });
      for (const thread of page) {
        if (thread.archivedAt !== null || thread.deletedAt !== null || thread.projectId !== projectId) continue;
        const data = metadata.threads.find((row) => row.threadId === thread.id)?.metadata;
        if (data?.kind === "daily-review" && (data.file === undefined || data.file === host.file)) {
          return { thread, data };
        }
      }
      if (page.length < 100) return null;
    }
  }

  async function run(options: { includeToday: boolean; automatic?: boolean }): Promise<string> {
    const now = (host.now ?? (() => new Date()))();
    const today = dateKey(now);
    const state = await loadState();
    if (options.automatic && (now.getHours() < 7 || now.getHours() >= 23 || state.reviewDay === today)) {
      return "Daily review already checked or outside review hours.";
    }
    const notes = await host.notes(now, options.includeToday);
    if (notes.length === 0) return "No pending notes to review.";
    if (state.attemptDay === today && state.attempts >= MAX_REVIEW_ATTEMPTS) {
      return "Review retry limit reached (3 attempts today); pending notes remain eligible tomorrow.";
    }
    if (state.attemptDay === today && state.retryAt > now.getTime()) {
      return "Review retry pending; try again after the 30-minute cooldown.";
    }
    const projectId = await host.projectId();
    if (projectId === null) {
      throw new Error("No project for the review thread. Set it with `bb plugin config pad set reviewProject <project-id>`.");
    }
    const signature = createHash("sha256").update(JSON.stringify(notes)).digest("hex");
    const metadata = { kind: "daily-review", file: host.file, reviewDay: today, signature, notes: notes.length };
    const prompt = reviewPrompt(notes, { file: host.file, now });
    // Persist the attempt before any SDK operation. A restart cannot turn an
    // unavailable provider into an unbounded retry loop. This is not a day claim.
    const attempt: ReviewState = {
      ...state, attemptDay: today,
      attempts: state.attemptDay === today ? state.attempts + 1 : 1,
      retryAt: now.getTime() + REVIEW_RETRY_MS,
    };
    await host.kv.set(REVIEW_STATE_KEY, attempt);
    const existing = await findOpen(projectId);
    let threadId: string;
    let action: string;
    if (existing) {
      threadId = existing.thread.id;
      if (existing.data.reviewDay === today && existing.data.signature === signature) {
        // Also recovers a successful spawn whose response or local save failed.
        action = "Reused";
      } else {
        if (!["idle", "error"].includes(existing.thread.status) || existing.thread.hasPendingInteraction || existing.thread.queuedWork === "waiting") {
          return `Review pending in open thread ${threadId}; waiting for it to become idle. No new thread started.`;
        }
        await host.threads.send({
          threadId,
          mode: "queue-if-active",
          input: [{ type: "text", mentions: [], text: `Continue this Pad review with the current pending notes. Earlier proposals remain unapproved unless the user answered them.\n\n${prompt}` }],
        });
        await host.threads.updatePluginMetadata({ threadId, set: metadata });
        action = "Resumed";
      }
    } else {
      const thread = await host.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        title: `Pad · ${now.toLocaleDateString("en", { day: "numeric", month: "long" })}`,
        prompt,
        pluginMetadata: metadata,
      });
      threadId = thread.id;
      action = "Started";
    }
    // Claim only after an accepted spawn/send or confirmed existing delivery.
    await host.kv.set(REVIEW_STATE_KEY, { ...attempt, reviewDay: today, attempts: 0, retryAt: 0 });
    return `${action} review thread ${threadId} with ${notes.length} pending notes.`;
  }

  return {
    start(options: { includeToday: boolean; dryRun?: boolean; automatic?: boolean }): Promise<string> {
      if (options.dryRun) {
        const now = (host.now ?? (() => new Date()))();
        return host.notes(now, options.includeToday).then((notes) =>
          notes.length ? reviewPrompt(notes, { file: host.file, now }) : "No pending notes to review.");
      }
      const next = queue.then(() => run(options));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
