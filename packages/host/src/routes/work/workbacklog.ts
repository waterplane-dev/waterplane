/**
 * Work routes — backlog slice of `routes/work.ts` (see that file for the whole picture).
 */
import { namingStartedNote } from "../../naming.js";
import { addClientBacklogItem } from "../../agentintents.js";
import { cleanSessionBudget } from "@waterplane/shared";
import type { Route, RouteSpec, RouteTable } from "../types.js";

const onFanoutList: Route<"fanout.list"> = (a) => {
    a.c.send(a.ws, { t: "fanout.list", runs: a.c.fanout.list() });
};

/**
 * One prompt, N repos, a fresh session each.
 *
 * The most expensive message in the app to duplicate — a re-sent sweep is N
 * extra claude processes — so it is durable. No `contain`: `start()` validates
 * every dir against `discoverTargets()`, which is a stricter gate than the root
 * rule and is the one this message has always used.
 */
const onFanoutRun: RouteSpec<"fanout.run"> = {
  durable: true,
  run: (a) => {
    const { text, dirs, cols, rows, launch } = a.msg;
    // Each target's session is born with this budget (refused whole if garbage).
    const budget = cleanSessionBudget(a.msg.budget) ?? undefined;
    return a.c.fanout.start(dirs, text, { launch, budget, cols, rows }).then((r) => {
      if ("error" in r) { a.c.send(a.ws, { t: "toast", text: `fan-out: ${r.error}` }); return { ok: false, reason: r.error }; }
      return { ok: true, runId: r.id };
    });
  },
};

const onFanoutFollowup: Route<"fanout.followup"> = (a) => {
    // Drive the sessions a run ALREADY spawned — never spawns anything, so
    // there are no dirs to validate against the repo list here: every dir is
    // matched against the run's own targets. A run the host no longer knows
    // (evicted from the ring, or a restart) is an honest ok:false: starting a
    // fresh run would send "now commit that" to repos that never did step one.
    a.c.durableOp(a.ws, a.msg.ackId, () => a.c.fanout.followUp(a.msg.runId, a.msg.text, a.msg.dirs).then((r) => {
      if ("error" in r) { a.c.send(a.ws, { t: "toast", text: `fan-out: ${r.error}` }); return { ok: false, reason: r.error }; }
      return { ok: true, runId: r.id };
    }), a.msg);
};

const onBacklogList: Route<"backlog.list"> = (a) => {
    a.c.send(a.ws, a.c.backlogSnapshot());
};

/**
 * Backlog adds still on the wire, joined by ackId.
 *
 * The ledger check below is SYNCHRONOUS and the write is not: `containRepoDir`
 * awaits a `discoverTargets` git scan for any directory that is not plainly
 * inside ROOT, and a phone's retry landing in that window finds nothing
 * remembered and posts the same words a second time — a second work item, with
 * a second id (`randomUUID().slice(0, 8)`, so the store's own at-most-once by
 * id cannot save it), which auto-fire then types into the repo twice.
 *
 * `server/wsops.ts` closes exactly this gap for ops (`opsInFlight`) and for compose
 * sends (`inputsInFlight`). This was the third async path carrying an ackId and
 * the only one without a join.
 *
 * Memory only, like both siblings: a crash mid-add must not leave a persisted
 * "already did it" for an item that was never written.
 */
type BacklogVerdict = { ok: boolean; itemId?: string; reason?: string };
const backlogAddsInFlight = new Map<string, Promise<BacklogVerdict | null>>();

