/**
 * The files a queued prompt names — is each one really going to be there, and
 * what does it LOOK like?
 *
 * Two problems, one cause. A prompt written on a phone says
 * `.claude/inbox/1000074539-mtjv8u52a489a0.jpg`, a name minted before the bytes
 * moved (`plannedInboxPath`), which means:
 *
 *  - nobody can tell which photo that is. A camera counter and six random
 *    characters is a worse label than no label: it looks like information.
 *  - nobody can tell whether it will exist. The upload is a separate queue entry
 *    with its own verdict, and when it fails its bytes were dropped — leaving
 *    text that reads perfectly and points at nothing.
 *
 * This module supplies both answers for any text: the thumbnail (from whichever
 * copy exists — the phone's own bytes first, since they need no link) and the
 * state (`@waterplane/shared`'s `attachState`, pure and pinned by `e2e-attach.mjs`).
 *
 * It also owns the RETAINED bytes, which is what turns "dead" into a button.
 * When an upload entry dies while text still names its path, the blob is moved
 * aside instead of deleted, keyed by that path. A re-attach then re-queues the
 * upload with the SAME path — so the prompt needs no rewriting, which is the
 * whole point: the words were fine, the transport wasn't.
 */
import { attachStatuses, sendingUploads, type AttachFacts, type AttachStatus } from "@waterplane/shared";
import { api } from "./api";
import { deadUploads } from "./outbox";
import type { OutboxEntry } from "./outbox";
import { refsIn, type FileRef } from "./fileRefs";
import { idbClearWhere, idbDel, idbGet, idbKeys, idbSet } from "./idb";

export type { AttachStatus };

/**
 * Key prefix for bytes kept after their queue entry is gone, inside the same
 * `uploads` store the live queue uses.
 *
 * Same store on purpose: these ARE queued-upload bytes, one state later, and a
 * store of their own would be a second thing to prune, migrate and forget about.
 * The prefix is what keeps them from colliding with the live entries, which are
 * keyed by ackId.
 */
const KEEP = "keep:";
/** Path a keep-key refers to, or null when it is a live entry's ackId. */
const keptPath = (key: string) => (key.startsWith(KEEP) ? key.slice(KEEP.length) : null);

/**
 * How many orphaned files this device holds on to.
 *
 * Bounded because it is storage nothing is asking for: the bytes are only useful
 * while the text naming them is still somewhere the user can act on it (the
 * queue, the pad, a compose draft), which is days at most. Twelve is roughly a
 * screen's worth of failed sends; past that the oldest goes, because a photo
 * from three weeks ago is not what "re-attach" means to anyone.
 */
const KEEP_CAP = 12;

/** Keep one dying upload's bytes under the path its text already names. */
export async function keepUploadBytes(relPath: string, blob: Blob): Promise<void> {
  await idbSet("uploads", KEEP + relPath, { relPath, blob, ts: Date.now() });
  await pruneKept();
}

/** The bytes still held for a path, or null. */
export async function keptBytes(relPath: string): Promise<Blob | null> {
  const rec = await idbGet<{ blob: Blob }>("uploads", KEEP + relPath);
  return rec?.blob ?? null;
}

/** Every path this device could still re-attach from its own storage. */
export async function keptPaths(): Promise<string[]> {
  return (await idbKeys("uploads")).map(keptPath).filter((p): p is string => !!p);
}

/** Let go of one — after a re-attach has re-queued it, or a discard. */
export async function dropKept(relPath: string): Promise<void> {
  await idbDel("uploads", KEEP + relPath);
}

/** Oldest-first eviction down to `KEEP_CAP`. Best-effort, like everything in idb.ts. */
async function pruneKept(): Promise<void> {
  const keys = (await idbKeys("uploads")).filter((k) => keptPath(k));
  if (keys.length <= KEEP_CAP) return;
  const dated = await Promise.all(keys.map(async (k) => ({
    k, ts: (await idbGet<{ ts?: number }>("uploads", k))?.ts ?? 0,
  })));
  dated.sort((a, b) => a.ts - b.ts);
  for (const { k } of dated.slice(0, dated.length - KEEP_CAP)) await idbDel("uploads", k);
}

/**
 * Everything knowable about the files one text names.
 *
 * `repoId` may be null (a pad note has no target yet) — then the host is never
 * asked and every unknown file reports `unknown` rather than `missing`, which is
 * the honest answer: without a repo there is no listing to be absent from.
 */
