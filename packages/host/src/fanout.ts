/**
 * Fan-out: run ONE prompt in N repos at once, each in its own FRESH `claude`
 * session. The maintenance case ("/init everywhere", "check this month's cost in
 * every project") is otherwise N manual repo taps plus N re-typings of the same
 * instruction.
 *
 * ── A run is now DURABLE, and that is the change ───────────────────────────
 *
 * It used to be an in-memory ring: "the sessions survive a host restart, the run
 * record doesn't need to". That was wrong in exactly the case that matters. A
 * restart mid-sweep left twelve live `claude` processes and no account of what
 * they were for, no way to follow up on them as a set, and — for a sweep the
 * phone had queued but the host had not yet started — no sweep at all.
 *
 * So a fan-out is N intents sharing a `groupId`: a parent row (the sweep as
 * posted, `target: repos`) and one child per repo (`target: repo+fresh`). The
 * store owns the clock, the lifecycle and the persistence; `FanoutRun` is
 * rebuilt from those rows on demand (`intents/adapters.ts`), so `fanout.*` is
 * unchanged on the wire and a restart mid-run reconciles instead of forgetting.
 *
 * What is left here is what is genuinely the fan-out's:
 *
 *   • **validation** — a dir from the phone must be one `discoverTargets()`
 *     returned. An unknown path is silently DROPPED, never spawned. This is a
 *     stricter gate than the root rule and is the one this feature has always
 *     used.
 *   • **one repo's spawn + delivery**, including the one-shot `retry`
 *     re-attempt: a session that has just booted is precisely the case that
 *     needs a second look, and `retry` means nothing was typed so a second look
 *     cannot stack a copy. `unconfirmed` never is.
 *   • **the follow-up**, which spawns nothing: a target whose session died is
 *     reported, not revived, because starting a fresh session would run "…and
 *     now commit that" against a repo that never did step one.
 *
 * The concurrency pool moved into the store, where it is a bound on rows of one
 * `groupId` that are DELIVERING at once — which is what the in-process pool
 * meant, minus the process it died with.
 */
import { randomUUID } from "node:crypto";
import type { FanoutRun, Intent, IntentDraft, LaunchOpts, SessionBudget } from "@waterplane/shared";
import { sessionOriginOfIntent } from "@waterplane/shared";
import type { SessionManager } from "./sessions.js";
import type { ExecutorResult, IntentManager } from "./intents/manager.js";
import { discoverTargets } from "./repos.js";
import { ORIGIN_FANOUT_FOLLOWUP, ORIGIN_FANOUT_RUN, ORIGIN_FANOUT_TARGET, fanoutRuns } from "./intents/adapters.js";
import { deliverPrompt, deliverToNewSession, type DeliveryResult } from "./deliver.js";
import { spawnFailure } from "./ptycap.js";
import { env } from "./env.js";

/** Why a target didn't deliver, phone-sized. `unsubmitted` means the prompt IS in
 *  that session's composer — one Return from running — so the row must say
 *  "press Return there", never "nothing happened" (re-running would type it twice). */
function deliveryError(res: DeliveryResult): string {
  if (res === "unconfirmed") return "typed but not confirmed on screen — open the session and check before re-running";
  if (res === "unsubmitted") return "typed but the Return was swallowed — open the session and press Return (don't re-run: it would type a second copy)";
  return "the session never became ready for input";
}

/** How many repos are spawned+fed concurrently. Each target is a real `claude`
 *  process, so a 20-repo fan-out fired in one go would stampede the machine.
 *  Enforced by the store, per `groupId` — see `IntentDeps.groupConcurrency`. */
export const FANOUT_CONCURRENCY = Math.max(1, Number(env("FANOUT_CONCURRENCY") || 6));

export class FanoutManager {
  constructor(
    private root: string,
    private sessions: SessionManager,
    private intents: IntentManager,
  ) {}

  /** The runs, rebuilt from the rows that ARE them. */
  list(): FanoutRun[] { return fanoutRuns(this.intents.list()); }

