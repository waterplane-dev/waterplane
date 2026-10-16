/**
 * The session screen's middle: what the backend cannot do (the cants strip),
 * the terminal or the reader with the connection banner floating over it, the
 * explanations drawn over an empty or dead terminal, the corner group, and the
 * strips under it — sign-in, the reply suggestion, the special-key row and the
 * new-images strip.
 *
 * Lifted out of App's session screen unchanged. The PTY bytes are the term
 * core's (`useTermFeed`, buffer-by-ref + `writeSeq`); every word this sends is
 * the queue's (`submitInput`, `answerPrompt`) or a raw key through the compose
 * core's `sendInput` — no new send path.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookOpen, ChevronLeft, CloudOff, CornerDownLeft, GripVertical, Hourglass, Loader2,
  List, Maximize2, Minimize2, Radar, RotateCw, ScrollText, Terminal as TerminalIcon, X,
} from "lucide-react";
import { blockedReasonText, promptFingerprint, sessionCostOf } from "@waterplane/shared";
import type { BackendInfo, SessionInfo } from "@waterplane/shared";
import { api } from "../../api";
import { backendIdOf, isShellBackend, sessionCants, shellQuietLine } from "../../backendCaps";
import { ago } from "../../format";
import { LoginBar } from "../../LoginBar";
import { ShellLinksBar } from "../../ShellLinksBar";
import { hasShellBar } from "../../shellLinks";
import { ZoomPair } from "../../ZoomPair";
import { sized } from "../../media";
import { ReplyBar } from "../../ReplyBar";
import { CliSuggestion } from "../../CliSuggestion";
import { absorb as absorbScreenLog, hasScrollback } from "../../screenlog";
import { resumeHint, resumeIdOf } from "../../sessionFacts";
import { TerminalView } from "../../Terminal";
import { showToast } from "../../toast";
import { TranscriptView } from "../../TranscriptView";
import { CliPeek } from "./CliPeek";
import { PromptAnswer } from "../../PromptAnswer";
import { termAnswersBox } from "./termAnswers";
import { ModelWheel } from "./ModelWheel";
import { ModeGlyph } from "./ModeSection";
import { badgeMode, modeTitle } from "../../modePick";
import { tallyTitle, turnTally } from "../sessions/tags";
import { TermCostStrip } from "../../TermCostStrip";
import { nextReaderZoom, nextTermZoom, readerScale } from "../../uiScale";
import { track } from "../../usage";
import { Unavailable } from "../../Unavailable";
import type { Connection } from "../conn/useConnection";
import type { TermFeed } from "../term/useTermFeed";
import type { QueueApi } from "../queue/useQueue";
import { isLaterId } from "../queue/logic.ts";
import type { ComposeApi } from "../compose/useCompose";
import type { Launch } from "../launch/useLaunch";
import { keepFocus } from "../compose/ComposeBar";
import { fullScreenTap } from "../../chromeMode";
import { applyReaderZoom, applyTermZoom, usePref } from "../prefs";
import { NewImagesStrip, openFileRef } from "../../features/images";
import { copyCode, copyLink, openLink } from "../../features/clipboard";
import { pasteLoginCode } from "../../features/hostTools";
import { openScrollback } from "../../features/scrollback";
import { openContext } from "../../features/context";
import { useWeekIncl, useWeekUsdPerPct } from "../../features/tokens";
import { openShellsFor } from "../../features/shells";
import { openLogins } from "../../features/shellLogins";
import { DemoHookCard, DemoHookHint } from "../../features/demoTour";
import type { SessionChrome } from "./useSessionChrome";
import { useTermPick } from "./useTermPick";
import { useReaderPick } from "./useReaderPick";
import { useCornerDrag } from "./useCornerDrag";
import { OVER_TERMINAL, startStrayKeys } from "./strayKeys";

const ICON = 16;

/** Actively blur the compose box so a tap can't re-summon the on-screen keyboard.
 * preventDefault keeps the tapped button from taking focus; the blur dismisses
 * (and keeps dismissed) the keyboard for TUI-navigation keys. */
const blurCompose = (e: ReactPointerEvent) => {
  e.preventDefault();
  (document.activeElement as HTMLElement | null)?.blur();
};

// `nav` keys (arrows) are TUI navigation used while NOT typing. They must not
// hold compose focus — on Android a still-focused (but keyboard-dismissed)
// textarea re-summons the on-screen keyboard on any focus-preserving tap. So
// arrows blur the compose box instead; the rest keep focus for mid-typing use.
// `title` is what a long press explains (`hints.ts` falls back to it) and the name a screen
// reader says: four of these are bare glyphs, which explained nothing.
const SPECIAL_KEYS: { label: ReactNode; title: string; data: string; nav?: boolean }[] = [
  { label: "Esc", title: "Esc — close a menu or interrupt claude", data: "\x1b" }, { label: "Tab", title: "Tab — complete", data: "\t" },
  { label: <ArrowUp size={ICON} />, title: "up — move the selection in a box", data: "\x1b[A", nav: true },
  { label: <ArrowDown size={ICON} />, title: "down — move the selection in a box", data: "\x1b[B", nav: true },
  { label: <ArrowLeft size={ICON} />, title: "left", data: "\x1b[D", nav: true }, { label: <ArrowRight size={ICON} />, title: "right", data: "\x1b[C", nav: true },
  { label: "^C", title: "Ctrl-C — cancel", data: "\x03" }, { label: <CornerDownLeft size={ICON} />, title: "Return — confirm the selection", data: "\r" },
];

/** Each hook's members this area reads — `Pick<>`s, like `LauncherProps`, so
 *  what the screen depends on is stated rather than "the whole hook". */
