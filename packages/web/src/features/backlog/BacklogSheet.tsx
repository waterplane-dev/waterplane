/**
 * The `backlog` overlay: `Backlog.tsx` wired to this feature's stores and the
 * core — the prop list `App.tsx`'s `overlayViews.backlog` spelled out, with
 * its reasons kept beside each verb. Every backlog MUTATION is live-only
 * (`liveSend` + `BL_OFFLINE`); the two DURABLE verbs are *run it again*
 * (`intent.requeue`) and *name these* (`backlog.name`).
 */
import { useMemo } from "react";
import { assessRunBlocker } from "../../assessRows";
import { intentTitle } from "../../activityRows";
import { api } from "../../api";
import { Backlog } from "../../Backlog";
import {
  DROP_CLOCK_TOAST, PAST_BUDGET_UNDONE_TOAST, archiveDoneToast, dropClocksToast, nameLabel, namingToast,
  scheduleParentLabel, scheduleRuleLabel,
} from "../../backlogFilter";
import { sendModeToast } from "../../composeSend";
import { ensureMtime, knownMtime } from "../../fileMtime";
import { pickThumbWidth, sized } from "../../media";
import { budgetReasonText, scheduleIdFromOrigin } from "@waterplane/shared";
import { useCore, usePref, useStore } from "../../sdk";
import { closeChoicePatch, closeChoiceToast } from "../../autoSessions";
import { BL_OFFLINE, clockParentsOf, scheduleMaps } from "./logic";
import { assessBusy, assessRuns, backlog, backlogFocus, backlogScope } from "./store";
import { openAssessFor, openBacklogCut, runAgain, runAgainMany } from "./actions";