  /**
   * The dirs a sweep may legally name, with the labels its rows are titled by.
   *
   * The gate: `dirs` are worktree paths from a phone, so they are matched
   * against the DISCOVERED repo list and anything else is dropped. An arbitrary
   * path can never become a session cwd here.
   */
  async validate(dirs: string[]): Promise<{ dir: string; title: string }[]> {
    let known: Awaited<ReturnType<typeof discoverTargets>> = [];
    try { known = await discoverTargets(this.root); } catch { return []; }
    const out: { dir: string; title: string }[] = [];
    for (const dir of Array.from(new Set(dirs))) {
      const t = known.find((k) => k.worktreePath === dir);
      if (!t) continue; // unknown path — silently dropped, never spawned
      out.push({ dir, title: `${t.repoName} · ${t.branch}` });
    }
    return out;
  }

  /**
   * Start a run: validate, then post the sweep as one durable row.
   *
   * Returns as soon as the row is on disk. The children are posted by the
   * store when it fires the parent, each progresses on its own, and every
   * transition is broadcast by the store's `onChange` — the same shape the
   * in-memory version had, with the ring replaced by rows.
   */
  async start(
    dirs: string[],
    text: string,
    opts: { launch?: LaunchOpts; budget?: SessionBudget; cols?: number; rows?: number; id?: string } = {},
  ): Promise<FanoutRun | { error: string }> {
    const body = text.trim();
    if (!body) return { error: "nothing to run" };
    const targets = await this.validate(dirs);
    if (!targets.length) return { error: "no known repos selected" };
    const id = opts.id || randomUUID();
    const posted = this.intents.post({
      id,
      // A sweep has no single repo; the first target is the nominal cwd, which
      // is what the row names itself by. Every dir it touches is in
      // `target.dirs` and is validated there and again at fire time.
      cwd: targets[0].dir,
      payload: { kind: "prompt", steps: [body] },
      target: { kind: "repos", dirs: targets.map((t) => t.dir) },
      trigger: { kind: "now" },
      origin: ORIGIN_FANOUT_RUN,
      groupId: id,
      cols: opts.cols,
      rows: opts.rows,
      launch: opts.launch,
      // Not one budget for the sweep: EACH target's session is born with it.
      ...(opts.budget ? { budget: opts.budget } : {}),
    });
    if (!posted.ok || !posted.intent) return { error: posted.reason || "could not be written down" };
    return this.run(id) ?? { error: "could not be written down" };
  }

  /**
   * The sweep executor: one child intent per repo.
   *
   * Posting rather than spawning is what makes each target independently
   * durable, independently retryable and independently visible — and it is what
   * puts the concurrency bound in one place. The parent settles as soon as the
   * children exist, because "started" is all a sweep's own row ever claimed.
   */
  async sweep(i: Intent, dirs: string[]): Promise<ExecutorResult> {
    const body = i.payload.kind === "prompt" ? i.payload.steps[0] : "";
    const targets = await this.validate(dirs);
    if (!targets.length) return { ok: false, detail: "none of those repos is still there" };
    // A direct `fanout.run` IS its run — the id the receipt named, so a replay
    // gets the same one. A SCHEDULED sweep is a standing rule that fires again
    // next week, so each occurrence is its own run: sharing an id would make the
    // second occurrence post children that already exist (at-most-once by id) and
    // therefore never run at all.
    const runId = i.origin === ORIGIN_FANOUT_RUN ? (i.groupId || i.id) : `${i.id}@${i.startedAt ?? Date.now()}`;
    targets.forEach((t, n) => {
      this.intents.post({
        id: `${runId}#${n}`,
        cwd: t.dir,
        payload: { kind: "prompt", steps: [body] },
        target: { kind: "repo", fresh: true },
        trigger: { kind: "now" },
        title: t.title,
        origin: ORIGIN_FANOUT_TARGET,
        groupId: runId,
        order: n,
        cols: i.cols,
        rows: i.rows,
        launch: i.launch,
        ...(i.budget ? { budget: i.budget } : {}),
      } as IntentDraft);
    });
    return { ok: true, detail: `fan-out started in ${targets.length} repo${targets.length === 1 ? "" : "s"}` };
  }

