/**
 * The pending session (`pending:<createAck>`): **a queued `session.create` IS a
 * session screen.**
 *
 * The open is durable, so it is already a fact the moment it is queued — what
 * was missing was somewhere to stand while it happens. A synthetic
 * `SessionInfo` (id per CREATE, never per repo) renders the real session
 * screen, and the terminal area says which of the three things is true —
 * warming up, waiting for the link, or refused. What it cannot do is anything
 * that needs the host to already hold the session (attach, kill, star, slash,
 * the raw key pipe), and those SAY so rather than pretending.
 *
 * The compose bar is unchanged and needs no special case: `submitInput`
 * routes a pending id into the create's own lane, which is where the chain
 * behind a `session.create` has always gone (`queueSessionPrompt`).
 */
import { useMemo, useRef } from "react";
import { ownedPendingCreates, type LaunchOpts, type SessionInfo } from "@waterplane/shared";
import { isCreateOp, loadDraft, newAckId, saveDraft, type OutboxEntry } from "../../outbox";
import { noteSendFailed } from "../../link";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { baseName } from "../../format";
import type { DurableOp } from "../../sdk/types.ts";
import { LATER_PREFIX, PENDING_PREFIX, isLaterId, isPendingId, laterId, pendingLaneId } from "./logic.ts";
import { noteShellAdopted } from "../launch/shellReturn.ts";
import type { PendingFns, PendingKept, QueueCtx } from "./types.ts";

/** How long an adopted screen may stand in for a session the list has not
 *  named yet. Normally a frame; past this the id is just unknown, as before. */
const ADOPT_BRIDGE_MS = 30_000;

/** A kept entry, or undefined once its adoption is older than the bridge —
 *  Back onto a long-adopted `pending:` id is an unknown screen, not a session
 *  that "opens in a moment" for ever. */
function adoptBridge(k: PendingKept | undefined): PendingKept | undefined {
  return k?.adoptedAt && Date.now() - k.adoptedAt > ADOPT_BRIDGE_MS ? undefined : k;
}

/**
 * The pending screen's state: what each one was opened FOR, the queue entry
 * behind the one on top, and the synthetic session it renders from.
 */
export function usePendingState(activeId: string | null, outbox: OutboxEntry[], sessions: readonly SessionInfo[]) {
  /** What each pending screen was opened FOR, so it survives its queue entry
   *  being retired by a successful ack. Written on entry, stamped on adoption
   *  (and copied under the session's id) to bridge the frames until it is listed. */
  const pendingKept = useRef<Map<string, PendingKept>>(new Map());
  /** The queue entry behind a pending screen, or null once it has been acked,
   *  dropped or evicted — the screen then says so rather than hanging. */
  const pendingEntry = useMemo(() => {
    if (!isPendingId(activeId)) return null;
    const ackId = activeId!.slice(PENDING_PREFIX.length);
    return outbox.find((e) => e.ackId === ackId && isCreateOp(e)) ?? null;
  }, [outbox, activeId]);
  /**
   * The synthetic `SessionInfo` the screen renders from. `running: true` on
   * purpose: `running: false` is what the terminal overlay reads as "ended",
   * and a session that is on its way is not one that has finished.
   */
  const pendingSession = useMemo<SessionInfo | null>(() => {
    // **Adopted, not yet listed.** `op.ack` names the session and moves the
    // screen onto that id (`adoptPendingSession`) a frame or more before
    // `session.created` puts it in the list — and in that gap App had no
    // session at all, so the whole screen unmounted and came back: the
    // "pick a session" pane flashed and the caret the fresh screen had put in
    // the compose box was gone. The pending screen stands in until the real
    // one arrives, and not a frame longer.
    if (activeId && !isPendingId(activeId)) {
      if (sessions.some((s) => s.id === activeId)) return null;
      const was = adoptBridge(pendingKept.current.get(activeId));
      if (!was?.adoptedAt) return null;
      return {
        id: activeId, cwd: was.cwd, title: was.title, remoteControl: false, running: true, createdAt: was.ts,
      };
    }
    if (!isPendingId(activeId)) return null;
    // `+ later`: no create, no entry — the repo is in the id.
    if (isLaterId(activeId)) {
      const cwd = activeId!.slice(LATER_PREFIX.length);
      return { id: activeId!, cwd, title: baseName(cwd) || "new session", remoteControl: false, running: true, createdAt: Date.now() };
    }
    const e = pendingEntry;
    // The queue entry is GONE the moment `op.ack` says ok — and for a create the
    // host PARKED (it is holding it until the files land), the session it will
    // name is still minutes away. Without a fallback the screen would drop to
    // the launcher on the very ack that means it worked. So what was opened is
    // remembered separately, and the entry only ever adds detail.
    const kept = adoptBridge(pendingKept.current.get(activeId!.slice(PENDING_PREFIX.length)));
    if (!e && !kept) return null;
    const op = e?.op as (DurableOp & { t: "session.create" }) | undefined;
    const cwd = e?.cwd || kept?.cwd || "";
    return {
      id: activeId!, cwd, title: op?.title || kept?.title || baseName(cwd) || "new session",
      remoteControl: false, running: true, createdAt: e?.ts ?? kept?.ts ?? Date.now(),
      model: op?.launch?.model, effort: op?.launch?.effort,
      permissionMode: op?.launch?.permissionMode, remoteControlled: op?.launch?.remoteControlled,
    };
  }, [pendingEntry, activeId, sessions]);
  return { pendingKept, pendingEntry, pendingSession };
}