export async function checkAttachments(
  text: string,
  repoId: string | null,
  outbox: OutboxEntry[],
  online: boolean,
  signal?: AbortSignal,
): Promise<{ refs: FileRef[]; states: AttachStatus[] }> {
  const refs = refsIn(text);
  if (!refs.length) return { refs, states: [] };
  const facts: AttachFacts = {
    onHost: null,
    // A queue entry that has GIVEN UP is not sending anything. Only rows that
    // will still be attempted count, or a prompt would be called sendable on the
    // strength of an upload that has already failed for good.
    sending: sendingUploads(outbox),
    kept: await keptPaths(),
    dead: deadUploads(),
  };
  if (repoId && online) {
    // One listing answers for every inbox file in the prompt; the outbox side is
    // the artifact listing. Both are cheap and both degrade to `null` — an
    // unanswered listing must read as "could not ask", never as "not there".
    const wantInbox = refs.some((r) => r.relPath.startsWith(".claude/inbox/"));
    const wantOutbox = refs.some((r) => !r.relPath.startsWith(".claude/inbox/"));
    const [inbox, outboxFiles] = await Promise.all([
      wantInbox ? api.inbox(repoId, signal).catch(() => null) : Promise.resolve([]),
      wantOutbox ? api.artifacts(repoId, "outbox", undefined, { signal }).then((d) => d.files).catch(() => null) : Promise.resolve([]),
    ]);
    // Either half failing leaves the other half's answer usable only if the
    // failing half was not asked about — so a partial failure degrades the whole
    // check rather than reporting half the files missing.
    facts.onHost = inbox && outboxFiles ? [...inbox, ...outboxFiles].map((f) => f.relPath) : null;
  }
  return { refs, states: attachStatuses(refs.map((r) => r.relPath), facts) };
}

/**
 * The bytes THIS DEVICE still holds for a path, as an object URL — or null.
 *
 * The only copy that exists while an upload is queued, and the only copy left
 * when one has died, so it is what makes a failed send show the photo it failed
 * to send. The caller owns the URL: `revokeObjectURL` when the preview unmounts,
 * or a phone scrolling a long queue leaks a photo per row.
 *
 * The host copy is deliberately NOT resolved here. A picture the host holds is
 * drawn from a MTIME-VERSIONED thumbnail URL through the same cache the gallery
 * and the reader use (`thumbSrc.ts`), which needs a hook and a render, not a
 * promise — and an un-versioned URL is cacheable by nobody, i.e. one request per
 * strip per session over the link this app exists to survive.
 */
export async function localPreview(
  relPath: string,
  state: AttachStatus["state"],
  outbox: OutboxEntry[],
): Promise<string | null> {
  if (state === "sending") {
    const e = outbox.find((x) => x.mode === "upload" && x.upload?.relPath === relPath);
    const blob = e ? await idbGet<Blob>("uploads", e.ackId) : null;
    if (blob) return URL.createObjectURL(blob);
  }
  if (state === "sending" || state === "kept" || state === "dead" || state === "missing" || state === "unknown") {
    const blob = await keptBytes(relPath);
    if (blob) return URL.createObjectURL(blob);
  }
  return null;
}

/**
 * Ask for one named file to be opened full-screen.
 *
 * The strip is rendered inside six sheets and the compose bar, none of which
 * owns the viewer, so a handler would have to be threaded through all seven —
 * seven chances to leave one strip's pictures dead, which is the state every one
 * of them was in. It asks by event instead, the arrangement `NetPulseBar` and
 * `hostUrl.requestHostSetup()` already use, and App is the single listener.
 *
 * The payload is the FACTS (path, repo, verdict) and never the URL the strip is
 * drawing: opening the viewer unmounts the sheet, and the object URL that strip
 * minted dies with it. Whoever shows the picture resolves its own copy, or the
 * viewer opens on a revoked blob — a black screen with no way to tell it from a
 * crash.
 */
export const ATTACH_OPEN_EVENT = "app:open-attachment";
export interface AttachOpenDetail {
  relPath: string;
  /** Null when the text has no target yet (a pad note) — then only local bytes
   *  can answer, since there is no repo to ask. */
  repoId: string | null;
  state: AttachStatus["state"];
}
export function requestAttachOpen(d: AttachOpenDetail): void {
  try { window.dispatchEvent(new CustomEvent(ATTACH_OPEN_EVENT, { detail: d })); } catch { /* no DOM */ }
}

/** One line saying where a file stands, in the words the row shows. */
export function attachLabel(s: AttachStatus): string {
  // closed: an upload state the phone itself sets
  switch (s.state) {
    case "host": return "in the repo";
    case "sending": return "uploads before this message";
    case "kept": return "not uploaded — the file is still on this phone";
    case "dead": return s.why ? `not uploaded — ${s.why}` : "not uploaded";
    case "missing": return "not in the repo, and not on this phone";
    case "unknown": return "can't check without a connection";
  }
}

/** Every key in `uploads` that is a KEPT orphan rather than a live queued
 *  send. Exported as a predicate, not as a prefix, so the storage screen
 *  measures and deletes through the same rule this file writes with
 *  (`storageAudit.ts`). */
export const isKeptKey = (key: string) => key.startsWith(KEEP);

/**
 * Let go of every orphaned upload at once — the storage screen's button.
 *
 * These are the bytes of sends that DIED: the picture exists here and nowhere
 * else, which is why the row asks twice and why this is not folded into any
 * "clear caches" control. Nothing else is touched — a photo attached to a
 * message still sitting in the send queue is keyed by its ackId and is that
 * message's to lose, from the queue screen, with its words in front of you.
 */
export async function forgetKept(): Promise<boolean> {
  return idbClearWhere("uploads", isKeptKey);
}
