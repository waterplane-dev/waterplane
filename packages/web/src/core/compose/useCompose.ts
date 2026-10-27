/**
 * **The compose bar** — the per-session draft, its history, the split Send
 * button's two modes and its one aim, CLI mode's raw key pipe, the snippet
 * popover and the microphone.
 *
 * Two hooks, because the draft is older than the queue: the queue core reads
 * the box (`composeTextRef`) and writes it back (`setCompose`, a restore) and
 * records history (`pushHistory`), while this bar sends THROUGH the queue. So
 * `useComposeDraft()` is the state alone and is called BEFORE `useQueue`;
 * `useCompose(draft, deps)` is everything that acts, called after `useSend`
 * (hook order in App: conn → route → prefs → term → [draft] → queue → launch →
 * send → compose → verbs → bindCore).
 *
 * Lifted out of `App.tsx` unchanged; every name App used is a member of one of
 * the two returns. **No draft clobber**: `setCompose("")` only runs where the
 * words are provably in the outbox (after `submitInput`/`queueBacklog`/
 * `dispatchIntent` accepted them, or `addPadNote` kept them); dictation and
 * snippets APPEND; the clear button takes two taps.
 */
import { besidePicture } from "../../besideRoom";
import { askChoice, askConfirm, askConfirmRemember } from "../../Confirm";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from "react";
import {
  answeredOnlyInCli, budgetReasonText, cliRestartDue, cliRestartSendAsk, cliRestartView, isLocalCommand, sessionBudgetHeld,
  sessionBudgetText,
} from "@waterplane/shared";
import type { ClientMessage, LaunchOpts, RepoTarget, SessionInfo } from "@waterplane/shared";
import { resumeIdOf } from "../../sessionFacts";
import { restartOfferClosed } from "../Banners";
import {
  PAD_EMPTY_TOAST, PAD_KEPT_TOAST, WHERE_UNPICKED_TOAST, sendModeToast, whereGoneToast, type SendMode, type SendWhere,
  busyPastBudgetToast, busySendAsk, busySendRememberedToast, busySendRoute,
} from "../../composeSend";
import { hardSendAsk } from "../../budgetInput";
import { recallMode, recallWhen, recallWhere, recalledWhenNote } from "../../sendMemory";
import type { SendTarget } from "../../sendIntent";
import { addPadNote, loadDraft, padNoteId, saveDraft } from "../../outbox";
import { PIPE_PAD, decodePipe, keyToBytes } from "../../cliKeys";
import { useChord } from "./useChord";
import { NAMED_KEY, type ChordMod } from "./chordState.ts";
import { CMD_HISTORY_MAX, loadCmdHistory } from "../../localState";
import type { HeaderCmd } from "../../headerCmds";
import type { Snippet } from "../../SnippetSheet";
import { useVoice } from "../../useVoice";
import { baseName } from "../../format";
import { LS, lsSetJson } from "../../storage";
import { prefRef, setPref } from "../prefs.ts";
import { showToast } from "../../toast";
import { track } from "../../usage";
import type { HostConnection } from "../../ws";
import { useLatest } from "../../sdk/hooks.ts";
import type { SecretFillContext, SeedOutcome } from "../../sdk/types.ts";
import { secretAsk } from "../../secretAsk";
import { isShellBackend } from "../../backendCaps";
import { isLaterId } from "../queue/logic.ts";
import type { QueueApi, SendApi } from "../send/useSend";

type Ref<T> = { readonly current: T };

// Ceiling for the auto-growing compose box. The terminal above it has to keep
// showing something, so the input stops growing here and scrolls instead.
// Keep in sync with `.compose textarea { max-height }` in styles.css.
const COMPOSE_MAX_H = 200;

/** `<session id>|<installed version>` answered "send on the old one" — not asked again. In memory, as the bar's own. */
const restartPassed = new Set<string>();

/**
 * The compose box's state — no behaviour, no dependencies. Called above
 * `useQueue`, which reads and restores the box.
 */