export interface TermAreaProps {
  active: SessionInfo;
  pending: boolean;
  conn: Pick<Connection, "status" | "connVisible" | "send" | "info" | "liveAsk">;
  term: Pick<TermFeed, "termRef" | "geomRef" | "buffers" | "lastPtyAt" | "ptyTail" | "exitedRef" | "staleAt" | "writeSeq"
    | "termNonce" | "readMode" | "setView" | "readerCmd" | "outlineJump" | "transcriptNonce">;
  q: Pick<QueueApi, "entries" | "pendingEntry" | "answerPrompt" | "retryPendingCreate" | "submitInput" | "blocked">;
  compose: Pick<ComposeApi, "cliMode" | "sendInput" | "focusPipe" | "toggleCliMode" | "noteCursorLine">;
  launch: Pick<Launch, "sessionCan" | "openCwd" | "runForkRequest" | "relaunch" | "setLaunchOpt">;
  chrome: SessionChrome;
  backends: BackendInfo[] | null;
  /** Whether the READER is the thing on screen (App's `readerShown`). */
  readerShown: boolean;
  /** How many header chips were withheld as slash commands (`splitHeaderCmds`). */
  hiddenSlash: number;
  activeRepoId: string | null;
  /** What is in this repo's inbox/outbox, read while the reader is up (`transportIndex.ts`). */
  transportKnown: readonly string[] | undefined;
  setActiveId(id: string | null): void;
  closeSession(s: SessionInfo): void;
  /** Opens the outline — present only while the `outline` toolbar item is pinned. */
  openOutline?: () => void;
}

/**
 * The surface's own controls, drawn ON it in the top-right corner: full
 * screen, then the zoom pair. The terminal and the reader both get them —
 * "I want to see more of this" is the same question about either.
 *
 * It was a toolbar item first, and that was wrong twice over. The toolbar is
 * collapsed behind a burger by default on a phone, so the control for "I
 * cannot see enough" lived inside a closed menu; and it is a row you scroll
 * sideways, so using it meant losing sight of the thing being resized —
 * which is the only feedback this setting has.
 *
 * FLOATING, never in the flex column, for the connection banner's reason: a
 * strip in flow takes height off the terminal, a terminal that changes height
 * refits, and a refit SIGWINCHes the PTY, which the claude TUI answers by
 * clearing and repainting the whole screen. A control whose job is to resize
 * the grid must not resize it by existing.
 *
 * It is a SIBLING of `.term-canvas`, not a child, so a tap here is not also
 * the canvas's "let me type here" tap in CLI mode.
 *
 * NO SIZE ON IT. A "10px" pill sat between the buttons for a build, and it
 * was answering a question nobody standing in front of a terminal has: the
 * text got smaller, which you can see, and the number it got smaller TO is
 * not something to act on. Over live output it is one more thing in the way.
 * The pixel figure is still on the Appearance row, where a setting is being
 * read rather than used.
 *
 * What survives is the END of the ladder, as a word — because there the
 * button itself is gone (`Unavailable.tsx`: never a dimmed one) and a control
 * that disappears without saying so is the thing that rule exists to stop.
 */