const onBacklogAdd: Route<"backlog.add"> = (a) => {
    // Same at-most-once contract as session.input: the phone may queue an item
    // while the tunnel is down and re-send it with the SAME ackId on
    // reconnect. A repeat is re-acked, never added twice — without this the
    // durable offline queue would duplicate work items.
    const ackId = a.msg.ackId;
    if (ackId) {
      const seen = a.c.acks.get(ackId);
      if (seen) {
        a.c.netstats.noteAckReplay();
        a.c.send(a.ws, { t: "backlog.ack", ackId, ok: seen.ok, itemId: seen.itemId, reason: seen.reason });
        return;
      }
      // Already being added — join it rather than starting a second one. The
      // retry normally RACES the first add rather than following it, because
      // the phone's receipt deadline is shorter than a cold `discoverTargets`.
      const already = backlogAddsInFlight.get(ackId);
      if (already) {
        a.c.netstats.noteAckReplay();
        void already.then((v) => { if (v) a.c.send(a.ws, { t: "backlog.ack", ackId, ...v }); });
        return;
      }
      // Lost ledger + first sent before the loss ⇒ this item may already be on
      // the backlog. Refused, never added, remembered (acks.ts).
      const lostRefusal = a.c.acks.preLossRefusal(a.msg);
      if (lostRefusal) {
        a.c.acks.remember(ackId, { ok: false, reason: lostRefusal });
        a.c.send(a.ws, { t: "backlog.ack", ackId, ok: false, reason: lostRefusal });
        return;
      }
    }
    // A backlog item is a deferred `session.create` — it names the repo an
    // agent will later be spawned in — so it is contained on the way IN
    // rather than at fire time, when the phone that could be told is gone.
    // The add itself is `addClientBacklogItem` (`agentintents.ts`) — the ONE
    // client path into `backlog.add`, which the agent's loopback route calls
    // too. `steps` is the WHOLE chain (`steps[0]` repeats `text`) and rides as
    // ONE item delivered a turn at a time, never N items — N items would be N
    // sessions. `resume` opens that item's session with `claude --continue`.
    // Both additive, which is why `PROTOCOL_VERSION` did not move for it.
    const run = addClientBacklogItem(a.c, {
      repoDir: a.msg.repoDir, text: a.msg.text, label: a.msg.label, targetSessionId: a.msg.targetSessionId,
      autoFire: a.msg.autoFire, steps: a.msg.steps, resume: a.msg.resume,
      // Strictly a boolean: absent follows the global close-when-done setting.
      closeWhenDone: typeof a.msg.closeWhenDone === "boolean" ? a.msg.closeWhenDone : undefined,
      // The budget the item's session is born with; garbage is no budget.
      budget: cleanSessionBudget(a.msg.budget) ?? undefined,
    }).then((added) => {
      if (!added.ok) {
        // The sentence rides ON the receipt (and in the ledger, so a replay
        // says it again): the phone fails the row with it and toasts it once.
        // It used to be a separate toast beside a bare `ok:false`, which a
        // replay never repeated and the row could not show.
        const verdict: BacklogVerdict = { ok: false, reason: "That folder is outside the configured root — not added." };
        // No ackId = no receipt to carry it (an old client): then the toast is the only way to be told.
        if (!ackId) a.c.send(a.ws, { t: "toast", text: verdict.reason ?? "" });
        if (ackId) a.c.acks.remember(ackId, verdict);
        return verdict;
      }
      const item = added.item;
      if (a.msg.fire) void a.c.backlog.fire(item.id);
      const verdict = { ok: true, itemId: item.id };
      // Remembered BEFORE the ack goes out, so a retry that arrives with the
      // receipt still in flight reads the ledger rather than the empty gap.
      if (ackId) a.c.acks.remember(ackId, verdict);
      return verdict;
    }, () => {
      // Thrown ⇒ not remembered, and no receipt — the same shape this route
      // has always had on a rejected containment, so the phone's own deadline
      // retries it and gets a real second attempt.
      return null;
    });
    if (ackId) {
      backlogAddsInFlight.set(ackId, run);
      void run.finally(() => backlogAddsInFlight.delete(ackId));
    }
    void run.then((v) => { if (v && ackId) a.c.send(a.ws, { t: "backlog.ack", ackId, ...v }); });
};

const onBacklogRemove: Route<"backlog.remove"> = (a) => {
    a.c.backlog.remove(a.msg.id);
};

const onBacklogFire: Route<"backlog.fire"> = (a) => {
    void a.c.backlog.fire(a.msg.id);
};

const onBacklogDone: Route<"backlog.done"> = (a) => {
    a.c.backlog.markDone(a.msg.id);
};

const onBacklogUpdate: Route<"backlog.update"> = (a) => {
    // `headline`/`category` travel with the rest rather than through a message
    // of their own: they are an edit to a row a person is already editing, and
    // a second message would mean a rename and a re-word arriving as two ops
    // with an order nobody decided. The host stamps them `hand` — see
    // `IntentManager.edit`, which is where `""` becoming "nobody has said" is
    // written down.
    const named = {
      headline: a.msg.headline, category: a.msg.category,
      // `true`/`false`/`null` (back to the global) only — anything else off the
      // wire says nothing, and nothing must not clear the override.
      ...(a.msg.closeWhenDone === true || a.msg.closeWhenDone === false || a.msg.closeWhenDone === null
        ? { closeWhenDone: a.msg.closeWhenDone } : {}),
    };
    // A title this app would not write is SAID, the way `intent.requeue` says
    // its refusal. The rest of the edit landed, so this is not a failed op and
    // nothing here is `ok: false` — it is the one half that did not, and
    // without it the phone closes its editor over words that were dropped.
    const say = (r: { refused?: string }): void => {
      if (r.refused) a.c.send(a.ws, { t: "toast", text: `backlog: ${r.refused}` });
    };
    // `repoDir` is optional here; only a stated one needs containing, and an
    // uncontained one must not fall through as "leave it where it was".
    if (a.msg.repoDir === undefined) {
      say(a.c.backlog.update(a.msg.id, { text: a.msg.text, label: a.msg.label, targetSessionId: a.msg.targetSessionId, autoFire: a.msg.autoFire, resume: a.msg.resume, ...named }));
    } else {
      void a.c.containRepoDir(a.msg.repoDir).then((repoDir) => {
        if (!repoDir) { a.c.send(a.ws, { t: "toast", text: "that folder is outside the configured root — not moved" }); return; }
        say(a.c.backlog.update(a.msg.id, { text: a.msg.text, label: a.msg.label, repoDir, targetSessionId: a.msg.targetSessionId, autoFire: a.msg.autoFire, resume: a.msg.resume, ...named }));
      });
    }
};

