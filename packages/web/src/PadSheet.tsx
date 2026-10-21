import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Files, ListPlus, NotebookPen, Plus, SendHorizontal, Trash2, X } from "lucide-react";
import { FILE_WORDS, PAD_HINT, type RepoTarget } from "@waterplane/shared";
import { AttachStrip } from "./AttachStrip";
import { dropFileRef } from "./fileRefs";
import { AttachButtons, PromptComposer } from "./PromptComposer";
import { RepoPicker } from "./RepoPicker";
import { SyncMark } from "./SyncMark";
import { isAnnotatable } from "./media";
import { addPadNote, loadPad, removePadNotes, updatePadNote, loadSheetDraft, saveSheetDraft, type OutboxEntry, type PadDraft } from "./outbox";
import { onSettingsChange } from "./settings";
import { track } from "./usage";
import { LS } from "./storage";
import { SheetHead } from "./Sheet";
import { ConfirmButton } from "./Confirm";
import { Empty } from "./Empty";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";

interface Props {
  /** Repos — for the inbox an attachment needs, and for naming a note's own. */
  repos: RepoTarget[];
  /**
   * Hand this note to the one Send surface — the sheet that asks where, when
   * and how many at once, all four with an answer already filled in.
   *
   * It used to be FOUR buttons and three inline pickers on every row (a live
   * session, a repo's work items, a fresh session, a fan-out) plus a fifth for
   * "check its files first" — five destinations, no WHEN at all, and each one
   * asking a note that had already recorded which repo it was written for. One
   * button, because the note is the WHAT and everything else is the decision
   * the Send sheet exists to take.
   *
   * The note is NOT removed here. A dispatch that opens a sheet is not a send:
   * the seed carries the note's id and the successful POST retires it, so a
   * cancelled decision leaves the words exactly where they were.
   */
  onDispatch: (d: PadDraft) => void;
  /**
   * Put this note on its OWN repo's backlog, as it is.
   *
   * The one thing a target-less note can do without the Send sheet, and only
   * because it has already answered that sheet's first question: it names a
   * repo. Everything else — when, whether anything runs now, how many at once —
   * a backlog row answers by being a backlog row. Drawn only where the `cwd`
   * resolves, and NOTHING is drawn where it does not: `send…` is that note's
   * path and the hint above says so. A dimmed sibling would be a control whose
   * reason lives in a `title` nobody on a phone can see (`Unavailable.tsx`).
   */
  onFile: (d: PadDraft, repo: RepoTarget) => void;
  /** The live send queue and link state, so the strip can say where each file
   *  stands rather than only what it is called. */
  outbox: OutboxEntry[];
  online: boolean;
  /** Which repo a note's paths belong to (from its `cwd`). */
  repoIdForCwd: (cwd: string) => string | null;
  /**
   * Scroll to this note and flash it once, on open.
   *
   * Anything that says "your words are on the pad" points here by note id. That
   * sentence is only an answer when it points at the NOTE — the pad is a pile of
   * everything with no target yet, and a person who arrives to find a list has
   * been given a search, not their message back.
   */
  focusId?: string | null;
  /**
   * Park picked files in a repo's inbox and resolve to the repo-relative path
   * each one WILL have — the Start sheet's `onAttach`, aimed at a repo the note
   * has to name first.
   *
   * A pad note is target-less by design, but a FILE is not: bytes have to be
   * uploaded into some repo, under a path minted now, so attaching is the one
   * act that makes a note pick a repo early. That choice is remembered as the
   * note's `cwd`, so the strip can keep telling the truth about those files
   * afterwards — and it is what makes *file it* offerable.
   */
  onAttach: (files: File[], repo: RepoTarget) => Promise<string[]>;
  /** Hand picked IMAGES to the annotator (which replaces this sheet — the
   *  editor buffer is persisted per keystroke, and the marked path is appended
   *  to it, so what comes back has both). */
  onAnnotate: (files: File[], repo: RepoTarget) => void;
  onClose: () => void;
}

/** The open editor's live buffer, persisted per keystroke. */
const EDIT_KEY = "pad.editor";

