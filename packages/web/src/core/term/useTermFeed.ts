/**
 * The terminal feed: the per-session PTY buffers and everything that keeps
 * them honest — attach and resume, the `pty`/`session.exit` frames, the
 * restored-from-disk tail and its save, the offline transcript sweep, and the
 * reader-view switches that share the same attach.
 *
 * Lifted out of `App.tsx` unchanged; every name App used is a member of the
 * return. The bytes are REFS, never state: a frame mutates `buffers` in place
 * and bumps `writeSeq`, which is the one re-render (a `useState` of bytes would
 * be a whole-App render per frame on every phone). The pure half is `tail.ts`.
 */
import { useEffect, useRef, useState } from "react";
import { MIN_PTY_ROWS, type ClientMessage, type HostMessage, type SessionInfo } from "@waterplane/shared";
import type { TerminalHandle } from "../../Terminal.tsx";
import type { Overlay } from "../../routing.ts";
import { PTY_SAVE_BYTES, PTY_SAVE_MS, PTY_TAIL, TRANSCRIPT_SWEEP_MS, escapeSafeTail, loadPtyTails, savePtyTail } from "../../ptyTail.ts";
import { api } from "../../api.ts";
import { dataSaver } from "../../media.ts";
import { screenSweepIds, sweepScreens, type ScreenSweepDeps } from "./screenSweep.ts";
import { prefetchTranscript, sweepTranscripts } from "../../offlineCache.ts";
import { hydrateScreenLogs, saveScreenLog } from "../../screenlog.ts";
import { b64ToStr } from "../../format.ts";
import { track } from "../../usage.ts";
import { LS, lsBool, lsSetBool } from "../../storage.ts";
import { useLatest } from "../../sdk/hooks.ts";
import { appendTail, applyPtyBytes, seedFromTails, sweepOrder } from "./tail.ts";
import { isPendingId } from "../queue/logic.ts";
import { bgFresh, catchUpMs, parksWhenHidden, sweepsWhenHidden } from "./bgFresh.ts";
import { isNativeShell } from "../../hostUrl.ts";

export interface TermFeedDeps {
  /** The one socket (`useConnection`), whole: `send` for attach/detach/resize,
   *  `connRef.reconnect()` for a stuck terminal, `status` for the re-attach. */
  conn: { connRef: { current: { reconnect(): void } }; send(frame: ClientMessage): void; status: string };
  activeId: string | null;
  setActiveId(id: string | null): void;
  setOverlay(o: Overlay): void;
  /** This render's session list — the deep-link attach waits for the id to appear in it. */
  sessions: SessionInfo[];
  /** The session on screen (a pending one included). A getter, because App
   *  derives it from the queue's pending entry, which is built after this hook. */
  getActive(): SessionInfo | null | undefined;
  /** The launcher's "row we last opened" highlight. */
  noteVisited(id: string): void;
  /** `session.exit` re-decides the queue (`flushOutbox`). */
  onExit(): void;
}

type ReaderKind = "outline" | "find" | "refresh";
type PtyFrame = Extract<HostMessage, { t: "pty" }>;
type ExitFrame = Extract<HostMessage, { t: "session.exit" }>;

