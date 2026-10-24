/**
 * The compose bar: the aim line above it, the upload row, the attach strip,
 * the split Send button's menu, the snippet popover, the box itself and the
 * button row under it (or CLI mode's bar in its place).
 *
 * Lifted out of App's session screen unchanged; everything it acts with is
 * `useCompose`'s return (`api`). **One PromptComposer**: the `<textarea>` here
 * is the pipe/CLI surface and the per-session draft, the one the compose bar
 * has always had (`web-send`) — nothing new is hand-rolled.
 */
import { useEffect, useLayoutEffect, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowDown, ArrowUp, Camera, Check, ChevronsUpDown, Eye, EyeOff, Hourglass, KeyRound, ListTodo, Loader, NotebookPen, Paperclip, Pencil,
  Plus, Quote, SendHorizontal, Terminal as TerminalIcon, Trash2, Waypoints, X, Zap,
} from "lucide-react";
import { sessionPickLabel } from "@waterplane/shared";
import type { BacklogItem, RepoTarget, SessionInfo } from "@waterplane/shared";
import type { OutboxEntry } from "../../outbox";
import type { UploadProgress } from "../../sdk/types.ts";
import type { Overlay } from "../../routing";
import {
  AIM_HERE_LABEL, WHERE_LEAD, composeAimNote, composeMenu, composeWhere, sendButtonTitle, sendModeLabel, sendWhereLabel,
} from "../../composeSend";
import { AttachStrip } from "../../AttachStrip";
import { dropFileRef } from "../../fileRefs";
import { VoiceButton } from "../../VoiceButton";
import { Empty } from "../../Empty";
import { SessionName } from "../../SessionName";
import { hiddenByArchive } from "../../backlogFilter";
import { PIPE_PAD } from "../../cliKeys";
import { baseName } from "../../format";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { useSnippets } from "../../features/snippets";
import { openBacklogIn } from "../../features/backlog";
import { takeBoxReturn, useBoxReturn } from "../../features/images";
import type { ComposeApi } from "./useCompose";
import { useFileDrop } from "./useFileDrop";
import { isShellBackend } from "../../backendCaps";
import { isLaterId, isPendingId } from "../queue/logic.ts";
import { secretFillers } from "../extensionPoints";
import { Button } from "../../kit/Button";
import { RowTitle, RowSub } from "../../kit/Row";

const ICON = 16;

/** Stop a tap from blurring the compose box (which would dismiss the keyboard). */
export const keepFocus = (e: ReactPointerEvent) => e.preventDefault();

function coarsePointer(): boolean {
  try { return window.matchMedia?.("(pointer: coarse)").matches ?? false; } catch { return false; }
}

export interface ComposeBarProps {
  api: ComposeApi;
  active: SessionInfo;
  sessions: SessionInfo[];
  outbox: OutboxEntry[];
  online: boolean;
  repoForCwd(cwd: string): RepoTarget | null;
  /** The queue core's upload buffer, as the row under the box draws it. */
  uploads: {
    uploading: string | null; parking: number; upProg: UploadProgress | null;
    uploadPending: boolean; uploadRowLinger: boolean; cancelUploads(): void;
  };
  activeRepoId: string | null;
  pickImageFor(repoId: string): void;
  pickFileFor(repoId: string): void;
  /** The backlog as the launcher cuts it (hidden repos, focus) — the badge counts this repo's share. */
  visibleBacklogItems: BacklogItem[];
  setOverlay(o: Overlay): void;
}