export function pendingFns(c: QueueCtx): PendingFns {
  const { outboxRef, pendingKept, activeIdRef, connRef, wantNavRef, buffers, pendingEntry, backendsRef } = c;
  const writeOutbox = (list: OutboxEntry[]) => c.writeOutbox(list);
  const addOutbox = (e: OutboxEntry, frontOfLane?: boolean) => c.addOutbox(e, frontOfLane);
  const queueOp: QueueCtx["queueOp"] = (op, laneKey, text, opts) => c.queueOp(op, laneKey, text, opts);
  const setOverlay = c.setOverlay;
  const setActiveId = c.setActiveId;
  const setLastVisitedId = c.setLastVisitedId;

  /** The oldest create still in flight for a directory — what the in-flight
   *  chip opens. With "+" now always starting ANOTHER session, this chip is the
   *  only way back to the screen of one already on its way. */
  function enterOldestPending(cwd: string): void {
    const e = outboxRef.current.find((x) => isCreateOp(x) && x.cwd === cwd && x.status !== "failed");
    if (e) enterPending(e.ackId);
  }

  /** `+ later` (`laterId`): the same screen, with nothing queued behind it
   *  until Send — the compose bar is aimed at a NEW session, when it's free. */
  function enterLater(cwd: string): void {
    wantNavRef.current = false;
    setOverlay(null);
    setActiveId(laterId(cwd));
  }
  /**
   * Show the session NOW, before the host has made it.
   *
   * The create is durable, so it is already a fact the moment it is queued —
   * what was missing was somewhere to stand while it happens. `pending:<ackId>`
   * is that place: the real session screen, addressed by the create's own ack
   * so two opens of one repo are two screens and not one shared lie.
   */
  function enterPending(createAck: string): void {
    const e = outboxRef.current.find((x) => x.ackId === createAck);
    const op = e?.op as (DurableOp & { t: "session.create" }) | undefined;
    if (e) pendingKept.current.set(createAck, { cwd: e.cwd, title: op?.title || baseName(e.cwd), ts: e.ts });
    // Bounded: this only has to outlive one ack, and an unbounded map of every
    // session ever opened in this tab is a leak with no reader.
    while (pendingKept.current.size > 8) pendingKept.current.delete(pendingKept.current.keys().next().value!);
    wantNavRef.current = false;
    setOverlay(null);
    setActiveId(pendingLaneId(createAck));
  }
  /**
   * The create on this pending screen was refused — post it again, with the
   * words that were queued behind it.
   *
   * A FRESH ackId always: the old one carries the host's `ok:false` verdict in
   * its ledger for 45 minutes, and a retry wearing it would be re-acked with
   * that verdict and never run — the same trap `migrateGiveUps` documents. The
   * failed rows are retired here rather than kept, because their words are
   * carried forward into the new entries verbatim; nothing is lost, and two
   * copies of one prompt in Activity is how a retry runs twice.
   */
  function retryPendingCreate(backend?: string): void {
    const e = pendingEntry;
    const op = e?.op;
    if (!e || e.status !== "failed" || op?.t !== "session.create") return;
    track(backend ? "action:session.pending.instead" : "action:session.pending.retry");
    const behind = outboxRef.current
      .filter((x) => x.mode === "input" && x.createAck === e.ackId && x.status === "failed")
      .sort((a, b) => a.ts - b.ts);
    const dead = new Set([e.ackId, ...behind.map((x) => x.ackId)]);
    writeOutbox(outboxRef.current.filter((x) => !dead.has(x.ackId)));
    const createAck = newAckId();
    const { ackId: _drop, ...payload } = op;
    // "Start with <backend> instead": the same open under the program the person picked. Only the
    // backend rides — a model, an effort or a mode chosen for the refused one is not this one's.
    if (backend) (payload as { launch?: LaunchOpts }).launch = { backend };
    queueOp(payload as DurableOp, e.sessionId, e.text, { cwd: e.cwd, focus: true, ackId: createAck });
    for (const x of behind) queueSessionPrompt(x.cwd, x.text, createAck, x.kind === "command" ? "command" : "prompt");
    // The half-written words on the refused screen go with it to the new one;
    // the old id is never loaded again.
    const from = pendingLaneId(e.ackId), draft = loadDraft(from);
    if (draft && saveDraft(pendingLaneId(createAck), draft)) saveDraft(from, "");
    enterPending(createAck);
    showToast(connRef.current.status === "open" ? "trying again…" : "queued — it opens when the link is back");
  }
  /**
   * The session exists now — move the screen (and the half-written draft on it)
   * onto the real id.
   *
   * Called from BOTH bindings: `op.ack` when the host made it straight away,
   * and `launch.opened` when the host was holding the create for its files. The
   * draft is migrated by hand because it is keyed by session id: without this,
   * words typed while the session was warming up vanish at the exact moment it
   * opens, which is the one moment nobody would suspect.
   */
  function adoptPendingSession(createAck: string, sessionId: string): void {
    const from = pendingLaneId(createAck);
    // Not dropped yet: the ack's outbox write renders BEFORE `setActiveId`
    // below does, and in that frame the pending screen has neither its entry
    // nor this. Kept under both ids, stamped, for the gap until the session
    // is listed (`usePendingState`); the same bound as every other entry here.
    const was = pendingKept.current.get(createAck);
    if (was) {
      const adopted = { ...was, adoptedAt: Date.now() };
      pendingKept.current.set(createAck, adopted);
      pendingKept.current.set(sessionId, adopted);
    }
    // A shell a sheet went to (`launch.focusShell`) is remembered by this id
    // too — re-keyed whether or not it is the screen on top right now.
    noteShellAdopted(createAck, sessionId);
    if (activeIdRef.current !== from) return;
    const draft = loadDraft(from);
    // The pending lane's draft is deleted only once the session's own draft holds
    // the words: a refused write keeps them where they were typed.
    if (!draft || saveDraft(sessionId, draft)) saveDraft(from, "");
    if (!buffers.current.has(sessionId)) buffers.current.set(sessionId, []);
    setActiveId(sessionId);
    setLastVisitedId(sessionId);
  }
  /**
   * Queue a prompt for a session that hasn't been created yet.
   *
   * The lane is the create's own (`create:<cwd>`), so ordering is already
   * guaranteed: the create is the head, the uploads and prompts behind it drain
   * strictly one at a time, and `op.ack` rewrites these entries' lane to the
   * real session id (`bindPendingSession`). Until then the entry is unsendable
   * — its `sessionId` names a lane, not a session.
   *
   * `holdUntilIdle` is what makes a CHAIN work: prompt 2 must not be typed into
   * the composer while prompt 1's turn is still running, or the TUI concatenates
   * them. Exact on a hooked session, the usual silence guess otherwise — same
   * caveat as every other hold in this app.
   */
  function queueSessionPrompt(cwd: string, text: string, createAck: string, kind: "prompt" | "command" = "prompt"): void {
    // The first prompt for an open that has not gone out yet rides INSIDE it,
    // so the desktop types it the moment the session is up — no second
    // delivery from a phone that may have lost the link again by then.
    const shells = new Set((backendsRef?.current ?? []).filter((b) => b.kind === "shell").map((b) => b.id));
    const folded = kind === "prompt" ? foldIntoCreate(outboxRef.current, createAck, text, shells) : null;
    if (folded) { writeOutbox(folded); return; }
    addOutbox({
      ackId: newAckId(), sessionId: `create:${cwd}`, cwd, text,
      ts: Date.now(), status: "queued", attempts: 0, kind, mode: "input",
      pendingCreate: true, holdUntilIdle: true, createAck,
      // Released by construction: it was written as part of "open a session and
      // run these", so there is nothing for the reconnect prompt to ask about
      // that it wouldn't already be asking about the create ahead of it.
      armed: true,
    });
  }
  /**
   * The create for this lane could not be delivered (refused, or given up on) —
   * so the prompts queued behind it have no session to run in, and would
   * otherwise hold that lane forever (a `pendingCreate` entry is never picked).
   * Fail them with a reason instead: the text stays, and the queue sheet can
   * restore or re-aim it at a session that does exist.
   */
  /**
   * The create for this lane was accepted but PARKED host-side — it is waiting
   * for its files, and the host owns that wait now.
   *
   * The prompts queued behind it must stay unsendable until `launch.opened`
   * names the session, which `pendingCreate` already guarantees. This used to
   * also mark them exempt from the queue's thirty-minute clock, because the
   * host's own deadline for a parked create is hours; there is no clock left to
   * be exempt from, so the mark is gone and the wait is simply the wait.
   */
  function holdForLaunch(lane: string, createAck?: string): void {
    const mine = new Set(ownedPendingCreates(outboxRef.current, lane, createAck).map((e) => e.ackId));
    writeOutbox(outboxRef.current.map((e) => mine.has(e.ackId) ? { ...e, noTtl: true } : e));
  }
  /**
   * `createAck` scopes this to ONE create's chain. The lane is per repo, so
   * without it a create that was refused took the prompts of every other create
   * queued for the same repo down with it — including ones that had not been
   * sent yet and were about to work.
   */
  function failPendingCreates(lane: string, reason: string, createAck?: string): void {
    const mine = new Set(ownedPendingCreates(outboxRef.current, lane, createAck).map((e) => e.ackId));
    writeOutbox(outboxRef.current.map((e) => {
      if (!mine.has(e.ackId)) return e;
      noteSendFailed();
      return { ...e, status: "failed" as const, reason, failedAt: Date.now() };
    }));
  }
  /**
   * An image never made it — fail the queued messages that NAME it.
   *
   * The upload takes its lane ahead of the prompt precisely so the file is on
   * disk before the agent is told to look at it. That ordering was only enforced
   * for the success path: a failed upload freed its lane like any settled entry
   * and the prompt went out regardless, pointing the agent at
   * `.claude/inbox/<file>` that does not exist and never will. From the phone it
   * looks like the send worked; from the session it looks like the user
   * referenced a missing file. Both ends are lying.
   *
   * Only `queued` entries, and only ones whose text carries this upload's
   * predicted path: a message that merely shares the lane is unrelated work and
   * must still be delivered. The text is preserved, so the recovery bar can put
   * it back once the picture has been re-attached.
   */
  function failDependentUploads(e: OutboxEntry, reason: string): void {
    const rel = e.upload?.relPath;
    if (!rel) return;
    const hit = (x: OutboxEntry) =>
      x.text.includes(rel) ||
      (x.mode === "op" && JSON.stringify(x.op ?? "").includes(rel));
    writeOutbox(outboxRef.current.map((x) => {
      if (!(x.ackId !== e.ackId && x.status === "queued" && x.sessionId === e.sessionId && hit(x))) return x;
      noteSendFailed();
      return { ...x, status: "failed" as const, reason, failedAt: Date.now() };
    }));
  }

  return {
    enterPending, enterOldestPending, enterLater, retryPendingCreate, adoptPendingSession, queueSessionPrompt, holdForLaunch,
    failPendingCreates, failDependentUploads,
  };
}