export function useComposeDraft() {
  const [compose, setCompose] = useState("");
  /**
   * The compose box's CURRENT text, by ref.
   *
   * Dictation reads it at the moment transcribed words arrive, which since
   * `dictateQueue.ts` can be minutes after the microphone closed — a recording
   * made on a dead tunnel is held and read when it comes back. A closure over
   * the `compose` of that older render would append onto text the person has
   * since gone on writing, i.e. delete it (`local/no-draft-clobber`'s failure,
   * reached by a different lever). It is also the queue's `composeTextRef`
   * (async upload finalizers) — one mirror, not two.
   */
  const composeNow = useRef("");
  composeNow.current = compose;
  const composeRef = useRef<HTMLTextAreaElement>(null);
  // Recently-sent compose text, newest-last, for up/down history scrolling. Global,
  // capped, persisted. `histIdx` = position while browsing (-1 = live draft, not
  // browsing); `histStash` holds the draft that browsing interrupted so Down past
  // the newest entry restores it.
  const [cmdHistory, setCmdHistory] = useState<string[]>(loadCmdHistory);
  const [histIdx, setHistIdx] = useState(-1);
  const histStash = useRef("");
  // Two-tap guard for the destructive clear button.
  const [clearArmed, setClearArmed] = useState(false);
  // Whether the caret is in the compose box RIGHT NOW. Not a ref: the layout
  // depends on it (`chromeMode`).
  const [composeFocused, setComposeFocused] = useState(false);
  // Whether the pick-a-snippet popover is open (the list is `features/snippets`).
  const [snippetOpen, setSnippetOpen] = useState(false);
  /* Auto-grow the compose box with its content, up to COMPOSE_MAX_H. It is a
   * fixed two-row slot otherwise: `resize: none` removes the drag handle a
   * desktop would offer, and nothing else ever sets a height, so the CSS
   * `max-height` was dead and a multi-step prompt written on a phone was read
   * through a 48px porthole. Driven off `compose` rather than the change
   * handler because the value is set from a dozen places (history stepping,
   * snippet insert, draft restore, queue restore, clear) and a handler-only
   * grow would be right in exactly one of them. Layout effect so the height
   * lands in the same frame as the text — a passive effect shows one frame of
   * the old size on every keystroke.
   *
   * Also run by `ComposeBar` on MOUNT and when CLI mode flips: the textarea
   * remounts at `rows={2}` under every sheet (App returns early per overlay),
   * and keyed on `compose` alone a multi-line draft sat in a two-row box
   * until the next keystroke. */
  function growCompose() {
    const el = composeRef.current;
    if (!el) return;
    el.style.height = "auto"; // shrink back first, else it can only ever grow
    // `scrollHeight` is content+padding and EXCLUDES the border, while
    // `box-sizing: border-box` makes the height property include it — so
    // assigning scrollHeight straight across leaves the box 2px short and the
    // last line permanently under a scrollbar. `offsetHeight - clientHeight`
    // is that border, measured rather than hard-coded from the stylesheet.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, COMPOSE_MAX_H)}px`;
  }
  useLayoutEffect(growCompose, [compose]);

  /** Record a sent command for up/down history and reset the browse cursor. */
  function pushHistory(text: string) {
    const t = text.trim();
    if (!t) return;
    setCmdHistory((prev) => {
      const next = [...prev.filter((x) => x !== t), t].slice(-CMD_HISTORY_MAX);
      lsSetJson(LS.cmdHistory, next);
      return next;
    });
    setHistIdx(-1);
    setClearArmed(false);
  }
  /** Add to the draft — never overwrites it (`core.compose.insert`). */
  function insertCompose(text: string) { setCompose((c) => (c ? `${c}${c.endsWith(" ") ? "" : " "}${text}` : text)); }

  return {
    compose, setCompose, composeNow, composeRef, cmdHistory, histIdx, setHistIdx, histStash, clearArmed, setClearArmed,
    composeFocused, setComposeFocused, snippetOpen, setSnippetOpen, pushHistory, insertCompose, growCompose,
  };
}
export type ComposeDraft = ReturnType<typeof useComposeDraft>;

export interface ComposeDeps {
  /** The one socket, whole: `send` is CLI mode's raw keystrokes (deliberately
   *  NOT durable), `connRef` the live status a toast reads. */
  conn: { connRef: Ref<HostConnection>; send(frame: ClientMessage): void };
  active: SessionInfo | null;
  /** The session on screen is a queued create with no PTY yet. */
  pending: boolean;
  activeId: string | null;
  sessions: SessionInfo[];
  /** The reader is up (CLI mode is off there — the grid is not on screen). */
  readerShown: boolean;
  /** Return submits (a device pref). */
  enterSends: boolean;
  /** CLI mode as remembered, and its setter — the caller persists it. */
  cliModeOn: boolean;
  setCliModeOn(on: boolean): void;
  /** Put the terminal on screen instead of the reader (App's `setView(false)`). */
  showCli(): void;
  queue: Pick<QueueApi, "submitInput" | "queueBacklog" | "budget"> & { uploads: { parkingRef: MutableRefObject<number> } };
  sender: Pick<SendApi, "dispatchIntent" | "openSend" | "noteSendAim" | "sendMemRef">;
  repoForCwd(cwd: string): RepoTarget | null;
  /** `claude --version` on the desktop (`UpdateInfo.current`) — a session older than it is asked about on Send. */
  cliInstalled: string | undefined;
  relaunch(s: SessionInfo, patch: Partial<LaunchOpts>, opts?: { quiet?: boolean; prompt?: string }): void;
  /** Off the session screen — the `+ later` screen once its words are posted. */
  leave(): void;
}