/**
 * Title this repo's untitled rows.
 *
 * `contain` because the message names a DIRECTORY the client chose and the
 * handler spawns a completion with that directory as its cwd — `backlog.
 * setSmartPick`'s gate, for the same reason, one step further along: this one
 * spawns something immediately rather than writing a key a later pass spawns
 * from.
 *
 * **Durable**, unlike the smart-pick tick-box, and that is not symmetry for its
 * own sake: this op SPENDS a completion. A phone that queued the tap while the
 * tunnel was down and re-sent it on reconnect would otherwise buy the same
 * titles twice — and the second pass, arriving after the first has written, is
 * a pass over a list where every row it was asked about now has a name, so it
 * spends the money and reports "nothing here needs a title", which reads like a
 * bug.
 *
 * The finishing sentence goes to the REQUESTER and not to everybody: it is an
 * answer to a tap, and a toast about a naming pass on a phone that did not ask
 * for one is noise about somebody else's list.
 *
 * **The ack does not wait for the pass**, and that is the whole shape of this
 * handler. `assess.run` already had it; this one awaited instead, and the
 * arithmetic of awaiting was: ten sequential batches × `NAME_TIMEOUT_MS`
 * (120 s) against the phone's `OP_ACK_TIMEOUT_MS` of 20 s and
 * `MAX_SEND_ATTEMPTS` of 8. A pass that was working was re-sent eight times
 * (`opsInFlight` suppressed every one, so nothing was bought twice), shown as
 * FAILED on the phone while it was still running, and then acked up to eight
 * times when it finished. So: refuse or start HERE, ack HERE, and let the
 * pass's own sentence arrive as the toast it already was.
 */
const onBacklogName: RouteSpec<"backlog.name"> = {
  contain: "repoDir",
  refusal: "that folder is outside the configured root",
  durable: true,
  run: (a) => {
    const r = a.c.naming.begin(a.dir, a.msg.ids);
    // Always `ok: true`: a refusal here is a SENTENCE about the list ("one is
    // already running", "nothing needs a title"), not a failed op, and acking
    // it false would make the phone's outbox retry a tap that was answered.
    if ("refusal" in r) { a.c.send(a.ws, { t: "toast", text: r.refusal }); return { ok: true, reason: r.refusal }; }
    // Detached, and the toast is sent to whoever asked whenever it lands. The
    // socket may be gone by then — `send` is a no-op on a closed one, and the
    // titles are on disk either way, which is what the tap was for.
    void r.finished.then((text) => a.c.send(a.ws, { t: "toast", text }));
    return { ok: true, reason: namingStartedNote(r.rows) };
  },
};

const onBacklogSwap: Route<"backlog.swap"> = (a) => {
    a.c.backlog.swap(a.msg.id, a.msg.otherId);
};

const onBacklogReorder: Route<"backlog.reorder"> = (a) => {
    a.c.backlog.reorder(a.msg.ids);
};

const onBacklogSetAuto: Route<"backlog.setAuto"> = (a) => {
    a.c.backlog.setAuto(a.msg.enabled);
};

