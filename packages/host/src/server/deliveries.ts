/**
 * How the host types words into a session on its own and says what became of
 * them: a create's first prompt (`startPrompt`), a work item's chain
 * (`deliverChain`), the compose send (`deliverInput`), and the open-delivery
 * sweep's re-send callback, `"settled"` listener and snapshot.
 *
 * Moved verbatim out of `main.ts` (M2 of the host split, see
 * docs/notes/host-architecture.md). Every main-scope name is read as
 * `ctx.<name>` at CALL time — `startPrompt` reaches `ctx.backlog`, which
 * `main.ts` constructs long after this factory is called. The
 * `new OpenDeliveries(…)`, `setOpenDeliveries(…)` and the `DOCTOR`-gated
 * `.start()` stay in `main.ts`, around `wireDeliverySettled()`.
 *
 * Never a second delivery path: every word still goes through `deliver.ts`.
 */
import { basename } from "node:path";
import type { HostMessage, OpenDelivery, SendView } from "@waterplane/shared";
import { deliverPrompt, deliverToNewSession, type DeliveryResult } from "../deliver.js";
import type { Redeliverer } from "../opendeliveries.js";
import type { InputVerdict } from "../routes/types.js";
import type { ServerCtx } from "./ctx.js";
import { logTag } from "@waterplane/shared";

/** Everything `createDeliveries` built; `main.ts` assigns each into `ctx`. */
export type Deliveries = ReturnType<typeof createDeliveries>;

