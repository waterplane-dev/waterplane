// Client → host: the backlog. A member list of `ClientMessage` (`../messages.ts`).

import type { ItemCategory } from "../../naming.js";
import type { SessionBudget } from "../../sessionbudget.js";
import type { SendStamp } from "../../sendstamp.js";

export type ClientBacklogMsg =
  | { t: "backlog.list" }
  /** autoFire: fire when the target session next goes idle (per-item; ignores the global auto switch) — appends to the queue bottom so items run in the order added.
   *  `ackId` (optional): same contract as session.input — the host de-dupes a
   *  repeat and answers `backlog.ack`, so the phone can queue an item while
   *  offline and safely re-send it on reconnect without adding it twice.
   *
   *  `steps` is the WHOLE chain, `steps[0]` being `text` again — one item that
   *  is delivered a turn at a time (`payload.steps`, which never concatenates),
   *  rather than the N separate items the sheet used to post for a chain. Absent
   *  means the one-turn item this message has always carried, and a host that
   *  does not know the field reads `text` and runs the first turn: old
   *  behaviour, not a dropped chain.
   *
   *  `resume` opens the new session with `claude --continue` — "a new session,
   *  picking up the repo's last conversation". Absent = start clean, which is
   *  the default precisely because it is the cheap side of `sessioncost.ts`.
   *
   *  Both are ADDITIVE: `PROTOCOL_VERSION` did not move for it. Neither adds a message,
   *  neither changes what an existing field means, and absent is the behaviour
   *  every bundle already shipped has. */
  | ({ t: "backlog.add"; text: string; repoDir: string; label?: string; fire?: boolean; targetSessionId?: string; autoFire?: boolean; steps?: string[]; resume?: boolean; closeWhenDone?: boolean; budget?: SessionBudget; ackId?: string } & SendStamp)
  | { t: "backlog.remove"; id: string }
  | { t: "backlog.fire"; id: string }
  | { t: "backlog.done"; id: string }
  /**
   * targetSessionId: "" clears the target (back to the repo default session).
   *
   * `autoFire` is the per-item switch `backlog.add` already carries, on an item
   * that already exists — which is what "queue this one here" is. Sent WITH a
   * `targetSessionId`, it means the whole of that tap: aim the item at that
   * session, exempt it from the global auto switch, and move it to the BOTTOM of
   * the queue so tapping three items in a row runs them in that order. Absent =
   * leave the flag alone, like every other field here.
   *
   * `resume` is `backlog.add`'s flag on an item that already exists — the chip
   * being turned on or off for a row that is still waiting. Absent leaves it
   * alone, like every other field here, which is what makes `false` meaningful:
   * it is the only way to say "start clean after all". Additive, v1.
   *
   * `closeWhenDone` is the item's own *close its session when done* answer
   * (`Intent.closeWhenDone`): `true`/`false` set it, `null` puts it back to
   * following the global setting, absent leaves it alone. Unlike the fields
   * above it is NOT an edit to the work — it lands through `edit()`, on a row
   * in any state (a running item's session is exactly the one a person may
   * decide to keep), and never re-queues anything. Additive, v1.
   *
   * `headline` and `category` are the person taking a machine-written name over
   * (`naming.ts`). A non-empty string is stamped `hand` by the host and is never
   * written over again by an assessment or a naming pass; `""` CLEARS the value
   * AND its author, which is "nobody has said", not "a person said nothing" — so
   * a later pass may name it again. The client never sends an author: a claim
   * about who wrote a name is the host's to make, exactly as `handOrdered` is.
   * Additive, v1.
   */
  | { t: "backlog.update"; id: string; text?: string; label?: string; repoDir?: string; targetSessionId?: string; autoFire?: boolean; resume?: boolean; closeWhenDone?: boolean | null; headline?: string; category?: ItemCategory | "" }
  /**
   * **Name these items** — the optional half of titles and kinds.
   *
   * A hand-written backlog row has no title and no kind and nothing derives one
   * for it, because nothing here applies itself. This is the tap that asks: one
   * toolless sidecar call that reads the items' OWN WORDS and nothing else — no
   * repo, no git, no tools — and writes a headline and a category on the rows
   * that have none.
   *
   * Durable (`ackId`), and safe to replay for a reason worth stating: a pass
   * never overwrites a field whose author is `hand`, and writing the same title
   * twice is the same row. `ids` is the CUT the phone was showing, never "the
   * repo" — a count on a control is a filter, so the rows named are the rows
   * counted. Additive, v1.
   */
  | ({ t: "backlog.name"; repoDir: string; ids: string[]; ackId?: string } & SendStamp)
  | { t: "backlog.swap"; id: string; otherId: string }
  /** Apply an explicit top-to-bottom order (drag-and-drop). */
  | { t: "backlog.reorder"; ids: string[] }
  | { t: "backlog.archive"; id: string; archived: boolean }
  | { t: "backlog.check"; id: string }
  /** Deep outcome validation — verdict + proposed next steps. */
  | { t: "backlog.validate"; id: string }
  /** Feed a chosen validation next-step (by index) back into the item's session. */
  | { t: "backlog.nextStep"; id: string; step: number }
  /** Open/resume a coding session for the item, seeded with its task + check/validate verdict as context. */
  | { t: "backlog.continue"; id: string }
  | { t: "backlog.setAuto"; enabled: boolean }
  /**
   * Turn the per-repo *smart pick* on or off.
   *
   * With it on, the moment this repo's next automatic item would fire the host
   * first buys one cheap unattended pass over the repo's remaining items, which
   * may pick which runs next, merge items that are one job, and sort the rest.
   * Per REPO and not global, because the answer to "should a machine groom this
   * list" is different for a repo with two items a week and one with fifty.
   *
   * ADDITIVE, and `PROTOCOL_VERSION` did not move for it. It adds a message and no existing
   * field changes meaning; absent state is the old behaviour exactly, so a host
   * or a bundle that does not know about it behaves as it always did and the
   * feature is simply inert. `routes/work.ts` contains `repoDir` like every
   * other repo-addressed message.
   */
  | { t: "backlog.setSmartPick"; repoDir: string; enabled: boolean }
  /**
   * Undo one smart-pick merge: `id` is the MERGED row.
   *
   * Puts each original back where it was (its previous `order` and its previous
   * archived state, which is not always `false` — a member may have been
   * archived by hand before the merge), rewires anything chained behind one of
   * them, removes the merged row, and remembers the id-set so the next pass
   * cannot propose the same merge again. Refused with a sentence once the merged
   * row has started, because by then there is a session running its words.
   *
   * Not durable and never queued offline, for `intent.cancel`'s reason: an undo
   * delivered an hour late calls back words that have since run. Additive, v1.
   */
  | { t: "backlog.unmerge"; id: string }
  | { t: "backlog.openRepoSession"; repoDir: string };
