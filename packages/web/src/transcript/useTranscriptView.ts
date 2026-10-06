import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptDoc, TranscriptTurn } from "@waterplane/shared";
import { mixSlots } from "../turnMix";
import { lastCostTurn, turnAgents } from "../lastTurnCost";
import { api, copyText, isOffline } from "../api";
import { dataSaver } from "../media";
import { getToolDetails, getTranscriptAt, putToolDetails, putTranscript } from "../offlineCache";
import { matches, newestTs, readSeen, turnText, turnTs, wantedDetail, writeSeen } from "../transcriptUtil";
import { track } from "../usage";
import { LS, lsBool, lsSetBool } from "../storage";
import type { DetailState, TranscriptViewProps } from "./tvTypes";
import { BUSY_POLL_MS, PAGE, POLL_MS, SAVER_POLL_FACTOR } from "./tvRows";
import { liveReading } from "./tvLive";

/**
 * Every piece of state, ref, effect and handler of the reader, in the order the
 * one-component version declared them (effect order is behaviour). The region
 * components under `transcript/` only read what this returns.
 */
export function useTranscriptView(p: TranscriptViewProps) {
  const { sessionId, refreshKey, status, cliPeek, onToast, jumpTo, toolsMode, cmd } = p;
  const [doc, setDoc] = useState<TranscriptDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [outline, setOutline] = useState(false);
  /** Find is a toggle in the header (the row it used to live on is gone, and a
   *  permanent text field does not fit beside the title). Opening it focuses
   *  it; a non-empty query keeps it open however it was opened. */
  const [findOpen, setFindOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [openBlocks, setOpenBlocks] = useState<Set<string>>(new Set());
  // Tool inputs/results that a `lite` document withheld, per TURN — see
  // `loadDetails` below. Declared here because the find-hit counter has to
  // re-run when one lands.
  const [details, setDetails] = useState<Map<string, DetailState>>(new Map());
  const detailsRef = useRef(details);
  detailsRef.current = details;
  useEffect(() => { setDetails(new Map()); }, [sessionId]);
  const [hitIdx, setHitIdx] = useState(0);
  const [hitCount, setHitCount] = useState(0);
  const [seenMark, setSeenMark] = useState(0);  // newest turn ts already seen (0 = not resolved yet)
  const [, setTick] = useState(0); // 1 Hz heartbeat for the live status strip
  // Set when the last fetch attempt FAILED and what's on screen is therefore
  // the offline cache, not a live read — drives the "showing cached
  // transcript" chip. The value is the doc's own `updatedAt` (when that
  // content was actually produced), not the failure time. Cleared on the
  // next successful fetch.
  const [offlineAt, setOfflineAt] = useState<number | null>(null);
  /**
   * When THIS PHONE wrote the copy on screen down, when the copy came from the
   * cache. Distinct from `offlineAt` (the doc's own `updatedAt`, i.e. when the
   * conversation last moved) because they answer different questions and the
   * reader was printing the wrong one: a session that went quiet at 14:00 and
   * was cached at 18:00 said "as of 14:00", which tells you nothing about how
   * out of date what you are reading is.
   */
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  /**
   * The IndexedDB probe for this session has not answered yet.
   *
   * The whole point: **"loading transcript…" may only ever be shown once we
   * KNOW there is nothing saved for this session.** The reader is the last
   * screen anyone reaches on a dying tunnel, the bytes are usually already on
   * the phone (`prefetchTranscript` on attach/turn-end/reconnect, plus the
   * 5-minute sweep), and rendering a spinner over them for the length of the
   * fetch fuse is the app failing at the one thing it exists to do. So the
   * spinner waits for the CACHE, not for the host.
   */
  const [probing, setProbing] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<TranscriptDoc | null>(null);
  const stickRef = useRef(true);       // was the reader parked at the bottom?
  const seenRef = useRef<string>("");  // session whose first paint already scrolled
  const turnsRef = useRef<TranscriptTurn[]>([]);
  const gotLiveRef = useRef(false);    // this session got at least one successful live fetch
  const curSidRef = useRef(sessionId); // latest sessionId prop, for the async cache-seed race below
  const cacheTimer = useRef<number | null>(null);
  const cachePending = useRef<TranscriptDoc | null>(null); // doc the debounce still owes the cache

  docRef.current = doc;
  curSidRef.current = sessionId;
  // Model colours, decided ONCE per document so a model keeps its hue from
  // turn to turn (`turnMix.ts`).
  const mixSlotsDoc = useMemo(() => mixSlots(doc?.turns ?? []), [doc]);
  // "Why dollars?" is said once, under the newest turn with figures — the same
  // turn the terminal's strip speaks for — not repeated at every turn's foot.
  const whyTurnId = useMemo(() => lastCostTurn(doc?.turns ?? [])?.id ?? null, [doc]);
  // Each turn's cost is a FOLD (`CostFold`, the terminal strip's head). The
  // newest one with figures follows the ONE stored preference the terminal's
  // strip uses — it is the same card; an older one opens per tap, for this
  // visit only.
  const [costLastOpen, setCostLastOpen] = useState(() => lsBool(LS.termCostOpen));
  const [costOpen, setCostOpen] = useState<Set<string>>(new Set());
  const toggleCost = (id: string, newest: boolean) => {
    const open = !(newest ? costLastOpen : costOpen.has(id));
    track(open ? "action:read.cost.open" : "action:read.cost.close");
    if (newest) {
      lsSetBool(LS.termCostOpen, open);
      setCostLastOpen(open);
      return;
    }
    const next = new Set(costOpen);
    if (open) next.add(id); else next.delete(id);
    setCostOpen(next);
  };
  // Turns at or after the first one that started a subagent: their "session so
  // far" leaves that spend out, while the header's total counts it — the note
  // under the figure has to say so or the two read as one number disagreeing.
  const agentsSoFar = useMemo(() => {
    const s = new Set<string>();
    let seen = false;
    for (const t of doc?.turns ?? []) {
      if (turnAgents(t) > 0) seen = true;
      if (seen) s.add(t.id);
    }
    return s;
  }, [doc]);

  // Debounced write-through to the offline cache — a poll every few seconds
  // while busy would otherwise hit IndexedDB that often for no benefit.
  const scheduleCacheWrite = (d: TranscriptDoc) => {
    cachePending.current = d;
    if (cacheTimer.current) clearTimeout(cacheTimer.current);
    cacheTimer.current = window.setTimeout(() => {
      cacheTimer.current = null;
      const pend = cachePending.current;
      cachePending.current = null;
      if (pend) void putTranscript(pend);
    }, 1500);
  };
  // FLUSH on unmount, never just cancel: this component is keyed per session, so
  // it remounts on every switch — and a session read for less than the debounce
  // window (the common case: open it, glance, go back) would otherwise never be
  // cached at all, which is exactly the session you next open with no tunnel.
  useEffect(() => () => {
    if (cacheTimer.current) clearTimeout(cacheTimer.current);
    cacheTimer.current = null;
    const pend = cachePending.current;
    cachePending.current = null;
    if (pend) void putTranscript(pend);
  }, []);

  const load = useCallback(async (incremental: boolean) => {
    try {
      if (!incremental) setLoading(true);
      const want = wantedDetail(toolsMode);
      // Only poll with `since` while what we hold is already the shape we want.
      // Otherwise a switch to "full details" on a quiet session answers 204
      // forever and the setting looks broken. (`detail` absent = an older host,
      // which only ever sent full documents.)
      const held = docRef.current;
      const since = incremental && held && (held.detail ?? "full") === want ? held.updatedAt : undefined;
      const next = await api.transcript(sessionId, since, want);
      if (next) {
        gotLiveRef.current = true;
        setDoc(next);
        setErr(null);
        setOfflineAt(null); // a success clears any "showing cached" chip
        setCachedAt(null);
        scheduleCacheWrite(next);
      } else {
        // 204: the host answered and the log has NOT changed since `since`. That
        // is stronger proof of freshness than a 200 — what is on screen is
        // provably current — so it must clear the chip too. Clearing only inside
        // the `next` branch left the "showing cached transcript" chip up forever
        // on a reconnect to an idle session: every incremental poll answers 204,
        // so nothing ever contradicted the one failed fetch that raised it.
        gotLiveRef.current = true;
        setErr(null);
        setOfflineAt(null);
        setCachedAt(null);
      }
    } catch (e) {
      // The host is unreachable (or errored). Keep serving whatever's already
      // on screen — live or cache-seeded — flagged as stale, instead of
      // blanking the reader; only fall through to the error string when there
      // is truly nothing to show (never loaded AND no cache hit either).
      if (docRef.current) {
        setOfflineAt(docRef.current.updatedAt);
      } else {
        const hit = await getTranscriptAt(sessionId);
        if (hit && curSidRef.current === sessionId) { setDoc(hit.value); setCachedAt(hit.savedAt); setOfflineAt(hit.value.updatedAt); }
        else if (String(e).includes("404")) setErr("Nothing recorded for this session yet.");
        // "TimeoutError: timed out after 12s — transcript" is a stack trace
        // where a sentence belongs: the reader is the LAST screen someone
        // reaches on a dying tunnel, and what they need told is that the host
        // is unreachable, that this device has nothing saved for this session,
        // and that the terminal view still has its scrollback.
        else setErr(isOffline(e)
          ? "Can't reach the host, and there's no transcript saved on this device for this session yet."
          : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [sessionId, toolsMode]);

  // `load` is reached through a ref below: it changes identity when the tool
  // detail SETTING changes, and re-running the session-reset effect for that
  // would wipe the find box and the scroll position over a preference flip.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    setDoc(null); setLimit(PAGE); setQ(""); setOfflineAt(null);
    setSeenMark(readSeen(sessionId));
    stickRef.current = true;
    gotLiveRef.current = false;
    const sid = sessionId;
    // Seed from the IDB cache immediately, before the network round-trip
    // completes (or at all, offline) — a reopened session shows its last
    // transcript instead of a blank "loading…" state. Guarded against a live
    // fetch (or a session switch) winning the race in the meantime. Not
    // flagged as "offline" yet — that only happens if the fetch below
    // actually fails; most of the time it resolves fine and this was just a
    // faster first paint.
    setCachedAt(null);
    setProbing(true);
    // Cache read STARTED first, deliberately: on a dead tunnel the fetch below
    // holds for the length of its fuse (12 s) and the IndexedDB read answers in
    // milliseconds, so whichever wins the race the screen paints from disk.
    // `probing` is what stops the spinner appearing in the gap.
    void getTranscriptAt(sid)
      .then((hit) => {
        if (!hit || gotLiveRef.current || curSidRef.current !== sid) return;
        setDoc(hit.value);
        setCachedAt(hit.savedAt);
      })
      .finally(() => { if (curSidRef.current === sid) setProbing(false); });
    void loadRef.current(false);
  }, [sessionId]);

  // The setting changed: refetch in the new shape, keeping the find, the scroll
  // and the revealed-turn count exactly where they were. Skipped on mount — the
  // effect above already loaded.
  const modeRef = useRef(toolsMode);
  useEffect(() => {
    if (modeRef.current === toolsMode) return;
    modeRef.current = toolsMode;
    void load(false);
  }, [toolsMode, load]);

  // Leaving the reader (CLI toggle, session switch, unmount) while parked at the
  // bottom means you saw the tail — everything is read from here on.
  useEffect(() => () => {
    if (stickRef.current) writeSeen(sessionId, newestTs(turnsRef.current));
  }, [sessionId]);
  useEffect(() => { if (refreshKey) void load(true); }, [refreshKey, load]);
  const busy = !!status?.busy;
  useEffect(() => {
    const every = (busy ? BUSY_POLL_MS : POLL_MS) * (dataSaver() ? SAVER_POLL_FACTOR : 1);
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(true); }, every);
    return () => clearInterval(t);
  }, [load, busy]);
  // While busy the strip counts seconds, so it needs a heartbeat of its own —
  // nothing else re-renders between PTY frames (and a quiet tool run has none).
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `doc?.turns ?? []` is a new array only while no doc is loaded; memoising would change when the dependents re-run
  const turns = doc?.turns ?? [];
  // The empty reader's CLI peek: shown while there is a doc with no turns,
  // LEAVING (one flight into the CLI toggle) when the first turn arrives —
  // only if it was actually on screen — and then gone for this session. It
  // stays drawn through the one render where turns exist and `peek` is still
  // "shown": unmounting there remounted it blank and the flight never ran.
  const emptyNow = !!doc && turns.length === 0;
  const [peek, setPeek] = useState<"idle" | "shown" | "leaving" | "gone">("idle");
  useEffect(() => {
    if (!cliPeek) return;
    if (emptyNow) setPeek((p) => (p === "idle" ? "shown" : p));
    else setPeek((p) => (p === "shown" ? "leaving" : p));
  }, [emptyNow, cliPeek]);
  turnsRef.current = turns;

  // First open of a session on this device: adopt the tail as "seen" rather than
  // flagging the entire history as new.
  useEffect(() => {
    if (seenMark || !turns.length) return;
    const m = newestTs(turns);
    if (!m) return;
    writeSeen(sessionId, m);
    setSeenMark(m);
  }, [turns, seenMark, sessionId]);

  const newIdx = useMemo(
    () => (seenMark ? turns.findIndex((t) => turnTs(t) > seenMark) : -1),
    [turns, seenMark],
  );
  const unread = newIdx === -1 ? 0 : turns.length - newIdx;

  const shown = useMemo(() => turns.slice(Math.max(0, turns.length - limit)), [turns, limit]);

  // Follow the tail like a terminal does — but only while the reader is already
  // parked at the bottom, so reading history isn't yanked by a new turn. On the
  // first paint, land on the unread divider instead of the bottom when there is
  // one — the point of the mark is to start where you stopped.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !doc) return;
    if (seenRef.current !== sessionId) {
      if (!seenMark) return;                       // watermark not resolved yet
      if (unread > limit) { setLimit(unread + PAGE); return; }  // reveal them first
      seenRef.current = sessionId;
      if (unread > 0) {
        stickRef.current = false;
        requestAnimationFrame(() =>
          document.getElementById("tr-newmark")?.scrollIntoView({ block: "start" }));
      } else {
        el.scrollTop = el.scrollHeight;
      }
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [doc, sessionId, seenMark, unread, limit]);

  // Turns that land while the reader is parked at the BOTTOM of this session are
  // turns you are watching arrive, so the watermark follows them — the same rule
  // the unmount effect applies when you leave from the bottom. Without it the
  // mark only ever moved on a session switch, a first open or the explicit
  // button, so a live session counted every turn drawn in front of you as
  // unread: "4 new" sitting over the four turns you had just read. Hidden tab ⇒
  // not watching ⇒ still unread (the poll is visible-only, so the count catches
  // up on the next load once you come back).
  useEffect(() => {
    if (seenRef.current !== sessionId || !stickRef.current) return;
    if (document.visibilityState !== "visible") return;
    const m = newestTs(turns);
    if (!m || m <= seenMark) return;
    writeSeen(sessionId, m);
    setSeenMark(m);
  }, [turns, sessionId, seenMark]);
  const outlineTurns = useMemo(
    () => (q ? turns.filter((t) => matches(turnText(t), q)) : turns),
    [turns, q],
  );

  // The find bar counts real rendered <mark>s, so the count matches what you can jump to.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const marks = el.querySelectorAll(".tr-hit");
    setHitCount(marks.length);
    setHitIdx((i) => (marks.length ? Math.min(i, marks.length - 1) : 0));
    // `details` and `toolsMode` change what is on the page too: a loaded tool
    // detail can add hits, and folding removes rows. A count that doesn't
    // follow is a find bar promising jumps it can't make.
  }, [q, shown, openBlocks, doc, details, toolsMode]);

  const jump = (delta: number) => {
    const el = bodyRef.current;
    if (!el) return;
    const marks = el.querySelectorAll<HTMLElement>(".tr-hit");
    if (!marks.length) return;
    const next = (hitIdx + delta + marks.length) % marks.length;
    setHitIdx(next);
    marks.forEach((m, i) => m.classList.toggle("on", i === next));
    marks[next].scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const goTurn = (n: number) => {
    // Reveal it first if it's older than the rendered window.
    const idx = turns.findIndex((t) => t.n === n);
    if (idx !== -1 && turns.length - idx > limit) setLimit(turns.length - idx + PAGE);
    setOutline(false);
    // Stop following the tail — otherwise the parked-at-bottom autoscroll runs
    // after this and drags the view straight back off the turn you asked for.
    stickRef.current = false;
    setTimeout(() => {
      document.getElementById(`tr-turn-${n}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 30);
  };

  // A jump requested from the outline sheet. Deliberately keyed on `jumpTo.key`
  // only: the turns may still be loading when the sheet closes, so re-running on
  // every doc change would yank the scroll position on each poll.
  const jumpKey = jumpTo?.key ?? 0;
  useEffect(() => {
    if (!jumpTo || !turns.length) return;
    goTurn(jumpTo.n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpKey, turns.length > 0]);

  // A verb fired from the toolbar. Keyed on `cmd.key` alone for `jumpTo`'s
  // reason — tapping find twice must open it twice, and the kind is an
  // unchanged prop the second time. Find TOGGLES: the button is the same one
  // that used to sit in the header, and there is no second tap-to-close now
  // that the field only exists while it is open.
  const cmdKey = cmd?.key ?? 0;
  useEffect(() => {
    if (!cmd || !cmdKey) return;
    if (cmd.kind === "outline") { track("action:read.outline"); setOutline((v) => !v); }
    else if (cmd.kind === "find") setFindOpen((v) => { if (v) setQ(""); return !v; });
    else void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmdKey]);

  const markRead = () => { const m = newestTs(turns); writeSeen(sessionId, m); setSeenMark(m); };

  const goNew = () => {
    track("action:read.new");
    if (unread > limit) setLimit(unread + PAGE);
    setOutline(false);
    setTimeout(() => document.getElementById("tr-newmark")?.scrollIntoView({ block: "start", behavior: "smooth" }), 30);
  };

  const toggleBlock = (id: string) =>
    setOpenBlocks((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // ── Tool inputs/results, on demand ──────────────────────────────────────
  // The document is `lite`: it carries what each tool call WAS but not what went
  // in or came out (host/src/transcript.ts). Those two strings arrive per TURN,
  // on the first tap that opens one of its tool calls — one request buys every
  // tool in that turn, which is what a person reading that turn opens next
  // anyway, and it keeps a burst of taps from being a burst of requests.
  const loadDetails = useCallback(async (turn: TranscriptTurn, force = false) => {
    const turnId = turn.id;
    if (!force && detailsRef.current.has(turnId)) return; // loading, or already answered
    const put = (v: DetailState) => setDetails((m) => new Map(m).set(turnId, v));
    put({ state: "loading" });
    const cached = force ? null : await getToolDetails(sessionId, turnId);
    // A cached set from while a tool was still running has a hole where its
    // result now is. The lite block knows better (`ok` is set the moment a
    // result is matched back), so that disagreement means refetch rather than
    // showing "no result recorded" for a tool that finished ten minutes ago.
    const stale = !!cached && turn.blocks.some(
      (b) => b.kind === "tool" && b.ok !== undefined && cached[b.id]?.result === undefined);
    if (cached && !stale) { put({ state: "ok", tools: cached }); return; }
    try {
      const tools = await api.transcriptTools(sessionId, turnId);
      put({ state: "ok", tools });
      void putToolDetails(sessionId, turnId, tools);
    } catch (e) {
      // A stale cached set still beats nothing when the host is gone — the
      // inputs are exact and only an in-flight result is missing.
      if (cached) { put({ state: "ok", tools: cached }); return; }
      put({ state: "error", msg: isOffline(e)
        ? "can't reach the host — these tool details aren't saved on this device"
        : String(e) });
    }
  }, [sessionId]);

  const copy = (text: string) => void copyText(text).then((ok) => onToast(ok ? "copied" : "copy failed"));

  // One turn's fork/reset row open at a time: four controls in a turn header is
  // a reach on a phone, and two verbs that both start a session should not sit
  // one stray thumb from "copy turn".
  const [forkTurn, setForkTurn] = useState<string | null>(null);

  // A prompt outranks "working": a hooked session stays turn-active while the
  // dialog is up (the tool call has not returned), so both are true at once.
  const asking = !!status && status.running && (status.waiting || !!status.awaitingInput || !!status.asking);
  const askedRef = useRef(false);
  useEffect(() => {
    if (!asking) { askedRef.current = false; return; }
    if (askedRef.current) return;
    askedRef.current = true;
    // Reading history should not swallow a question — go to it once, then leave
    // the scroll position alone.
    requestAnimationFrame(() =>
      document.getElementById("tr-ask")?.scrollIntoView({ block: "end", behavior: "smooth" }));
  }, [asking]);

  const lv = liveReading(status, busy);

  return {
    ...p, ...lv,
    doc, err, loading, q, setQ, outline, findOpen, setFindOpen, limit, setLimit, openBlocks, details,
    hitIdx, setHitIdx, hitCount, seenMark, setSeenMark, offlineAt, cachedAt, probing,
    bodyRef, stickRef, seenRef, turnsRef, mixSlotsDoc, whyTurnId, costLastOpen, costOpen, toggleCost,
    agentsSoFar, turns, emptyNow, peek, setPeek, newIdx, unread, shown, outlineTurns, jump, goTurn, goNew,
    markRead, toggleBlock, loadDetails, copy, forkTurn, setForkTurn, asking, busy,
  };
}

export type TvModel = ReturnType<typeof useTranscriptView>;