/**
 * The prompt pad — drafts with NO target.
 *
 * Every other way of writing something here demands a destination first: a
 * compose box belongs to a session, a backlog row belongs to a repo, a fan-out
 * belongs to a repo list. That is the wrong order for how the ideas actually
 * arrive — on a train, in a queue, away from the desk, usually with no tunnel.
 * You know the sentence long before you know which of eleven repos it is for.
 *
 * So the pad holds text and nothing else, in localStorage (`waterplane.pad`), and the
 * decision is a separate, later act. It NEVER touches the socket: both target
 * actions call back into App's existing durable paths (the send queue, the
 * backlog queue), so the at-most-once contract, the per-session lane rule and
 * the offline behaviour are the ones already pinned by e2e-queue — there is no
 * second send path to keep in sync.
 */
export function PadSheet({ repos, onDispatch, onFile, outbox, online, repoIdForCwd, focusId, onAttach, onAnnotate, onClose }: Props) {
  const [drafts, setDrafts] = useState<PadDraft[]>(loadPad);
  // "Your words are on the pad" is only an answer if it points at the note.
  // Scroll to that row and flash it once — same rule and same class as
  // `NetHealthSheet`'s section focus, since a sheet that silently opens mid-list
  // reads as one that opened in the wrong place. Runs when the id changes,
  // never on every re-render of the list.
  const focusRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = focusRef.current;
    if (!focusId || !el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("nh-flash");
    const t = window.setTimeout(() => el.classList.remove("nh-flash"), 1400);
    return () => window.clearTimeout(t);
  }, [focusId]);
  // The pad follows the user across devices (settings.ts): a note written on the
  // phone is meant to be sendable from the desktop, so adopt a remote edit while
  // the sheet is open rather than at the next reload. Every local write in this
  // file announces the same key, so this is also how the list re-reads itself.
  useEffect(() => onSettingsChange(() => setDrafts(loadPad()), [LS.pad]), []);
  // Which draft is open in the editor (id), or "new" for an unsaved one.
  //
  // The editor buffer is persisted on EVERY keystroke, not on Save. A note is
  // typically written with no tunnel, on a phone that kills the backgrounded
  // tab and reloads itself when a reconnect goes nowhere — so "it's only lost
  // if you forget to tap Save" was really "it's lost whenever the network
  // decides". A buffer left behind by such a kill reopens the editor on the
  // next mount with the text still in it.
  const stashed = loadSheetDraft(EDIT_KEY);
  const [editing, setEditing] = useState<string | null>(stashed ? (loadSheetDraft(`${EDIT_KEY}.id`) || "new") : null);
  /**
   * Why the last Save did not happen, in the store's own words.
   *
   * The pad refuses rather than sheds (`addPadNote`), so a refusal is a state
   * this editor has to survive: the buffer stays, the sheet stays open, and the
   * sentence sits under it. Clearing the box before checking would have made
   * the refusal a delete.
   */
  const [refused, setRefused] = useState<string | null>(null);
  // The chain, as ONE stored string separated by a form feed — the same shape
  // and the same reason as the Start sheet's draft: the sheet-draft store is a
  // flat Record<string,string>, and \f cannot be typed on a phone keyboard, so
  // it can never appear inside a note and split it.
  const [prompts, setPrompts] = useState<string[]>(() => stashed.split("\f"));
  // The ref is the authority: attaching a file appends a path and the sheet can
  // unmount (the annotator takes the overlay) before a state update is applied.
  const promptsRef = useRef(prompts);
  /** Which turn the caret is in — written by `PromptComposer` on focus, read by
   *  the action bar's mic so speech lands in the turn the person is looking at
   *  rather than always in turn one. */
  const focusStep = useRef(0);
  function updatePrompts(next: string[]) {
    promptsRef.current = next;
    setPrompts(next);
    // Written HERE, not only in the effect below, for the same reason the Start
    // sheet does: an effect belonging to a component that unmounts in the same
    // commit never runs, and the path just appended would be missing from the
    // buffer this editor re-reads when it comes back from the annotator.
    saveSheetDraft(EDIT_KEY, next.join("\f"));
  }
  const text = prompts[0] ?? "";
  /** The repo attachments go to, once the note has picked one. Kept in the draft
   *  store rather than state alone, because the annotator unmounts this sheet
   *  and the returning path is only meaningful inside that repo. */
  const [attachCwd, setAttachCwd] = useState<string>(() => loadSheetDraft(`${EDIT_KEY}.cwd`));
  const attachRepo = repos.find((r) => r.worktreePath === attachCwd) ?? null;
  // Files picked before a repo was chosen — held while the picker is up.
  const heldRef = useRef<File[]>([]);
  const [askRepo, setAskRepo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shots, setShots] = useState<string[]>([]);
  // Write-through: the buffer is what survives, so it has to be on disk before
  // anything can interrupt.
  useEffect(() => {
    if (editing === null) return;
    const buf = prompts.join("\f");
    saveSheetDraft(EDIT_KEY, buf);
    saveSheetDraft(`${EDIT_KEY}.id`, buf.trim() ? editing : "");
    saveSheetDraft(`${EDIT_KEY}.cwd`, buf.trim() ? attachCwd : "");
  }, [editing, prompts, attachCwd]);
  function closeEditor() {
    saveSheetDraft(EDIT_KEY, "");
    saveSheetDraft(`${EDIT_KEY}.id`, "");
    saveSheetDraft(`${EDIT_KEY}.cwd`, "");
    setEditing(null);
    setRefused(null);
    updatePrompts([""]);
    setAttachCwd("");
    setShots([]);
    setAskRepo(false);
    heldRef.current = [];
  }

  /**
   * Picked files, routed by the file's own type — images to the annotator,
   * everything else straight into the send queue. Same rule as the Start sheet
   * and the compose bar; the difference here is that a note has no repo yet, so
   * the first attach asks for one and the answer is remembered on the note.
   */
  function pickFiles(files: File[], repo: RepoTarget | null = attachRepo) {
    if (!files.length) return;
    if (!repo) { heldRef.current = files; setAskRepo(true); return; }
    setAttachCwd(repo.worktreePath);
    saveSheetDraft(`${EDIT_KEY}.cwd`, repo.worktreePath);
    const images = files.filter(isAnnotatable);
    const rest = files.filter((f) => !isAnnotatable(f));
    // Non-images first, so references come out in pick order — the annotator's
    // result is appended to the same buffer afterwards.
    if (rest.length) void attach(rest, repo);
    if (images.length) onAnnotate(images, repo);
  }
  async function attach(files: File[], repo: RepoTarget) {
    setBusy(true);
    try {
      const paths = await onAttach(files, repo);
      if (!paths.length) return;
      setShots((cur) => [...cur, ...paths]);
      // Into the note itself: that is what an agent reads, and it stays visible
      // and editable rather than being invisible metadata.
      const cur = promptsRef.current.length ? promptsRef.current.slice() : [""];
      const head = cur[0] ?? "";
      cur[0] = head ? `${head}${/\s$/.test(head) ? "" : " "}${paths.join(" ")}` : paths.join(" ");
      updatePrompts(cur);
    } finally {
      setBusy(false);
    }
  }

  function startNew() { track("action:pad.new"); setEditing("new"); setRefused(null); updatePrompts([""]); setAttachCwd(""); setShots([]); }
  function startEdit(d: PadDraft) {
    setEditing(d.id);
    setRefused(null);
    updatePrompts([d.text, ...(d.steps ?? [])]);
    setAttachCwd(d.cwd ?? "");
    setShots([]);
  }
  /**
   * Save, against what is on disk right now — and never clear the buffer until
   * the store has said yes.
   *
   * `drafts` is React state seeded at mount and this sheet is not the only
   * writer: another device's pad lands through `settings.ts` with no sheet
   * involved. So every mutation goes through `outbox.ts`, which reads the value
   * fresh and merges by note id; deriving a new whole list from the mounted copy
   * used to persist a snapshot from before those notes existed. And the refusal
   * is checked BEFORE `closeEditor`, or a pad at its cap would have answered a
   * Save by deleting the words it refused to keep.
   */
  function commit() {
    const id = editing;
    // Read the REF, not the state: an attach that landed microseconds ago wrote
    // the path through `updatePrompts`, and the render that would put it in
    // `prompts` has not necessarily happened.
    const chain = promptsRef.current.map((p) => p.trim()).filter(Boolean);
    const cwd = attachCwd;
    if (!id) { closeEditor(); return; }
    if (!chain.length) { // emptied = deleted, the obvious reading
      // Through `removePadNotes` like every other delete here: the tombstone is
      // what stops the other device unioning this note straight back in.
      if (id !== "new") removePadNotes([id]);
      closeEditor();
      setDrafts(loadPad());
      return;
    }
    track("action:pad.save");
    const [t, ...steps] = chain;
    const isNew = id === "new";
    const existing = isNew ? undefined : loadPad().find((d) => d.id === id);
    // Steps are stored BESIDE the text, never inside it: `text` stays "the note"
    // for everything that already reads one (the row, the Send sheet, the file
    // check), so a chained note degrades to its first step rather than to a
    // string with control characters in it.
    const note: PadDraft = {
      id: isNew ? `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` : id,
      text: t,
      // Every save re-stamps, an edit included — which is what makes `ts` the
      // field `mergePad` compares two copies of one note on.
      ts: Date.now(),
    };
    if (steps.length) note.steps = steps;
    const home = cwd || existing?.cwd;
    if (home) note.cwd = home;
    const why = isNew ? addPadNote(note) : updatePadNote(note);
    if (why) { setRefused(why); return; } // buffer intact, sheet open, reason on screen
    closeEditor();
    setDrafts(loadPad());
  }
  function remove(id: string) {
    track("action:pad.remove");
    removePadNotes([id]);
    setDrafts(loadPad());
  }
  if (editing !== null) {
    return (
      <div className="sheet">
        <SheetHead title={<><NotebookPen size={16} /> {editing === "new" ? "New note" : "Edit note"}</>} onClose={closeEditor} />
        <Hint>
          Just the text. You pick where it goes when you get there.
          {attachRepo && <> Files go to <strong>{attachRepo.repoName}</strong>&apos;s inbox — that much the note has decided.</>}
        </Hint>
        {refused && <Hint tone="warn">{refused}</Hint>}
        <PromptComposer
          prompts={prompts}
          onChange={updatePrompts}
          placeholder="What should someone do about this?"
          chain
          stepHint="then, once that step's turn finishes:"
          trackAdd="action:pad.addprompt"
          focusRef={focusStep}
          autoFocus
        >
          {shots.length > 0 && (
            <Hint>
              <Files size={12} /> {shots.length} file{shots.length > 1 ? "s" : ""} queued for {attachRepo?.repoName ?? "that repo"}&apos;s inbox — the paths are in the note above.
            </Hint>
          )}
          {/* The same check the queue and the Send sheet run: a note that names
              a file is only as good as the file arriving. */}
          <AttachStrip compact debounceMs={700} text={text} repoId={attachRepo?.id ?? null}
            outbox={outbox} online={online}
            onRemove={(rel) => updatePrompts(promptsRef.current.map((p) => dropFileRef(p, rel)))} />
        </PromptComposer>
        {/* Attaching is the one act that makes a target-less note name a repo:
            bytes have to be uploaded somewhere, under a path minted now. Asked
            once, then remembered as the note's cwd. */}
        {askRepo && (
          <div className="queue-aim attach-aim">
            <Hint>Whose inbox do these files go to?</Hint>
            <RepoPicker repos={repos} listClass="" onPick={(r) => {
              const held = heldRef.current;
              heldRef.current = [];
              setAskRepo(false);
              pickFiles(held, r);
            }} />
          </div>
        )}
        <div className="sheet-actions">
          <Button onClick={closeEditor}><X size={16} /> cancel</Button>
          <AttachButtons prompts={promptsRef} onPrompts={updatePrompts} focusRef={focusStep} busy={busy} onFiles={(f) => pickFiles(f)}
            disabled={!repos.length} disabledTitle="no repos under the host root to upload into"
            trackImage="action:pad.attach" trackFile="action:pad.attachfile" />
          <span className="spacer" />
          <button className="send" onClick={commit}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet">
      <SheetHead title={<><NotebookPen size={16} /> Prompt pad</>} onClose={onClose}>
        <Button onClick={startNew}><Plus size={16} /> new</Button>
      </SheetHead>
      {/* The pad is synced, and it is by design the last copy of words nobody
          has decided about yet. The merge is per NOTE now (`shared/pad.ts`, on
          adopt, with tombstones for the deletes), so a value arriving from
          another device no longer replaces the list — but a screen showing
          those words identically whether the desktop has them or not is still
          the omission this mark exists for. */}
      <SyncMark keys={[LS.pad]} thing="your notes" />
      <Hint>{PAD_HINT}</Hint>
      <div className="list">
        {drafts.length === 0 && <Empty>Nothing on the pad. Tap “new” to park a thought.</Empty>}
        {drafts.map((d) => {
          const home = d.cwd ? repos.find((r) => r.worktreePath === d.cwd) : undefined;
          return (
            <div key={d.id} className="pad-item" ref={d.id === focusId ? focusRef : undefined}>
              <div className="queue-row">
                <button className="queue-text" onClick={() => startEdit(d)} title="tap to edit">
                  <span className="queue-text-body">{d.text}</span>
                  {/* The repo is stated on the row, not only inside a picker: a
                      note written for one repo is read as "which of my eleven
                      was this for?", and it has known the answer the whole
                      time — which is also what makes “file it” offerable. */}
                  <span className="queue-meta">{(d.steps?.length ?? 0) > 0 && <>+{d.steps!.length} step{d.steps!.length > 1 ? "s" : ""} · </>}{home ? <>{home.isPrimary ? home.repoName : `${home.repoName} · ${home.branch}`} · </> : null}{new Date(d.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                </button>
                <div className="queue-row-acts">
                  {/* Only where the note's own repo resolves. A note with no
                      repo draws NOTHING here — `send…` is its path, the hint at
                      the top says so, and a dimmed sibling would put the reason
                      in a `title` no phone renders. */}
                  {home && (
                    <Button title={FILE_WORDS.title(home.repoName)}
                      onClick={() => { track("action:pad.file"); onFile(d, home); }}>
                      <ListPlus size={16} /> {FILE_WORDS.label}
                    </Button>
                  )}
                  {/* One button. Where it goes, when it runs and whether N repos
                      run together are the Send sheet's four questions, and this
                      note has already answered one of them. */}
                  <Button title="send it — pick where and when in one sheet"
                    onClick={() => { track("action:pad.dispatch"); onDispatch(d); }}>
                    <SendHorizontal size={16} /> send…
                  </Button>
                  {/* Two taps. A delete here writes a TOMBSTONE that travels
                      (`removePadNotes`) — it is a real delete on every device,
                      not a note that disappears from this one and comes back at
                      the next merge — and this trash sits a thumb's width from
                      "send…" on a phone. */}
                  <ConfirmButton className="key danger" title="discard"
                    confirmTitle="tap again and this note is gone" confirm="discard?"
                    onConfirm={() => remove(d.id)}><Trash2 size={16} /></ConfirmButton>
                </div>
              </div>
              {/* A note still names its attachments by a path nobody can read.
                  Show them as pictures, and say which of them is actually going
                  to be there before anything is sent or filed. */}
              <AttachStrip compact text={d.text} repoId={d.cwd ? repoIdForCwd(d.cwd) : null}
                outbox={outbox} online={online} />
            </div>
          );
        })}
      </div>
      <div className="sheet-actions">
        <Button onClick={onClose}><ChevronLeft size={16} /> back</Button>
        <span className="spacer" />
        <span className="set-note" style={{ padding: 0 }}>{drafts.length} note{drafts.length === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}