export function useCompose(draft: ComposeDraft, deps: ComposeDeps) {
  const {
    compose, setCompose, composeNow, composeRef, cmdHistory, histIdx, setHistIdx, histStash, clearArmed, setClearArmed,
    setSnippetOpen, pushHistory,
  } = draft;
  const {
    active, pending, activeId, sessions, readerShown, enterSends, cliModeOn, setCliModeOn, repoForCwd,
  } = deps;
  const { connRef, send } = deps.conn;
  // The session on screen for callbacks that outlive the render (dictation,
  // the Send sheet's `onPosted`, `seedDraft`).
  const activeIdRef = useLatest(activeId);
  const { submitInput, queueBacklog } = deps.queue;
  const { parkingRef } = deps.queue.uploads;
  const { dispatchIntent, openSend, noteSendAim, sendMemRef } = deps.sender;
  const closeKbOnSend = prefRef("closeKbOnSend");
  const btwToCli = prefRef("btwToCli");
  const busySend = prefRef("busySend");

  /**
   * A `/btw` just went from the READER: its answer only ever exists in an
   * overlay of the CLI's own (`answeredOnlyInCli`), so offer to go there.
   * Asked, never done unasked — the screen changing under a send would read
   * as a bug — unless the person ticked "don't ask again", and then the
   * switch says where the reader is. Settings › Writing & reading undoes it.
   */
  function offerCliForBtw() {
    const go = () => {
      deps.showCli();
      showToast("switched to the CLI for the /btw answer — the book button above brings the reader back");
    };
    if (btwToCli.current === "switch") { go(); return; }
    if (btwToCli.current === "stay") return;
    void askConfirmRemember({
      title: "Switch to the CLI to read the answer?",
      lines: [
        "The CLI answers /btw in an overlay of its own and keeps no record of it, so the reader cannot show it.",
        "It stays readable in the CLI until the overlay is closed (Esc).",
      ],
      confirmLabel: "switch", cancelLabel: "stay", tone: "info",
      rememberLabel: "don't ask again",
    }).then(({ ok, remember }) => {
      if (remember) {
        setPref("btwToCli", ok ? "switch" : "stay");
        if (!ok) showToast("won't ask again — Settings › Writing & reading › /btw from the reader changes it");
      }
      if (ok) {
        track("action:compose.btwToCli");
        go();
      }
    });
  }

  /**
   * What the compose bar's Send button DOES — chosen on the chevron beside it.
   *
   * This is the split button, and it REMEMBERS per repo (`sendMemory.ts`):
   * queueing five prompts *when it's free* used to mean re-arming the chevron
   * five times, because the mode reset to `now` after every send.
   *
   * The bug that killed the FIRST per-repo memory (`waterplane.sendMode`) was
   * invisibility, not memory: it armed the button with a wall clock and said so
   * nowhere. What comes back is the half that can be seen — a repo left in
   * *when it's free* says `When free` on the button face before it is tapped,
   * and a CLOCK never reaches this control at all (`reusableMode`). Two modes,
   * and everything else is ONE errand into the Send sheet. The words are
   * `composeSend.ts`'s and tested there.
   */
  const [sendMode, setSendMode] = useState<SendMode>("now");
  /**
   * **WHERE the next message runs.** Recalled per repo like the mode
   * (`recallWhere`), and never invisible: for as long as it is not `this`, the
   * aim line above the composer says where the words are going and carries the
   * one tap that puts them back.
   */
  const [sendWhere, setSendWhere] = useState<SendWhere>("this");
  /**
   * Which session `other` means. NOT persisted and not remembered per repo — a
   * session id dies with the desktop's process (`reusableWhere`).
   */
  const [sendWhereSid, setSendWhereSid] = useState<string | null>(null);
  const [sendMenu, setSendMenu] = useState(false);
  /** What the pipe box was last known to hold — see `decodePipe`. */
  const pipePrev = useRef(PIPE_PAD);
  // The session the current compose text belongs to, so switching sessions saves
  // the outgoing draft under the RIGHT id before loading the incoming one.
  const composeSessionRef = useRef<string | null>(null);

  /** CLI mode is a raw pipe into a PTY. A session that has none is composing,
   *  whatever the toggle was left on — the setting is remembered, not applied.
   *  So is the reader: the grid those keystrokes land in is not on screen
   *  there, so typing into it is typing blind. Switching back to the terminal
   *  puts the mode back, draft intact. */
  // A held modifier (`useChord`) makes the box a key pipe for the next key, so
  // the letter that goes with Ctrl never lands in the draft.
  const chord = useChord(sendInput);
  const cliMode = (cliModeOn || chord.armed) && !pending && !readerShown;
  // Whether the box had the caret before a modifier armed it: a one-shot chord
  // that RAISED the keyboard puts it away again, so the key row comes back
  // (typing room hides it while the box is focused).
  const chordFocusedBefore = useRef(false);
  /** A modifier key's tap. Focus happens HERE, inside the gesture — iOS raises
   *  the keyboard only for a focus in the user event. */
  function tapChordMod(m: ChordMod) {
    if (!chord.armed && !cliModeOn) {
      chordFocusedBefore.current = document.activeElement === composeRef.current;
      pipePrev.current = PIPE_PAD;
      chord.tapMod(m);
      focusPipe();
      return;
    }
    chord.tapMod(m);
  }
  const chordWasArmed = useRef(false);
  useEffect(() => {
    if (chord.armed) { chordWasArmed.current = true; pipePrev.current = PIPE_PAD; return; }
    if (!chordWasArmed.current) return;
    chordWasArmed.current = false;
    if (!cliModeOn && !chordFocusedBefore.current) composeRef.current?.blur();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chord.armed]);
  // A held key belongs to the screen it was armed on: a session switch, the
  // reader or a pending session (where the row and the "held" bar are not
  // drawn) lets go, rather than firing on the first key typed somewhere else.
  useEffect(() => {
    chord.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, pending, readerShown]);
  /** The `+ later` screen (`isLaterId`): no session until its backlog item runs. */
  const later = isLaterId(activeId);

  // ── Compose durability: drafts (unsent) + outbox (sent, awaiting ack) ──
  // Persist the draft under its owning session on every change. Guarded by the
  // owner ref so the transient render right after a session switch (compose still
  // holds the OLD text, activeId already NEW) can't clobber the new session's draft.
  useEffect(() => {
    const owner = composeSessionRef.current;
    if (owner && owner === activeId) saveDraft(owner, compose);
  }, [compose, activeId]);
  // Switching sessions → load that session's saved draft into the box.
  useEffect(() => {
    if (!activeId) { composeSessionRef.current = null; return; }
    composeSessionRef.current = activeId;
    setCompose(loadDraft(activeId));
    setSendMenu(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setCompose is the draft hook's useState setter (stable)
  }, [activeId]);
  /**
   * The armed mode follows the REPO (`sendMemory.ts`), not the message.
   *
   * Keyed on the cwd rather than on `activeId` on purpose: a session attached
   * before its list arrives has no cwd for one render, and an effect that had
   * already run on the id would leave the button saying `Send` for a repo that
   * is set to *when it's free*.
   */
  useEffect(() => {
    // `+ later`: there is no session on screen to aim at, and nothing to
    // remember — the screen exists to queue a NEW session for when it's free.
    if (later) { setSendMode("idle"); setSendWhere("new"); setSendWhereSid(null); return; }
    setSendMode(recallMode(sendMemRef.current, active?.cwd));
    // The aim follows the repo too, and the session `other` named does NOT:
    // it belonged to the repo you were in, and carrying it across would aim
    // this repo's next prompt at a conversation in another one.
    setSendWhere(recallWhere(sendMemRef.current, active?.cwd));
    setSendWhereSid(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendMemRef is a ref; the repo is the key
  }, [active?.cwd, later]);

  /**
   * The compose bar's microphone, aimed at THIS session's draft.
   *
   * `key` is the session id because a held recording can land after the person
   * has walked to another session: these words were said about the one that was
   * on screen, and writing them into a different conversation's draft is worse
   * than parking them. The queue sends them to the pad instead, and says so.
   */
  const voice = useVoice({
    read: () => composeNow.current,
    write: (txt) => setCompose(txt),
    key: () => activeIdRef.current ?? "",
  });

  /**
   * **Add words to session `sid`'s draft** — the box when that session is the
   * one on screen, else its STORED draft, which the load effect reads when the
   * screen comes up. An APPEND either way (`local/no-draft-clobber`).
   *
   * Why not `insert`: a caller that has just navigated (an `attach`, an
   * `openCwd` onto a pending screen) typed into the box it was LEAVING — the
   * load effect then replaced the box with the new session's saved draft and
   * the words were gone (`continueImageInSession`'s *new session · <path>*).
   */
  // `ownLine`: joined to words already there by a newline, not a space — a
  // command for a shell (`lineToShell`) glued onto a half-typed one is a
  // different command.
  function seedDraft(sid: string, text: string, opts: { ownLine?: boolean } = {}): SeedOutcome {
    // Seeded words are for the person to read and send: CLI mode hides the box
    // behind the raw-keys pad, so the mode is left (the caller says so).
    const leftCli = cliModeOn;
    if (cliModeOn) { setCliModeOn(false); pipePrev.current = PIPE_PAD; }
    chord.clear();
    const onScreen = activeIdRef.current === sid;
    const cur = onScreen ? draft.composeNow.current : (loadDraft(sid) ?? "");
    // The same words twice (a second tap on the same button) are one copy, not two.
    const already = text.trim() !== "" && cur.includes(text.trim());
    const joined = cur.trim() !== "";
    if (already) return { leftCli, already, joined };
    if (opts.ownLine) {
      const next = joined ? `${cur.replace(/\s+$/, "")}\n${text}` : text;
      if (onScreen) draft.setCompose(next); else saveDraft(sid, next);
    } else if (onScreen) draft.insertCompose(text);
    else saveDraft(sid, cur ? `${cur}${cur.endsWith(" ") ? "" : " "}${text}` : text);
    return { leftCli, already, joined };
  }

  /** `core.compose.typeOn`: one key of the demo's typing — only onto exactly
   *  what the last key left, so a person's words stop it (`local/no-draft-clobber`). */
  function typeOn(from: string, to: string): boolean {
    if (draft.composeNow.current !== from) return false;
    draft.composeNow.current = to;
    draft.setCompose(to);
    return true;
  }

  /**
   * **A password asked for on screen** (`secretAsk.ts`, off the cursor line).
   *
   * While one is up the bar swaps the draft box for a masked field whose
   * words live HERE and nowhere else: never in `compose` (so never saved as a
   * draft), never `pushHistory`'d, never an outbox row. They go as raw keys
   * (`sendInput`, the CLI pipe's own path) — a password is an answer to a
   * prompt that is waiting NOW; queued behind a dead link it would be typed
   * into whatever is on screen when the link comes back, so offline refuses.
   * `secretDismissed` is the ask the person said is not one, until it goes.
   */
  const [secretLine, setSecretLine] = useState<string | null>(null);
  const [secretDismissed, setSecretDismissed] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [secretShown, setSecretShown] = useState(false);
  function noteCursorLine(line: string) {
    const ask = secretAsk(line);
    setSecretLine(ask);
    if (!ask) { setSecret(""); setSecretShown(false); setSecretDismissed(null); }
  }
  // A new screen has not reported its cursor yet: no ask carried across.
  useEffect(() => { setSecretLine(null); setSecret(""); setSecretShown(false); setSecretDismissed(null); }, [activeId]);
  // A shell only: claude's own screen draws typed words on its cursor line, so
  // a prompt ending "password:" would read as an ask there.
  const secretAskLine = secretLine && secretLine !== secretDismissed && !pending && !cliMode
    && isShellBackend(null, active?.backend) ? secretLine : null;
  function dismissSecret() { if (secretLine) setSecretDismissed(secretLine); setSecret(""); setSecretShown(false); }
  // A filler (`SecretFillerDef`, a stored login) answers after a sheet and a
  // fingerprint: it lands only while the SAME ask is still up in the SAME
  // session, read live at landing — never on whatever is on screen by then.
  const secretAskRef = useLatest(secretAskLine);
  function secretFillContext(): SecretFillContext | null {
    const sessionId = activeIdRef.current;
    const askLine = secretAskRef.current;
    if (!sessionId || !askLine) return null;
    return {
      sessionId, askLine,
      fill(value: string) {
        if (!value || activeIdRef.current !== sessionId || secretAskRef.current !== askLine) return false;
        setSecret(value);
        setSecretShown(false);
        return true;
      },
    };
  }
  function sendSecret() {
    if (!active) return;
    if (!secret) { showToast("type the password first — Send types it into the prompt"); return; }
    if (connRef.current.status !== "open") { showToast("link is down — a password is never queued; send it once the link is back"); return; }
    track("action:compose.secret.send");
    sendInput(`${secret}\r`);
    setSecret("");
    setSecretShown(false);
  }

  /** The raw key pipe. A session that has not been created has no PTY to
   *  receive a keystroke, and a `session.input` naming a lane id would be
   *  dropped host-side with nothing said — so say it here instead. Deliberately
   *  NOT durable: live navigation of what is on screen right now. An ANSWER is
   *  never one of these — it goes through `answerPrompt`. */
  function sendInput(data: string) {
    if (!active) return;
    if (pending) { showToast("no terminal yet — keys reach the CLI once the session opens"); return; }
    send({ t: "session.input", id: active.id, data });
  }

  /** Step to an older (dir<0) / newer (dir>0) sent command in the compose box. */
  function stepHistory(dir: -1 | 1) {
    if (cmdHistory.length === 0) return;
    setClearArmed(false);
    if (histIdx === -1) {
      if (dir > 0) return; // already on the live draft — nothing newer
      histStash.current = compose; // remember the draft we're leaving
      const idx = cmdHistory.length - 1;
      setHistIdx(idx);
      setCompose(cmdHistory[idx]);
      return;
    }
    const idx = histIdx + dir;
    if (idx < 0) { setHistIdx(0); setCompose(cmdHistory[0]); return; } // clamp at oldest
    if (idx >= cmdHistory.length) { setHistIdx(-1); setCompose(histStash.current); return; } // back to draft
    setHistIdx(idx);
    setCompose(cmdHistory[idx]);
  }
  /** Clear the compose box. First tap arms; second (within the armed window) clears. */
  function clearCompose() {
    if (!clearArmed) { setClearArmed(true); showToast("Tap clear again to wipe the message box"); return; }
    setCompose("");
    setHistIdx(-1);
    histStash.current = "";
    setClearArmed(false);
  }
  /** Append a snippet's text to the compose box (newline-separated if non-empty). */
  function appendSnippet(s: Snippet) {
    setCompose((c) => (c && !/\s$/.test(c) ? c + "\n" : c) + s.text);
    setHistIdx(-1);
    setClearArmed(false);
    setSnippetOpen(false);
    composeRef.current?.focus();
  }
  /** Put the caret in the box, and with it the on-screen keyboard. Tapping the
   *  toggle (or, in CLI mode, the terminal itself) is the gesture for "let me
   *  type at the CLI", so it has to raise the keyboard by itself. */
  function focusPipe() {
    const el = composeRef.current;
    if (!el) return;
    el.focus();
    // The caret belongs after the pad: `decodePipe` reads an append as typing
    // and a shortened value as backspaces, and both assume the end of the box.
    try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not focusable yet */ }
  }
  /**
   * Flip between composing (queue, ack, echo-checked delivery) and driving the
   * CLI directly (raw keystrokes, nothing remembered).
   *
   * The compose draft is untouched on the way in — the box shows the pad while
   * the mode is on, `compose` state keeps the words, and leaving CLI mode puts
   * them back. Losing a half-written prompt to a mode toggle would make the
   * toggle something you think twice about.
   */
  function toggleCliMode() {
    const on = !cliModeOn;
    track(on ? "action:cli.on" : "action:cli.off");
    chord.clear();
    setCliModeOn(on);
    pipePrev.current = PIPE_PAD;
    if (on) {
      focusPipe();
      showToast(connRef.current.status === "open"
        ? "CLI mode — keys go straight to the session; full screen while the keyboard is up (corner button brings the header back)"
        : "CLI mode — link is down, so keystrokes are NOT queued");
    }
  }
  /**
   * CLI mode: an edit in the box is keystrokes for the PTY, not text to send.
   *
   * The DOM value is reset SYNCHRONOUSLY rather than through state: React would
   * restore it after the event anyway, but two input events landing before that
   * restore would both be measured against the pad and double-count backspaces.
   * Mid-IME composition is left alone — a half-composed word is not yet a
   * keystroke, and `compositionend` runs the same diff over the finished one.
   */
  function onPipeInput(e: ChangeEvent<HTMLTextAreaElement>) {
    // Mid-composition the baseline is deliberately NOT advanced: `compositionend`
    // diffs the finished word against the pad and sends it whole.
    if ((e.nativeEvent as InputEvent).isComposing) return;
    flushPipe(e.target);
  }
  function flushPipe(el: HTMLTextAreaElement) {
    const bytes = decodePipe(pipePrev.current, el.value);
    pipePrev.current = PIPE_PAD;
    el.value = PIPE_PAD;
    if (bytes) chord.sendTyped(bytes);
  }
  /** Keys the text diff cannot see (Return, Tab, Esc, arrows, ^C from a
   *  hardware keyboard). `keyToBytes` returning bytes means we own the event —
   *  letting Return through as well would insert a newline AND send `\r`. */
  function onPipeKey(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const bytes = keyToBytes(e);
    if (!bytes) return;
    e.preventDefault();
    const named = NAMED_KEY[e.key];
    if (chord.armed && named) chord.sendKey(named, bytes); else sendInput(bytes);
  }
  /** Return in the compose box = send, when `enterSends` is on.
   *  Modifier+Return always inserts a newline (the default action), and an IME
   *  composition Return (Japanese/Chinese candidate pick) must never submit. */
  function onComposeKey(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter sends whatever `enterSends` says — the desktop habit from
    // every other chat box, and the one way to send with Enter set to newline.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (compose.trim() || besidePicture()) sendCompose();
      return;
    }
    if (e.key !== "Enter" || !enterSends) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (!compose.trim() && !besidePicture()) return;
    sendCompose();
  }
  /**
   * **The session the compose bar is aimed at, or the reason it is not.**
   *
   * One reader for the send, the aim line and the *elsewhere* errand, so the
   * sentence on screen and the place the words land cannot be two answers. A
   * refusal is returned rather than thrown: it becomes a toast with the words
   * left in the box.
   */
  function composeAim(): { target: Extract<SendTarget, { kind: "session" } | { kind: "repo" }> } | { refuse: string } {
    if (!active) return { refuse: "" };
    if (sendWhere === "new") return { target: { kind: "repo", cwd: active.cwd } };
    if (sendWhere === "other") {
      if (!sendWhereSid) return { refuse: WHERE_UNPICKED_TOAST };
      const s = sessions.find((x) => x.id === sendWhereSid && x.running);
      // It closed while it was armed. Never silently fall back to the session
      // on screen: that is a different answer to the question somebody asked.
      if (!s) return { refuse: whereGoneToast(sessions.find((x) => x.id === sendWhereSid)?.title ?? null) };
      return { target: { kind: "session", sessionId: s.id, cwd: s.cwd } };
    }
    return { target: { kind: "session", sessionId: active.id, cwd: active.cwd } };
  }
  /** The aim, back on the session you are looking at. Used by the aim line's
   *  one tap and by every refusal that had nowhere left to point. */
  function aimHere(): void {
    if (later) return;
    setSendWhere("this");
    setSendWhereSid(null);
    noteSendAim(active?.cwd, { where: "this" });
  }
  /** The session `other` names right now, for the aim line and the strip. */
  const aimedSession = sendWhere === "other" && sendWhereSid
    ? sessions.find((s) => s.id === sendWhereSid && s.running) ?? null
    : null;

  /**
   * The compose bar's primary button: send it to this session, now — or, with
   * the chevron on *when it's free*, hand it to the DESKTOP as a work item
   * pinned to this session. `mode` overrides the chevron's choice for THIS
   * send (the upload row's two one-tap verbs); it is not a setter.
   *
   * The phone still holds the one wait the desktop cannot: a session that does
   * not EXIST yet has no id for a pinned item to name, and a LOCAL command
   * (`/usage`) opens a view and starts no turn, so a pinned item watching for
   * one would never settle.
   */
  function sendCompose(mode?: SendMode, pictureAsked = false, busyPick?: SendMode, pastBudget = false, budgetAsked = false, restartAsked = false) {
    // A picture open on the annotator beside this box: ask whether it goes
    // too, every time — sending the words alone and leaving the marked picture
    // behind is the mistake this exists for. Yes is the annotator's own Send &
    // run (or its when-free twin), which submits the box once the bytes land.
    const picture = !pictureAsked && active && sendWhere === "this" ? besidePicture() : null;
    if (picture) {
      const how = mode ?? sendMode;
      void askConfirm({
        title: "Send the picture too?",
        lines: [
          "With the picture: the marked picture goes up and this message is sent with its path, once it lands.",
          compose ? "Text only: just the words — the picture stays open to finish." : "The message box is empty, so without it there is nothing to send.",
        ],
        confirmLabel: "With the picture", cancelLabel: "Text only", tone: "info",
      }).then((yes) => {
        if (yes) { track("action:compose.send.picture"); picture(how === "idle" ? "queue" : "run"); }
        else sendCompose(mode, true);
      });
      return;
    }
    if (!active || !compose) return;
    // Only while a picture is still being READ. Past that the path is in the
    // text and the lane orders the prompt behind the bytes on its own.
    if (parkingRef.current > 0) { showToast("still reading that picture — Send goes the moment it is readable"); return; }
    // The plain Send on a session whose turn is still running: ask whether the
    // words go into that turn now or wait for it (`busySendRoute`). A tap
    // outside keeps them in the box.
    const routed = busySendRoute({
      how: busyPick ?? mode ?? sendMode, explicit: mode !== undefined || busyPick !== undefined, aimedHere: sendWhere === "this",
      turnActive: !!active.turnActive, pending, localCmd: isLocalCommand(compose), pref: busySend.current,
    });
    if (routed === "ask") {
      // The budget's own sentence, only while it is holding automatic work —
      // the third answer is offered exactly then (`busySendAsk`).
      const budget = deps.queue.budget;
      void askChoice(busySendAsk(budget?.verdict.blocked ? budgetReasonText(budget.verdict) : null)).then((r) => {
        if (!r) return;
        const pick: SendMode = r.ok ? "now" : "idle";
        track(r.alt ? "action:compose.busy.pastbudget" : `action:compose.busy.${pick}`);
        // Remembers the MODE only: a waiver is about this one prompt.
        if (r.remember) { setPref("busySend", pick); showToast(busySendRememberedToast(pick)); }
        sendCompose(undefined, true, pick, !!r.alt);
      });
      return;
    }
    const how = mode ?? routed;
    // A HARD session budget, past its cap: this person's own send asks first
    // (`hardSendAsk`). Yes runs that one turn — the desktop grants it on
    // delivery — and a tap outside keeps the words in the box. Soft budgets
    // never ask; a local command starts no turn; `when it's free` is held by
    // the desktop's budget rung already.
    const budget = active.budget;
    if (!budgetAsked && how === "now" && sendWhere === "this" && budget?.cfg.hard && sessionBudgetHeld(active) && !isLocalCommand(compose)) {
      void askConfirm(hardSendAsk(sessionBudgetText(budget.verdict))).then((yes) => {
        track(yes ? "action:compose.hardbudget.send" : "action:compose.hardbudget.keep");
        if (yes) sendCompose(mode, true, how, pastBudget, true);
      });
      return;
    }
    // The bar's CLI restart, asked at the cheapest moment there is: nothing is
    // running, and this prompt is about to start a turn on the old binary —
    // after which the next chance is when that turn ends (`cliRestartSendAsk`).
    // Yes relaunches the same conversation with these words as its first
    // prompt, one op; the other answer sends here and is not asked again for
    // that version. A tap outside keeps the words in the box.
    const due = !restartAsked && how === "now" && sendWhere === "this" && !pending && !isLocalCommand(compose)
      ? cliRestartDue(active.cliVersion, deps.cliInstalled) : null;
    const restartKey = due ? `${active.id}|${due.installed}` : "";
    if (due && !restartOfferClosed(active.id, due.installed) && !restartPassed.has(restartKey)) {
      const v = cliRestartView(due, {
        turnActive: active.turnActive, agents: active.agents?.length, shells: active.shells, resumeId: resumeIdOf(active),
      });
      if (!v.cant && !v.loses) {
        const cur = active;
        void askChoice({ ...cliRestartSendAsk(due), tone: "info" }).then((r) => {
          if (!r) return;
          if (!r.ok) {
            track("action:compose.restart.sendOld");
            restartPassed.add(restartKey);
            sendCompose(mode, true, how, pastBudget, true, true);
            return;
          }
          track("action:compose.restart.thenSend");
          const text = compose;
          deps.relaunch(cur, {}, { prompt: text });
          pushHistory(text);
          setCompose("");
          afterSend();
        });
        return;
      }
    }
    // What the button stays armed with afterwards: an answer to the busy ask
    // is about THIS message, never a new mode for the repo.
    const armed = mode ?? sendMode;
    track(`action:compose.send.${how}`);
    const text = compose;
    const online = connRef.current.status === "open";
    /**
     * **Aimed somewhere else ⇒ one intent, onto the paths that already exist.**
     * `dispatchIntent` is the one function that maps WHEN and WHERE onto send
     * paths — the same one the send sheet's button calls — and every arm in
     * there toasts what it did, which is why nothing is said here. Before the
     * local-command branch: the phone-held park is about the session on screen.
     */
    if (sendWhere !== "this") {
      const aim = composeAim();
      if ("refuse" in aim) {
        if (aim.refuse) showToast(aim.refuse);
        // A session that has gone leaves the aim pointing at nothing; put it
        // back on this one so the next tap is not a second refusal.
        if (sendWhere === "other" && sendWhereSid) aimHere();
        return;
      }
      const cwd = aim.target.cwd;
      if (!dispatchIntent(
        { prompts: [text], target: aim.target, when: how === "idle" ? { kind: "idle" } : { kind: "now" }, sequential: false },
        { prompts: [text], target: aim.target, cwdHint: cwd, repoId: repoForCwd(cwd)?.id ?? null, origin: active.title },
      )) return;
      pushHistory(text);
      setCompose("");
      // `+ later` is done once its row is posted: back to where it was opened
      // from, the row now on the repo's chips. Nothing remembered — that aim
      // is the screen's, not the repo's.
      if (later) { afterSend(); deps.leave(); return; }
      // The aim is remembered per repo exactly as the mode is — `other` is
      // dropped on the way in (`reusableWhere`).
      noteSendAim(active.cwd, { mode: armed, where: sendWhere });
      setSendMode(armed);
      afterSend();
      return;
    }
    const localCmd = isLocalCommand(text);
    // A pending session is the phone's to hold; a live one is the desktop's.
    const holder: "desktop" | "phone" = how === "idle" && !pending && !localCmd ? "desktop" : "phone";
    if (how === "idle" && holder === "desktop") {
      const offline = queueBacklog({
        text: text.trim(), repoDir: active.cwd, label: text.trim().slice(0, 40),
        targetSessionId: active.id, autoFire: true,
        ...(pastBudget ? { pastBudget: true } : {}),
      });
      // null = refused (it names an upload that will never arrive). The words
      // stay in the box: `guardUploadRefs` has already said which file and why.
      if (offline === null) return;
      pushHistory(text);
      setCompose("");
      const queued = pastBudget ? busyPastBudgetToast(!offline) : sendModeToast("idle", { online: !offline, holder });
      if (queued) showToast(queued);
      // The mode STAYS armed and is remembered for this repo.
      noteSendAim(active.cwd, { mode: armed });
      setSendMode(armed);
      afterSend();
      return;
    }
    if (!submitInput(active.id, active.cwd, text, text.trimStart().startsWith("/") ? "command" : "prompt", how === "idle")) return;
    pushHistory(text);
    setCompose(""); // draft is cleared by the compose effect; text now lives in the outbox until acked
    const said = sendModeToast(how, { online, holder, phoneHold: localCmd ? "opens-a-view" : "session-not-open" });
    if (said) showToast(said);
    if (readerShown && how !== "idle" && answeredOnlyInCli(text)) offerCliForBtw();
    // Per REPO, and visible on the button: the next prompt starts where this
    // one was aimed (`sendMemory.ts`).
    noteSendAim(active.cwd, { mode: armed });
    setSendMode(armed);
    afterSend();
  }
  /** A send that went: drop the phone keyboard unless this device keeps it up. */
  function afterSend() {
    if (closeKbOnSend.current) composeRef.current?.blur();
  }
  /**
   * The same words, with the other three answers opened up.
   *
   * The box is deliberately NOT cleared: nothing has been posted until the
   * sheet's own button is pressed, and clearing here would lose the prompt on a
   * cancel. It IS cleared when the send goes (`onPosted`).
   */
  function openComposeSend() {
    if (!active) return;
    track("action:compose.options");
    // How this repo was last sent — a wall-clock rule included, which is the
    // one answer the split button may not carry; SAID in the origin line
    // (`recalledWhenNote`) because the WHEN row opens collapsed.
    const recalled = recallWhen(sendMemRef.current, active.cwd, Date.now());
    // Seeded to the aim the strip is ON, not to the session on screen. An
    // `other` aim whose session has gone falls back here rather than refusing.
    const aim = composeAim();
    const from = active.id;
    const words = compose;
    openSend({
      prompts: compose ? [compose] : [""],
      target: "target" in aim ? aim.target : { kind: "session", sessionId: active.id, cwd: active.cwd },
      cwdHint: active.cwd,
      repoId: repoForCwd(active.cwd)?.id ?? null,
      ...(recalled ? { when: recalled } : {}),
      origin: recalled && recalled.kind !== "now"
        ? `${active.title} · ${recalledWhenNote(repoForCwd(active.cwd)?.repoName ?? baseName(active.cwd))}`
        : active.title,
      // Clears the draft the sheet was opened FROM, never whichever box is up
      // when it posts: the seed outlives the overlay (the annotator round trip
      // lands back on `send`), so by then another session may be on screen.
      onPosted: () => {
        // A `+ later` screen whose words are posted has nothing left to do.
        if (activeIdRef.current === from) { setCompose(""); if (isLaterId(from)) deps.leave(); return; }
        if (loadDraft(from) === words) saveDraft(from, "");
      },
    });
  }
  /**
   * **The answer that is not a send: keep the words, run nothing.**
   *
   * A pad note has no target and no trigger: nothing in this app ever looks at
   * it until a person opens the pad. The repo rides along (`cwd`) — the one the
   * words were AIMED at — because that is what makes PadSheet's *file it*
   * reachable later. A refusal leaves the box EXACTLY as it is: the words in the
   * composer are the only copy.
   */
  function keepOnPad() {
    const text = compose.trim();
    if (!text) { showToast(PAD_EMPTY_TOAST); return; }
    track("action:compose.pad");
    const aim = composeAim();
    const cwd = "target" in aim ? aim.target.cwd : active?.cwd;
    const why = addPadNote({
      id: padNoteId(), text, ts: Date.now(),
      ...(cwd ? { cwd } : {}),
    });
    if (why) { showToast(why); return; }
    pushHistory(compose);
    setCompose("");
    showToast(PAD_KEPT_TOAST);
  }
  /**
   * Fire a header command chip into the active session.
   *
   * Same durable path as the compose box (`submitInput` → outbox → ackId), NOT
   * a bare socket write: a chip tapped on a dead tunnel is exactly the case the
   * send queue exists for. Deliberately NOT gated on the upload wait — a header
   * command carries no attachments.
   */
  function runHeaderCmd(c: HeaderCmd) {
    if (!active) return;
    track("action:hdrcmd.send");
    const text = c.text;
    if (!submitInput(active.id, active.cwd, text, text.trimStart().startsWith("/") ? "command" : "prompt")) return;
    pushHistory(text);
    // The chip is a single tap with no keyboard and, in reader view, no visible
    // echo — say what happened, and say it honestly when the link is down.
    showToast(connRef.current.status === "open" ? `sent ${c.title}` : `queued ${c.title} — sends when the link is back`);
  }

  return {
    ...draft,
    sendMode, setSendMode, sendWhere, setSendWhere, sendWhereSid, setSendWhereSid, sendMenu, setSendMenu,
    cliMode, enterSends, voice, aimedSession, noteSendAim,
    chord, tapChordMod, sendInput, stepHistory, clearCompose, appendSnippet, focusPipe, toggleCliMode, onPipeInput, flushPipe, onPipeKey,
    onComposeKey, aimHere, sendCompose, openComposeSend, keepOnPad, runHeaderCmd, seedDraft, typeOn,
    sendNow: () => sendCompose("now"),
    secretAskLine, secret, setSecret, secretShown, setSecretShown, noteCursorLine, dismissSecret, sendSecret, secretFillContext,
  };
}
export type ComposeApi = ReturnType<typeof useCompose>;
