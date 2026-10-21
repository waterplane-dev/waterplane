import { useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { Camera, Images, Paperclip, Plus, Quote, Trash2, X } from "lucide-react";
import { Empty } from "./Empty";
import { loadSnippets } from "./localState";
import type { Snippet } from "./SnippetSheet";
import { track } from "./usage";
import { useVoice } from "./useVoice";
import { VoiceButton } from "./VoiceButton";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";

/**
 * The one prompt-writing surface.
 *
 * Every sheet that asks for a prompt was writing its own: a `rows={N}` textarea
 * inside whatever container the sheet happened to use. Two things went wrong
 * with that, both invisible until you are holding the phone.
 *
 * The box was a FIXED number of rows, so on a 2200px screen with the keyboard
 * up the pad's note editor was an eight-row box with half a screen of black
 * under it — the sheet exists to write text and most of it was unusable. A
 * prompt box has exactly one right size: what the sheet gives it. So the
 * primary box GROWS to fill (`flex: 1 0 auto` inside a scrolling column) and
 * only starts scrolling once there are steps below it.
 *
 * And the features diverged. The Start sheet grew a prompt CHAIN and file
 * attachment because that is where a plan gets written on a train; the pad grew
 * neither, although a note written on the same train is the same act with the
 * target left blank. Sharing this component is what keeps "write a prompt" one
 * thing rather than five that drift.
 *
 * What it does NOT own: where the text goes. The chain is a plain
 * `string[]` the caller persists and dispatches; attachment routing (annotate
 * vs park, which repo, which lane) stays with the sheet, because that is the
 * part that differs.
 */
interface Props {
  /** The chain. `[0]` is the primary prompt; the rest are steps, each delivered
   *  only after the previous one's turn has ended. */
  prompts: string[];
  /** Called with the whole next chain — the caller is the authority on it (both
   *  sheets persist it per keystroke, so it cannot live in here). */
  onChange: (next: string[]) => void;
  placeholder: string;
  /** Chain offered? Off = a single box, which is what a one-shot editor wants. */
  chain?: boolean;
  stepPlaceholder?: string;
  /** The line above each step. Says WHY it is a step and not another paragraph. */
  stepHint?: string;
  addLabel?: string;
  /** Usage key for the add button, so each sheet's chain is countable on its own. */
  trackAdd?: string;
  autoFocus?: boolean;
  /**
   * The box is INSIDE something else — a queue row being rewritten, a backlog
   * item being edited, a scrolling editor with seven more fields under it.
   *
   * "A prompt box has one right height: whatever the sheet is not using" is the
   * argument this component was written for, and it holds only where the sheet
   * has nothing else to give the box. Inline, the sheet is using that room, and
   * a `flex: 1` box with an 8.5em floor either eats the fields below it or,
   * with no flex parent to fill, silently becomes a fixed 8.5em box anyway —
   * bigger than the three rows it replaced and no more useful. So an inline
   * composer takes `rows` and grows on its own, like the textarea it replaces,
   * and shares everything else: the chain, the step rules, the placeholder.
   */
  inline?: boolean;
  /** Inline only: the starting height, in rows. */
  rows?: number;
  /**
   * **Which turn the caret is in**, written on every focus.
   *
   * Shared with `AttachButtons`, which is mounted somewhere else entirely (the
   * sheet's action bar) and therefore cannot see the focus itself. Dictation
   * used to take `prompts.current[0]` as its base and write `next[0]` no matter
   * what — so speaking with the caret in turn 3 appended the words to turn 1,
   * mid-sentence. Not a loss (it appends), but a surprise, and a surprise about
   * where somebody's words went.
   *
   * A ref and not state for the reason every other prompt ref here is one: the
   * speech callback is captured when the mic is tapped and lives for as long as
   * somebody keeps talking. Optional — a sheet with one box has one answer.
   */
  focusRef?: MutableRefObject<number>;
  /**
   * Words for a machine, not a sentence — the live desktop's typing box: no capital the keyboard
   * adds by itself (a lone `ls` arrived as `Ls`), no autocorrect, no spellcheck.
   */
  plain?: boolean;
  /** Under the primary box: hints, an `AttachStrip`, anything sheet-specific. */
  children?: ReactNode;
}

const PLAIN = { autoCapitalize: "none", autoCorrect: "off", spellCheck: false } as const;

export function PromptComposer({
  prompts, onChange, placeholder, chain, stepPlaceholder = "…and then?",
  stepHint = "then, once the turn before it finishes:", addLabel = "another prompt",
  trackAdd, autoFocus, children, inline, rows, focusRef, plain,
}: Props) {
  const text = prompts[0] ?? "";
  const steps = prompts.slice(1);
  const setAt = (i: number, v: string) => {
    const next = prompts.length ? prompts.slice() : [""];
    next[i] = v;
    onChange(next);
  };
  const filled = prompts.map((p) => p.trim()).filter(Boolean);

  return (
    <div className={`promptc${inline ? " promptc-inline" : ""}`}>
      <textarea
        className="search promptc-area"
        autoFocus={autoFocus}
        rows={inline ? rows ?? 3 : undefined}
        {...(plain ? PLAIN : {})}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setAt(0, e.target.value)}
        onFocus={() => { if (focusRef) focusRef.current = 0; }}
        style={{ resize: "vertical", fontFamily: "inherit" }}
      />
      {children}
      {/* The rest of the chain. Each one is delivered only after the previous
          turn has ENDED — they are steps, not a paste: written into the
          composer back-to-back the TUI would glue them into one line. */}
      {chain && steps.map((p, i) => (
        <div key={i} className="promptc-step">
          <Hint style={{ padding: 0 }}>{stepHint}</Hint>
          <textarea
            className="search"
            rows={4}
            placeholder={stepPlaceholder}
            value={p}
            onChange={(e) => setAt(i + 1, e.target.value)}
            onFocus={() => { if (focusRef) focusRef.current = i + 1; }}
            style={{ resize: "vertical", fontFamily: "inherit" }}
          />
          <div className="queue-row-acts">
            <span className="spacer" />
            <Button variant="danger" title="drop this step"
              onClick={() => onChange(prompts.filter((_, j) => j !== i + 1))}><Trash2 size={16} /></Button>
          </div>
        </div>
      ))}
      {/* ABSENT until there is a first prompt, never dimmed with the reason in
          a `title` no phone displays: an empty box above it says why on its
          own, and there is nothing a second turn could follow. */}
      {chain && !!filled.length && (
        <div className="queue-row-acts promptc-add">
          <Button
            title="add another prompt, delivered after this one's turn ends"
            onClick={() => { if (trackAdd) track(trackAdd); onChange([...prompts, ""]); }}>
            <Plus size={16} /> {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

interface AttachProps {
  /**
   * The chain being written, BY REF, plus the way to rewrite it — what the mic
   * dictates into.
   *
   * A ref and not a value for the reason the two sheets that own one already
   * keep it: a dictation session lasts for as long as somebody keeps talking,
   * and the callback the Web Speech API holds is the one captured when the
   * button was tapped. Handed a plain array, every result for the next minute
   * would be written over the chain as it looked BEFORE the person started —
   * silently discarding a step they added, or a path an attach appended,
   * mid-sentence. The ref is the authority for the same reason it already is
   * on the attach path.
   *
   * Required, not optional: dictation went missing once by being a feature one
   * sheet happened to have (see `DictateButton`), and a required prop is the
   * only version of "every sheet with the action bar has voice" that a new
   * sheet cannot quietly skip.
   */
  prompts: MutableRefObject<string[]>;
  onPrompts: (next: string[]) => void;
  /** An attach is being prepared (shrink + park). Only labels the button — the
   *  primary action of a sheet is never disabled by it — `SendSheet` waits. */
  busy?: boolean;
  /** Nothing can be attached yet (no repo picked, say) — with a reason. */
  disabled?: boolean;
  disabledTitle?: string;
  /** Picked files, routed by the SHEET: images usually go to the annotator,
   *  everything else straight into the send queue. Routing by the file's own
   *  type and not by which button was tapped is the rule everywhere in this app,
   *  so a JPEG reached through "file" behaves like one reached through "image". */
  onFiles: (files: File[]) => void;
  /** Usage keys, one per button. */
  trackImage?: string;
  trackFile?: string;
  /** The turn the caret is in, written by the `PromptComposer` this bar belongs
   *  to — see its own `focusRef`. Dictation writes into THAT turn. */
  focusRef?: MutableRefObject<number>;
  /**
   * **A file that is already in the repo**, as opposed to one on this phone.
   *
   * Rendered only where the caller can route it. The two attach buttons above
   * both PARK NEW BYTES; naming a picture the repo already has was a separate
   * capability that only the deleted backlog add form ever offered, and the
   * only route left was the clipboard — which does not exist on a plain
   * `http://100.x` origin, i.e. exactly the tunnel the APK usually runs over.
   */
  onBrowse?: () => void;
  browseLabel?: string;
}

/**
 * The image/file pair for a sheet's action bar, plus the two hidden inputs.
 *
 * Separate from `PromptComposer` because these live in the pinned footer
 * (`.sheet-actions`) while the composer is the scrolling body — but they are
 * one feature, and a sheet that has the box should be able to have the buttons
 * by adding one element.
 *
 * `accept="image/*"` is what makes a phone offer the camera, so the image
 * button keeps it and documents get their own input.
 */
export function AttachButtons({ prompts, onPrompts, busy, disabled, disabledTitle, onFiles, trackImage, trackFile, focusRef, onBrowse, browseLabel = "in repo" }: AttachProps) {
  const imgRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<HTMLInputElement>(null);
  const take = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (f.length) onFiles(f);
  };
  return (
    <>
      <DictateButton prompts={prompts} onPrompts={onPrompts} focusRef={focusRef} />
      <SnippetButton prompts={prompts} onPrompts={onPrompts} focusRef={focusRef} />
      <Button disabled={busy || disabled} title={disabled ? disabledTitle : "attach an image (mark it up before it goes)"}
        onClick={() => { if (trackImage) track(trackImage); imgRef.current?.click(); }}>
        <Camera size={16} /> {busy ? "adding…" : "image"}
      </Button>
      <Button disabled={busy || disabled}
        title={disabled ? disabledTitle : "attach a file of any kind (PDF, doc, zip, audio…)"}
        onClick={() => { if (trackFile) track(trackFile); docRef.current?.click(); }}>
        <Paperclip size={16} /> file
      </Button>
      {onBrowse && (
        <Button disabled={busy || disabled}
          title={disabled ? disabledTitle : "name a file that is already in this repo — the gallery, and the path comes back into the prompt"}
          onClick={onBrowse}>
          <Images size={16} /> {browseLabel}
        </Button>
      )}
      <input ref={imgRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={take} />
      <input ref={docRef} type="file" multiple style={{ display: "none" }} onChange={take} />
    </>
  );
}

/**
 * The saved snippets, beside the attach buttons — the compose bar's quote
 * button, for the sheets that write a prompt somewhere else.
 *
 * Same argument as dictation below: it was on the compose bar only, so writing
 * a prompt in the Send sheet or the pad meant retyping the text a snippet
 * exists to save. Read from storage on each OPEN rather than held as props —
 * the list is edited on another screen (`SnippetSheet`) and synced, and a
 * sheet mounted before that edit would otherwise offer the old one.
 *
 * It APPENDS to the turn the caret is in, newline-separated, the rule the
 * compose bar's `appendSnippet` follows: a snippet is never a replacement for
 * what is already written.
 */
function SnippetButton({ prompts, onPrompts, focusRef }:
  { prompts: MutableRefObject<string[]>; onPrompts: (next: string[]) => void; focusRef?: MutableRefObject<number> }) {
  const [open, setOpen] = useState<Snippet[] | null>(null);
  const insert = (sn: Snippet) => {
    track("action:snippet.insert");
    const at = Math.min(Math.max(focusRef?.current ?? 0, 0), Math.max(prompts.current.length - 1, 0));
    const next = prompts.current.length ? prompts.current.slice() : [""];
    const c = next[at] ?? "";
    next[at] = (c && !/\s$/.test(c) ? c + "\n" : c) + sn.text;
    onPrompts(next);
    setOpen(null);
  };
  return (
    <>
      <button className={`key${open ? " on" : ""}`} title="insert a saved snippet into the turn the caret is in"
        onClick={() => setOpen((v) => (v ? null : loadSnippets()))}>
        <Quote size={16} /> snippet
      </button>
      {open && (
        <div className="snippet-pop">
          <div className="snippet-pop-head">
            <span>Snippets</span>
            <Button onClick={() => setOpen(null)} title="Close"><X size={14} /></Button>
          </div>
          <div className="snippet-pop-list">
            {open.length === 0 && <Empty>No snippets yet — add them from the compose bar's snippet button, under “manage”.</Empty>}
            {open.map((sn) => (
              <button key={sn.id} className="snippet-pop-item" title={sn.text} onClick={() => insert(sn)}>
                <span className="snippet-pop-title">{sn.title}</span>
                <span className="snippet-pop-preview">{sn.text.replace(/\s+/g, " ").trim()}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Dictation, beside the attach buttons.
 *
 * It used to live in the Backlog sheet's own add form. That form was a fifth
 * prompt textarea and was deleted for being one; the microphone went out with
 * it, and speaking a backlog item became three screens — open a session,
 * dictate into the compose bar, then *elsewhere or later…* — for something that
 * had been one tap. Nobody decided that; it fell out of a deletion.
 *
 * Which is the argument for it living HERE rather than being put back on
 * whichever sheet somebody next notices it missing from. A capability added per
 * sheet is a capability that disappears with a sheet, and "the one prompt
 * surface" is only worth the rule if the surface actually carries everything
 * writing a prompt needs. So it is part of the action bar: a sheet that draws
 * `AttachButtons` has voice, and one that forgets does not type-check.
 *
 * Two behaviours it does NOT get to choose:
 *
 *  - **Dictation APPENDS.** `useVoice` snapshots whatever is in the box as its
 *    base and grows the transcript onto the end of it. The typed words are the
 *    last copy of themselves — nothing in this app lists a draft — so starting
 *    a mic over one is a delete, not a fresh start.
 *  - **Unsupported is ABSENT, not dimmed.** No Web Speech API (every WebView
 *    without Google's speech service, Firefox, a locked-down Android build) and
 *    there is no button at all. A greyed control explains nothing on a phone,
 *    where a `title` never appears.
 *
 * What it LOOKS like is not this function's either: it draws `VoiceButton`,
 * the one voice-input control, the same round mic the compose bar carries.
 * This is only the adapter from that control to a prompt chain held by ref.
 */
export function DictateButton({ prompts, onPrompts, focusRef, boxKey = "step" }:
  {
    prompts: MutableRefObject<string[]>; onPrompts: (next: string[]) => void; focusRef?: MutableRefObject<number>;
    /** Whose box this is, for the landing check below. A second chrome (a
     *  file remark, `FileReview.tsx`) names itself, so a held recording made
     *  for one remark never lands in a send sheet's turn 1 — or another
     *  remark — that happens to be open when the words arrive. */
    boxKey?: string;
  }) {
  /**
   * WHICH turn it dictates into: the one the caret is in, clamped to a step
   * that still exists (a step can be dropped while the mic is on). It was
   * hard-wired to turn 1, which put speech into the top box while the person
   * was looking at turn 3.
   */
  const stepAt = () => Math.min(Math.max(focusRef?.current ?? 0, 0), Math.max(prompts.current.length - 1, 0));
  /**
   * The turn is the box's IDENTITY as well as its address.
   *
   * A recording made on a dead tunnel is held and read later
   * (`dictateQueue.ts`), and by then the caret may be in another turn of the
   * chain. Appending there would put a sentence into a step it was not said
   * about, so the key is checked at landing and the pad takes the words
   * instead, with a toast that says where they went.
   */
  const voice = useVoice({
    key: () => `${boxKey}:${stepAt()}`,
    read: () => prompts.current[stepAt()] ?? "",
    write: (text) => {
      const next = prompts.current.length ? prompts.current.slice() : [""];
      next[stepAt()] = text;
      onPrompts(next);
    },
  });
  return <VoiceButton voice={voice} idleTitle="dictate into the turn the caret is in — added to what is already written, never over it" />;
}