export function ComposeBar(p: ComposeBarProps) {
  const { api, active, sessions, outbox, online, repoForCwd, activeRepoId, pickImageFor, pickFileFor, visibleBacklogItems, setOverlay } = p;
  const { uploading, parking, upProg, uploadPending, uploadRowLinger, cancelUploads } = p.uploads;
  const {
    compose, setCompose, composeRef, cmdHistory, histIdx, setHistIdx, clearArmed, setClearArmed, setComposeFocused,
    snippetOpen, setSnippetOpen, sendMode, setSendMode, sendWhere, setSendWhere, sendWhereSid, setSendWhereSid,
    sendMenu, setSendMenu, cliMode, enterSends, voice, aimedSession, stepHistory, clearCompose, appendSnippet,
    chord, toggleCliMode, onPipeInput, flushPipe, onPipeKey, onComposeKey, aimHere, sendCompose, openComposeSend, keepOnPad, noteSendAim,
    secretAskLine, secret, setSecret, secretShown, setSecretShown, dismissSecret, sendSecret, secretFillContext,
  } = api;
  // A shell takes commands, not sentences: the keyboard's capital first letter
  // and autocorrect are both wrong there, as they are in CLI mode.
  const literal = cliMode || isShellBackend(null, active.backend);

  const snippets = useSnippets();
  const { dragOver, dropProps } = useFileDrop();
  // The box remounts at two rows under every sheet, and CLI mode swaps its
  // value: measure again on both, or a long draft reads through a porthole.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- growCompose is the draft hook's, reading by ref
  useLayoutEffect(() => { api.growCompose(); }, [cliMode]);
  // **A fresh session is somewhere to type**: the "+" opens a pending screen,
  // and on a desktop the next thing done is typing — so the caret goes into
  // the box. Keyed on the PENDING id (one per create), never on the switch to
  // the real id, which would steal focus from wherever it has gone since. Not
  // on a touch screen: a focus there raises the keyboard over the screen
  // nobody has read yet.
  const activeId = active?.id;
  const later = isLaterId(activeId);
  useEffect(() => {
    if (!isPendingId(activeId) || coarsePointer()) return;
    composeRef.current?.focus();
  }, [activeId, composeRef]);
  // **Back from the annotator, the caret is in the box, at the end** — on a
  // desktop. Its Ctrl/⌘+Return closed a sheet that held the focus, and the next
  // words needed the mouse. Read on mount too: on a phone-width screen the
  // annotator was a sheet, and this bar remounts under it.
  const boxReturnAt = useBoxReturn();
  useEffect(() => {
    if (!boxReturnAt || !takeBoxReturn() || coarsePointer() || cliMode) return;
    const el = composeRef.current;
    if (!el) return;
    el.focus();
    try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not focusable yet */ }
  }, [boxReturnAt, composeRef, cliMode]);
  return (
    <>
      {/* **The armed aim, said out loud for as long as it is not this session.**

          This is the half that makes the aim safe to REMEMBER. The per-repo
          the old `sendMode` key that was deleted from this app armed the primary
          button with an answer nobody could see, and the only way to find out
          was to tap it; the mode that replaced it is safe because
          `sendModeLabel` spells it out on the button face. `a new session` does
          not fit there beside it, so it takes a line of its own — a whole
          sentence, because the fact that matters is the NEGATIVE one (*not the
          conversation on screen*), which no badge can say — and the line
          carries the one tap that puts it back. `composeSend.ts` owns the
          words. */}
      {/* Not on `+ later`: the screen itself says where the words go. */}
      {active && !later && (() => {
        const note = composeAimNote(sendWhere, {
          repoName: repoForCwd(active.cwd)?.repoName ?? baseName(active.cwd),
          sessionName: aimedSession ? sessionPickLabel(aimedSession) : null,
        });
        if (!note) return null;
        return (
          <div className="compose-aim">
            <span className="compose-aim-what"><Waypoints size={12} /> {note}</span>
            <Button onPointerDown={keepFocus}
              title={`send to ${sendWhereLabel("this")} instead — the conversation on screen`}
              onClick={() => { track("action:compose.where.here"); aimHere(); }}>
              <SendHorizontal size={12} /> {AIM_HERE_LABEL}
            </Button>
          </div>
        );
      })()}

      <div className={`compose${dragOver ? " drop-over" : ""}`} {...dropProps}>
        {(uploadPending || uploadRowLinger) && (
          <div className="upload-progress" title="images upload in the background; a prompt naming one is delivered after it lands">
            <div className="upload-progress-line">
              {uploadPending
                ? <><Loader size={12} className="spin" /> {uploading}{parking > 0 ? " · still reading it" : ""}</>
                : <><Check size={12} /> uploads done</>}
              {/* Only while something is in flight: in the linger frame the
                  line already says "uploads done", and a dimmed cancel beside
                  it was a control with nothing to cancel. */}
              {uploadPending && (
                <Button className="upload-cancel" onPointerDown={keepFocus} onClick={cancelUploads} title="cancel uploads">
                  <X size={12} /> cancel
                </Button>
              )}
            </div>
            {/**
              * **The decision, where the waiting is visible.**
              *
              * This row used to end at "Send waits for uploads" over a Send
              * button that was dimmed out — a progress bar and no controls, on
              * the one screen where a person is sitting and watching. Both
              * answers they might want were reachable only through the chevron
              * below, and one of them was not reachable at all while the block
              * was on.
              *
              * So the two verbs are here, one tap each, in the same words the
              * queue's own strip uses:
              *
              *  - **send now** — it goes straight away. If the text names a
              *    picture still moving, `guardUploadRefs` adopts that upload
              *    into this lane and the one-delivery-per-lane rule makes the
              *    prompt wait for the bytes anyway. So this cannot outrun its
              *    own attachment; it only stops the composer from sitting idle.
              *  - **let it wait** — parked until the session is free
              *    (`holdUntilIdle`), for the case where the agent is mid-turn
              *    and the follow-up should land after it rather than being
              *    glued onto the CLI's composer.
              *
              * Only with something to send: two buttons over an empty box are
              * two taps that do nothing.
              */}
            {uploadPending && compose.trim() && (
              <div className="upload-acts">
                <span className="upload-acts-what">{parking > 0
                  ? "Send goes as soon as the picture is readable"
                  : "your prompt is ready to go — it is delivered after the picture lands"}</span>
                <Button onPointerDown={keepFocus} data-hint="queue.sendnow"
                  title="post it now — if it names a picture still moving, the queue still delivers it after the bytes"
                  onClick={() => { track("action:upload.sendnow"); sendCompose("now"); }}>
                  <Zap size={14} /> send now
                </Button>
                <Button onPointerDown={keepFocus} data-hint="queue.hold"
                  title="park it until this session is free, instead of typing it in mid-turn"
                  onClick={() => { track("action:upload.hold"); sendCompose("idle"); }}>
                  <Hourglass size={14} /> let it wait
                </Button>
              </div>
            )}
            {/* Determinate bar whenever the byte total is known — the spinner
                alone can't be told apart from a stalled uplink. The track is
                ALWAYS rendered while the row is up: mounting it when the byte
                total arrives is another 7px height change on the composer, and
                every height change here repaints the terminal above it. */}
            <div className="upload-bar">
              <div className={`upload-bar-fill${upProg?.waiting ? " waiting" : ""}`} style={{ width: `${upProg && upProg.total > 0 ? upProg.pct : 0}%` }} />
            </div>
          </div>
        )}
        {/* What the draft is pointing AT. An attached photo becomes a minted
            path in the text ("…/1000074539-mtjv8u52a489a0.jpg") and from then on
            the composer shows a name nobody can read — two attachments in and
            you cannot tell which is which without sending them. Checked behind a
            debounce, because the alternative is a repo listing per keystroke. */}
        {active && (
          <AttachStrip compact debounceMs={700} text={compose}
            repoId={repoForCwd(active.cwd)?.id ?? null}
            outbox={outbox} online={online}
            onRemove={(rel) => setCompose((c) => dropFileRef(c, rel))} />
        )}
        {/* What Send does, chosen per message: two MODES (the button changes,
            nothing is sent) and ONE errand into the send sheet.
            `composeSend.ts` owns the words and is tested on them.

            It was five rows. Three of those were modes, and two of the three —
            `when it's free` and `queue here` — were the same decision with
            different holders, a difference that is about which machine
            remembers and not about anything a person wants. The other two were
            errands that opened the SAME sheet, differing only in which row it
            came up with expanded. Marked, so the armed mode is visible in the
            menu as well as on the button. */}
        {sendMenu && !cliMode && (
          <div className="row-more send-more">
            {/* **WHERE, above WHEN, because it is the question that was missing.**

                Every row below this aimed at the session on screen and there
                was no way to say otherwise without leaving for the send sheet —
                so the cheapest thing you can do with a prompt, ask it in a
                clean window, was the most expensive thing to ask for. The three
                answers are the send sheet's own minus the sweep, worded
                identically (`composeSend.ts`), because two spellings of "a new
                session" two screens apart is two decisions as far as anybody
                reading them is concerned.

                It applies to every row under it, including *keep it on the pad*
                — a note is filed against the repo its words were aimed at. */}
            {/* Not on `+ later`: a new session is the only answer there is. */}
            {!later && <div className="send-where">
              <span className="send-where-lead">{WHERE_LEAD}</span>
              {composeWhere().map((w) => (
                <button key={w.key}
                  className={`more-act${sendWhere === w.key ? " on" : ""}`}
                  onPointerDown={keepFocus} title={w.title}
                  onClick={() => {
                    track(`action:compose.where.${w.key}`);
                    setSendWhere(w.key);
                    // Leaving `other` drops the session it named: an id kept
                    // behind a different armed answer is a target nobody can
                    // see and nobody chose.
                    if (w.key !== "other") setSendWhereSid(null);
                    // `other` never survives this write (`reusableWhere`) — it
                    // names a per-boot id — so the memory holds the two answers
                    // the aim line can state before the next tap.
                    noteSendAim(active?.cwd, { where: w.key });
                  }}>
                  {w.key === "new" ? <Plus size={ICON} /> : w.key === "other" ? <Waypoints size={ICON} /> : <SendHorizontal size={ICON} />}
                  {w.label}
                </button>
              ))}
            </div>}
            {/* The pick `other` needs. Drawn IN the strip rather than behind a
                sheet: the whole reason this toggle exists is that leaving this
                screen to answer WHERE cost five taps. An empty list is a
                sentence — never a dimmed segment (`Unavailable.tsx`). */}
            {sendWhere === "other" && (() => {
              const others = sessions.filter((s) => s.running && s.id !== active?.id);
              if (!others.length) return <div className="send-where-pick"><Empty>No other session is open — <em>a new session</em> opens one.</Empty></div>;
              return (
                <div className="send-where-pick">
                  {others.map((s) => (
                    <button key={s.id} className={`row${sendWhereSid === s.id ? " sched-on" : ""}`}
                      onPointerDown={keepFocus}
                      title={`send to ${sessionPickLabel(s)}`}
                      onClick={() => { track("action:compose.where.pick"); setSendWhereSid(s.id); }}>
                      <RowTitle>{s.title}</RowTitle>
                      {/* The desktop's own name for the conversation — without
                          it this list is the repo name once per session and the
                          question cannot be answered (`SessionName.tsx`). */}
                      <SessionName s={s} />
                      <RowSub>{s.turnActive ? "working" : "idle"}</RowSub>
                    </button>
                  ))}
                </div>
              );
            })()}
            {composeMenu().map((m) => (
              <button key={m.key}
                className={`more-act${m.mode && sendMode === m.mode ? " on" : ""}`}
                onPointerDown={keepFocus} title={m.title}
                onClick={() => {
                  setSendMenu(false);
                  if (m.mode) { setSendMode(m.mode); return; }
                  // The row that keeps words instead of aiming them: no target,
                  // no trigger, nothing that fires itself.
                  if (m.key === "pad") { keepOnPad(); return; }
                  // The one errand: the same words, with the other three answers
                  // opened up. Seeded to what the button would have done — this
                  // session, now — with both rows collapsed, so it is an
                  // EXPANSION of the decision already made and never a fresh one.
                  openComposeSend();
                }}>
                {m.icon === "hourglass" ? <Hourglass size={ICON} />
                  : m.icon === "elsewhere" ? <ChevronsUpDown size={ICON} />
                    : m.icon === "pad" ? <NotebookPen size={ICON} />
                      : <SendHorizontal size={ICON} />}
                {m.label}
              </button>
            ))}
            {/* The way out that is not the chevron. The chevron lives in the
                compose bar BELOW this strip, so anything that grows the
                composer — a long draft, an attachment strip, a system font
                scale — takes the only way to close this menu off the bottom of
                the screen. A row here costs nothing and cannot be pushed away
                from its own strip. */}
            <button className="more-act more-close" onPointerDown={keepFocus}
              title="close this menu — nothing is sent and the mode stays as it is"
              onClick={() => setSendMenu(false)}>
              <X size={ICON} /> close
            </button>
          </div>
        )}
        {snippetOpen && (
          <div className="snippet-pop">
            <div className="snippet-pop-head">
              <span>Snippets</span>
              <Button onPointerDown={keepFocus} onClick={() => { setSnippetOpen(false); setOverlay("snippets"); }} title="Manage snippets"><Pencil size={14} /> manage</Button>
              <Button onPointerDown={keepFocus} onClick={() => setSnippetOpen(false)} title="Close"><X size={14} /></Button>
            </div>
            <div className="snippet-pop-list">
              {snippets.length === 0 && <Empty>No snippets yet — tap “manage” to add one.</Empty>}
              {snippets.map((s) => (
                <button key={s.id} className="snippet-pop-item" onPointerDown={keepFocus} title={s.text} onClick={() => { track("action:snippet.insert"); appendSnippet(s); }}>
                  <span className="snippet-pop-title">{s.title}</span>
                  <span className="snippet-pop-preview">{s.text.replace(/\s+/g, " ").trim()}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {secretAskLine ? (
          /* **A password asked on screen** (`useCompose`'s secret state): a
             masked field in place of the draft box, its words never a draft,
             never history, never an outbox row. Masked by default; the eye
             shows what was typed. The draft below it is untouched. */
          <>
            <div className="secret-ask">
              <KeyRound size={12} />asked on screen: <code>{secretAskLine}</code> — typed straight in, never kept as a draft or in history
            </div>
            <div className="secret-row">
              <input
                type={secretShown ? "text" : "password"}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); sendSecret(); } }}
                placeholder="password"
                autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
                enterKeyHint="send"
                onFocus={() => setComposeFocused(true)}
                onBlur={() => setComposeFocused(false)}
              />
              <button className="mic" onPointerDown={keepFocus} onClick={() => setSecretShown((v) => !v)}
                aria-pressed={secretShown}
                title={secretShown ? "Hide what is typed" : "Show what is typed"}>
                {secretShown ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <div className="compose-bar">
              <Button className="secret-other" onPointerDown={keepFocus} onClick={dismissSecret}
                title="Back to the message box — this line is not asking for a password">
                <X size={14} /> not a password
              </Button>
              {/* Contributed sources (`SecretFillerDef`): they fill the field above, never send. */}
              {(() => { const ctx = secretFillContext(); return ctx ? secretFillers(ctx) : []; })().map((f) => (
                <Button key={f.key} onPointerDown={keepFocus} title={f.unavailable ?? f.label}
                  onClick={() => { if (f.unavailable) { showToast(f.unavailable); return; } track("action:compose.secret.fill"); f.open(); }}>
                  <f.icon size={14} /> {f.label}
                </Button>
              ))}
              <div className="send-split">
                <button className="send" onPointerDown={keepFocus} onClick={sendSecret}
                  title="Type it into the prompt and press Enter — nothing is kept">
                  <KeyRound size={ICON} /> Send
                </button>
              </div>
            </div>
          </>
        ) : (<>
        <textarea
          ref={composeRef}
          className={cliMode ? "pipe" : undefined}
          data-compose=""
          // In CLI mode the box holds a pad of spaces and never any of your
          // words: what you type is already on the screen above, echoed by the
          // CLI itself, so a second copy of it down here is only a second place
          // for it to get out of step. `compose` keeps the draft meanwhile.
          value={cliMode ? PIPE_PAD : compose}
          onChange={cliMode ? onPipeInput : (e) => { setCompose(e.target.value); setHistIdx(-1); setClearArmed(false); }}
          onCompositionEnd={cliMode ? (e) => flushPipe(e.currentTarget) : undefined}
          placeholder="Message or /command…" rows={2}
          // Autocorrect rewrites words it thinks are typos — in a pipe that is
          // an invented keystroke, and half of what gets typed at a TUI is not
          // a word at all.
          autoCapitalize={literal ? "off" : undefined}
          autoCorrect={literal ? "off" : undefined}
          spellCheck={literal ? false : undefined}
          enterKeyHint={cliMode ? "enter" : enterSends ? "send" : "enter"}
          onKeyDown={cliMode ? onPipeKey : onComposeKey}
          // Ctrl+V of a screenshot or a file is `useFileDrop`'s, the ONE paste
          // handler: two of them once routed the same picture twice, and this
          // one skipped the annotator-busy question and replaced its marks.
          onFocus={() => setComposeFocused(true)}
          onBlur={() => setComposeFocused(false)}
        />
        {cliMode ? (
          /* No Send, no Queue, no "when idle": in this mode there is nothing
             sitting in the box to aim anywhere — it already left. What the row
             owes the user instead is the one thing the durable path guarantees
             and this one does not. */
          <div className="compose-bar cli-bar">
            <span className={`cli-note${online ? "" : " warn"}`}>
              <TerminalIcon size={13} />
              {chord.armed
                ? ` ${chord.heldName} held — the next key you type or tap goes with it${online ? "" : " (link is down: it is dropped, not held)"}`
                : online
                ? " keys go straight to the session — nothing is queued or confirmed"
                : " link is down — these keystrokes are dropped, not held"}
            </span>
            {chord.armed ? (
              <button className="send" onPointerDown={keepFocus} onClick={chord.clear}
                title="Let go of the held keys — your draft comes back">
                <X size={ICON} /> let go
              </button>
            ) : (
            <button className="send" onPointerDown={keepFocus} onClick={toggleCliMode}
              title="Back to composing — messages queue, survive a dead link and are confirmed on the host">
              <X size={ICON} /> leave CLI
            </button>
            )}
          </div>
        ) : (
        <div className="compose-bar">
          <div className="compose-scroll">
          {/* Never greyed (CLAUDE.md): at an end of the history, or with an
              empty box, the tap says why nothing moved instead. */}
          <button className="mic" onPointerDown={keepFocus}
            onClick={() => cmdHistory.length === 0 ? showToast("nothing sent yet — no earlier message to recall") : stepHistory(-1)}
            title="Previous sent command"><ArrowUp size={18} /></button>
          <button className="mic" onPointerDown={keepFocus}
            onClick={() => histIdx === -1 ? showToast("this is your draft — there is nothing newer") : stepHistory(1)}
            title="Next sent command"><ArrowDown size={18} /></button>
          <button className={`mic ${clearArmed ? "on" : ""}`} onPointerDown={keepFocus}
            onClick={() => compose ? clearCompose() : showToast("the message box is already empty")}
            title={clearArmed ? "Tap again to clear" : "Clear message box"}><Trash2 size={18} /></button>
          {/* Voice input: the one control every dictation surface draws
              (`VoiceButton.tsx`, where its states are argued). `useVoice` is
              wired in `useCompose` — this bar dictates into `compose`. */}
          <VoiceButton voice={voice} onPointerDown={keepFocus} />
          <button className="mic" onPointerDown={keepFocus} onClick={() => activeRepoId ? pickImageFor(activeRepoId) : showToast("not a known repo")} title="Send image to this repo"><Camera size={18} /></button>
          <button className="mic" onPointerDown={keepFocus} onClick={() => activeRepoId ? pickFileFor(activeRepoId) : showToast("not a known repo")} title="Attach a file of any kind (PDF, doc, zip, audio…) to this repo — images open in the annotator"><Paperclip size={18} /></button>
          <button className={`mic ${snippetOpen ? "on" : ""}`} onPointerDown={keepFocus} onClick={() => setSnippetOpen((v) => !v)}
            title="Insert a saved snippet"><Quote size={18} /></button>
          <button className="mic" onPointerDown={keepFocus} onClick={() => setOverlay("pad")}
            title="Prompt pad — park this thought without picking a target yet"><NotebookPen size={18} /></button>
          {/* A COUNT ON A CONTROL IS A FILTER. This badge counted every repo in
              focus and then opened the list on whatever repo the sheet had last
              been left scoped to — so "7" opened a page showing two, and the
              other five were somewhere the reader had to go and find. The tap
              now scopes the sheet to the session on screen, and the number is
              the length of what that tap opens. */}
          {(() => {
            // …and the tap's OTHER cut: the sheet's default view hides archived
            // rows, so a count that included them described a longer list than
            // the one it opened.
            // done/failed rows stay in, because the default view draws those.
            //
            // …and `hiddenByArchive`, not `!archived`: a row archived while it
            // RUNS is still doing something, and a badge
            // that drops by one for a session still typing is the count
            // describing a shorter list than the sheet it opens.
            const here = (active ? visibleBacklogItems.filter((it) => it.repoDir === active.cwd) : visibleBacklogItems)
              .filter((it) => !hiddenByArchive(it));
            return (
              <button className="mic show-backlog" onPointerDown={keepFocus}
                onClick={() => openBacklogIn(active?.cwd)}
                title={active ? `Backlog for this repo — ${here.length} item${here.length === 1 ? "" : "s"}` : "Show backlog"}>
                <ListTodo size={18} />
                {here.length > 0 && <span className="mic-badge">{here.length}</span>}
              </button>
            );
          })()}
          </div>
          <div className="send-split">
            {/* The button says what it will do, and the chevron is what changes
                that — a split button, which is what it looks like. It is
                remembered PER REPO (`sendMemory.ts`), so five prompts queued
                *when it's free* are five taps on Send and not five on the
                chevron. The per-repo `sendMode` that was deleted armed this
                button with a wall CLOCK and displayed it nowhere, so a repo
                left in "later" turned Send into a schedule editor days after
                anyone chose it; this one holds `now`/`idle` only and spells
                whichever it holds out on the face, before it is tapped. */}
            {/* NEVER disabled. It was, for the whole of an upload — a dimmed
                button whose `title` is invisible on a phone, sitting under a
                99% progress bar, which is the exact shape this app forbids
                (`Unavailable.tsx`). It was also unnecessary: past the park the
                queue orders the prompt behind its picture by itself. The only
                real wait is the park, and that refuses in words. */}
            <button className="send" onPointerDown={keepFocus} onClick={() => sendCompose()}
              title={sendButtonTitle(sendMode, sendWhere, aimedSession ? sessionPickLabel(aimedSession) : null)}>
              {sendMode === "idle" ? <Hourglass size={ICON} /> : <SendHorizontal size={ICON} />}
              {" "}{sendModeLabel(sendMode)}
            </button>
            <button className={`send send-mode${sendMenu ? " on" : ""}`} onPointerDown={keepFocus}
              onClick={() => setSendMenu((v) => !v)}
              aria-expanded={sendMenu}
              data-hint="compose.options"
              title="Change what Send does — which session it runs in, and now or when it's free — or send it somewhere else or later">
              <ChevronsUpDown size={14} />
            </button>
          </div>
        </div>
        )}
        </>)}
      </div>
    </>
  );
}
