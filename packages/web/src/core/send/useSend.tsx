/**
 * **The one send surface's plumbing** — how a seed reaches `SendSheet`, and how
 * the finished intent reaches the send paths that were already there.
 *
 * Twelve entry points each asked a different subset of the same four
 * questions (what / where / when / how many at once), in a different order,
 * and answered the rest by existing. `SendSheet` asks all four with every
 * answer pre-filled; this hook is the two functions it needs — `openSend` and
 * `dispatchIntent` — plus the seeds other screens hand it, the per-repo send
 * memory both the sheet and the compose bar write, and the re-time editor a
 * LIST draws over itself.
 *
 * A repair — "this never went, fix it and send it again" — is the same sheet
 * with `repair` on, which is what makes the queue's third option (rewrite the
 * words, fix or drop each file) available from every entry point rather than
 * only from a failed row.
 *
 * Lifted out of `App.tsx` unchanged; every name App used is a member of the
 * return. **No new send path**: every arm of `dispatchIntent` is a call the
 * queue core already makes (`submitInput`, `queueOp`, `queueBacklog`) or the
 * launch core's `startSessionWithPrompt`.
 */
import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  budgetReasonText, describeRule, ruleRecurs, typedName, DEFAULT_GRACE_MIN, DRAFT_KEPT_TOAST, DRAFT_REFUSED_TOAST,
  repoBranchLabel,
} from "@waterplane/shared";
import type {
  ClientMessage, Intent, IntentDraft, IntentPatch, IntentTarget, LaunchOpts, RepoTarget, ScheduleEntry, SessionBudget, SessionInfo, UsageInfo,
} from "@waterplane/shared";
import {
  RETIME_NOW_SEG, WHEN_PATCH_OFFLINE, budgetHeldIds, fmtWhen, onceIn, pastBudgetToast, previewOf, seedAfterRescue,
  SEND_DRAFT, whenPatchToast, whenRoute, whenWords, type SendIntent, type SendResume, type SendSeed, type SendTarget, type SendWhen,
} from "../../sendIntent";
import { SendSheet } from "../../SendSheet";
import type { RenderRetime } from "../../RetimeBar";
import { BL_OFFLINE, retimeQueuedToast, retimeToast } from "../../backlogFilter";
import { rememberSend, type SendMemory } from "../../sendMemory";
import { clearDeadUpload, removePadNotes, seedSheetDraft, newAckId } from "../../outbox";
import { keptBytes, dropKept } from "../../attachments";
import { idbGet, idbSet } from "../../idb";
import { effectiveMaxWidth, scaleForUpload } from "../../uploadScale";
import { baseName } from "../../format";
import { LS, lsJson, lsSetJson } from "../../storage";
import { showToast } from "../../toast";
import { track } from "../../usage";
import type { Overlay } from "../../routing";
import type { HostConnection } from "../../ws";
import { buildLane, buildNameOf, buildQueueTitle, buildQueuedToast, useBuildNames } from "../../features/build";
import type { useQueue } from "../queue/useQueue.ts";

type Ref<T> = { readonly current: T };
/** The queue core's return, as App holds it (`const q = useQueue(...)`). */
export type QueueApi = ReturnType<typeof useQueue>;


export interface SendDeps {
  connRef: Ref<HostConnection>;
  liveSend(frame: ClientMessage, done: string, blocked?: string): boolean;
  liveSendAll(frames: ClientMessage[], done: string, blocked?: string): boolean;
  /** The one send path — and its pending session (a queued create's screen,
   *  a legitimate target) and the host's usage budget, both the queue's. */
  queue: QueueApi;
  sessions: SessionInfo[];
  /** A getter: the launcher's cut is derived below the hook call in App. */
  getVisibleRepos(): RepoTarget[];
  intents: Intent[];
  usage: UsageInfo | null;
  launch: LaunchOpts;
  wireLaunch(o: LaunchOpts): LaunchOpts;
  geomRef: Ref<{ cols: number; rows: number }>;
  repoForCwd(cwd: string): RepoTarget | null;
  startSessionWithPrompt(cwd: string, title: string, prompts: string[], sequential?: boolean,
    launchOverride?: LaunchOpts, resume?: boolean, onCancel?: () => void, budget?: SessionBudget): void;
  setOverlay(o: Overlay): void;
  attach(s: SessionInfo): void;
}

export type SendApi = ReturnType<typeof useSend>;

