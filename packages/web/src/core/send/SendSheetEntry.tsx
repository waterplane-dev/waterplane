/**
 * The `send` overlay: the one send surface, behind every entry point that used
 * to be its own sheet. A `repair` seed turns on the file check and the
 * per-file fixes — what `ResendSheet` was; a `scheduleId` makes the save an
 * upsert of an existing schedule rather than a new one.
 *
 * Lifted out of App's `overlayViews.send` unchanged. What the sheet decides
 * goes through `useSend`'s `dispatchIntent` and nowhere else.
 */
import type { OutboxEntry } from "../../outbox";
import { clearSheetDraft, removePadNotes } from "../../outbox";
import { SendSheet } from "../../SendSheet";
import type { RepoTarget, SessionInfo, UsageInfo, Intent } from "@waterplane/shared";
import type { SheetId } from "../../sdk/types.ts";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { SEND_DRAFT } from "../../sendIntent";
import type { SendApi } from "./useSend";

export interface SendSheetEntryProps {
  send: SendApi;
  sessions: SessionInfo[];
  pendingSession: SessionInfo | null;
  visibleRepos: RepoTarget[];
  outbox: OutboxEntry[];
  online: boolean;
  usage: UsageInfo | null;
  intents: Intent[];
  /** The queue core's verb — a discarded row goes the way every discard goes. */
  removeQueued(ackId: string): void;
  /** `closeSheet` — never a bare `setOverlay(null)` (see below). */
  closeSheet(self: SheetId): void;
  onAttach(files: File[], repo: RepoTarget): Promise<string[]>;
  onAnnotate(files: File[], repo: RepoTarget): void;
  onBrowseRepoFiles(repo: RepoTarget): void;
}

export function SendSheetEntry(p: SendSheetEntryProps) {
  const { send, sessions, pendingSession, removeQueued } = p;
  const { sendSeed, setSendSeed, sendResumeRef, dispatchIntent, noteSendAim, retireSendSource, openSent } = send;
  if (!sendSeed) return null;
  return <>
    <SendSheet
      // The session being opened is a legitimate target (its lane already
      // takes prompts), and without it the sheet can only call it "that
      // session".
      seed={sendSeed} sessions={pendingSession ? [...sessions, pendingSession] : sessions} repos={p.visibleRepos}
      outbox={p.outbox} online={p.online} usage={p.usage}
      // The store itself, not a list of names: the *after another…* picker
      // titles a row with `intentTitle` and decides what may be chained
      // behind with `chainCandidates`, and both of those are rules that
      // exist once.
      intents={p.intents}
      buildName={send.buildNames}
      onAttach={p.onAttach}
      onAnnotate={p.onAnnotate}
      // Reference a file the repo ALREADY has. The gallery takes the overlay,
      // `returnTo` brings this sheet back and `insertInto` puts the path into
      // its draft — a round trip rather than the clipboard because a plain
      // `http://100.x` origin has no clipboard at all.
      onBrowseRepoFiles={p.onBrowseRepoFiles}
      resume={sendResumeRef.current}
      onDecide={(d) => { sendResumeRef.current = d; }}
      onReattach={send.reattachKept}
      onReplace={send.pickReplacement}
      onSend={(intent) => {
        if (!dispatchIntent(intent, sendSeed)) return false;
        // How this repo is being driven right now, for the next send from
        // it. Only a single-repo target has a repo to remember against — a
        // sweep is one decision over N — and `rememberSend` drops what
        // cannot be re-offered (a chain, a one-off already come round).
        const aimed = intent.target.kind === "session" || intent.target.kind === "repo"
          ? intent.target.cwd : null;
        if (aimed) noteSendAim(aimed, { when: intent.when });
        retireSendSource(sendSeed);
        sendSeed.onPosted?.();
        // A re-send lands you on the session it went to. Read the target off
        // the INTENT and never off the seed: the seed's target is what was
        // proposed and the intent's is what was chosen.
        if (sendSeed.openAfter && intent.target.kind === "session") openSent(intent.target.sessionId);
        return true;
      }}
      onDiscard={sendSeed.ackId || sendSeed.padId
        ? () => {
            track("action:send.discard");
            if (sendSeed.ackId) removeQueued(sendSeed.ackId);
            if (sendSeed.padId) removePadNotes([sendSeed.padId]);
            clearSheetDraft(SEND_DRAFT);
            showToast("discarded");
          }
        : undefined}
      // `closeSheet`, never a bare `setOverlay(null)`: the send this sheet
      // just made may have raised the launch ask or the hosted notice, and
      // closing "whatever is on top" would take that question with it.
      onClose={() => { sendResumeRef.current = null; setSendSeed(null); p.closeSheet("send"); }}
    />
    {/* Lives beside the sheet, not inside it: a picker unmounted mid-choice
        never fires `change`, and the sheet closes the moment it is sent. */}
    <input ref={send.replacePick} type="file" hidden onChange={send.onPickReplacement} />
  </>;
}