function ScreenCorner({ zoom: zoomOn, active, pending, readerShown, readMode, setView, sessionCan, chrome, wheel, openOutline }: {
  zoom?: boolean;
  openOutline?: () => void;
  active: SessionInfo;
  pending: boolean;
  readerShown: boolean;
  readMode: boolean;
  setView(read: boolean): void;
  sessionCan: Launch["sessionCan"];
  chrome: SessionChrome;
  /** What the model wheel needs to land a pick — `ModelSheet`'s two paths. */
  wheel: Pick<Launch, "relaunch" | "setLaunchOpt"> & Pick<QueueApi, "submitInput"> & Pick<Connection, "liveAsk">
    & { backends: BackendInfo[] | null };
}): ReactNode {
  const [wheelOpen, setWheelOpen] = useState(false);
  const corner = useCornerDrag((wasReset) => showToast(wasReset
    ? "buttons back in the corner"
    : "drag the grip to move these buttons; double-tap it to put them back"));
  const wheelBtn = useRef<HTMLButtonElement>(null);
  const { chromeHidden: shut, setFullScreen, setTypingPeek, chromeIn } = chrome;
  const txtScale = usePref("txtScale");
  const tZoom = usePref("tZoom");
  const rZoom = usePref("rZoom");
  // `zoom: false` is the blank terminal — a session that has not started, or
  // one with nothing cached. There is no grid to make bigger, but the two
  // controls that decide WHICH view you are in still have to be reachable, or
  // a phone that opens an offline session with no bytes on disk has no way to
  // the transcript it does have.
  const withZoom = zoomOn !== false;
  // Which document the zoom is about is WHICH ONE IS ON SCREEN. The reader
  // and the terminal keep separate values (`uiScale.ts`): one is a grid whose
  // size the host is told about, the other a page that reflows, and wanting
  // the CLI dense while the conversation stays comfortable is not a
  // contradiction. Same two buttons either way, because the question a person
  // is asking — "more of this on screen" — is the same one.
  const zoom = readerShown ? rZoom : tZoom;
  const nextZoom = readerShown ? nextReaderZoom : nextTermZoom;
  const apply = readerShown ? applyReaderZoom : applyTermZoom;
  const what = readerShown ? "reader" : "console";
  const smaller = nextZoom(zoom, -1, txtScale);
  const bigger = nextZoom(zoom, 1, txtScale);
  const wider = readerShown ? "" : ", i.e. more columns and rows for the CLI to draw in";
  const narrower = readerShown ? "" : ", i.e. fewer columns and rows";
  return (<>
    <div ref={corner.ref} className="term-zoom" data-hint="term.zoom" style={corner.style}>
      {/* The grip, FIRST so it sits at the far end from the fixed full-screen
          button: drag it to move the whole group off a line it is hiding,
          double-tap to put it back (`useCornerDrag`). No `active` highlight
          once moved: the owner asked for it not to stay blue after a drag —
          the group's new place already says it was moved. */}
      <button className="key term-zoom-grip" data-hint="term.grip"
        aria-label="move these buttons"
        title="drag to move these buttons; double-tap to put them back"
        {...corner.handle}>
        <GripVertical size={ICON} />
      </button>
      {/* The outline, when pinned, LEFT of the view switch — the owner's
          place for it. It was on the status line beside context for a build
          (0679e450): a number there read as one more fact in a row of facts,
          not as a door, and it sat away from the reader it opens. The count
          rides on the button; the pin still decides whether it is shown. */}
      {!pending && openOutline && (
        <button className="key term-zoom-outline" data-hint="toolbar:outline"
          onPointerDown={keepFocus}
          aria-label="outline"
          title={`outline — where you are in this session${tallyTitle(turnTally(active))}`}
          onClick={openOutline}>
          <List size={ICON} />{turnTally(active) == null ? null : <span className="term-zoom-count">{turnTally(active)}</span>}
        </button>
      )}
      {/* The CLI ↔ companion-shell toggle USED TO BE HERE (orange, first in
          the group). It is the header's [Claude | Shell] tabs now
          (`SessionHeader` `PairTabsSeg`), the owner's ask: two tabs by the
          title that say which half is on screen, not one button naming only
          where a tap goes. */}
      {/* The view switch, moved off the header: full screen hides that row,
          so the one control that swaps the whole view was absent from the
          layout people read long turns in.

          No `active` highlight: the icon already flips to the DESTINATION
          view, and highlighting it in read mode painted a selected-looking
          terminal icon — which reads as "CLI is the current view", the exact
          opposite of the truth.

          A backend that keeps no conversation log has no reader to switch to,
          so the switch is ABSENT rather than greyed — and the sentence saying
          why is on the terminal screen under it (`noLog`), where the
          scrollback it points at actually is. */}
      {/* Absent while the CLI is in its first-launch setup: the terminal is held up then
          (`cliSetup`), and the toast on entering said why and when the reader comes back. */}
      {!pending && sessionCan(active, "transcript") && !(active.cliSetup && active.running) && (
        <button className="key" data-hint="term.read"
          /* `keepFocus` for the full-screen button's reason: with the caret
             in the box the pointerdown blurred it, typing room let go, the
             chrome came back and this button moved before its click landed —
             the tap read as "left full screen, still in the CLI". */
          onPointerDown={keepFocus}
          aria-label={readMode ? "back to the terminal" : "reader view"}
          title={readMode ? "back to the terminal" : "reader view — scrollable, searchable transcript of this conversation"}
          onClick={() => { track("action:read.toggle"); setView(!readMode); }}>
          {readMode ? <TerminalIcon size={ICON} /> : <BookOpen size={ICON} />}
        </button>
      )}
      {/* The model wheel, RIGHT of the view switch (the owner swapped them). Absent on a pending
          session: there is no process yet to send /model to or relaunch.
          It carries the footer's permission mode as a small second glyph
          (`badgeMode`: the LIVE reading only, and nothing for Manual — the CLI
          labels that state with nothing either), so the mode shows closed. */}
      {!pending && !isShellBackend(wheel.backends, active.backend) && (() => {
        const badge = badgeMode(active);
        const label = `model, effort and mode${badge ? ` — now ${modeTitle(badge)}` : ""}`;
        return (
          <button ref={wheelBtn} className={`key${wheelOpen ? " active" : ""}${badge ? " mw-badged" : ""}`} data-hint="term.modelwheel"
            onPointerDown={keepFocus}
            aria-label={label} aria-expanded={wheelOpen}
            title={label}
            onClick={() => { track("action:modelwheel.open"); setWheelOpen((o) => !o); }}>
            <Radar size={ICON} />
            {badge && <span className="mw-badge"><ModeGlyph mode={badge} size={12} /></span>}
          </button>
        );
      })()}
      {withZoom && (
        <ZoomPair smaller={smaller} bigger={bigger} onZoom={apply} what={what} subject={`the ${what}`}
          smallerHint={wider} biggerHint={narrower} endClassName="term-zoom-px muted" iconSize={ICON} />
      )}
      {/* LAST in the group, so it never moves. The group is anchored to the
          RIGHT edge of the surface, so it grows leftward: the right-most
          button is the one at a fixed place on screen, and everything before
          it slides when a zoom button drops out at the end of its ladder or
          the reader switch is absent. It was first here for the opposite
          reason, which was simply the wrong end.

          It speaks for what is ON SCREEN (`chromeHidden`), never for either
          switch: drawn from `fullMode` it said "enter" while typing room hid
          the chrome, drawn from `fullScreen` it said "leave" over a header the
          ☰ peek had brought back — a dead tap both times. `fullScreenTap`
          asks for the opposite of what is visible and moves both hiders to
          agree. */}
      <button className={`key${shut ? " active" : ""}`} data-hint="term.fullscreen"
        /* `keepFocus` for the reason the header's two typing-room buttons
           carry it: with the keyboard up, the pointerdown blurs the box,
           typing room ends, the chrome comes back and the whole terminal —
           this button with it — moves out from under the finger before the
           click can land. The tap then read as a dead button, which is the
           other half of "sometimes I have to open the menu to get out". */
        onPointerDown={keepFocus}
        aria-label={shut ? "leave full screen" : "full screen"} aria-pressed={shut}
        title={shut
          ? "leave full screen — the header, status and toolbar come back"
          : `full screen — hide the header, status and toolbar and give the rows to the ${readerShown ? "conversation" : "output"}. No keyboard${readerShown ? "" : ": the Esc/arrow row stays"}.`}
        onClick={() => {
          const next = fullScreenTap(chromeIn);
          track(next.fullScreen ? "action:fullscreen.on" : "action:fullscreen.off");
          setFullScreen(next.fullScreen);
          setTypingPeek(next.typingPeek);
        }}>{shut ? <Minimize2 size={ICON} /> : <Maximize2 size={ICON} />}</button>
    </div>
    {wheelOpen && !pending && !isShellBackend(wheel.backends, active.backend) && (
      <ModelWheel cur={active} backends={wheel.backends} canSlash={sessionCan(active, "slash")}
        submitInput={wheel.submitInput} setLaunchOpt={wheel.setLaunchOpt} relaunch={wheel.relaunch} liveAsk={wheel.liveAsk}
        anchor={wheelBtn} onClose={() => setWheelOpen(false)} />
    )}
  </>);
}