export function useSend(deps: SendDeps) {
  const {
    connRef, liveSend, liveSendAll, queue, sessions, getVisibleRepos, intents, usage,
    launch, wireLaunch, geomRef, repoForCwd, startSessionWithPrompt, setOverlay, attach,
  } = deps;
  const { pendingSession, budget } = queue;
  const {
    guardChain, guardUploadRefs, queueOp, submitInput, queueBacklog, writeOutbox, outboxRef, addOutbox, flushOutbox,
    queueImageUpload,
  } = queue;
  const outbox = queue.entries;
  const buildNames = useBuildNames(); // subscribed: the Send sheet's names repaint when a list lands

  /**
   * The Send sheet's seed, or null when it is closed.
   *
   * The sheet OPENS on what this repo was last sent with (`recallWhen`) and
   * says so in its origin line — that is how ten prompts get queued for the
   * same time without setting the clock ten times. It is not the persisted
   * `waterplane.sendMode` that was deleted: that one armed the PRIMARY button with a
   * wall clock and displayed it nowhere, and the only way to find out was to
   * tap it. Here the recalled answer lands in the sheet, which draws the rule
   * in words and restates the whole decision on its own button.
   */
  const [sendSeed, setSendSeed] = useState<SendSeed | null>(null);
  // Read from callbacks that outlive the render that set it — the annotator
  // unmounts the sheet and comes back through `afterUpload`.
  const sendSeedRef = useRef<SendSeed | null>(null);
  sendSeedRef.current = sendSeed;
  /** What the Send sheet had decided when it last unmounted — see `SendResume`.
   *  It lives here and not in the sheet because the sheet is REPLACED by the
   *  annotator, and it lives in a ref and not in state because reading it back
   *  is a render of the sheet, never a reason to re-render this. Cleared with
   *  the seed, so one send's schedule can never leak into the next. */
  const sendResumeRef = useRef<SendResume | null>(null);

  /**
   * How each repo's last send was aimed. A ref, not state: nothing on screen
   * reads the whole map — the two things derived from it (`sendMode`, and the
   * sheet's seeded WHEN) are read at the moment a repo becomes current or a
   * sheet opens, so a re-render on every write would repaint the app for a fact
   * no pixel shows.
   */
  const sendMemRef = useRef<SendMemory>(lsJson<SendMemory>(LS.sendMemory, {}));
  /** The one writer. Merges — the composer decides `mode`, the sheet decides
   *  `when`, and neither may erase what the other last said. */
  function noteSendAim(cwd: string | null | undefined, patch: Parameters<typeof rememberSend>[2]): void {
    const next = rememberSend(sendMemRef.current, cwd, patch, Date.now());
    if (next === sendMemRef.current) return;
    sendMemRef.current = next;
    lsSetJson(LS.sendMemory, next);
  }

  /**
   * **One new WHEN for many rows that exist — one tap, one receipt.** The same
   * contract as *drop the clock* (an `intent.update` per row carrying a
   * `trigger`; the wire has no batch frame), with whatever the When editor
   * chose: a clock or usage-window rule, *when it's free*, *now*, or *after
   * another…*. Only the trigger moves — each row keeps its words, target and
   * place. *Wait until it's free* is carried as `holdForHost` beside a rule
   * (as the single-row re-time does) and left alone otherwise. Live-only, like
   * every backlog mutation: a decision about WHEN replayed an hour late is
   * about a moment that may have gone.
   */
  function retimeMany(ids: string[], w: SendWhen): boolean {
    const trigger: IntentPatch["trigger"] = w.kind === "at"
      ? { kind: "at", rule: w.rule, graceMin: w.graceMin }
      : w.kind === "after"
        ? { kind: "after", id: w.id, onlyIfOk: w.onlyIfOk, title: w.title }
        : { kind: w.kind };
    const words = w.kind === "at" ? describeRule(w.rule) : w.kind === "now" ? RETIME_NOW_SEG : whenWords(w, previewOf(w, usage ?? undefined));
    // With no clock the rows move from the clock list to their repo's ⌛ chip,
    // and the receipt says so — four rows re-timed to "now" read as gone.
    const repoNames = [...new Set(ids.flatMap((id) => {
      const cwd = intents.find((x) => x.id === id)?.cwd;
      const name = cwd ? (repoForCwd(cwd)?.repoName ?? baseName(cwd)) : "";
      return name ? [name] : [];
    }))];
    // The *held until* clause only when the budget holds one of THESE rows — a
    // row already let past it (`pastBudget`) is not waiting for it.
    const held = budget?.verdict.blocked && budgetHeldIds(ids, intents).length > 0
      ? (budget.verdict.resumeAt ? fmtWhen(budget.verdict.resumeAt) : "it clears") : null;
    const toast = w.kind === "at" ? retimeToast(ids.length, words) : retimeQueuedToast(ids.length, words, repoNames, held);
    return liveSendAll(
      ids.map((id) => ({
        t: "intent.update", id,
        patch: { trigger, ...(w.kind === "at" ? { holdForHost: !!w.waitUntilFree } : {}) },
      })),
      toast, BL_OFFLINE);
  }
  /**
   * The When editor for a re-time: the Send sheet in its re-time mode, drawn by
   * the LIST that asked (over it, so a cancel leaves its ticks and its filter
   * where they were). Seeded from the first ticked row's own clock, so the
   * editor opens on a rule somebody already chose rather than on "in 1h".
   */
  const renderRetime: RenderRetime = (ids, done): ReactNode => {
    const first = intents.find((x) => x.id === ids[0]);
    const seedWhen: SendWhen = first?.trigger.kind === "at"
      ? { kind: "at", rule: first.trigger.rule, graceMin: first.trigger.graceMin, ...(first.holdForHost ? { waitUntilFree: true } : {}) }
      : onceIn(3600e3);
    let sent = false;
    return (
      <SendSheet
        seed={{ retime: { ids }, when: seedWhen, draftKey: "send.retime" }}
        sessions={sessions} repos={getVisibleRepos()} outbox={outbox} online={connRef.current.status === "open"} usage={usage}
        intents={intents}
        buildName={buildNames}
        onAttach={async () => []} onAnnotate={() => {}}
        onSend={(intent) => { sent = retimeMany(ids, intent.when); return sent; }}
        onClose={() => (sent ? done.onSent() : done.onCancel())}
        // The host's own sentence for what is holding automatic work, when
        // something is — a re-time is queued work, so it is held too.
        budgetHeld={budget?.verdict.blocked
          ? { note: budgetReasonText(budget.verdict), resumeAt: budget.verdict.resumeAt, ids: budgetHeldIds(ids, intents) }
          : null}
        // The one way past the BUDGET, and only the budget: `intent.waive` for
        // exactly the rows it holds, so they still run in turn — one at a time
        // per repo, behind the slots and the smart pick. A bulk verb never
        // sends `intent.run`: `runNow` skips the whole ladder, and four rows in
        // one checkout once started at the same second that way. Live-only —
        // "the budget holds these" is a live fact. One receipt for the tap.
        onPastBudget={(h) => {
          if (liveSendAll(h.map((id) => ({ t: "intent.waive", id, rung: "budget", on: true })), pastBudgetToast(h.length), BL_OFFLINE)) done.onSent();
        }}
      />
    );
  };

  /**
   * Where a message that already had a destination should be aimed NOW.
   *
   * The session it was written for may have died with the link — a session id
   * is per-boot — so it is only offered while it is still live; otherwise the
   * repo it was written in, which the row has carried all along. That `cwd` is
   * the answer to "I need to select the repo again for which the prompt was
   * meant": nothing here asks a message that has already said.
   */
  function sendTargetFor(sessionId: string | undefined, cwd: string | undefined): SendTarget | undefined {
    const s = sessionId ? sessions.find((x) => x.id === sessionId && x.running) : undefined;
    if (s) return { kind: "session", sessionId: s.id, cwd: s.cwd };
    return cwd ? { kind: "repo", cwd } : undefined;
  }

  /**
   * An existing schedule, as a send waiting to be re-decided — from the
   * durable row rather than from its `ScheduleEntry` projection (what an
   * Activity row hands back now that it carries the intent itself).
   * `scheduleId` is what makes the save an UPSERT rather than a second copy.
   */
  function seedFromIntent(i: Intent): SendSeed {
    const sweep = i.target.kind === "repos";
    const steps = i.payload.kind === "prompt" ? i.payload.steps : [];
    const text = steps[0] ?? "";
    return {
      // The WHOLE chain, for `seedFromSchedule`'s reason: an edit re-posts
      // whatever this seed produced, so seeding one turn of a three-turn row
      // would delete the other two — words somebody typed, thrown away by an
      // edit they made about the row's TIME.
      prompts: steps.length ? [...steps] : [text],
      // The row's own close-when-done answer comes in with it, so the patch
      // (which carries it absolutely) re-sends it rather than clearing it.
      target: sweep && i.target.kind === "repos" ? { kind: "repos", dirs: i.target.dirs, ...(i.budget ? { budget: i.budget } : {}) }
        : { kind: "repo", cwd: i.cwd, ...(typeof i.closeWhenDone === "boolean" ? { closeWhenDone: i.closeWhenDone } : {}), ...(i.budget ? { budget: i.budget } : {}) },
      // Only a name somebody TYPED is carried into the editor. `title` is the
      // host's `text.slice(0, 120)` whenever nobody typed one, and seeding it
      // round-trips a derivation back as a decision.
      when: i.trigger.kind === "at"
        ? {
            kind: "at", rule: i.trigger.rule, graceMin: i.trigger.graceMin ?? DEFAULT_GRACE_MIN,
            name: i.label || typedName(i.title, text) || undefined,
            waitUntilFree: i.serial === true && i.holdForHost === true ? true : undefined,
          }
        : undefined,
      cwdHint: i.cwd || null,
      scheduleId: i.id,
      origin: "Editing a schedule",
    };
  }

  function seedFromSchedule(e: ScheduleEntry): SendSeed {
    const a = e.action;
    return {
      // The WHOLE chain comes back, not its head. An edit re-posts whatever this
      // seed produced, so seeding one turn of a three-turn rule would delete the
      // other two. `[a.text]` is what a rule with no chain means.
      prompts: a.kind === "backlog" && a.steps?.length ? [...a.steps] : [a.text],
      target: a.kind === "fanout" ? { kind: "repos", dirs: a.dirs, ...(a.budget ? { budget: a.budget } : {}) }
        : { kind: "repo", cwd: a.repoDir, ...(typeof a.closeWhenDone === "boolean" ? { closeWhenDone: a.closeWhenDone } : {}), ...(a.budget ? { budget: a.budget } : {}) },
      // `seedFromIntent`'s rule, on the DTO: `e.name` is the host's derived
      // slice unless a person typed one.
      when: {
        kind: "at", rule: e.rule, graceMin: e.graceMin ?? DEFAULT_GRACE_MIN,
        name: typedName(e.name, a.text) || undefined,
        waitUntilFree: e.waitUntilFree,
      },
      cwdHint: a.kind === "fanout" ? a.dirs[0] ?? null : a.repoDir,
      scheduleId: e.id,
      origin: "Editing a schedule",
    };
  }

  /**
   * Show the session a send has just gone to.
   *
   * A pending create is a legitimate target (`SendSheet` is handed it as one),
   * so it is searched here too. A session that has since gone says nothing:
   * `dispatchIntent` has already spoken for this tap.
   */
  function openSent(sessionId: string): void {
    const s = (pendingSession ? [...sessions, pendingSession] : sessions).find((x) => x.id === sessionId);
    if (s) attach(s);
  }

  /**
   * Open the Send sheet on a seed.
   *
   * The prompt is written into the sheet's draft store HERE, not passed as a
   * prop the sheet reads once: attaching an image replaces this sheet with the
   * annotator, and the marked path comes back through that same buffer. One
   * authority for the words, so a round trip through the annotator cannot
   * resurrect the seed over the top of them.
   */
  function openSend(seed: SendSeed) {
    // Never a bare `saveSheetDraft`: this is the one writer that replaces words
    // somebody typed with words nobody did. Anything left in the slot becomes a
    // pad note first (`local/no-draft-clobber`) — and where the pad REFUSED it,
    // the draft is left exactly where it is and the sheet opens on it. A rescue
    // that could not happen must not also be a delete.
    const kept = seedSheetDraft(SEND_DRAFT, (seed.prompts?.length ? seed.prompts : [""]).join("\f"), seed.cwdHint);
    if (kept === "kept") showToast(DRAFT_KEPT_TOAST);
    else if (kept === "refused") showToast(DRAFT_REFUSED_TOAST);
    sendResumeRef.current = null;
    // On a refusal the slot still holds the OLD draft and the sheet will open on
    // it, so this seed's `padId`/`ackId` name a note and a queue row that have
    // nothing to do with the words about to be sent (`seedAfterRescue`).
    setSendSeed(seedAfterRescue(seed, kept));
    setOverlay("send");
  }

  /**
   * One decision, onto the paths that already exist. **No new send path.**
   *
   * Every arm here is a call the app already made from some sheet; what changes
   * is that the caller composed the decision instead of inheriting it from
   * which sheet they opened. Returns false when a send was REFUSED (the text
   * names an upload that will never arrive) so the sheet stays up with the
   * words in it — the one thing that must never be dropped.
   */
  function dispatchIntent(i: SendIntent, seed: SendSeed): boolean {
    const steps = i.prompts.map((p) => p.trim()).filter(Boolean);
    const first = steps[0] ?? "";
    const label = first.slice(0, 40);
    const kindOf = (t: string) => (t.trimStart().startsWith("/") ? "command" as const : "prompt" as const);

    /**
     * The upload guard runs over the WHOLE chain here, before any arm below has
     * posted anything — see `guardChain`. The per-arm guards further down stay:
     * they are the half that ADOPTS a live upload into the lane the words are
     * going to. What is hoisted is the refusal, which is the half that can lose
     * words. A build carries no prose, so it does not reach this. A schedule
     * does: a rule saved naming an upload that will never arrive is a prompt
     * that fires at 03:00 against a path nothing resolves.
     */
    if (i.target.kind !== "shell" && !guardChain(steps)) return false;

    /**
     * **The row this sheet was opened ON — re-decided, never duplicated.**
     *
     * `whenRoute` is the one decision (pure, `sendIntent.ts`, pinned), and a
     * `patch` is the exact contract *drop the clock* already uses:
     * `intent.update` carrying the new trigger. Live-only, never durable. The
     * refusal is a second line of defence: `sendBlocker` draws it on the button.
     */
    const editing = seed.scheduleId ? intents.find((x) => x.id === seed.scheduleId) ?? null : null;
    const route = whenRoute(i, editing);
    if (route.kind === "refuse") { showToast(route.why); return false; }
    if (route.kind === "patch" && editing) {
      // `IntentPatch` carries no budget (a cap is set when a row is made, and on a
      // live session by its own sheet), so a changed one here would be dropped
      // silently — the one way this app may not lose an answer. Said, with nothing sent.
      const asked = i.target.kind === "repo" || i.target.kind === "repos" ? i.target.budget : undefined;
      if (JSON.stringify(asked ?? null) !== JSON.stringify(editing.budget ?? null)) {
        showToast("a budget can't be changed on a row that is already waiting — remove the budget change, or post this as a new row");
        return false;
      }
      const patch: IntentPatch = {
        // The whole decision, not just the trigger: the words may have been
        // rewritten in the same breath as the time. Every field is an ABSOLUTE
        // value (`IntentPatch`), so a replay lands the same row in the same state.
        payload: { kind: "prompt", steps },
        trigger: i.when.kind === "after"
          ? { kind: "after", id: i.when.id, onlyIfOk: i.when.onlyIfOk, title: i.when.title }
          // A clock reaches this route only aimed at a SESSION (`whenRoute`).
          : i.when.kind === "at"
            ? { kind: "at", rule: i.when.rule, graceMin: i.when.graceMin }
            : { kind: i.when.kind === "idle" ? "idle" : "now" },
        target: i.target.kind === "session" ? { kind: "session", sessionId: i.target.sessionId } : { kind: "repo" },
        cwd: i.target.kind === "session" ? i.target.cwd : i.target.kind === "repo" ? i.target.cwd : undefined,
        resume: i.target.kind === "repo" ? !!i.target.resume : undefined,
        // Absolute like every field here: `null` is "follow the global" — the
        // seed carried the row's own answer in, so an untouched choice re-sends it.
        closeWhenDone: i.target.kind === "repo" ? i.target.closeWhenDone ?? null : undefined,
        holdForHost: i.when.kind === "at" ? !!i.when.waitUntilFree : undefined,
        label,
      };
      track("action:send.retime");
      if (!liveSend({ t: "intent.update", id: editing.id, patch }, whenPatchToast(i.when), WHEN_PATCH_OFFLINE)) return false;
      return true;
    }

    /**
     * ── at a wall-clock time, AIMED AT A SESSION ⇒ an intent, not a schedule.
     *
     * `ScheduleEntry` has no vocabulary for a session, so it rides
     * `intent.post`. The host snapshots the CONVERSATION that session is in
     * (`IntentTarget.resumeConvId`) as the row is written, so if the process
     * has gone when the rule fires, the row reopens that conversation.
     */
    if (i.when.kind === "at" && i.target.kind === "session") {
      const w = i.when;
      const t = i.target;
      const draft: IntentDraft = {
        id: seed.scheduleId ?? `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        cwd: t.cwd,
        payload: { kind: "prompt", steps },
        target: { kind: "session", sessionId: t.sessionId },
        trigger: { kind: "at", rule: w.rule, graceMin: w.graceMin },
        holdForHost: w.waitUntilFree || undefined,
        // A row aimed at one session by hand is exempt from the global
        // auto-fire switch and never from the account's budget.
        auto: true,
        pinned: true,
        label,
      };
      track("action:send.clockSession");
      if (!guardUploadRefs(steps.join("\n"), t.sessionId)) return false;
      const offline = queueOp({ t: "intent.post", intent: draft }, t.sessionId, first, { cwd: t.cwd });
      const chain = steps.length > 1 ? ` · ${steps.length} turns` : "";
      const at = previewOf(i.when, usage ?? undefined);
      const when = at != null ? fmtWhen(at) : "when its window opens";
      showToast(offline
        ? `Queued offline${chain} — it reaches the desktop when the link is back, then waits for ${when}`
        : `Queued${chain} for ${when} — it goes to that session, or to its conversation reopened if the session has gone`);
      return true;
    }

    // ── at a wall-clock time ⇒ a schedule, for every other target.
    // `schedule.save` upserts on a client-minted id, so an offline replay
    // overwrites instead of adding a second weekly sweep.
    if (i.when.kind === "at") {
      // Re-saving a row that HAD a cap with the field blanked is a CLEAR, and
      // only `null` says so: `schedule.save` upserts, and an absent budget there
      // keeps the stored one (an older bundle never heard of budgets).
      const cleared = editing?.budget && !(i.target.kind === "repo" || i.target.kind === "repos" ? i.target.budget : undefined)
        ? { budget: null } : {};
      const action: ScheduleEntry["action"] = i.target.kind === "repos"
        ? { kind: "fanout", dirs: i.target.dirs, text: first, ...(i.target.kind === "repos" && i.target.budget ? { budget: i.target.budget } : cleared) }
        // The WHOLE chain travels; `steps` only when there is more than one turn,
        // so a one-turn rule is written exactly as it always was.
        : { kind: "backlog", repoDir: i.target.cwd, text: first, autoFire: true, ...(steps.length > 1 ? { steps } : {}),
            ...(i.target.kind === "repo" && typeof i.target.closeWhenDone === "boolean" ? { closeWhenDone: i.target.closeWhenDone } : {}),
            ...(i.target.kind === "repo" && i.target.budget ? { budget: i.target.budget } : cleared) };
      const entry: ScheduleEntry = {
        id: seed.scheduleId ?? `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: (i.when.name ?? "").trim() || first.split("\n")[0].slice(0, 60),
        enabled: true,
        rule: i.when.rule,
        action,
        createdAt: Date.now(),
        // What this phone could see; for a window rule with no reading yet that
        // is null — "not armed", never "never".
        nextAt: previewOf(i.when, usage ?? undefined),
        graceMin: i.when.graceMin,
        waitUntilFree: i.when.waitUntilFree,
      };
      track("action:schedule.save");
      const offline = queueOp({ t: "schedule.save", entry }, `sched:${entry.id}`, entry.name);
      const chain = steps.length > 1 ? ` · ${steps.length} turns` : "";
      /**
       * **Where it actually lands, said at the moment of saving.** A one-off
       * aimed at ONE repo is a row in that repo's backlog wearing a clock
       * (`isTimedWorkRow`), not a schedule card; a rule that RECURS and a SWEEP
       * keep the sentence they always had.
       */
      const timed = i.target.kind === "repo" && !ruleRecurs(i.when.rule);
      const where = timed ? ` in ${repoForCwd(i.target.kind === "repo" ? i.target.cwd : "")?.repoName ?? "that repo"}` : "";
      if (i.target.kind === "repos" && steps.length > 1) showToast(`scheduled the first step — a sweep is ONE prompt, so the other ${steps.length - 1} were dropped`);
      else if (timed) showToast(offline
        ? `queued${chain} — it is saved to the backlog when the link is back`
        : `queued${where}${chain} for ${entry.nextAt != null ? fmtWhen(entry.nextAt) : "when its window opens"} — it is in the backlog`);
      else showToast(offline ? `queued${chain} — the schedule is saved when the link is back` : `schedule saved${chain}`);
      return true;
    }

    /**
     * ── after another item ⇒ a chained row, whatever the target is.
     *
     * The one WHEN that cannot ride on `backlog.add` (no trigger), so it is
     * `intent.post` — `ok` only once the row is on the desktop's disk. A session
     * target stays a session target: a chain is released by an event usually
     * minutes away, and the ladder has a sentence for a session that went.
     */
    if (i.when.kind === "after") {
      const w = i.when;
      // Defence behind `sendBlocker`'s refusal: a `{kind:"repos"}` intent is the
      // fan-out and `fanout.ts` reads `steps[0]` and nothing else.
      if (i.target.kind === "repos" && steps.length > 1) {
        showToast(`a sweep is ONE prompt — the other ${steps.length - 1} step${steps.length === 2 ? "" : "s"} would be dropped, so nothing was sent`);
        return false;
      }
      const cwd = i.target.kind === "repos" ? i.target.dirs[0] ?? "" : i.target.cwd;
      const target: IntentTarget = i.target.kind === "session"
        ? { kind: "session", sessionId: i.target.sessionId }
        : i.target.kind === "repos"
          ? { kind: "repos", dirs: i.target.dirs }
          // Bare `{kind:"repo"}`, normalised to `fresh: true` by `cleanTarget`.
          : { kind: "repo" };
      const draft: IntentDraft = {
        // Client-minted, and the at-most-once key for the row's whole LIFE.
        id: `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        cwd,
        // The whole chain, delivered one turn at a time by `deliverChain`.
        payload: { kind: "prompt", steps },
        target,
        trigger: { kind: "after", id: w.id, onlyIfOk: w.onlyIfOk, title: w.title },
        // `backlogDraft`'s reading of the same two flags.
        serial: i.target.kind === "session" ? undefined : true,
        auto: true,
        pinned: i.target.kind === "session" ? true : undefined,
        resume: i.target.kind === "repo" ? i.target.resume : undefined,
        closeWhenDone: i.target.kind === "repo" ? i.target.closeWhenDone : undefined,
        // Born with its cap (`Intent.budget`); a session target has no field for one.
        budget: i.target.kind === "repo" || i.target.kind === "repos" ? i.target.budget : undefined,
        label,
      };
      track("action:send.after");
      const lane = i.target.kind === "session" ? i.target.sessionId : cwd;
      // The ADOPT half of the guard, over the joined chain — step 3 may be the
      // turn that names the picture.
      if (!guardUploadRefs(steps.join("\n"), lane)) return false;
      const offline = queueOp({ t: "intent.post", intent: draft }, lane, first, { cwd });
      const chain = steps.length > 1 ? ` · ${steps.length} turns` : "";
      const waits = w.title ? `“${w.title}”` : "the item before it";
      showToast(offline
        ? `Queued offline${chain} — it reaches the desktop when the link is back, then waits for ${waits}`
        : `Queued${chain} — it goes in after ${waits} finishes`);
      return true;
    }

    const idle = i.when.kind === "idle";

    switch (i.target.kind) {
      /**
       * A live session. Step 1 goes the way the compose bar sends it; every
       * later step becomes a pinned item on the DESKTOP, in order — the host is
       * the one thing still there when the phone locks.
       */
      case "session": {
        const sid = i.target.sessionId, cwd = i.target.cwd;
        let sent = 0, offline = false;
        for (const [n, t] of steps.entries()) {
          if (n === 0 && !idle) {
            if (!submitInput(sid, cwd, t, kindOf(t))) return false;
            sent++;
            continue;
          }
          const q = queueBacklog({ text: t, repoDir: cwd, label: t.slice(0, 40), targetSessionId: sid, autoFire: true });
          // "Unreachable" is a claim about another function — keeping the words
          // costs a turn that runs twice, dropping them costs the last copy.
          if (q === null) { showToast("part of that chain could not be queued — its words are still in the box"); return false; }
          offline = offline || q;
          sent++;
        }
        if (!sent) return false;
        const rest = steps.length > 1 ? ` · ${steps.length - 1} more behind it` : "";
        showToast(offline || connRef.current.status !== "open" ? `queued — it reaches the desktop when the link is back${rest}`
          : idle ? `queued on the desktop — it goes in when this session is free${rest}`
            : `sent${rest}`);
        return true;
      }
      /**
       * A repo — a session opened for these words. `now` is the durable
       * `session.create` carrying its first prompt; `when it's free` is ONE
       * backlog item carrying the whole chain.
       */
      case "repo": {
        const cwd = i.target.cwd;
        if (!idle) {
          const repo = repoForCwd(cwd);
          /**
           * **The words come back if the launch question is dismissed.**
           * `startSessionWithPrompt` may DEFER the tap (model ask, hosted
           * notice); by then this sheet has cleared its draft and closed, so the
           * rescue re-opens it on exactly these steps — without the seed's
           * `ackId`/`padId`, which `retireSendSource` has already retired.
           */
          startSessionWithPrompt(cwd, repo ? repoBranchLabel(repo) : baseName(cwd), steps, i.sequential, undefined, i.target.resume,
            () => {
              openSend({ prompts: steps, target: i.target, cwdHint: cwd, repoId: seed.repoId, origin: seed.origin });
              showToast("nothing was started — your words are back in the send sheet");
            }, i.target.budget);
          return true;
        }
        const q = queueBacklog({
          text: first, steps, repoDir: cwd, label, autoFire: true, resume: i.target.resume, closeWhenDone: i.target.closeWhenDone, budget: i.target.budget,
        });
        if (q === null) return false;
        const chain = steps.length > 1 ? ` · ${steps.length} turns` : "";
        showToast(q ? `Queued offline${chain} · it reaches the desktop when the link is back`
          // The same clause the button used ("when this repo is free").
          : `Queued${chain} · a new session when this repo is free`);
        return true;
      }
      // A sweep. `all at once` is the fan-out (a fresh session in each);
      // `one at a time` is a work item in each repo. Both are existing paths.
      case "repos": {
        if (!i.sequential) {
          const offline = queueOp(
            // Gated like every create (`createOp`): a sweep is N spawns, so an
            // ungated stale `backend` here is the wrong binary N times.
            { t: "fanout.run", dirs: i.target.dirs, text: first, launch: wireLaunch(launch), ...(i.target.budget ? { budget: i.target.budget } : {}), cols: geomRef.current.cols, rows: geomRef.current.rows },
            "fanout", first,
          );
          if (steps.length > 1) showToast(`a sweep is ONE prompt — the other ${steps.length - 1} steps were dropped`);
          else showToast(offline ? "queued — the sweep runs when the link is back" : `fanning out to ${i.target.dirs.length} repo${i.target.dirs.length === 1 ? "" : "s"}`);
          return true;
        }
        // One item per REPO, each carrying the whole chain — not one per step.
        let added = 0, offline = false;
        for (const dir of i.target.dirs) {
          const q = queueBacklog({ text: first, steps, repoDir: dir, label, autoFire: true, budget: i.target.budget });
          if (q === null) { showToast("part of that sweep could not be queued — its words are still in the box"); return false; }
          offline = offline || q;
          added++;
        }
        if (!added) return false;
        const chain = steps.length > 1 ? ` · ${steps.length} turns each` : "";
        showToast(offline ? `Queued offline · ${added} repo${added === 1 ? "" : "s"}${chain} when the link is back`
          : `Queued for ${added} repo${added === 1 ? "" : "s"}${chain} — one at a time in each`);
        return true;
      }
      // A build: a shell in the repo, no agent. Durable, lane per repo.
      case "shell": {
        const name = buildNameOf(i.target.cwd, i.target.buildId);
        const offline = queueOp({ t: "build.run", repoDir: i.target.cwd, buildId: i.target.buildId },
          buildLane(i.target.cwd), buildQueueTitle(name), { cwd: i.target.cwd });
        showToast(buildQueuedToast(offline, name));
        return true;
      }
    }
  }

  /**
   * A posted send lets go of whatever it replaces — and only afterwards.
   * Retiring the source BEFORE the send is queued is how "nothing typed is
   * lost" gets broken.
   */
  function retireSendSource(seed: SendSeed) {
    if (seed.ackId) writeOutbox(outboxRef.current.filter((e) => e.ackId !== seed.ackId));
    // Through `removePadNotes`, which writes the tombstone — without one the
    // other device unions the note straight back in and sends it a second time.
    if (seed.padId) removePadNotes([seed.padId]);
  }

  /**
   * Put a retained copy back in the send queue under the path it always had.
   *
   * The bytes were moved aside when their entry died (`retainUploadBytes`), so
   * the file the prompt names can be uploaded again WITHOUT rewriting the
   * prompt. The dead mark goes with it, or `guardUploadRefs` would keep
   * refusing a send that is now perfectly good.
   */
  async function reattachKept(relPath: string, repoId: string, cwd: string): Promise<void> {
    track("action:resend.reattach");
    const blob = await keptBytes(relPath);
    if (!blob) { showToast("those bytes are no longer on this phone"); return; }
    const ackId = newAckId();
    const name = relPath.split("/").pop() || "file";
    await idbSet("uploads", ackId, blob);
    // Same read-back as `queueImageUpload`: a store that silently dropped the
    // write would leave a queue entry with no bytes.
    if (!(await idbGet<Blob>("uploads", ackId))) { showToast("couldn't park the file on this device"); return; }
    addOutbox({
      ackId, sessionId: cwd, cwd, text: `file · ${name}`,
      ts: Date.now(), status: "queued", attempts: 0, mode: "upload",
      upload: { repoId, name, relPath, size: blob.size, type: blob.type || "application/octet-stream" },
      armed: true,
    });
    clearDeadUpload(relPath);
    await dropKept(relPath);
    flushOutbox();
    showToast(connRef.current.status === "open" ? "re-attached — uploading" : "re-attached — uploads when the link is back");
  }

  /**
   * Pick a different file for one mention and queue it — its own hidden input
   * (`SendSheetEntry` mounts it beside the sheet). Resolves to the NEW path,
   * which the sheet substitutes into the text.
   */
  const replacePick = useRef<HTMLInputElement | null>(null);
  const replaceResolve = useRef<((p: string | null) => void) | null>(null);
  function pickReplacement(_relPath: string, repoId: string, cwd: string): Promise<string | null> {
    track("action:resend.replace");
    // A picker left open must not strand the previous promise.
    replaceResolve.current?.(null);
    return new Promise<string | null>((resolve) => {
      replaceResolve.current = async (raw) => {
        replaceResolve.current = null;
        resolve(raw);
      };
      const el = replacePick.current;
      if (!el) { replaceResolve.current = null; resolve(null); return; }
      el.value = ""; // same file twice in a row still fires `change`
      el.dataset.repoId = repoId;
      el.dataset.cwd = cwd;
      el.click();
    });
  }
  async function onPickReplacement(ev: ChangeEvent<HTMLInputElement>) {
    const el = ev.target;
    const file = el.files?.[0] ?? null;
    const repoId = el.dataset.repoId ?? "";
    const cwd = el.dataset.cwd ?? "";
    const done = replaceResolve.current;
    if (!file || !repoId || !done) { done?.(null); return; }
    try {
      const { width } = effectiveMaxWidth();
      const shrunk = await scaleForUpload(file, file.name, width);
      const parked = await queueImageUpload(repoId, shrunk.blob, shrunk.name, cwd, cwd);
      done(parked?.relPath ?? null);
      showToast(parked ? "attached — it uploads before the message" : "couldn't park that file");
    } catch {
      done(null);
      showToast("couldn't read that file");
    }
  }

  return {
    sendSeed, setSendSeed, sendSeedRef, sendResumeRef, sendMemRef, noteSendAim,
    openSend, openSent, dispatchIntent, retireSendSource, seedFromIntent, seedFromSchedule, sendTargetFor,
    retimeMany, renderRetime, reattachKept, pickReplacement, onPickReplacement, replacePick, buildNames,
  };
}