export function createDeliveries(ctx: ServerCtx) {
  /**
   * Type a `session.create`'s `prompt` into the session it just made.
   *
   * Deliberately not awaited by the op: the create is accepted the moment the PTY
   * exists, and delivery takes seconds (the TUI has to boot, the echo has to be
   * confirmed, the Return has to be proven). A failure is therefore never a failed
   * op — the session IS open, and re-sending the op would spawn a second one.
   *
   * What a failure must not be either is what it was: a broadcast TOAST. The
   * phone's own record of that prompt is already gone by then (the pad note was
   * dispatched, the queue entry acked `ok`), so a sentence painted for whoever was
   * looking at a screen at that second was the only trace of the whole message —
   * "a new session opened and the prompt never showed up", with nothing anywhere
   * to recover it from. Two things instead, split on the ONE distinction that
   * matters here, which is whether anything was typed:
   *
   *   • `retry` — provably nothing was typed (the TUI never became ready). The
   *     text is safe to hold somewhere and safe to fire again, so it goes into
   *     that repo's work items, aimed at this session. Durable, restart-proof,
   *     visible in the Backlog sheet, one tap to fire.
   *   • `unconfirmed` / `unsubmitted` — it may be sitting in that composer. These
   *     may never be re-queued (that is how a prompt gets run twice), so they only
   *     get named.
   *
   * Both notify (`undelivered`), which is a feed row AND a push: the thing this
   * has to survive is the phone being in a pocket.
   */
  async function startPrompt(sessionId: string, text: string, opts: { rescue?: boolean } = {}): Promise<DeliveryResult> {
    let res: DeliveryResult;
    // WHY a `retry` happened, in the delivery's own words. "Never became ready"
    // and "the desk's input box already holds text ("y")" are the same verdict
    // and different instructions to the person reading the push.
    let why: string | undefined;
    try {
      res = await deliverToNewSession(ctx.sessions, sessionId, text, text.startsWith("/") ? "command" : "prompt",
        { audit: { source: "create", actor: "user", detail: "first prompt of a new session" }, onDetail: (d) => { why = d; } });
    } catch {
      res = "unconfirmed";
    }
    // The verdict is RETURNED now, and the rescue below is opt-out, because one
    // caller already has somewhere durable to put the words: a work item's own row
    // IS the record this rescue exists to recreate, and re-queuing into a second
    // row would leave the repo holding the same prompt twice. That caller reads
    // the verdict and settles its row on it (`freshSession`).
    if (res === "ok" || opts.rescue === false) return res;
    const info = ctx.sessions.get(sessionId);
    const repo = info ? basename(info.cwd) : "that repo";
    const head = text.trim().split("\n")[0].slice(0, 80);
    if (res === "retry" && info) {
      // Nothing was typed — the one verdict that makes a second attempt safe.
      // It becomes a work item rather than a second delivery here: another type
      // now would race the same un-ready TUI, and a work item is the queue this
      // host already has for "run this in that repo when it can".
      ctx.backlog.add(text, info.cwd, head, sessionId);
      ctx.notify("undelivered", {
        title: `Prompt not delivered · ${repo}`,
        body: why
          ? `${why.charAt(0).toUpperCase()}${why.slice(1)}. Kept as a work item — fire it from the Backlog. “${head}”`
          : `The session opened but never became ready, so nothing was typed. Kept as a work item — fire it from the Backlog. “${head}”`,
        sessionId,
        tag: `undelivered-${sessionId}`, key: `undelivered:${sessionId}`,
      });
      return res;
    }
    // `unconfirmed` / `unsubmitted` are NOT reported here any more, and the
    // silence is the point. Both are now open questions (`opendeliveries.ts`):
    // the host keeps asking the CLI's own conversation log what became of this
    // delivery, and one of `landed` / `composer` / `absent` is true within
    // seconds. Alerting at this moment would push "your prompt never ran" for a
    // prompt that is running — which is precisely the false alarm that filled a
    // phone with 67 rows — and would then have to be contradicted by the
    // resolution a moment later. The sweep's terminal verdict is what notifies,
    // because it is the first thing said here that is known to be true.
    console.log(`${logTag} prompt unconfirmed (${res}) · ${repo} — the host is settling it: “${head}”`);
    return res;
  }

  /**
   * Deliver a chain one turn at a time, never concatenated. `deliverPrompt` waits
   * for the session to be ready, so awaiting each step is what puts them on
   * separate turns. Stops at the first step that does not land.
   *
   * It answers WHICH step stopped as well as what happened to it. `retry` means
   * "provably nothing was typed" about THAT STEP, never about the item, and the
   * caller has to be able to tell a first-step `retry` (safe to run the item
   * again) from a later one (step 1 already ran, so running the item again types
   * it twice). `backlog.ts`'s `retryableStep` is where that rule is written down.
   */
  async function deliverChain(sessionId: string, steps: readonly string[]): Promise<{ last: DeliveryResult; step: number }> {
    let last: DeliveryResult = "ok";
    let step = 0;
    for (; step < steps.length; step++) {
      last = await deliverPrompt(ctx.sessions, sessionId, steps[step], steps[step].trimStart().startsWith("/") ? "command" : "prompt",
        { audit: { source: "backlog", actor: "auto", detail: "a durable intent came due" } });
      if (last !== "ok") break;
    }
    return { last, step };
  }

  /** The `OpenDeliveries` re-send callback (`Redeliverer`). The construction
   *  stays in `main.ts`; this is its third argument. */
  const resendOpenDelivery: Redeliverer = async (q) => {
    // The re-send of a prompt that provably never ran. Not `interactive`: this is
    // the host typing with nobody present, so it waits for the session to be
    // ready the way the backlog and the fan-out do, rather than interjecting into
    // whatever turn happens to be running. `watch: false` because its verdict
    // updates the row that ordered it — a second row would make one prompt look
    // like two, and an ambiguous re-send would open a question whose only answer
    // is another re-send.
    const res = await deliverPrompt(ctx.sessions, q.sessionId, q.text, q.kind === "command" ? "command" : "prompt", {
      watch: false,
      audit: { source: q.source, actor: "auto", detail: "re-sent by the host: the conversation log proved it never ran" },
    });
    return res;
  };

  /** `openDeliveries.on("settled")` — called once, by `main.ts`, right after
   *  `setOpenDeliveries(openDeliveries)` and before the gated `.start()`. */
  function wireDeliverySettled(): void {
    ctx.openDeliveries.on("settled", (q: OpenDelivery) => {
      ctx.broadcast({ t: "delivery.settled", item: q });
      const repo = q.repoName || "that repo";
      if (q.verdict === "landed") {
        // An "undelivered" item is NOT resolved here: its words are still unrun (they went to
        // the backlog); only the person's `done` clears it.
        // It ran. Nothing to tell anybody — the row retires and the queue row with
        // it — UNLESS the host is the reason it ran, in which case a turn nobody
        // started is a surprise worth naming.
        if (q.resentAt) {
          ctx.notify("info", {
            title: `Prompt re-sent · ${repo}`,
            body: `It had never run, so the host sent it again — it is running now. “${q.head}”`,
            sessionId: q.sessionId,
            tag: `resent-${q.sessionId}`,
          });
        }
        return;
      }
      // A row a client claimed is a row that client is showing, in red, with its
      // own recovery buttons on it. Buzzing the phone about the thing already on
      // its screen is how the kinds that need a human get buried.
      if (q.clientOwned) return;
      // Everything else is a prompt that did not run, said once and only once the
      // host knows it to be true. The alert `deliver.ts` used to fire immediately —
      // before anything had been checked — is gone; this is its replacement.
      ctx.notify("undelivered", {
        title: q.verdict === "composer" ? `Prompt waiting · ${repo}` : `Prompt not delivered · ${repo}`,
        body: `${q.reason ?? "the host could not confirm it"} — “${q.head}”`,
        sessionId: q.sessionId,
        tag: `undelivered-${q.sessionId}`, key: `undelivered:${q.sessionId}`,
      });
    });
  }

  function deliverySnapshot(): HostMessage {
    return { t: "delivery.list", items: ctx.openDeliveries.list() };
  }

  /**
   * Deliver a compose/slash send the way the backlog and the fan-out deliver
   * theirs: type it, confirm it echoed, press Return, and (on a hooked session)
   * prove the turn started.
   *
   * This is the fix for compose sends that silently disappeared. The old path
   * wrote the bytes, answered `ok`, and left the CLIENT to fire the submitting
   * Return as a separate, unacked socket write — after the outbox entry had
   * already been dropped on that `ok`. A tunnel that died in between (the common
   * case: the reconnect watchdog reloads the page, taking ws.ts's in-memory send
   * queue with it) left the prompt sitting in the composer, unsent, with nothing
   * left to retry and a UI that said "sent".
   *
   * `remoteControl` is still honoured — `deliverPrompt` writes through
   * `sessions.write()`, which is the automation path and bypasses that gate, so
   * the check has to happen here.
   */
  async function deliverInput(id: string, text: string, ackId?: string, cwd?: string, view?: SendView): Promise<InputVerdict> {
    const info = ctx.sessions.get(id);
    if (!info || !info.running) {
      // The session died between composing and sending — the common case on a
      // phone, where the two can be an hour apart.
      //
      // Refusing is what this used to do, and it pushed the whole problem onto
      // the client: the phone had to notice, re-derive this very liveness test
      // (`!info || !info.running`, copied into `goneLanes`), run a 45-second
      // grace by its OWN clock, and only then re-aim the words at that repo's
      // work items. That clock only ticks while a tab is foregrounded, so a
      // phone that reconnects for ten seconds and sleeps rescued nothing.
      //
      // The host is awake and owns the store, so it keeps the words itself: a
      // work item in the repo the prompt was composed for, on disk, which runs
      // when that repo next has a session. `ok: false` because THIS delivery did
      // not happen — but `rescued` tells the client to drop the row rather than
      // retry it, since a retry would post the same prose twice.
      //
      // Only when the client named a repo. Without one there is nowhere to put
      // it, and inventing a target for somebody's words is worse than saying no.
      const dir = cwd ? await ctx.containRepoDir(cwd) : null;
      if (dir && text.trim()) {
        try {
          const item = ctx.backlog.add(text, dir, text.trim().split("\n")[0].slice(0, 60));
          const where = basename(dir);
          ctx.notify("undelivered", {
            title: "Session gone — kept as a work item",
            body: `${where}: ${item.label || text.trim().slice(0, 60)}`,
          });
          return { ok: false, state: "rescued", reason: `that session is gone — the words are a work item in ${where} now, and will run when it next has a session` };
        } catch {
          // Falling through to the plain refusal is the safe direction: the
          // client still holds the text and can retry or re-aim it by hand.
        }
      }
      return { ok: false, reason: "session not available" };
    }
    if (!info.remoteControl) return { ok: false, reason: "remote control is off for this session" };
    let res: Awaited<ReturnType<typeof deliverPrompt>>;
    // The sentence the delivery wrote about itself, if it wrote one. `retry` is
    // one enum value covering two different events, and only one of them ("that
    // composer already holds text this app cannot tell apart from yours") is
    // something a person can act on — reporting it as "the session never reached
    // its prompt" is a row that says the wrong thing, on the screen that exists
    // to say the right one.
    let detail: string | undefined;
    // A person sending to a session past its budget chose to let it work: an
    // Esc still owed for that crossing would interrupt the turn they just asked
    // for (`sessions/budgetwatch.ts`). Under a HARD budget this also grants
    // that turn its run — the phone asked "send anyway?" first.
    ctx.sessions.settleBudgetEsc(id, true);
    try {
      // `interactive` — a person typed this. Do not wait for the agent to finish;
      // typing at a working session is a deliberate interjection, and the app has a
      // separate, explicit "hold until idle" mode for the other intent.
      //
      // `ackId` rides along so that an unconfirmable verdict, settled minutes
      // later by the sweep, can name the row it retires. This is the path the 67
      // stuck rows came down.
      res = await deliverPrompt(ctx.sessions, id, text, text.trimStart().startsWith("/") ? "command" : "prompt",
        { interactive: true, ackId, view, audit: { source: "compose", actor: "user" }, onDetail: (d) => { detail = d; } });
    } catch (e) {
      // A host fault, not a completed delivery: report it retryable so the phone
      // keeps the text queued rather than failing it (and so the verdict is not
      // remembered — see the caller).
      return { ok: false, reason: String((e as Error)?.message || e), state: "notready", retryable: true };
    }
    ctx.netstats.noteDelivery(res);
    switch (res) {
      case "ok":
        return { ok: true, state: "ok" };
      case "retry":
        // Provably NOTHING was typed, so a second attempt cannot stack a copy.
        // The only auto-retryable failure of the four.
        return { ok: false, state: "notready", reason: detail ?? "the session never reached its prompt", retryable: true };
      case "unsubmitted":
        return { ok: false, state: "unsubmitted", reason: "typed, but Return was swallowed — open the session and press Return" };
      default:
        return { ok: false, state: "unconfirmed", reason: "typed, but never appeared on screen — check the session before re-sending" };
    }
  }

  return { startPrompt, deliverChain, resendOpenDelivery, wireDeliverySettled, deliverySnapshot, deliverInput };
}
