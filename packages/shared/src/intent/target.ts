/**
 * Rung 5, target readiness (`targetVerdict`, exported for `verdict.ts` only),
 * and the predicates both ends ask about a row's target: `needsSlot`,
 * `reopensConversation`, `liveConvSession`.
 *
 * A slice of `../intent.ts`, which is the one door into the intent model —
 * import from there, never from here. Layout and import order:
 * docs/notes/shared-architecture.md.
 */

import type { SerialSessionState } from "../queue.js";
import { sessionWall } from "../queue.js";
import type { Intent } from "./row.js";
import type { IntentFacts, IntentVerdict } from "./facts.js";
import { BUSY_OTHER_INTENT, GONE_SESSION, GONE_SESSIONS, wait } from "./words.js";

/**
 * Does running this row mean OPENING a session?
 *
 * Exported because the manager has to ask the same question for a different
 * purpose — which fires in a pass spend a slot — and a second reading of "is
 * this the shape that spawns" is exactly the drift this module exists to end.
 * A `repos` sweep also spawns, and is deliberately not counted here: it has its
 * own pool, and folding the two would make each bound the other's business.
 */
export const needsSlot = (i: Intent): boolean =>
  (i.target.kind === "repo" && i.target.fresh === true) || reopensConversation(i);

/**
 * Will this row REOPEN the conversation it was aimed at, rather than wait for
 * a session that is gone?
 *
 * True only for a clock row that carries a conversation snapshot
 * (`IntentTarget.resumeConvId`), and it is the one predicate both ends ask —
 * the ladder, so rung 5 lets such a row through with its session gone; the
 * host, so `execute()` opens the session instead of typing into a dead id; and
 * the phone, so the backlog stops telling somebody that a row aimed at a closed
 * session is held for ever when this one is not.
 *
 * It says nothing about whether the session is gone RIGHT NOW: while it is
 * alive the row is delivered into it exactly as before, which is the whole
 * point — the reopen is the fallback, never the plan.
 */
export const reopensConversation = (i: Intent): boolean =>
  i.target.kind === "session" && !!i.target.resumeConvId && i.trigger.kind === "at";

/**
 * The live session already driving the conversation this row would reopen, or
 * null. Asked only once the row's own session id is gone: the id is per
 * process, and the SAME conversation may be open again under another one — a
 * person reopened it from *Recently closed*, or (when a session could still run
 * without tmux) a restart re-keyed it. Reopening it a second time would put two CLI processes on one
 * conversation in one worktree; typing into the one that is open is what the
 * row was aimed at. The ladder (rung 5) and the executor (`fire.ts`) both ask
 * this, so the verdict's session and the one typed into cannot disagree.
 */
export function liveConvSession(i: Intent, sessions: readonly SerialSessionState[]): string | null {
  if (!reopensConversation(i) || i.target.kind !== "session") return null;
  const conv = i.target.resumeConvId;
  const s = sessions.find((x) => x.running !== false && x.convId === conv && x.id !== (i.target as { sessionId: string }).sessionId);
  return s?.id ?? null;
}

/**
 * Rung 5 on its own: is the thing this intent points at able to take it?
 *
 * The per-session half is `sessions.autoFireBlocker()`'s ladder, in its order:
 * gone, then limit, then a question box, then mid-turn. Ahead of it sits the
 * backlog's own `sessionBusy()` check — one intent at a time per session —
 * which comes first there and comes first here.
 *
 * What is deliberately NOT here is the tick's `firedSession` claim (at most one
 * new fire per session per pass). That is a fact about one sweep of the loop,
 * not about the intent, and it belongs to the manager that is doing the sweep.
 */