  /**
   * One repo: a fresh session, then the prompt typed into it.
   *
   * `deliverToNewSession` is shared with `session.create`'s own `prompt`, so the
   * "a just-spawned session may still be booting" retry cannot drift between
   * the two. The row then waits in `running` for a HOOK — never for silence: a
   * sweep's whole output is the claim that N repos did the work, and a guess is
   * not that claim.
   */
  async runTarget(i: Intent): Promise<ExecutorResult> {
    const text = i.payload.kind === "prompt" ? i.payload.steps[0] : "";
    let sessionId: string;
    try {
      const info = this.sessions.create(i.cwd, {
        cols: i.cols, rows: i.rows,
        title: i.title,
        launch: i.launch as LaunchOpts | undefined,
        origin: sessionOriginOfIntent(i),
        ...(i.budget ? { budget: i.budget } : {}),
      });
      sessionId = info.id;
    } catch (err) {
      return { ok: false, detail: `could not start a session: ${spawnFailure(err)}` };
    }
    const res = await deliverToNewSession(this.sessions, sessionId, text, text.startsWith("/") ? "command" : "prompt",
      { audit: { source: "fanout", actor: "auto", detail: `fan-out ${i.groupId} → ${i.cwd}` } });
    if (res === "ok") return { ok: true, detail: "delivered", sessionId, watch: "hook" };
    // The session exists either way — the row keeps it so the target is still
    // tappable, which is how anyone acts on "press Return there".
    return { ok: false, detail: deliveryError(res), sessionId };
  }

  /**
   * Send ANOTHER instruction into the sessions this run already spawned — the
   * "…and now commit that" second step of a sweep, without reopening N sessions
   * by hand.
   *
   * `dirs` narrows it to a subset (omitted = every target with a live session).
   * Nothing is ever spawned: a target whose session died is left out and said
   * so, because silently starting a fresh session would run the follow-up
   * against a repo that never did step one.
   *
   * One child intent per session rather than one for the batch, so a follow-up
   * that lands in three repos and fails in the fourth says exactly that. They
   * share a batch id, which is how the run records the subset one tap addressed.
   */
  async followUp(runId: string, text: string, dirs?: string[]): Promise<FanoutRun | { error: string }> {
    const body = text.trim();
    if (!body) return { error: "nothing to send" };
    const run = this.run(runId);
    if (!run) return { error: "that run is no longer in the list" };
    const wanted = dirs?.length ? new Set(dirs) : null;
    const picked = run.targets.filter((t) => !wanted || wanted.has(t.dir));
    const live = picked.filter((t) => t.sessionId && this.sessions.get(t.sessionId)?.running);
    if (!live.length) return { error: "none of those sessions is still open" };

    const batch = randomUUID().slice(0, 8);
    live.forEach((t, n) => {
      this.intents.post({
        id: `${runId}~${batch}~${n}`.slice(0, 64),
        cwd: t.dir,
        payload: { kind: "prompt", steps: [body] },
        target: { kind: "session", sessionId: t.sessionId! },
        trigger: { kind: "now" },
        title: t.title,
        origin: `${ORIGIN_FANOUT_FOLLOWUP}${batch}`,
        groupId: runId,
        // The next turn of this very sweep, in a session this run opened and is
        // still holding. Without this it would queue behind its own target row
        // and — on a session with no hook pipe, which never reports finishing —
        // wait for ever.
        interject: true,
      });
    });
    return this.run(runId) ?? { error: "that run is no longer in the list" };
  }

  /**
   * A follow-up's delivery: type into a session that already exists.
   *
   * Same at-most-once contract as `runTarget`: only `retry` (nothing typed) is
   * re-attempted, once — a session mid-turn is exactly the case that needs the
   * second look, and `unconfirmed` must never be re-sent.
   */
  async followUpTarget(i: Intent, sessionId: string): Promise<ExecutorResult> {
    const text = i.payload.kind === "prompt" ? i.payload.steps[0] : "";
    const kind = text.startsWith("/") ? "command" : "prompt";
    const audit = { audit: { source: "fanout-followup" as const, actor: "auto" as const, detail: `follow-up in run ${i.groupId}` } };
    let res = await deliverPrompt(this.sessions, sessionId, text, kind, audit);
    if (res === "retry") res = await deliverPrompt(this.sessions, sessionId, text, kind, audit);
    if (res === "ok") return { ok: true, detail: "delivered", sessionId, watch: "hook" };
    return { ok: false, detail: deliveryError(res), sessionId };
  }

  private run(runId: string): FanoutRun | null {
    return fanoutRuns(this.intents.list(), Number.MAX_SAFE_INTEGER).find((r) => r.id === runId) ?? null;
  }
}
