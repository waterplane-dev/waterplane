/**
 * The pad's writers: opening it on one note, closing it, and the two things a
 * note can be handed to — the Send sheet (`dispatch`) and its own repo's
 * backlog (`file it`). The editor, the chain and the per-note merge are
 * `PadSheet.tsx`'s and `outbox.ts`'s; nothing here re-implements them.
 */
import type { RepoTarget } from "@waterplane/shared";
import { padFiledToast } from "@waterplane/shared";
import type { PadDraft } from "../../outbox";
import { refsIn } from "../../fileRefs";
import { core } from "../../sdk";
import { padFocus } from "./store";

/** Open the pad scrolled to one note, flashed once. */
export function openPadAt(noteId: string): void {
  padFocus.set(noteId);
  core().nav.open("pad");
}

export function closePad(): void {
  padFocus.set(null);
  core().nav.close("pad");
}

/** One dispatch, into the one Send surface. The note keeps its place until the
 *  send is actually POSTED (`padId` on the seed retires it), so a decision
 *  abandoned halfway costs nothing. */
export function dispatchNote(d: PadDraft): void {
  const c = core();
  c.say.track("action:pad.dispatch");
  c.nav.openSend({
    prompts: [d.text, ...(d.steps ?? [])],
    target: c.send.targetFor(undefined, d.cwd),
    cwdHint: d.cwd ?? null,
    repoId: d.cwd ? c.world.repoForCwd(d.cwd)?.id ?? null : null,
    padId: d.id,
    // A note that names files is exactly the one the four old targets were
    // wrong for: dispatching it sent words pointing at a file whose upload died
    // with the row.
    repair: refsIn(d.text).length > 0,
    origin: "From the pad",
  });
}

/**
 * *file it* — the note, as it is, onto its OWN repo's backlog.
 *
 * The EXISTING outbox `mode: "backlog"` entry, i.e. `backlog.add` with its own
 * ackId, de-duped by the host ledger. No new send path and no wire change: this
 * is the same call the Backlog sheet's own add makes.
 *
 * No `label` is passed, deliberately. The flusher derives one as
 * `text.slice(0, 40)`, which is exactly what `typedName` recognises as DERIVED
 * — so the row arrives untitled by anybody (`headline` absent = nobody said)
 * and the Backlog's *name these N* names it like any other row typed into that
 * sheet. A label minted here would read as a title a person wrote. No `origin`
 * either: nothing scheduled this.
 *
 * And the retire order is `retireSendSource`'s rule: the note goes only once
 * the row is in the durable queue. A refusal (the text names an upload that
 * will never arrive) leaves the words on the pad.
 */
export function fileNote(d: PadDraft, repo: RepoTarget): void {
  if (!d.cwd) return;
  const c = core();
  const offline = c.queue.queueBacklog({
    text: d.text,
    repoDir: d.cwd,
    // `steps[0]` repeats `text`: that is what `deliverChain` runs, and what
    // keeps an older desktop running turn one instead of nothing.
    steps: d.steps?.length ? [d.text, ...d.steps] : undefined,
  });
  if (offline === null) return; // refused — the words stay where they are
  c.compose.removePadNotes([d.id]);
  c.say.toast(padFiledToast(repo.repoName, offline));
}