export function useTermFeed(deps: TermFeedDeps) {
  const { activeId, setActiveId, setOverlay, sessions } = deps;
  const { connRef, send, status } = deps.conn;
  const termRef = useRef<TerminalHandle>(null);
  const buffers = useRef<Map<string, string[]>>(new Map());
  // Per-session output high-water mark (the `seq` from the last PTY frame). Sent
  // back as `resumeSeq` on a reconnect so the host replays only the delta instead
  // of the whole scrollback — the reconnect is then a near-invisible append.
  const lastSeqById = useRef<Map<string, number>>(new Map());
  // Liveness for the reader view, which shows no terminal: when each session last
  // emitted PTY bytes, and a short tail of them (the CLI's own working line lives
  // in there). Refs, not state — every PTY frame already bumps writeSeq, so a
  // render that can read these is guaranteed without a second state update.
  const lastPtyAt = useRef<Map<string, number>>(new Map());
  const ptyTail = useRef<Map<string, string>>(new Map());
  // Sessions whose buffer was seeded from IndexedDB (savePtyTail) and that have
  // not produced a live frame since: their terminal shows RESTORED bytes, so it
  // is dimmed and chipped rather than passed off as current. State, not a ref —
  // the dimming has to repaint. Cleared per session on its first live frame.
  const [staleAt, setStaleAt] = useState<Map<string, number>>(new Map());
  // The stored resume point per not-yet-live session, consumed by attach().
  const restoreRef = useRef<Map<string, number>>(new Map());
  // The host boot each stored resume point was recorded under, handed back as
  // `session.attach.resumeBoot` so the host can refuse a seq from a previous
  // boot instead of stitching a delta out of a dead byte stream (see PtyTail).
  const resumeBootRef = useRef<Map<string, string>>(new Map());
  // This host process's boot id, from `welcome`. Saved with every persisted tail.
  const bootIdRef = useRef<string | undefined>(undefined);
  // Sessions the host has told us exited (`session.exit`), independent of the
  // session.list that normally carries `running: false`.
  const exitedRef = useRef<Set<string>>(new Set());
  // False until the mount-time seed has finished. The attach effect WAITS on it:
  // firing before the seed lands sends `resumeSeq: undefined`, the host answers
  // with a full replay, and the whole point of persisting the seq is lost.
  const [ptyRestored, setPtyRestored] = useState(false);
  const [writeSeq, setWriteSeq] = useState(0);
  const [termNonce, setTermNonce] = useState(0); // bump to force a fresh xterm mount (refresh)
  // Reader mode: render the session's structured transcript instead of the xterm
  // grid (same session, different representation — see TranscriptView). Sticky,
  // because it's a reading preference, not a per-session state.
  const [readMode, setReadMode] = useState(() => lsBool(LS.readMode));
  // Mirror for the ws message handler (its closure can't read state) — it decides
  // whether a finished turn needs a background transcript cache write or whether
  // the mounted reader is already fetching the same document.
  const readModeRef = useRef(readMode);
  readModeRef.current = readMode;
  // Turn the outline sheet asked the reader to scroll to. `key` bumps per tap so
  // the same turn twice still jumps.
  const [outlineJump, setOutlineJump] = useState<{ n: number; key: number } | null>(null);
  const [transcriptNonce, setTranscriptNonce] = useState(0); // bump ⇒ reader refetches
  /** The reader's own verbs, fired from the toolbar (`toolbar.ts`'s
   *  READER_TOOLBAR_IDS). `key` bumps per tap so the same verb fires twice. */
  const [readerCmd, setReaderCmd] = useState<{ kind: ReaderKind; key: number } | null>(null);
  function fireReader(kind: ReaderKind) { setReaderCmd((c) => ({ kind, key: (c?.key ?? 0) + 1 })); }
  const geomRef = useRef({ cols: 80, rows: 30 });
  const attachedRef = useRef<string | null>(null); // session id we've sent session.attach for
  const prevStatusRef = useRef(status); // detect closed→open transitions to re-attach after a reconnect
  const sessionsRef = useLatest(sessions);
  // Background freshness (`bgFresh.ts`): while the app is hidden the open
  // session is DETACHED (parked) instead of streaming every redraw to a page
  // nobody sees, and caught up on the chosen interval. `syncRef` is the session
  // a catch-up attach is in flight for; its `session.history` reply ends it.
  const parkedRef = useRef(false);
  const syncRef = useRef<string | null>(null);
  const syncFuseRef = useRef<number | undefined>(undefined);
  const [unparkNonce, setUnparkNonce] = useState(0);
  const statusRef = useLatest(status);

  /** The host has spoken for this session, so what is on screen is no longer a
   *  restored-from-disk guess: the resume point has been spent (drop it, which
   *  also re-enables the periodic tail save) and the "stale" dimming + chip go.
   *  Called from BOTH proofs an attach can produce — a pty frame and the
   *  `session.history` reply — because a resume delta of zero bytes sends only
   *  the latter. */
  function hostAnsweredFor(id: string) {
    if (syncRef.current === id) endCatchUp(id);
    restoreRef.current.delete(id);
    // Whatever the host just replayed is numbered in THIS boot's stream, so the
    // stored boot stamp has been consumed — later resumes use the live one.
    resumeBootRef.current.delete(id);
    setStaleAt((prev) => {
      if (!prev.has(id)) return prev; // same Map ⇒ no re-render
      const n = new Map(prev);
      n.delete(id);
      return n;
    });
  }

  function attach(s: SessionInfo) {
    track("action:session.attach");
    deps.noteVisited(s.id);
    setOverlay(null);
    // A reader verb is spent where it was tapped. `readerCmd` outlives the
    // session it was fired in, and `TranscriptView` is keyed on the session id —
    // so an un-cleared one fires again the moment the reader mounts over the
    // NEXT session, opening a find bar nobody asked for. Cleared on the way in;
    // `openReader` re-fires its own afterwards.
    setReaderCmd(null);
    // The IndexedDB seed may still be in flight (it lands ~100 ms after mount and
    // a tap can beat it). Attaching now would go out WITHOUT the stored resumeSeq
    // — and worse, the seed would then paint a restored tail over a session the
    // host has already answered for. Set the session active and let the effect
    // below, which gates on `ptyRestored`, fire the attach once the seed is in.
    if (!ptyRestored) { setActiveId(s.id); return; }
    // A session restored from IndexedDB on this cold start keeps its buffer and
    // attaches WITH the stored resume point: a live host stitches the delta onto
    // the restored scrollback (and, if that point has aged out of its capped
    // buffer, answers `full: true`, which replaces the restore wholesale — see
    // the pty case). A dead tunnel simply leaves the restored bytes on screen,
    // dimmed, instead of a black rectangle. Every other attach behaves exactly as
    // before: clear, no resumeSeq, full replay.
    const resumeSeq = restoreRef.current.get(s.id);
    // Restored bytes with no usable resume point (a record from an older build,
    // or one the host will refuse because it predates this boot) are still worth
    // keeping on screen: the full replay this attach asks for REPLACES them when
    // it lands, and until then dimmed scrollback beats a black rectangle.
    if (resumeSeq == null && !staleAt.has(s.id)) buffers.current.set(s.id, []); // cleared; server replays scrollback on attach
    attachedRef.current = s.id;
    setActiveId(s.id);
    send({ t: "session.attach", id: s.id, resumeSeq, resumeBoot: resumeBootRef.current.get(s.id) ?? bootIdRef.current });
    // Save the conversation so far while the link is still up. Opening a session
    // is the moment you have both a working tunnel and a stated interest in it,
    // and waiting for the first turn-end to cache anything means a session opened
    // during a good minute of signal and read an hour later still has nothing.
    // `since`-conditional and throttled (offlineCache.ts), so this is a 204 for a
    // session that hasn't moved.
    if (!readModeRef.current) void prefetchTranscript(s.id);
  }

  /** Re-sync a stuck terminal without a page reload. Remounting the xterm (via a
   *  key bump) mirrors the known-good first-attach path: a brand-new terminal in
   *  the normal buffer, then re-attach so the host replays fresh scrollback into
   *  it. Reusing the live xterm + term.reset() left alt-screen sessions blank —
   *  reset() doesn't cleanly re-establish the alternate buffer the TUI lives in. */
  function refreshTerminal() { repaintTerminal(true); }

  /** Remount + re-sync the xterm. `reconnect` also forces a fresh socket (the
   *  stuck-terminal case); leaving the reader view only needs the repaint. */
  function repaintTerminal(reconnect: boolean) {
    const active = deps.getActive();
    if (!active) return;
    const id = active.id;
    buffers.current.set(id, []);
    setTermNonce((n) => n + 1);   // remount xterm fresh
    // The socket may be a zombie (readyState OPEN but dead after a network
    // switch) — that's the usual cause of a black terminal. Force a fresh
    // connection first so the detach/attach below actually reach the host
    // (they queue and flush on the new socket's open). Matches a page reload.
    if (reconnect) connRef.current.reconnect();
    send({ t: "session.detach", id });
    send({ t: "session.attach", id }); // host replays scrollback into the fresh term
    // A same-size remount sends no SIGWINCH, so an idle alt-screen TUI (claude)
    // never repaints and the fresh term shows only replayed scrollback — which
    // renders blank after the alt-screen leave/clear sequences. Jiggle the PTY
    // size once the new xterm has mounted to force claude to redraw live.
    setTimeout(() => {
      const { cols, rows } = geomRef.current;
      // The jiggle must stay a JIGGLE: one row off a real geometry, never down
      // into the range the CLI cannot draw a composer in (`shared/ptysize.ts`).
      send({ t: "session.resize", id, cols, rows: Math.max(MIN_PTY_ROWS, rows - 1) });
      setTimeout(() => send({ t: "session.resize", id, cols, rows }), 120);
    }, 280);
  }

  /** Flip between the xterm grid and the reader view of the same session. The
   *  xterm unmounts in reader mode (PTY frames keep buffering), so coming back
   *  repaints it the same way a fresh attach does. */
  function setView(read: boolean) {
    setReadMode(read);
    lsSetBool(LS.readMode, read);
    if (read) setTranscriptNonce((n) => n + 1);
    else setTimeout(() => repaintTerminal(false), 0); // after the xterm remounts
  }

  /** Open a session straight into the reader with its outline already up — the
   *  "where did this get to?" tap, answered without landing in the terminal
   *  first. Three taps (open · switch view · outline) and three screen paints
   *  (a full scrollback replay into an xterm that is then unmounted) collapse
   *  into one, which is what makes checking six sessions in a row bearable.
   *
   *  Back still goes to the launcher, and the header's view toggle is where it
   *  always was — this is a way IN, not a mode. */
  function openReader(s: SessionInfo, outline = true) {
    track("action:session.read");
    // `attach` decides whether to prefetch the transcript on the mode we are in,
    // and the ref is only re-assigned on the next render — so it moves BEFORE
    // the attach, not after it, or the reader's own fetch is paid for twice.
    readModeRef.current = true;
    setView(true);
    attach(s);
    // After `attach`, which clears the previous verb: this lands as key 1 on a
    // freshly mounted reader, whose effect runs on mount and opens the outline.
    // Without it (the demo tour's "answer by tap"), the reader opens on the
    // conversation itself, where the box and the compose bar are.
    if (outline) fireReader("outline");
  }

  /** A finished turn is when the conversation log grows — nudge the reader to
   *  refetch (it sends `since`, so an unchanged log answers 204). */
  function bumpTranscript() { setTranscriptNonce((n) => n + 1); }

  /**
   * **Put session `id` on screen and attach to it** — the one "navigate to a
   * session": the queue's `op.ack` focus, `session.created` for a create this
   * phone asked for, and the host's own `session.focus` all land here. The
   * caller clears App's `wantNavRef` (the "this client asked" flag is App's).
   */
  function focus(id: string) {
    if (!buffers.current.has(id)) buffers.current.set(id, []);
    attachedRef.current = id;
    setActiveId(id);
    deps.noteVisited(id);
    setOverlay(null);
    send({ t: "session.attach", id });
  }

  /** App's `case "welcome"`, the terminal's half: stamp the boot every
   *  persisted tail is recorded under, then refill the offline transcript cache
   *  — the attached session first (unless the reader is already fetching it),
   *  then the sequential sweep over every other. */
  function onWelcome(bootId: string) {
    // Stamped into every persisted PTY tail: a resume point is only valid
    // for the boot that issued it (see PtyTail).
    bootIdRef.current = bootId;
    // The link is back — refill the offline transcript cache for whatever
    // session is on screen, so the NEXT outage has the turns that landed
    // during this window. Throttled + `since`-conditional (offlineCache),
    // so a flapping tunnel doesn't re-download a multi-MB document.
    if (attachedRef.current && !readModeRef.current) void prefetchTranscript(attachedRef.current);
    // …and top up every OTHER session's cached transcript too, newest
    // first. The sweep is sequential and `since`-conditional, so a link
    // that just came back is not hit with a dozen parallel fetches.
    sweepRef.current();
  }

  /** App's `case "session.updated"`, the terminal's half: a turn that ended. */
  function onSessionUpdated(s: SessionInfo) {
    // A finished turn is when the conversation log grows — nudge the reader
    // to refetch (it sends `since`, so an unchanged log answers 204).
    if (s.id === attachedRef.current && s.idle) bumpTranscript();
    // A turn ended: write that session to the offline cache even when the
    // reader is closed AND even when it is not the session on screen. The
    // reader caches what it displays and the prefetch used to run only for
    // the attached session, so a phone went offline holding one document
    // and eleven sessions whose reader said "loading transcript…" — and
    // which one you want to read is exactly what you don't know until the
    // link is already gone. Throttled and `since`-conditional inside (see
    // offlineCache.ts); skipped for the attached session while the reader
    // is mounted, since it is already fetching the same document.
    if (s.idle && !(readModeRef.current && s.id === attachedRef.current)) void prefetchTranscript(s.id);
  }

  /** App's `case "pty"`. */
  function onPty(msg: PtyFrame) {
    const data = b64ToStr(msg.dataB64);
    // Full scrollback replay → replace the buffer wholesale, and if it's the
    // on-screen session, remount the xterm (termNonce) so it renders from a
    // clean slate; live output or a reconnect delta appends (see `tail.ts`).
    if (applyPtyBytes(buffers.current, msg.id, data, msg.full)) {
      if (attachedRef.current === msg.id) setTermNonce((n) => n + 1);
    }
    if (msg.seq != null) lastSeqById.current.set(msg.id, msg.seq);
    hostAnsweredFor(msg.id);
    // Reader-view liveness. A replay (`full`) is history, not fresh output —
    // timestamping it would make a reconnect look like the CLI just spoke.
    if (!msg.full && data) {
      lastPtyAt.current.set(msg.id, Date.now());
      ptyTail.current.set(msg.id, appendTail(ptyTail.current.get(msg.id), data, PTY_TAIL));
    }
    setWriteSeq((n) => n + 1);
  }

  /** App's `case "session.exit"`. */
  function onSessionExit(msg: ExitFrame) {
    // Remembered as well as re-rendered: the terminal's "session ended"
    // card must not depend on a session.list landing after this, which a
    // socket that drops in the same breath would never deliver.
    exitedRef.current.add(msg.id);
    setWriteSeq((n) => n + 1);
    // This is the frame that KNOWS the session died, and it arrives before
    // the `session.list` that will say `running: false`. Re-deciding the
    // queue here is what stops the first prompt of that lane being fired
    // into the corpse and buried as a red row (`goneLanes`).
    deps.onExit();
  }

  /** The local scrollback reconstruction; [] with no xterm mounted. */
  const snapshot = () => termRef.current?.snapshot() ?? [];

  // On reconnect the fresh server socket has no attachment, so drop our record:
  // the session.list that follows our `hello` then re-fires the attach effect
  // below and the host replays scrollback into the existing terminal.
  useEffect(() => {
    if (status === "open" && prevStatusRef.current !== "open") attachedRef.current = null;
    prevStatusRef.current = status;
  }, [status]);
  // Restore a session deep-linked from the URL: once it shows up in the list,
  // attach so the host replays its scrollback (the tap path does this in attach()).
  useEffect(() => {
    if (!activeId) { attachedRef.current = null; return; }
    if (parkedRef.current) return; // hidden + parked: the catch-up tick attaches, briefly
    if (attachedRef.current === activeId) return;
    if (!sessions.some((s) => s.id === activeId)) return; // wait for session.list
    if (!ptyRestored) return; // …and for the stored resume point (see ptyRestored)
    attachedRef.current = activeId;
    // Resume from where the still-mounted terminal left off (reconnect): the host
    // replays only the delta and we append it. On a first attach there's no seq →
    // full replay (handled by the pty `full` frame, which resets the buffer). Do
    // NOT clear the buffer here, or a delta would have nothing to append onto.
    send({ t: "session.attach", id: activeId, resumeSeq: lastSeqById.current.get(activeId), resumeBoot: resumeBootRef.current.get(activeId) ?? bootIdRef.current });
    // Same reason as in `attach()`: save this conversation while the link is up.
    // This is the deferred/deep-link path (the tap path early-returns above), so
    // without it a session opened from a URL or restored on a cold start would
    // never be cached until its next turn ended.
    if (!readModeRef.current) void prefetchTranscript(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `send` is bound to the one connection; the resume points are refs
  }, [activeId, sessions, ptyRestored, unparkNonce]);

  // ── Offline transcripts: keep EVERY session cached, in the background ────
  //
  // Reading a session offline is only useful if the one you reach for happens
  // to be cached, and the only sessions that ever were are the ones you had
  // open. So sweep the whole list on a cadence: newest first, one at a time,
  // `since`-conditional (a session that has not moved is a 204), throttled per
  // session inside offlineCache. With `lite` documents — the default, where
  // tool inputs/results stay on the host — a whole list costs a fraction of
  // what one busy session's transcript used to.
  //
  // Visible-only in a browser: a hidden tab's timers are throttled to minutes
  // anyway. The APK keeps the page alive behind the screen (background link),
  // and there the turn-end prefetch alone missed every session whose turn ended
  // while the socket was down — so it sweeps hidden too (`sweepsWhenHidden`).
  const sweepStatusRef = useLatest(status);
  const sweepRef = useRef(() => {});
  sweepRef.current = () => {
    if (sweepStatusRef.current !== "open") return;   // a sweep into a dead link is 12 timeouts
    // Attached first (most likely to be read), then newest — the same order the
    // cache's own eviction keeps, so the sweep never fights the prune.
    const ids = sweepOrder(sessionsRef.current, attachedRef.current);
    if (!ids.length) return;
    // Transcripts first, then the terminal screens (`screenSweep.ts`) — strictly
    // one after the other, for the same tunnel-is-the-bottleneck reason.
    void sweepTranscripts(ids).then(() => {
      const newest = [...sessionsRef.current].sort((a, b) => b.createdAt - a.createdAt);
      const want = screenSweepIds(newest, attachedRef.current, screenAskedRef.current, Date.now(), dataSaver());
      return want.length ? sweepScreens(want, screenDeps, screenAskedRef.current) : undefined;
    });
  };
  const screenAskedRef = useRef(new Map<string, number>());
  const screenDeps: ScreenSweepDeps = {
    fetchTail: (id, since) => api.screenTail(id, since),
    // A held seq counts in the boot that numbered it: a restored record from an
    // earlier boot is no `since` for this one.
    heldSeq: (id) => {
      const boot = resumeBootRef.current.get(id);
      return boot && boot !== bootIdRef.current ? undefined : lastSeqById.current.get(id);
    },
    attached: (id) => attachedRef.current === id,
    apply: async (id, t) => {
      const boot = t.boot ?? bootIdRef.current;
      await savePtyTail(id, t.data, t.seq, boot);
      // Into memory too: the APK's page lives for days, and the IndexedDB seed
      // runs only at mount — a tail stored but not seeded still paints nothing.
      seedFromTails([{ sessionId: id, tail: escapeSafeTail(t.data.slice(-PTY_SAVE_BYTES)), seq: t.seq, savedAt: Date.now(), boot }], {
        buffers: buffers.current, lastSeqById: lastSeqById.current,
        restore: restoreRef.current, resumeBoot: resumeBootRef.current,
      }, true);
      setStaleAt((prev) => new Map(prev).set(id, Date.now()));
    },
  };
  useEffect(() => {
    const run = () => {
      if (document.visibilityState === "visible" || sweepsWhenHidden(bgFresh(), isNativeShell())) sweepRef.current();
    };
    const t = setInterval(run, TRANSCRIPT_SWEEP_MS);
    document.addEventListener("visibilitychange", run);
    run();
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", run); };
  }, []);

  // ── Offline PTY scrollback: seed at mount, save while attached ───────────
  // One-shot seed. Runs before any attach can (the effect above gates on
  // `ptyRestored`), so `lastSeqById` already holds the stored seq when the
  // attach goes out and the host can answer with a delta instead of a full
  // replay. A session that already has live bytes in this tab is never
  // overwritten — the restore is strictly a cold-start fallback.
  useEffect(() => {
    let cancelled = false;
    loadPtyTails()
      .then((entries) => {
        if (cancelled) return;
        const stale = seedFromTails(entries, {
          buffers: buffers.current, lastSeqById: lastSeqById.current,
          restore: restoreRef.current, resumeBoot: resumeBootRef.current,
        });
        if (stale.size) setStaleAt(stale);
      })
      .finally(() => { if (!cancelled) setPtyRestored(true); }); // failure reads as "no cache", never a stuck attach
    void hydrateScreenLogs(); // the reconstructed scrollback, same cold-start deal
    return () => { cancelled = true; };
  }, []);
  // Save the on-screen session's tail. `pagehide`/`freeze` are the real save
  // points (a phone is backgrounded, not closed, and ws.ts already closes the
  // socket on both); the interval is the backstop for an OS kill that fires
  // neither, and the cleanup catches leaving the session.
  useEffect(() => {
    const id = activeId;
    if (!id) return;
    const save = () => {
      // A session still showing its RESTORED tail has produced nothing new, and
      // re-storing it would only move `savedAt` forward — making the "output as
      // of …" chip claim the bytes are fresher than they are.
      // The scrollback archive is saved either way: it is lines this device
      // rendered at some point, and a restored-tail session has them too.
      void saveScreenLog(id);
      if (restoreRef.current.has(id)) return;
      void savePtyTail(id, (buffers.current.get(id) ?? []).join(""), lastSeqById.current.get(id), bootIdRef.current);
    };
    // Parked (hidden, `bgFresh.ts`): nothing arrives between catch-ups, and each
    // catch-up saves on its own — a timer here would only rewrite the same bytes.
    const iv = window.setInterval(() => { if (!parkedRef.current) save(); }, PTY_SAVE_MS);
    window.addEventListener("pagehide", save);
    window.addEventListener("freeze", save);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("pagehide", save);
      window.removeEventListener("freeze", save);
      save();
    };
  }, [activeId]);
  // ── Background freshness: park the terminal while the app is hidden ──────
  function saveTail(id: string) {
    void saveScreenLog(id);
    if (restoreRef.current.has(id)) return;
    void savePtyTail(id, (buffers.current.get(id) ?? []).join(""), lastSeqById.current.get(id), bootIdRef.current);
  }
  /** A catch-up attach was answered (or its fuse ran out): save what it
   *  brought and let go of the stream again. */
  function endCatchUp(id: string) {
    syncRef.current = null;
    window.clearTimeout(syncFuseRef.current);
    if (!parkedRef.current) return; // came back to the foreground meanwhile: stay attached
    saveTail(id);
    send({ t: "session.detach", id });
  }
  useEffect(() => {
    const id = activeId;
    if (!id || isPendingId(id)) return;
    let tick: number | undefined;
    const park = () => {
      const mode = bgFresh();
      if (!parksWhenHidden(mode) || parkedRef.current) return;
      parkedRef.current = true;
      saveTail(id);
      send({ t: "session.detach", id });
      const every = catchUpMs(mode);
      if (every != null) tick = window.setInterval(catchUp, every);
    };
    const catchUp = () => {
      if (!parkedRef.current || syncRef.current || statusRef.current !== "open") return;
      syncRef.current = id;
      send({ t: "session.attach", id, resumeSeq: lastSeqById.current.get(id), resumeBoot: resumeBootRef.current.get(id) ?? bootIdRef.current });
      // A zombie socket never answers: give up on this round rather than
      // leave the attach standing until the next one.
      syncFuseRef.current = window.setTimeout(() => endCatchUp(id), 20_000);
      sweepRef.current(); // the reader's copy too, since-conditional
    };
    const unpark = () => {
      window.clearInterval(tick); tick = undefined;
      if (!parkedRef.current) return;
      parkedRef.current = false;
      syncRef.current = null;
      window.clearTimeout(syncFuseRef.current);
      attachedRef.current = null; // the attach effect re-attaches from the last seq
      setUnparkNonce((n) => n + 1);
    };
    const onVis = () => { if (document.visibilityState === "hidden") park(); else unpark(); };
    document.addEventListener("visibilitychange", onVis);
    if (document.visibilityState === "hidden") park();
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(tick);
      // Leaving the session while parked: the attach for the NEXT one must go out.
      if (parkedRef.current) { parkedRef.current = false; syncRef.current = null; window.clearTimeout(syncFuseRef.current); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bound per session; `send` is the one connection's, `endCatchUp` and the handlers read refs (`parkedRef`, `syncRef`, `statusRef`)
  }, [activeId]);

  // Detach from a session when we navigate away (stops the host streaming it).
  // A pending screen (`pending:<createAck>`) was never attached: the host has no
  // session by that id yet.
  useEffect(() => {
    if (!activeId || isPendingId(activeId)) return;
    return () => send({ t: "session.detach", id: activeId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the detach names the session this effect ran for, which is the one being left
  }, [activeId]);

  return {
    termRef, geomRef, buffers, lastPtyAt, ptyTail, exitedRef,
    staleAt, writeSeq, termNonce,
    readMode, readModeRef, setView, openReader,
    readerCmd, fireReader, outlineJump, setOutlineJump, transcriptNonce,
    attach, focus, refreshTerminal, hostAnsweredFor, onWelcome, onSessionUpdated, onPty, onSessionExit, snapshot,
  };
}

export type TermFeed = ReturnType<typeof useTermFeed>;
