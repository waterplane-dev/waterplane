/**
 * **What a decided send becomes on the wire**, where more than one screen posts it: the `schedule.save`
 * row of a clock and the backlog item of "when this repo is free". Pure: `dispatchIntent` (the Send
 * sheet) and the set-up page (`features/repoSetup`) both build from here and both hand the result to
 * the one queue, so a weekly rule is the same rule whichever screen made it.
 */
import type { LaunchOpts, ScheduleEntry, SessionBudget } from "@waterplane/shared";
import type { QueueBacklogOpts } from "../sdk/types.ts";
import { previewOf } from "./sendChain.ts";
import { flagWhenDoneOf } from "./sendFlag.ts";
import type { SendTarget, SendWhen } from "./sendTypes.ts";

type RepoSend = Extract<SendTarget, { kind: "repo" }>;
type ClockWhen = Extract<SendWhen, { kind: "at" }>;
/** The gate every launch goes through before it is sent (`core().launch.wire`). */
type Wire = (o: LaunchOpts) => LaunchOpts;

/** One backlog item in one repo, carrying the whole chain. */
export function repoItemOpts(t: RepoSend, when: SendWhen, steps: string[], wire: Wire): QueueBacklogOpts {
  const first = steps[0] ?? "";
  return {
    text: first, steps, repoDir: t.cwd, label: first.slice(0, 40), resume: t.resume, closeWhenDone: t.closeWhenDone,
    budget: t.budget, flagWhenDone: flagWhenDoneOf(t, when),
    ...(t.launch ? { launch: wire(t.launch) } : {}),
  };
}

/** The rule a clock saves (a clock aimed at a live session is an intent, never this). `cleared` is the Send sheet's answer
 *  for a row whose cap was blanked; the caller mints `id` and stamps `now`. */
export function scheduleEntryOf(
  target: SendTarget, when: ClockWhen, steps: string[],
  o: { id: string; now: number; wire: Wire; usage?: Parameters<typeof previewOf>[1]; cleared?: { budget?: null } },
): ScheduleEntry {
  const first = steps[0] ?? "";
  const cleared = (o.cleared ?? {}) as { budget?: SessionBudget | null };
  const action: ScheduleEntry["action"] = target.kind === "repos"
    ? { kind: "fanout", dirs: target.dirs, text: first, ...(target.budget ? { budget: target.budget } : cleared),
        // The sweep's own model (the fan-out sheet's row) rides on the rule;
        // absent is written absent, which is how an edit clears it.
        ...(target.launch ? { launch: o.wire(target.launch) } : {}) }
    // The WHOLE chain travels; `steps` only when there is more than one turn,
    // so a one-turn rule is written exactly as it always was.
    : { kind: "backlog", repoDir: target.cwd, text: first, autoFire: true, ...(steps.length > 1 ? { steps } : {}),
        ...(target.kind === "repo" && typeof target.closeWhenDone === "boolean" ? { closeWhenDone: target.closeWhenDone } : {}),
        ...(flagWhenDoneOf(target, when) ? { flagWhenDone: true } : {}),
        ...(target.kind === "repo" && target.budget ? { budget: target.budget } : cleared),
        // The model each occurrence's session starts on — the sweep arm's
        // rule above: absent is written absent, which is how an edit clears it.
        ...(target.kind === "repo" && target.launch ? { launch: o.wire(target.launch) } : {}) };
  return {
    id: o.id,
    name: (when.name ?? "").trim() || first.split("\n")[0].slice(0, 60),
    enabled: true,
    rule: when.rule,
    action,
    createdAt: o.now,
    // What this phone could see; for a window rule with no reading yet that
    // is null — "not armed", never "never".
    nextAt: previewOf(when, o.usage),
    graceMin: when.graceMin,
    waitUntilFree: when.waitUntilFree,
  };
}