/** Said when the terminal is held up over the reader for the CLI's setup, and when it lets go. */
export const CLI_SETUP_HOLD = "claude is not signed in on the desktop yet: the terminal stays up for its setup (theme, sign-in). The reader comes back once it reaches its prompt.";
export const CLI_SETUP_DONE = "claude is set up: back to the reader.";

export function TermArea(p: TermAreaProps): ReactNode {
  const {
    active, pending, conn, term, q, compose, launch, chrome, backends, readerShown, hiddenSlash,
    activeRepoId, transportKnown, setActiveId, closeSession, openOutline,
  } = p;
  const { pendingEntry } = q;
  const { status, connVisible, send } = conn;
  const { tailscaleIp } = conn.info;
  const {
    termRef, geomRef, buffers, lastPtyAt, ptyTail, exitedRef, staleAt, writeSeq, termNonce, readMode, setView,
    readerCmd, outlineJump, transcriptNonce,
  } = term;
  const outbox = q.entries;
  const { answerPrompt, retryPendingCreate, submitInput } = q;
  const { cliMode, sendInput, focusPipe, toggleCliMode } = compose;
  const { sessionCan, openCwd, runForkRequest } = launch;
  const { dismissedReply, setDismissedReply } = chrome;
  // The CLI's proposal the person hid on this screen — by its words, so the
  // next turn's different proposal shows again.
  const [hiddenSuggestion, setHiddenSuggestion] = useState("");
  const usdPerWeekPct = useWeekUsdPerPct(); // turn costs as a share of the week
  const weekIncl = useWeekIncl(); // …and what that share counted beyond this desktop
  const pick = useTermPick(termRef, writeSeq, active.id);
  // Answers queued for THIS box — matched on the FINGERPRINT, not the session: one queued for a box
  // that has since been replaced is not this one's. A list because a checkbox box collects several
  // (toggle, toggle, Submit); `failed` rows are excluded — those are the recovery bar's.
  const queuedAnswers = active.prompt
    ? outbox
        .filter((e) => e.answer?.fingerprint === promptFingerprint(active.prompt!) && e.status !== "failed")
        .map((e) => ({ label: e.answer!.label }))
    : [];
  const onAnswer = (data: string, label: string, submitBox?: boolean, choice?: number) => answerPrompt(active, data, label, submitBox, choice);
  const readerRef = useRef<HTMLDivElement>(null);
  const readerPick = useReaderPick(readerRef, active.id, readerShown);
  // The CLI's first-launch setup holds the terminal up over the reader preference (App's
  // `readerShown`). A view that switches itself says so, both ways (skill `ux`, §1).
  const setupHold = readMode && !!active.cliSetup && active.running;
  const heldFor = useRef<string | null>(null);
  useEffect(() => {
    if (setupHold) {
      if (heldFor.current !== active.id) { heldFor.current = active.id; showToast(CLI_SETUP_HOLD); }
    } else if (heldFor.current === active.id) {
      heldFor.current = null;
      if (readMode && active.running && !active.cliSetup) showToast(CLI_SETUP_DONE);
    }
  }, [setupHold, active.id, active.running, active.cliSetup, readMode]);
  // A desktop key typed at no field goes to the terminal (`strayKeys.ts`) — while the grid is the view.
  const sendRef = useRef(sendInput);
  sendRef.current = sendInput;
  useEffect(() => (readerShown || pending ? undefined
    : startStrayKeys(window, (b) => sendRef.current(b), () => termRef.current?.focus(), () => !!document.querySelector(OVER_TERMINAL))),
  [readerShown, pending, termRef]);
  // Collapse the whole active-session header — the cants strip goes with it.
  /** How much of a tool call the reader shows/downloads — a synced setting. */
  const toolsMode = usePref("toolsMode");
  const txtScale = usePref("txtScale");
  const rZoom = usePref("rZoom");
  const corner = (zoom?: boolean) => (
    <ScreenCorner zoom={zoom} active={active} pending={pending} readerShown={readerShown} readMode={readMode}
      setView={setView} sessionCan={sessionCan} chrome={chrome} openOutline={openOutline}
      wheel={{ backends, submitInput, relaunch: launch.relaunch, setLaunchOpt: launch.setLaunchOpt, liveAsk: conn.liveAsk }} />
  );
  // `+ later` (`isLaterId`): there is no session and none is on its way, so
  // nothing here is a terminal — the one sentence is the view. The compose
  // bar under it is the real one (paste, drop, chain, dictation), aimed at a
  // NEW session when it's free.
  if (isLaterId(active.id)) return (
    <div className="term-area term-later">
      <div className="term-overlay as-card">
        <div className="term-overlay-box">
          <Hourglass size={16} />
          <span>The session starts only once this backlog item runs.</span>
          <span className="term-overlay-hint">
            Send queues it for when this repo is free; the arrow beside Send has <em>elsewhere or later…</em> for a clock.
            Write, chain and attach here — nothing is queued until you send.
          </span>
        </div>
      </div>
    </div>
  );
  return (
    <>
      <div className="term-area">
      {/* What this session's BACKEND cannot do, said once, where the controls
          that are missing would have been. Empty (and so unrendered) for
          claude and for every host that never described a backend, which is
          what keeps this screen pixel-identical to what it was. */}
      {!pending && (
        /* Keyed on the DERIVED caps and built by one function
           (`backendCaps.ts`'s `sessionCants`), because two of the rows are
           conditional on another row and the slash row carries a count of the
           user's own header chips being withheld THIS RENDER. The number and
           the cut come from the same `splitHeaderCmds` call the header used
           three rows up — never a second pass over the list. */
        <Unavailable className="toolbar-cants"
          cants={sessionCants(backends, backendIdOf(active), { hiddenSlash })} />
      )}
      {/* A shell: no strip of missing Claude features — ONE quiet line. */}
      {!pending && shellQuietLine(backends, active.backend) && (
        <div className="act-cants toolbar-cants">
          <span className="act-cant"><TerminalIcon size={11} /> {shellQuietLine(backends, active.backend)}</span>
        </div>
      )}

      <div className="term-wrap">
        {/* The connection banner FLOATS over the terminal rather than sitting
            above it in the flex column. In flow it took height from the
            terminal, and a terminal that changes height refits its grid and
            SIGWINCHes the PTY — which the claude TUI answers by clearing and
            repainting the whole screen. A flapping tunnel is exactly when this
            banner comes and goes, so the indicator for a bad link was itself
            repainting the screen twice per blip. Floating costs one row of
            output for as long as the link is down, and nothing else. */}
        {connVisible && status !== "open" && (
          <div className={`conn-banner floating conn-${status}`}>
            {status === "closed" ? <><AlertTriangle size={12} /> connection lost — reconnecting…</> : "connecting…"}
            {tailscaleIp ? ` · ${tailscaleIp}` : ""}
          </div>
        )}
        {readerShown ? (
          /* The reader's zoom, as ONE property on its subtree. Every size in
             the transcript is `calc(Npx * var(--ui-font))` already, so this
             re-sizes the whole document without a component learning about it —
             the same trick the app-wide text setting uses, scoped. `display:
             contents` on the wrapper so `.tr`'s own `height: 100%` still
             resolves against `.term-wrap`: a box here would be a layout change,
             and the corner buttons must not move the thing they resize. */
          <div ref={readerRef} className="tr-zoom" style={{ ["--ui-font" as string]: String(readerScale(txtScale, rZoom)) }}>
          <TranscriptView
            key={active.id}
            sessionId={active.id}
            refreshKey={transcriptNonce}
            status={{
              running: active.running,
              // Hooked sessions report the turn exactly; without hooks `turnActive`
              // is the same silence guess `idle` makes, so fall back to it.
              busy: active.hooked ? !!active.turnActive : active.running && !active.idle,
              exact: !!active.hooked,
              waiting: !!active.prompt,
              prompt: active.prompt,
              suggestion: active.suggestion,
              awaitingInput: !!active.awaitingInput,
              asking: active.asking,
              // Work that outlives the main loop's turn: two background agents
              // keep going after Stop, and the reader has no footer to see them
              // in (host `agents.ts`).
              agents: active.agents,
              shells: active.shells,
              shellList: active.shellList,
              blocked: !!active.limit?.blocked,
              turnStartedAt: active.turnStartedAt,
              lastOutputAt: lastPtyAt.current.get(active.id),
              tail: ptyTail.current.get(active.id),
              // With no socket every field above is last-known, not current —
              // the reader labels itself rather than counting seconds off a
              // `turnStartedAt` that stopped meaning anything when the link died.
              linkDown: status !== "open",
            }}
            onShowCli={() => setView(false)}
            cliPeek={pending ? undefined : (leaving, onGone) => (
              <CliPeek chunks={buffers.current.get(active.id) ?? []} writeSeq={writeSeq}
                cols={geomRef.current.cols} rows={geomRef.current.rows}
                leaving={leaving} onGone={onGone}
                onOpen={() => { track("action:read.peekToCli"); setView(false); }} />
            )}
            /* The reader ANSWERS the box now — the approve bar that used to do
               it is gone. Same `answerPrompt` as ever (durable, fingerprinted,
               first in its lane, refused host-side once the box has gone), so
               this adds no send path; it moves the buttons to the one surface
               with room for the whole question. */
            onAnswer={onAnswer}
            onStop={() => sendInput("\x1b")}
            queuedAnswers={queuedAnswers}
            cmd={readerCmd ?? undefined}
            toolsMode={toolsMode}
            // Composing from a cached transcript is fine — a turn uuid is stable
            // for ever — but both verbs START A SESSION on the host, so the
            // reader disables them with the socket down rather than queueing:
            // a reset replayed an hour late kills a session that has since done
            // an hour of work.
            //
            // ABSENT — the whole disclosure, not a dimmed pair inside it — for
            // a backend that can be READ and must not be REWRITTEN. `fork` was
            // the same flag as `transcript` until such a backend arrived; the
            // moment `transcript` flips true for it, a `transcript` gate here
            // puts a fork button on every turn of a conversation nothing can
            // cut. It resolves back to `transcript` on any host that never
            // described it, so claude's reader is unchanged. The sentence
            // saying why is in the strip under the toolbar (`sessionCants`),
            // where it is shown only because a reader exists to miss it from.
            fork={sessionCan(active, "fork")
              ? { online: status === "open", run: (req) => void runForkRequest(active, req) }
              : undefined}
            jumpTo={outlineJump ?? undefined}
            onOpenCost={openContext}
            nextTurn={sessionCostOf(active.contextSpark, { lastTurnAt: active.lastTurnAt, turnActive: active.turnActive, now: Date.now() })}
            usdPerWeekPct={usdPerWeekPct}
            weekIncl={weekIncl}
            onOpenShells={() => openShellsFor(active)}
            files={activeRepoId ? {
              // Thumbnails come from the same artifact route the gallery uses —
              // and, given an mtime, at the same VERSIONED URL, so a picture the
              // grid already warmed paints here with no request at all and one
              // the reader fetches survives the tunnel going down (fileMtime.ts,
              // thumbCache.ts). The mtime is the renderer's to supply: it is the
              // one that knows which path it is drawing.
              repoId: activeRepoId,
              url: (rel, w, mtime) => { const u = api.artifactUrl(activeRepoId, rel); return w ? sized(u, w, mtime) : u; },
              open: (rel) => openFileRef(activeRepoId, rel),
              known: transportKnown,
            } : undefined}
            onToast={showToast}
          />
          {readerPick.chrome}
          </div>
        ) : (() => {
          // An empty xterm is a black rectangle, and a black rectangle is
          // indistinguishable from a crash — which is exactly what "the app went
          // black" reports turned out to be. So the terminal always carries an
          // overlay saying WHICH of the three harmless explanations applies.
          // Terminal.tsx stays dumb: everything here is App state it already has.
          const buf = buffers.current.get(active.id) ?? [];
          const hasOutput = buf.some((c) => c.length > 0);
          // Restored-from-disk bytes (item 9) — real output, just not current.
          const restoredAt = staleAt.get(active.id);
          const offline = status !== "open" && connVisible; // past the reconnect grace window
          // With the socket up, `running` from session.list is authoritative — and
          // it has to be, because a usage-limit resurrection revives a session
          // under the SAME id, and a sticky exit mark would leave it reading
          // "ended" forever. The remembered exit only speaks when the list can't.
          const ended = !active.running || (status !== "open" && exitedRef.current.has(active.id));
          const seenAt = restoredAt ?? lastPtyAt.current.get(active.id);
          // A session that does not exist yet outranks every other explanation:
          // there is no PTY, so "no output" and "offline" would both be true and
          // neither would be the thing worth saying.
          const kind = pending ? "pending" : ended ? "ended" : offline ? "offline" : hasOutput ? null : "empty";
          // With content on screen the explanation is a corner chip; with none it
          // is a card over the void. Never a modal backdrop over readable output.
          const card = !hasOutput;
          return (
          <div className="term-stage">
            {/* Dimming is a CSS filter on the container, never injected ANSI: a
                replayed TUI re-sets its own SGR attributes within bytes and would
                paint straight over any dim code we wrote. */}
            {/* In CLI mode a tap on the screen is "let me type here" — the
                gesture anyone who has used a terminal already has. It raises
                the keyboard by focusing the pipe box, not xterm's own hidden
                textarea (that one is pinned `inputmode=none` precisely so a
                special-key tap can't summon the keyboard). A pan is a
                touchmove and never reaches this. */}
            <div className={`term-canvas${restoredAt != null ? " stale" : ""}`}
                 onClick={cliMode ? focusPipe : undefined}>
              <TerminalView
                key={`${active.id}:${termNonce}`}
                ref={termRef}
                pending={buf}
                writeSeq={writeSeq}
                onInput={sendInput}
                // eslint-disable-next-line local/no-silent-send -- not a tap: the terminal reports its own geometry on every layout change, and a toast on a keyboard opening would fire several times a second. A resize that never lands is re-sent by the next one, and by `session.attach` on reconnect.
        onResize={(cols, rows) => { geomRef.current = { cols, rows }; if (!pending) send({ t: "session.resize", id: active.id, cols, rows }); }}
                linkUp={status === "open"}
                onScreen={(lines) => absorbScreenLog(active.id, lines)}
                onCursorLine={compose.noteCursorLine}
                onReachBack={() => { track("action:scrollback.reachback"); openScrollback(); }}
                onScrollStalled={() => showToast("no new output from that scroll — “scrollback” reads this device's own copy")}
                onLongPress={pick.onLongPress}
              >{pick.gutter}</TerminalView>
            </div>
            {/* Over the console, top right — see `ScreenCorner`. Not drawn
                over the CARD explanations (a session that has not started, or
                one with nothing cached): there is no grid to make bigger yet,
                and the corner is where that card's own words are. */}
            {corner(!card)}
            {pick.chrome}
            {/* The one box the terminal answers by tap (`termAnswers.ts`): the trust box a new
                person meets first, before they know the key bar, drawn unnumbered with the
                cursor on "No, exit". The reader's own card body, over the bottom of the grid
                where the CLI draws the same box — an overlay, so the PTY is never resized. */}
            {termAnswersBox(active.prompt, active.running) && (
              <div className="term-answer" data-box="trust">
                <PromptAnswer prompt={active.prompt} queued={queuedAnswers} suggestion={active.suggestion}
                  onAnswer={onAnswer} ev="term.trust" />
              </div>
            )}
            {kind && (
              <div className={`term-overlay ${card ? "as-card" : "as-chip"} term-overlay-${kind}${kind === "pending" && pendingEntry?.status === "failed" ? " failed" : ""}`}>
                <div className="term-overlay-box">
                  {kind === "empty" && (
                    <><Loader2 size={16} className="spin" /> <span>no output yet — the session is running and hasn’t printed anything</span></>
                  )}
                  {kind === "offline" && (
                    <>
                      <CloudOff size={16} />
                      <span>
                        offline — {hasOutput
                          ? <>output as of {seenAt ? ago(seenAt) : "the last connection"}</>
                          : <>nothing cached for this session yet</>}
                      </span>
                      {card && <span className="term-overlay-hint">It reappears the moment the tunnel is back. Anything you send is queued, not lost.</span>}
                      {/* Scrolling the TUI needs the socket; this doesn't. Only
                          offered once there is history to show — a button that
                          opens an empty view is worse than no button. */}
                      {hasScrollback(active.id) && (
                        <span className="term-overlay-acts">
                          <button className="key" title="earlier output, read from this device (pan up on the terminal does the same)"
                            onClick={openScrollback}><ScrollText size={14} /> scrollback</button>
                        </span>
                      )}
                    </>
                  )}
                  {kind === "pending" && (() => {
                    const failed = pendingEntry?.status === "failed";
                    const onWire = pendingEntry?.status === "pending";
                    // Online but not going out: say what holds it (the budget,
                    // auto-send off, …). "warming up the CLI" over an open the
                    // queue had not even sent read as a session that was running.
                    const held = !onWire && status === "open" && pendingEntry ? q.blocked.get(pendingEntry.ackId) : undefined;
                    return (
                    <>
                      {failed ? <AlertTriangle size={16} /> : <Loader2 size={16} className="spin" />}
                      <span>
                        {failed
                          ? <>the session was not started — {pendingEntry?.reason || "the desktop refused it"}</>
                          : !pendingEntry
                            // Accepted and off our books: either the CLI is
                            // starting, or the host is holding the create until
                            // the files it names have landed (`launch.opened`).
                            ? <>the desktop has it — the session opens in a moment…</>
                            : held
                              ? <>not opened yet — {blockedReasonText(held)}</>
                              : onWire || status === "open"
                              ? <>warming up the CLI for you…</>
                              : <>offline — the session will be created once you are back online</>}
                      </span>
                      <span className="term-overlay-hint">
                        {failed
                          ? "Anything typed here is still in the queue and can be re-aimed from Activity."
                          : "Write, chain and attach now — it all goes into this session the moment it opens."}
                      </span>
                      <span className="term-overlay-acts">
                        {failed && (
                          <button className="key" title="try this open again" onClick={retryPendingCreate}>
                            <RotateCw size={14} /> try again
                          </button>
                        )}
                        <button className="key" title={failed ? "back to the launcher" : "stop waiting — the open stays queued and can be dropped in Activity"}
                          onClick={() => setActiveId(null)}>
                          <ChevronLeft size={14} /> back
                        </button>
                      </span>
                    </>
                    );
                  })()}
                  {kind === "ended" && (
                    <>
                      <X size={16} />
                      <span>session ended{offline ? " · offline, so this is the last state we saw" : ""}</span>
                      <span className="term-overlay-acts">
                        {/* `backend` rides along with model/effort/permissionMode:
                            the override is what the reopen RUNS, and one built
                            without it reopened an opencode conversation under
                            claude — the wrong binary, not merely the wrong
                            conversation. (`wireLaunch` in `createOp` still strips
                            it for a host that never described one.) */}
                        <button className="key" title={`reopen this session — ${resumeHint(!!resumeIdOf(active))}`}
                          onClick={() => openCwd(active.cwd, active.title, true, "continue", { model: active.model, effort: active.effort, permissionMode: active.permissionMode, backend: active.backend }, resumeIdOf(active))}>
                          <RotateCw size={14} /> reopen
                        </button>
                        <button className="key" title="remove this session from the list" onClick={() => { closeSession(active); setActiveId(null); }}>
                          <X size={14} /> close
                        </button>
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
          );
        })()}
        {/* The reader's copy of the corner group. The terminal branch keeps its
            own inside `.term-stage` (where it drops the zoom pair for the
            full-card explanations); here there is no such state — a transcript
            is either drawn or the reader is not up. */}
        {readerShown && corner()}
        {/* The demo's first minute only: one hint under the real reader toggle. */}
        {!pending && <DemoHookHint session={active} readMode={readMode} />}
      </div>
      </div>

      {/* The last prompt's cost, under the terminal — the reader's card body
          for the newest turn with figures (`TermCostStrip.tsx`). Two fixed
          heights so a new turn never resizes the PTY; absent with no figures
          and for a backend that keeps no conversation log to read them from. */}
      {!pending && !readerShown && sessionCan(active, "transcript") && (
        <TermCostStrip
          key={active.id}
          sessionId={active.id}
          refreshKey={transcriptNonce}
          busy={active.hooked ? !!active.turnActive : active.running && !active.idle}
          turnStartedAt={active.turnStartedAt}
          nextTurn={sessionCostOf(active.contextSpark, { lastTurnAt: active.lastTurnAt, turnActive: active.turnActive, now: Date.now() })}
          usdPerWeekPct={usdPerWeekPct}
          weekIncl={weekIncl}
          onOpenCost={openContext}
          chipOnly={chrome.chromeHidden}
        />
      )}

      {/* Signing in is the one flow that cannot be finished inside this app, and
          on a phone-width grid its 300-character URL is broken across six rows
          — untappable, unselectable, untypeable. Above the prompt bar because a
          session showing a login screen is not showing a choice box, and if it
          somehow shows both, the sign-in is the one blocking the other. */}
      {active.login && (
        <LoginBar
          login={active.login}
          onOpen={openLink}
          onCopy={(u) => void copyLink(u)}
          onPasteCode={() => void pasteLoginCode(active.id)}
        />
      )}

      {/* A shell session's own sign-in card: links a program printed or asked the
          desktop to open, a code to copy, and the cheat sheet of the commands
          that finish on a phone. Claude-shaped sessions never carry `links`. */}
      {!active.login && hasShellBar(active) && (
        <ShellLinksBar
          links={active.links ?? []}
          awaitingCode={!!active.awaitingCode}
          onOpen={openLink}
          onCopy={(u) => void copyLink(u)}
          onCopyCode={copyCode}
          onPasteCode={() => void pasteLoginCode(active.id)}
          onLogins={openLogins}
        />
      )}

      {/* The `approve` BAR is gone, deliberately — and with it three sizes, a
          standing collapse preference, a `vh` cap, a three-line clamp and a
          `more` toggle, every one of which existed because the bar took its
          height FROM the terminal. On a six-option `AskUserQuestion` with a
          paragraph each it still lost: two options on screen, four inside a
          scroll region with no scrollbar on Android and nothing saying they were
          there. The two places a box is answered by TAPPING are now the reader's
          own card and `QuestionsSheet`, both of them documents with a scroll of
          their own, both drawing `PromptAnswer.tsx`.

          Here — the terminal view — there is nothing to draw: the CLI is showing
          that box, with the same options and the same descriptions, inches
          above where this card used to restate them, and a terminal is driven
          the terminal's way (press the digit; `cliKeys.ts` and the special-key
          row are how). */}

      {!active.prompt && active.suggestion?.reply != null && active.suggestion.reply !== dismissedReply && (
        <ReplyBar
          key={active.id + ":" + active.suggestion.reply}
          suggestion={active.suggestion}
          // Prose, not a keystroke — so it takes the ordinary durable compose
          // path (typed, echo-checked, Return proven host-side) rather than the
          // fingerprinted answer path. It was a bare socket write, which meant
          // the one reply you write while away from the desk was the one the
          // tunnel could eat.
          onSend={(t) => { submitInput(active.id, active.cwd, t, "prompt"); setDismissedReply(active.suggestion!.reply!); }}
          onDismiss={() => setDismissedReply(active.suggestion!.reply!)}
        />
      )}

      {/* The CLI's own proposal for the next prompt — Tab at the desk, a tap
          here. Under a plugin's reply card when there is one: that card is an
          answer to a question, this is only what to do next. */}
      {!active.prompt && active.running && !active.turnActive && active.cliSuggestion
        && active.cliSuggestion !== hiddenSuggestion
        && !(active.suggestion?.reply != null && active.suggestion.reply !== dismissedReply) && (
        <CliSuggestion
          text={active.cliSuggestion}
          onSend={(t) => { submitInput(active.id, active.cwd, t, "prompt"); setHiddenSuggestion(t); }}
          onDismiss={() => setHiddenSuggestion(active.cliSuggestion!)}
          ev="term"
        />
      )}

      {/* The raw-key row and CLI mode both write straight into a PTY. A pending
          session has none, so the row is not rendered at all rather than
          offering keys that can only answer with a toast.

          Nor is it drawn in the reader: Esc / Tab / the arrows / ^C aim at a
          choice box, a menu cursor or a running turn on a grid that is not on
          screen there — the reader answers a box by TAPPING it
          (`PromptAnswer.tsx`) and its prose has no cursor to move. Full screen
          already hid the row there for that reason; it was chrome the rest of
          the time too. The CLI toggle goes with it, which is why `cliMode`
          reads `readerShown` as well — hiding the way out of a live pipe would
          strand the composer in it. */}
      {!pending && !readerShown && (
      <div className="keys">
        {/* The arrows normally BLUR the box (a focused-but-dismissed textarea
            re-summons the keyboard on any focus-preserving tap). In CLI mode the
            box IS the keyboard — dismissing it to press an arrow would mean
            re-opening it for the next letter. */}
        {SPECIAL_KEYS.map((k, i) => (
          <button key={i} className="key" title={k.title} aria-label={k.title} onPointerDown={k.nav && !cliMode ? blurCompose : keepFocus} onClick={() => sendInput(k.data)}>{k.label}</button>
        ))}
        {/* Lives at the END of this row on purpose: the row IS raw input, and
            CLI mode is the same thing with the alphabet added. */}
        <button
          className={`key cli-key ${cliMode ? "active" : ""}`}
          data-hint="compose.cli"
          onPointerDown={keepFocus}
          onClick={toggleCliMode}
          title={cliMode
            ? "CLI mode is on — every key you type goes straight to the session. Tap to go back to composing (queued, confirmed sends)."
            : "CLI mode — type directly at the CLI instead of composing a message: keystrokes go through as you type, nothing is queued or echo-checked."}
        ><TerminalIcon size={ICON} /> CLI</button>
      </div>
      )}

      <NewImagesStrip sessionId={active.id} />
      {/* The demo's closing card, once its first-minute loop has run. */}
      {!pending && <DemoHookCard session={active} readMode={readerShown} />}
    </>
  );
}