const onBacklogOpenRepoSession: Route<"backlog.openRepoSession"> = (a) => {
    // Open the repo's own auto-titled session and navigate the requester to it
    // (create()→"created" broadcasts it).
    //
    // It is no longer where fired work goes — every item opens a session of its
    // own — so what this button makes now is what it always looked like: a
    // session, in this repo, carrying the `backlog · ` prefix so it counts
    // against the cap and is swept like any other automatic one. It is the thing
    // *queue here* can aim a row at.
    // `containRepoDir`, not a second hand-rolled `inRoot`: this SPAWNS a
    // session, which is exactly the verb the one gate exists for. The bare
    // `inRoot` was stricter in the safe direction — it refuses a legitimate
    // discovered worktree outside ROOT — but a copy of a rule is a copy, and
    // this repo has already paid for six of them (`paths.ts`).
    void a.c.containRepoDir(a.msg.repoDir).then((okDir) => {
      if (!okDir) { a.c.send(a.ws, { t: "toast", text: "that folder is outside the configured root" }); return; }
      const sid = a.c.backlog.ensureRepoSession(okDir);
      a.att.add(sid);
      // Navigate the requester to it whether it was just created or already open
      // (the "created" event only fires for new sessions).
      a.c.send(a.ws, { t: "session.focus", id: sid });
      // Re-broadcast the backlog: clients gate "fire" on a repo session being
      // open, so they need a fresh snapshot AFTER the session exists.
      a.c.broadcast(a.c.backlogSnapshot());
    });
};

/**
 * Turn this repo's *smart pick* on or off.
 *
 * `contain` because the message names a DIRECTORY the client chose and this
 * writes it into host state that a later pass then spawns `claude -p` in. It is
 * the same gate `build.list` takes for a read, and for the stronger of its two
 * reasons: an unguarded key here would let a phone name `/anywhere` and have the
 * host run a grooming pass there the next time something fired.
 *
 * Not durable: the message is idempotent by construction (a boolean set to what
 * it already is writes nothing and kicks nothing), so an ackId would be
 * protecting against a repeat that costs nothing.
 */
const onBacklogSetSmartPick: RouteSpec<"backlog.setSmartPick"> = {
  contain: "repoDir",
  refusal: "that folder is outside the configured root",
  run: (a) => {
    a.c.backlog.setSmartPick(a.dir, a.msg.enabled);
    a.c.broadcast(a.c.backlogSnapshot());
  },
};

/**
 * Put a merge's originals back — before OR after the merged row has run.
 *
 * No `contain` — it names a ROW, not a directory, and the row's own `cwd` is the
 * host's. Not durable and never queued offline, for `intent.cancel`'s reason: an
 * undo delivered an hour late calls back words that have since run.
 *
 * **Both answers are a TOAST carrying the host's own sentence**, and the success
 * one is not a nicety: the same tap means two different things depending on
 * whether the merged row got there first, and the difference — *"your 2
 * originals are back and will run again"* versus *"put back, they never ran"* —
 * is exactly what the person needs told. The client draws the button on any
 * merged row, whatever its state, and never greys it out; the host decides what
 * the tap does and says so. `Unavailable.tsx`'s rule, applied to a verb rather
 * than a control.
 */
const onBacklogUnmerge: Route<"backlog.unmerge"> = (a) => {
    const res = a.c.backlog.unmerge(a.msg.id);
    if (!res.ok) { a.c.send(a.ws, { t: "toast", text: res.reason || "that merge could not be undone" }); return; }
    if (res.detail) a.c.send(a.ws, { t: "toast", text: res.detail });
    a.c.broadcast(a.c.backlogSnapshot());
};

const onBacklogArchive: Route<"backlog.archive"> = (a) => {
    a.c.backlog.archive(a.msg.id, a.msg.archived);
};

const onBacklogCheck: Route<"backlog.check"> = (a) => {
    void a.c.review.check(a.msg.id);
};

const onBacklogValidate: Route<"backlog.validate"> = (a) => {
    void a.c.review.validate(a.msg.id);
};

const onBacklogNextStep: Route<"backlog.nextStep"> = (a) => {
    void a.c.review.nextStep(a.msg.id, a.msg.step);
};

const onBacklogContinue: Route<"backlog.continue"> = (a) => {
    void a.c.review.continueWork(a.msg.id);
};

export const workbacklogRoutes: RouteTable = {
  "fanout.list": onFanoutList,
  "fanout.run": onFanoutRun,
  "fanout.followup": onFanoutFollowup,
  "backlog.list": onBacklogList,
  "backlog.add": onBacklogAdd,
  "backlog.remove": onBacklogRemove,
  "backlog.fire": onBacklogFire,
  "backlog.done": onBacklogDone,
  "backlog.update": onBacklogUpdate,
  "backlog.swap": onBacklogSwap,
  "backlog.reorder": onBacklogReorder,
  "backlog.setAuto": onBacklogSetAuto,
  "backlog.setSmartPick": onBacklogSetSmartPick,
  "backlog.name": onBacklogName,
  "backlog.unmerge": onBacklogUnmerge,
  "backlog.openRepoSession": onBacklogOpenRepoSession,
  "backlog.archive": onBacklogArchive,
  "backlog.check": onBacklogCheck,
  "backlog.validate": onBacklogValidate,
  "backlog.nextStep": onBacklogNextStep,
  "backlog.continue": onBacklogContinue,
};