/**
 * **The first prompt written on a pending screen goes INSIDE the create.**
 *
 * Reported 2026-11-12: offline, `+ now`, Send — and the person expects that
 * prompt to run once the link is back, as surely as `+ later` would. Queued as
 * a `session.input` behind the create it needed the PHONE twice: once for the
 * create and again, after `op.ack` named the session, to type it — and a link
 * that came back for a moment and went again left it parked on the phone. A
 * `session.create` carries `prompt` (and `needs` for the inbox files it names),
 * which the host types itself once the session is up: one op, one ackId,
 * at-most-once like every create.
 *
 * Only while the create has never been on the wire: a retry must be the same
 * bytes, so an op that may already be in the host's ledger is never rewritten
 * (then the chained row is the path, as before). Not over a prompt the op
 * already has, nor ahead of a row already chained behind it — order is the
 * person's. Not into a shell, whose first line is not a prompt. Null = not
 * folded; the caller queues the row as before.
 */
export function foldIntoCreate(
  outbox: readonly OutboxEntry[], createAck: string, text: string, shellBackends: ReadonlySet<string> = new Set(),
): OutboxEntry[] | null {
  const prompt = text.trim();
  if (!prompt) return null;
  const i = outbox.findIndex((e) => e.ackId === createAck && isCreateOp(e));
  const e = outbox[i];
  if (!e || e.status !== "queued" || e.attempts || e.tries || e.firstTryAt || e.sentAt) return null;
  const op = e.op as DurableOp & { t: "session.create" };
  if (op.prompt || op.replaceSessionId || op.companionOf) return null;
  if (op.launch?.backend && shellBackends.has(op.launch.backend)) return null;
  if (outbox.some((x) => x.createAck === createAck && x.mode === "input")) return null;
  const needs = [...new Set([...(op.needs ?? []), ...inboxNeeds(prompt)])];
  const next = outbox.slice();
  next[i] = { ...e, text: prompt, op: { ...op, prompt, ...(needs.length ? { needs } : {}) } };
  return next;
}

/**
 * The inbox paths a prompt names — what a `session.create` must not run
 * without. Matched on the shape of the path: the host stats them itself.
 */
export function inboxNeeds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\.claude\/inbox\/[A-Za-z0-9._-]+/g)) out.add(m[0]);
  return [...out];
}
