// Client → host: the backlog. A member list of `ClientMessage` (`../messages.ts`).

import type { ItemCategory } from "../../naming.js";
import type { SessionBudget } from "../../sessionbudget.js";
import type { SendStamp } from "../../sendstamp.js";
import type { LaunchOpts } from "../session.js";

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
   *  every bundle already shipped has.
   *
   *  `pastBudget` is the person's *past the budget* for THIS prompt, asked at
   *  the moment it is queued: the host lets the new row past the usage budget
   *  exactly as `intent.waive` would (only the budget, until the tripped
   *  window resets). Additive too — an older desktop ignores it and the row
   *  waits for the budget like any other.
   *
   *  `launch` is the model/effort/backend the item's OWN session starts with
   *  (`Intent.launch`, the send sheet's *model* row), cleaned by
   *  `cleanLaunchOpts` on the way in; meaningless beside `targetSessionId`.
   *  Additive: an older desktop drops it and opens the session on its own
   *  new-session defaults, which is what absent means. */
  | ({ t: "backlog.add"; text: string; repoDir: string; label?: string; fire?: boolean; targetSessionId?: string; autoFire?: boolean; steps?: string[]; resume?: boolean; closeWhenDone?: boolean; flagWhenDone?: boolean; budget?: SessionBudget; launch?: LaunchOpts; pastBudget?: boolean; ackId?: string } & SendStamp)
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
   * `flagWhenDone` is the item's *flag for follow up when done* (`Intent.
   * flagWhenDone`): `true` sets it, `false`/`null` clears it, absent leaves it
   * alone. Lands through `edit()` like `closeWhenDone`, on a row in any state.
   *
   * `budget` is the cap the session this row OPENS is born with (`Intent.
   * budget`): an object sets or changes it, `null` clears it, absent leaves it
   * alone. The host cleans it (`cleanSessionBudget`) and applies it only to a
   * row that has not started (`edit()` says so otherwise). Additive, v1.
   *
   * `headline` and `category` are the person taking a machine-written name over
   * (`naming.ts`). A non-empty string is stamped `hand` by the host and is never
   * written over again by an assessment or a naming pass; `""` CLEARS the value
   * AND its author, which is "nobody has said", not "a person said nothing" — so
   * a later pass may name it again. The client never sends an author: a claim
   * about who wrote a name is the host's to make, exactly as `handOrdered` is.
   * Additive, v1.
   */
  | { t: "backlog.update"; id: string; text?: string; label?: string; repoDir?: string; targetSessionId?: string; autoFire?: boolean; resume?: boolean; closeWhenDone?: boolean | null; flagWhenDone?: boolean | null; budget?: SessionBudget | null; headline?: string; category?: ItemCategory | "" }
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
  | { t: "backlog.openRepoSession"; repoDir: string };
