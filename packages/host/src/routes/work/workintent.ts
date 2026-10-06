/**
 * Work routes — intent slice of `routes/work.ts` (see that file for the whole picture).
 */
import { postClientDraft } from "../../agentintents.js";
import type { Route, RouteSpec, RouteTable } from "../types.js";

const onIntentList: Route<"intent.list"> = (a) => {
    a.c.send(a.ws, a.c.intentSnapshot());
};

/**
 * Take ownership of a piece of work.
 *
 * The receipt means more here than it does anywhere else on this wire: `ok`
 * is not sent until the row is on disk (`IntentManager.post` persists
 * synchronously and the dispatcher acks afterwards), because "the phone may now
 * forget these words" is the entire promise.
 */
const onIntentPost: RouteSpec<"intent.post"> = {
  durable: true,
  run: async (a) => {
    // The ONE client path into the store (`agentintents.ts`'s
    // `postClientDraft`): the cwd contained by hand — `contain` names a
    // top-level string and this one is nested — the naming authors forced to
    // `hand`, the budget fields and the agent mark stripped. The agent's HTTP
    // route calls the same function, so the two cannot drift.
    const posted = await postClientDraft(a.c, a.msg.intent);
    if (!posted.ok) {
      a.c.send(a.ws, { t: "toast", text: posted.refusedCwd ? "that folder is outside the configured root — nothing was written down" : `not queued: ${posted.reason}` });
      return { ok: false, reason: posted.reason };
    }
    // A replayed intent id past the ledger's TTL lands here and gets the SAME
    // row back — the second at-most-once guard, and the one that makes the
    // phone's 30-minute expiry deletable.
    return { ok: true, intentId: posted.intent.id, launchId: posted.intent.trigger.kind === "files" ? posted.intent.id : undefined };
  },
};

/** Run it now, whatever the trigger says. Durable: "run it now" delivered twice
 *  is the sweep running twice. */
const onIntentRun: RouteSpec<"intent.run"> = {
  durable: true,
  run: (a) => a.c.intents.runNow(a.msg.id).then((r) => {
    if (!r.ok) a.c.send(a.ws, { t: "toast", text: `intent: ${r.reason}` });
    return { ok: r.ok, reason: r.reason, intentId: a.msg.id };
  }),
};

/**
 * Put a failed row back in the queue — the row's own tap, and the hand half of
 * what an assessment's *still wanted* does.
 *
 * Durable for `intent.run`'s reason and one more: a re-queue delivered twice
 * would otherwise write a second history entry saying a person asked twice,
 * which is a sentence on the row that nobody said. At-most-once by ackId makes
 * the replay a re-ack that writes nothing.
 *
 * And a re-queue delivered an HOUR late is safe — the case `intent.cancel` is
 * deliberately not durable for — because the manager re-asks the live state:
 * a row that ran in the meantime is refused in words rather than revived.
 *
 * ── …except that "still failed" is not the same failure ──────────────────────
 *
 * The state guard is what makes a late delivery safe, and on its own it is not
 * enough. `failed` is a STATE, not an event: in the hour this op spent in an
 * outbox the row can have been put back by hand or by an assessment, run, and
 * failed again on something completely different. The manager's re-ask says
 * "yes, failed" to that and revives it — starting the work over on the strength
 * of a failure nobody has read, and quietly retiring the one that is actually
 * on the row.
 *
 * So the phone sends WHICH failure it was looking at (`failedAt`) and it is
 * compared with the row's own `settledAt` here. Equal, or absent — an older
 * client, a row with no stamp — proceeds on the existing guard, which is
 * `expectPrompt`'s posture on absence and the behaviour every build before this
 * field had. Different ⇒ refused in words that say the row has failed again, so
 * the person looks at the new failure and taps again if they still mean it.
 * `by: "hand"` and not `"run"`: this tap puts the row back to wait its turn and
 * fires nothing.
 */
const onIntentRequeue: RouteSpec<"intent.requeue"> = {
  durable: true,
  run: (a) => {
    const row = a.c.intents.get(a.msg.id);
    if (a.msg.failedAt != null && row?.settledAt != null && row.settledAt !== a.msg.failedAt) {
      const reason = "it has failed again since you looked — open it and read the new failure, then put it back if you still want it";
      a.c.send(a.ws, { t: "toast", text: `intent: ${reason}` });
      return { ok: false, reason, intentId: a.msg.id };
    }
    const r = a.c.intents.requeueFailed(a.msg.id, { kind: "hand" });
    if (!r.ok) a.c.send(a.ws, { t: "toast", text: `intent: ${r.reason}` });
    return { ok: r.ok, reason: r.reason, intentId: a.msg.id };
  },
};

const onIntentUpdate: RouteSpec<"intent.update"> = {
  durable: true,
  run: (a) => {
    const r = a.c.intents.update(a.msg.id, a.msg.patch);
    if (!r.ok) a.c.send(a.ws, { t: "toast", text: `intent: ${r.reason}` });
    return { ok: r.ok, reason: r.reason, intentId: a.msg.id };
  },
};

// Lifts ONE rung (the budget) for one row — never a fire. Durable like
// `intent.update`: a replayed waiver sets the same flag again.
const onIntentWaive: RouteSpec<"intent.waive"> = {
  durable: true,
  run: (a) => {
    const r = a.c.intents.waive(a.msg.id, a.msg.rung, a.msg.on);
    if (!r.ok) a.c.send(a.ws, { t: "toast", text: `intent: ${r.reason}` });
    return { ok: r.ok, reason: r.reason, intentId: a.msg.id };
  },
};

const onIntentRetarget: RouteSpec<"intent.retarget"> = {
  durable: true,
  run: (a) => {
    const r = a.c.intents.retarget(a.msg.id, a.msg.target, a.msg.cwd);
    if (!r.ok) a.c.send(a.ws, { t: "toast", text: `intent: ${r.reason}` });
    return { ok: r.ok, reason: r.reason, intentId: a.msg.id };
  },
};

const onIntentCancel: Route<"intent.cancel"> = (a) => {
    // Deliberately not durable and never queued offline: a cancel delivered an
    // hour late calls off work that has since run.
    if (!a.c.intents.cancel(a.msg.id)) a.c.send(a.ws, { t: "toast", text: "that one has already been settled" });
};

const onIntentDismiss: Route<"intent.dismiss"> = (a) => {
    a.c.intents.dismiss(a.msg.id);
};

export const workintentRoutes: RouteTable = {
  "intent.list": onIntentList,
  "intent.post": onIntentPost,
  "intent.run": onIntentRun,
  "intent.requeue": onIntentRequeue,
  "intent.update": onIntentUpdate,
  "intent.waive": onIntentWaive,
  "intent.retarget": onIntentRetarget,
  "intent.cancel": onIntentCancel,
  "intent.dismiss": onIntentDismiss,
};