export function BacklogSheet() {
  const core = useCore();
  const { liveSend, liveSendAll } = core.conn;
  const { queueOp } = core.queue;
  const { intents, sessions, visibleRepos, active, pending, budget, schedules } = core.world;
  const online = core.conn.status === "open";
  const bl = useStore(backlog);
  const focusIds = useStore(backlogFocus);
  const scope = useStore(backlogScope);
  const runs = useStore(assessRuns);
  const busy = useStore(assessBusy);
  // The global *close automatic sessions when done* — what a row with no
  // answer of its own follows, said on its *as set globally* chip.
  const closeGlobal = usePref("closeWhenDone");
  // The launcher's visibility rule (hidden repos, the focus window), applied to
  // the rows exactly as the launcher applies it to sessions.
  // Keyed on the predicate itself, never on `core.world` (a new object every
  // App render, so the memo — and every memo `Backlog` keys on `items` — would
  // never hit).
  const { cwdVisible } = core.world;
  const items = useMemo(() => bl.items.filter((it) => cwdVisible(it.repoDir)), [bl.items, cwdVisible]);
  // Which schedule wrote which row — the entry maps, then the same join over
  // the durable rows for the legacy parents the entry list no longer holds.
  const sched = useMemo(() => scheduleMaps(schedules), [schedules]);
  const clockParents = useMemo(() => clockParentsOf(intents, intentTitle), [intents]);
  const repoIdForDir = (dir: string) => core.world.repos.find((r) => r.worktreePath === dir)?.id;
  return (
    <Backlog
      items={items} auto={bl.auto} repos={visibleRepos}
      waiting={bl.waiting}
      /* A fact about this second, like `waiting` — live only. */
      autoSlots={online ? bl.autoSlots : null}
      closeWhenDoneGlobal={closeGlobal}
      intents={intents}
      /* Live only, for the reason the store gives: a stale copy would put
         *naming…* on rows nothing is naming, and the sheet reads the same
         list to decide whether to offer the verb at all. */
      naming={online ? bl.naming : []}
      smartPick={bl.smartPick} passes={bl.passes} snapAt={bl.snapAt}
      online={online}
      // The cut this sheet was opened on, and the seam back to the rule that
      // wrote a row. Both halves of "these two lists are the same subject".
      focusIds={focusIds}
      /* The "here". Never a pending session: a queued `session.create` has no
         id a host-side item can be aimed at. */
      activeSession={active && !pending ? { id: active.id, cwd: active.cwd, title: active.title || "this session" } : null}
      sessions={sessions}
      defaultRepoDir={scope ?? active?.cwd}
      verbs={{
        /* The per-row answer, live-only like every backlog mutation; `null`
           clears it back to the global. Never a requeue (host's `edit()`). */
        onSetCloseWhenDone: (id, c) => liveSend(
          { t: "backlog.update", id, closeWhenDone: closeChoicePatch(c) },
          closeChoiceToast(c, closeGlobal), BL_OFFLINE),
        /* **Take the clock off and leave the words.** An `intent.update` whose
           patch carries a `trigger`; live-only, because a decision about a clock
           replayed an hour later is about an instant that may have arrived. The
           receipt says what happened to the CLOCK and not the row's state (the
           host kicks synchronously). `holdForHost` survives. */
        onDropClock: (id) => liveSend(
          { t: "intent.update", id, patch: { trigger: { kind: "idle" } } },
          DROP_CLOCK_TOAST, BL_OFFLINE),
        // The undo of *let past the budget*: the row waits for the budget again.
        onHoldForBudget: (id) => liveSend(
          { t: "intent.waive", id, rung: "budget", on: false },
          PAST_BUDGET_UNDONE_TOAST, BL_OFFLINE),
        // **Put a failed row back in the queue** — DURABLE (`actions.ts` says why).
        onRunAgain: runAgain,
        /* Its time, changed where every other *when* in this app is chosen: the
           Send sheet's *When*. `seedFromIntent` carries the whole chain and the
           `scheduleId`, so the save upserts on this row. */
        onEditWhen: (id) => {
          const i = intents.find((x) => x.id === id);
          if (!i) { core.say.toast("that row is gone"); return; }
          core.nav.openSend(core.send.seedFromIntent(i));
        },
        // Every backlog MUTATION is live-only and deliberately not durable: a
        // "mark it done" or a "fire it now" delivered an hour late is about a
        // situation that has moved on. The receipt is what closes the gap between
        // a socket that reads open and a tunnel that is not there; the fire-nav
        // is armed only once the frame is actually on the wire.
        onRemove: (id) => liveSend({ t: "backlog.remove", id }, "removed", BL_OFFLINE),
        onUpdate: (id, patch) => liveSend({ t: "backlog.update", id, ...patch }, "saved", BL_OFFLINE),
        /* ONE WHEN, ONE NAME — for the RECEIPT as well as the verb: aim it at
           this session with its own auto-fire flag. `sendModeToast` is that
           sentence (`composeSend.test.mjs` pins it); `""` is the undo. */
        onQueueHere: (id, sessionId) => liveSend(
          { t: "backlog.update", id, targetSessionId: sessionId, autoFire: !!sessionId },
          sessionId
            ? sendModeToast("idle", { online, holder: "desktop" })!
            : "taken off this session's queue",
          BL_OFFLINE),
        onSwap: (id, otherId) => liveSend({ t: "backlog.swap", id, otherId }, "reordered", BL_OFFLINE),
        onFire: (id) => { if (liveSend({ t: "backlog.fire", id }, "running it now…", BL_OFFLINE)) core.nav.followFire(id); },
        onDone: (id) => liveSend({ t: "backlog.done", id }, "marked done", BL_OFFLINE),
        // The verb the BUTTON wore (`undo` or `put them back`), never a fixed one.
        onUnmerge: (id, verb) => liveSend({ t: "backlog.unmerge", id }, verb, BL_OFFLINE),
        onArchive: (id, archived) => liveSend({ t: "backlog.archive", id, archived }, archived ? "archived" : "unarchived", BL_OFFLINE),
        onCheck: (id) => liveSend({ t: "backlog.check", id }, "checking…", BL_OFFLINE),
        onValidate: (id) => liveSend({ t: "backlog.validate", id }, "validating…", BL_OFFLINE),
        onNextStep: (id, step) => { if (liveSend({ t: "backlog.nextStep", id, step }, "firing the next step…", BL_OFFLINE)) core.nav.followFire(id); },
        onContinue: (id) => { if (liveSend({ t: "backlog.continue", id }, "continuing…", BL_OFFLINE)) core.nav.followFire(id); },
        onEditImage: core.files.editBacklogImage,
      }}
      cutVerbs={{
        /* The same contract over a cut, and **one receipt for one tap**: the
           wire has no batch `intent.update`, so the frames are one per row and
           what is batched is the SENTENCE, the only place the count survives. */
        onDropClocks: (ids) => liveSendAll(
          ids.map((id) => ({ t: "intent.update", id, patch: { trigger: { kind: "idle" } } })),
          dropClocksToast(ids.length), BL_OFFLINE),
        onRunAgainMany: runAgainMany,
        /* **Ask for titles and kinds** — DURABLE: a naming pass never writes over
           a `hand` field and the same title twice is the same row. One tap, ONE
           receipt, worded with the BUTTON's own label. */
        onName: (repoDir, ids) => {
          const offline = queueOp({ t: "backlog.name", repoDir, ids }, `name:${repoDir}`, nameLabel(ids.length), { cwd: repoDir });
          core.say.toast(offline ? `Queued · ${namingToast(nameLabel(ids.length))}` : namingToast(nameLabel(ids.length)));
        },
        onReorder: (ids) => liveSend({ t: "backlog.reorder", ids }, "order saved", BL_OFFLINE),
        /* The switch is called `auto` on the chip a thumb just pressed, so the
           receipt says `auto` — a switch with three names is a switch a person
           cannot be sure they just flipped. */
        onSetAuto: (enabled) => liveSend({ t: "backlog.setAuto", enabled }, `auto ${enabled ? "on" : "off"}`, BL_OFFLINE),
        /* The per-repo tick, live-only like every other backlog mutation. */
        onSetSmartPick: (repoDir, enabled) => liveSend(
          { t: "backlog.setSmartPick", repoDir, enabled },
          enabled ? "smart pick on — it looks before each item starts" : "smart pick off",
          BL_OFFLINE),
        /* The same contract over a cut, and **one receipt for one tap** —
           `onDropClocks`' rule exactly. */
        onArchiveMany: (ids) => liveSendAll(
          ids.map((id) => ({ t: "backlog.archive", id, archived: true } as const)),
          archiveDoneToast(ids.length), BL_OFFLINE),
        // "What is left here, and what is already done." Opens the sheet; it
        // starts a run only when this repo has nothing to read yet, which is why
        // the refusals below are the RUN's and stop applying once there is one.
        onAssess: (repoDir, ids) => {
          const repo = visibleRepos.find((r) => r.worktreePath === repoDir);
          if (repo) openAssessFor(repo, ids);
        },
        assessBlocked: (repoDir) => {
          const run = runs.get(repoDir) ?? null;
          if (run) return null; // there is something to read — opening it spends nothing
          return assessRunBlocker({
            run: null,
            online,
            busy: busy.size > 0,
            budgetNote: budget?.verdict.blocked ? budgetReasonText(budget.verdict) : null,
          });
        },
      }}
      nav={{
        /* *Close one to make room*: the ONE session close, a person's tap. */
        onCloseSession: core.nav.closeSession,
        // Parentage off the row first (every child a rule ever wrote), then the
        // one-per-rule `childId` map, then the same join over the durable rows
        // for a parent that is a timed one-off. Absent beats guessed.
        scheduleFor: (it) => {
          const byOrigin = scheduleIdFromOrigin(it.origin);
          return (byOrigin ? sched.byId.get(byOrigin) : undefined)
            ?? sched.byChild.get(it.id)
            ?? (byOrigin ? clockParents.byId.get(byOrigin) : undefined)
            ?? clockParents.byChild.get(it.id)
            ?? null;
        },
        /* The chip's tap, and it has TWO destinations because the parent is one
           of two things. A rule is a card in Schedules. A timed one-off is a
           backlog row of its own, so the door is its repo's backlog cut to that
           one id, which is a cut that shows archived rows on purpose. */
        onOpenSchedule: (id, name) => {
          if (sched.byId.has(id)) { core.nav.openScheduleCut([id], scheduleRuleLabel(name)); return; }
          const parent = intents.find((x) => x.id === id);
          if (parent) { openBacklogCut(parent.cwd, [id], scheduleParentLabel(name)); return; }
          core.say.toast("that schedule is no longer on the desktop");
        },
        renderRetime: core.send.renderRetime,
        onClose: () => core.nav.close("backlog"),
        // The sheet's own add form is gone — a second prompt textarea. This is
        // the one send surface, seeded to the repo on screen and to *when it's
        // free*, which is what an item in a backlog IS; its post still goes
        // through the durable queue with an ackId.
        onOpenSend: (repoDir, words) => {
          const repo = visibleRepos.find((r) => r.worktreePath === repoDir);
          core.nav.openSend({
            prompts: words ? [words] : undefined,
            target: { kind: "repo", cwd: repoDir },
            when: { kind: "idle" },
            cwdHint: repoDir,
            repoId: repo?.id ?? null,
            origin: words ? "Kept from the backlog's old add field" : "From the backlog",
          });
        },
        onOpenSession: (sid) => { const s = sessions.find((x) => x.id === sid); if (s) core.nav.attach(s); },
        // Versioned where possible, for the same reason the reader's inline
        // thumbnails are: an un-versioned thumb URL is served by the network or
        // by nothing (fileMtime.ts).
        imageSrc: (dir, rel) => {
          const id = repoIdForDir(dir);
          if (!id) return null;
          ensureMtime(id, rel);
          return sized(api.artifactUrl(id, rel), pickThumbWidth(72), knownMtime(id, rel));
        },
      }}
    />
  );
}
