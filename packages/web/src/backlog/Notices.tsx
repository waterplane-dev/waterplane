/**
 * The one-line notices above the list: *auto is off*, the add field's
 * leftover draft (rescued, never dropped), why there is no wait verb, and
 * the offline line.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import { SendHorizontal, X } from "lucide-react";
import { ConfirmButton } from "../Confirm";
import type { BacklogModel } from "./backlogTypes";

export function AutoOffNote({ m }: { m: BacklogModel }) {
  const { focusWords, p } = m;
  return (
    <>
      {/* What `auto off` actually stops, said where it is switched. Every
          *when it's free* post in the app is now an `auto` row — the composer's,
          the send sheet's, this sheet's — so this one-word switch pauses every
          deferred send on the desktop, not just "the backlog". Off, it was a
          chip reading `auto off` and nothing else, next to a list that had
          simply stopped moving.

          **ONE RULE, ONE COPY.** `focusRunWords` says the same thing about the
          rows on screen, with the switch beside it, and an ids cut therefore
          had *auto is off on this desktop* twice on one phone screen, six lines
          apart. It is drawn here exactly when that sentence is NOT — the
          condition is the sentence itself and not `filter.ids`, because the
          sentence goes `null` whenever nothing in the cut was going to start,
          and dropping the banner on the cut alone would take the fact off the
          screen entirely. */}
      {!p.auto && !focusWords && (
        <div className="form"><div className="form-hint">
          <b>auto</b> is off on this desktop: nothing queued anywhere runs until you turn it back on or
          fire an item by hand.
        </div></div>
      )}
    </>
  );
}

export function StrandedDraft({ m }: { m: BacklogModel }) {
  const { dropStrandedDraft, p, repoDir, strandedDraft } = m;
  return (
    <>
      {/* The rescue for the add field's leftover draft.
          Deleting the surface that held somebody's words is the same delete as
          writing over them, so the words are shown, offered as a send in one
          tap, and thrown away only on a deliberate second tap. It appears once
          and then never again. */}
      {strandedDraft && (
        <div className="form"><div className="form-hint">
          {/* Named for what the field WAS, because it was two fields in one:
              the draft for a new item and the search box over this repo. So
              what comes back may be a query somebody typed to find something,
              not words they meant to send — and offering that as "kept from
              before" with a send button under it reads as a lost prompt. */}
          <b>Kept from before</b> — this was the old add/search field, so it may be a search you typed:{" "}
          “{strandedDraft.length > 160 ? `${strandedDraft.slice(0, 160)}…` : strandedDraft}”
          <div className="annot-tools" style={{ marginTop: 6 }}>
            <button className="key" onClick={() => { const w = strandedDraft; dropStrandedDraft(); p.nav.onOpenSend(repoDir, w); }}>
              <SendHorizontal size={14} /> send it
            </button>
            <ConfirmButton confirm="discard it?" title="throw these words away" onConfirm={dropStrandedDraft}>
              <X size={14} /> discard
            </ConfirmButton>
          </div>
        </div></div>
      )}
    </>
  );
}

export function HereNotice({ m }: { m: BacklogModel }) {
  const { here, hereInRepo, p } = m;
  return (
    <>
      {/* The positive explainer is GONE with the word it was explaining: the
          row's verb now reads *when &lt;session&gt; is free*, which is the
          composer's own sentence, and the group head above each row says where
          the item ended up. Three sentences of vocabulary lesson under a repo
          bar was the cost of a name nobody could guess.

          What stays is the reason the verb is MISSING, which is the rule this
          app holds about every blocked control: say it in words, never as a
          dimmed thing nobody can tell from a working one. One line each, and
          nothing at all when the sheet was opened from a repo menu and there
          was never a session in the picture. */}
      {p.online && !hereInRepo && (here ? (
        <div className="form"><div className="form-hint">
          No wait verb on these items: the session you came from (<b>{here.title}</b>) is in another repo, and an
          item can only run in a session opened on its own checkout.
        </div></div>
      ) : p.activeSession ? (
        <div className="form"><div className="form-hint">
          No wait verb on these items: the session you came from is no longer running, so there is nothing to hand one to.
        </div></div>
      ) : null)}
      {!p.online && (
        <div className="form"><div className="form-hint">Offline — showing the last synced backlog. Every mutation (fire, edit, done, check, validate, continue, reorder, archive, remove) is disabled until the connection is back; <b>send…</b> still queues normally.</div></div>
      )}
    </>
  );
}