export function targetVerdict(
  i: Intent,
  facts: IntentFacts,
  occurrence: number | undefined,
  late: boolean | undefined,
): IntentVerdict {
  const go = (sessionId?: string): IntentVerdict => ({ kind: "go", sessionId, occurrence, late });

  switch (i.target.kind) {
    case "shell":
      // No agent, no session, nothing to be ready. This is the rate-limit
      // escape hatch: it runs a command in `cwd` and asks nobody's permission.
      return go();

    case "repos": {
      // A sweep opens a FRESH session per repo, so there is no readiness to
      // wait on — only whether the repos it names still exist. Unknown dirs are
      // dropped silently (fan-out's rule: never spawn into a directory that did
      // not come back from `discoverTargets`), and a sweep left with nothing to
      // sweep is a failure that says so rather than a silent no-op.
      const live = i.target.dirs.filter((d) => facts.knownDirs.has(d));
      if (!live.length) {
        return { kind: "fail", detail: "none of the repos this was aimed at are still there — re-aim it at one that is" };
      }
      return go();
    }

    case "sessions": {
      // A fan-out follow-up re-drives sessions that already exist and spawns
      // nothing. Every live one must be ready before any of them is typed into:
      // half a follow-up is worse than none, because the half that landed is
      // indistinguishable afterwards from the half that did not.
      const live = i.target.sessionIds.filter((id) => sessionOf(facts, id));
      if (!live.length) return wait("sessionGone", GONE_SESSIONS);
      for (const id of live) {
        const blocked = sessionBlocker(i, facts, id);
        if (blocked) return blocked;
      }
      return go();
    }

    case "session": {
      // ── The session is gone and this row can reopen its conversation ─────
      //
      // Asked BEFORE `sessionBlocker`, because that ladder's first rung is
      // `sessionGone` — a wait nothing in this store has ever resolved, which
      // is why a clock row aimed at a session used to be re-aimed at the repo
      // on the phone before it could ever be written. It is not re-aimed any
      // more: the conversation is snapshotted instead, and opening it IS the
      // work, exactly as it is for a fresh repo target. So `go()` with no
      // session id — the executor opens one — and `needsSlot` counts it.
      if (reopensConversation(i) && !sessionOf(facts, i.target.sessionId)) {
        // …unless that conversation is open right now under another id: then
        // it goes THERE, held by that session's readiness like any other.
        const open = liveConvSession(i, facts.sessions);
        if (open) return sessionBlocker(i, facts, open) ?? go(open);
        return go();
      }
      const blocked = sessionBlocker(i, facts, i.target.sessionId);
      return blocked ?? go(i.target.sessionId);
    }

    case "repo": {
      // ── A fresh target passes this rung unconditionally ──────────────────
      //
      // Opening the session IS the work, so there is nothing here for the tick
      // to find ready or busy — and `cleanTarget` normalises EVERY repo target
      // to `fresh`, which makes this the only live path.
      //
      // Asked BEFORE `facts.repoSession`, not inside a "no session open"
      // branch, and that order is the whole rule: a repo whose last item's
      // session is still lingering answers that lookup with a conversation
      // this row has nothing to do with, and the next item in that repo would
      // then wait on somebody else's turn — or on a person who had started
      // typing in it — for a session it was never going to use.
      //
      // There is no `else` any more, and that is the point of the change that
      // retired the shared per-repo conversation: a non-`fresh` repo target
      // cannot be built by `cleanTarget`, cannot be posted, and cannot be read
      // off disk — every row on disk goes through `cleanIntentRow`. What stood
      // here was a branch reachable only by hand-constructing an `Intent`, a
      // required fact (`facts.repoSession`) computed per tick for it alone, and
      // a sentence about adopting a session nobody's automatic work adopts. The
      // grep the plan asked for came back empty; this is the deletion it asked
      // for. `fresh` stays OPTIONAL on the type so a row written before it
      // existed still parses — `cleanTarget` fills it in on the way past.
      return go();
    }
  }
}

/** One session's readiness, or null when it is ready. `autoFireBlocker`'s
 *  ladder, with the backlog's one-intent-per-session check in front of it. */
function sessionBlocker(i: Intent, facts: IntentFacts, sessionId: string): IntentVerdict | null {
  const s = sessionOf(facts, sessionId);
  if (!s) return wait("sessionGone", GONE_SESSION);
  // Another intent already holds this session. Checked before the session's own
  // state because it is true even while the session looks perfectly idle — an
  // intent in `starting` is sitting in exactly that quiet window.
  if (facts.busySessions?.has(sessionId) && !i.interject && i.state !== "starting" && i.state !== "running") {
    return wait("sessionBusy", BUSY_OTHER_INTENT);
  }
  if (facts.budgetHeldSessions?.has(sessionId)) return wait("sessionBudget");
  // The three walls, in one place (`queue.ts`'s `sessionWall`): a limited
  // session would bounce the item, and prose typed at an open dialog — parsed
  // or not — goes INTO the dialog, so it neither runs nor answers.
  const wall = sessionWall(s);
  return wall ? wait(wall) : null;
}

/** The session record for an id, if it is live. `running === false` is gone;
 *  `running === undefined` is a session that simply did not say, which the
 *  queue's own rules already treat as live. */
function sessionOf(facts: IntentFacts, id: string): SerialSessionState | undefined {
  const s = facts.sessions.find((x) => x.id === id);
  return s && s.running !== false ? s : undefined;
}
