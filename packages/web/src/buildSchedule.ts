/**
 * **A build on a clock, in words** — the Build sheet's cue, the schedule-a-build
 * form's save, and Activity's provenance for a run a rule fired.
 *
 * Pure, and its imports carry `.ts` because `node --test` loads it straight off
 * the source (`buildSchedule.test.mjs`).
 *
 * The cue is a COUNT ON A CONTROL, so it is a filter (CLAUDE.md): the ids it
 * returns are exactly the rules its words describe, and the tap opens
 * Automation cut to exactly those ids. One list (`schedulesForBuild`, shared,
 * narrowed by `isStandingSchedule` — a spent one-off is not a schedule) feeds
 * both. Its words are the schedule cards' own: `describeRule` for WHAT,
 * shared `inWords` for WHEN, `HORIZON_LABEL` for an armed-at-nothing rule.
 */
import {
  DEFAULT_GRACE_MIN, HORIZON_LABEL, describeRule, inWords, isStandingSchedule, missingParamsText, resolveParamValues, ruleRecurs,
  scheduleActionText, scheduleIdFromOrigin, schedulesForBuild, typedName, unsafeParamIds, unsafeParamsText,
  type BuildConfig, type Intent, type ScheduleEntry,
} from "@waterplane/shared";
import { scheduleRuleLabel } from "./backlogFilter/scheduleWords.ts";
import { clockBlocker } from "./sendIntent/sendLabels.ts";
import type { SendWhen } from "./sendIntent/sendTypes.ts";

/** What a build row wears when rules run it: one line, and the cut it opens. */
export interface BuildScheduleCue {
  /** Exactly the rules counted — what the tap cuts Automation to. */
  ids: string[];
  /** The line under the command. */
  words: string;
  /** The filter bar's label over that cut. */
  label: string;
}

/** One rule's state clause: when it fires next, or why it does not. */
function stateWords(e: ScheduleEntry, now: number): string {
  if (!e.enabled) return ruleRecurs(e.rule) ? "paused" : "off";
  return e.nextAt != null ? `next ${inWords(e.nextAt, now)}` : HORIZON_LABEL.unarmed;
}

/**
 * The cue for one build entry, or null when no standing rule runs it.
 *
 * One rule: `every Mon–Fri · 07:00 · next in 3h` — the card's rule line plus
 * the countdown. A paused rule says `paused` in TEXT. Several: `2 schedules ·
 * next in 3h`, the soonest armed one; with none armed, `paused` when every one
 * is, else `not armed`.
 */
export function buildScheduleCue(
  entries: readonly ScheduleEntry[], repoDir: string, build: Pick<BuildConfig, "id" | "name">, now: number,
): BuildScheduleCue | null {
  const rules = schedulesForBuild(entries, repoDir, build.id).filter((e) => isStandingSchedule(e, now));
  if (!rules.length) return null;
  const ids = rules.map((e) => e.id);
  if (rules.length === 1) {
    const e = rules[0];
    return { ids, words: `${describeRule(e.rule)} · ${stateWords(e, now)}`, label: scheduleRuleLabel(e.name) };
  }
  const armed = rules.filter((e) => e.enabled && e.nextAt != null).map((e) => e.nextAt as number);
  const tail = armed.length
    ? `next ${inWords(Math.min(...armed), now)}`
    : rules.every((e) => !e.enabled) ? "paused" : HORIZON_LABEL.unarmed;
  return { ids, words: `${rules.length} schedules · ${tail}`, label: `the ${rules.length} schedules that run “${build.name}”` };
}

/** The WHEN a schedule-a-build form opens on: the rule being edited, or the
 *  Send sheet's own blank clock (`onceIn`'s shape, an hour out). */
export function buildScheduleWhen(entry: ScheduleEntry | null, now: number): Extract<SendWhen, { kind: "at" }> {
  if (!entry) return { kind: "at", rule: { kind: "once", at: now + 3600e3, offsetMin: 0 }, graceMin: DEFAULT_GRACE_MIN };
  return {
    kind: "at", rule: entry.rule, graceMin: entry.graceMin ?? DEFAULT_GRACE_MIN,
    name: typedName(entry.name, scheduleActionText(entry.action)) || undefined,
    waitUntilFree: entry.waitUntilFree,
  };
}

/**
 * The form's parameter values: the rule's own when editing one, else the
 * build's stored defaults — and nothing else (`BuildRunAsk`'s rule: a
 * remembered last value would make the form lie).
 */
export function buildScheduleValues(build: BuildConfig, entry: ScheduleEntry | null): Record<string, string> {
  const seed: Record<string, string> = {};
  const saved = entry?.action.kind === "build" ? entry.action.params ?? {} : {};
  for (const p of build.params ?? []) {
    const v = saved[p.id] ?? p.default;
    if (v) seed[p.id] = v;
  }
  return seed;
}

/** Why Save cannot go yet, as the sentence that REPLACES it — or null. */
export function buildScheduleBlocker(build: BuildConfig, vals: Record<string, string>, when: SendWhen, preview: number | null): string | null {
  const { values, missing } = resolveParamValues(build.params, vals);
  if (missing.length) return missingParamsText(missing);
  const unsafe = unsafeParamIds(build.cmd, values);
  if (unsafe.length) return unsafeParamsText(unsafe);
  return clockBlocker(when, preview);
}

/**
 * The `schedule.save` entry the form sends. `id` upserts (an edit re-saves the
 * same rule); a new one mints its own, client-side, so an offline replay
 * overwrites rather than adding a second nightly build. With no name typed the
 * rule takes the build's (the host does the same).
 */
export function buildScheduleEntry(o: {
  id: string; repoDir: string; build: BuildConfig; vals: Record<string, string>;
  when: Extract<SendWhen, { kind: "at" }>; preview: number | null; now: number;
}): ScheduleEntry {
  const { values } = resolveParamValues(o.build.params, o.vals);
  return {
    id: o.id,
    name: o.when.name?.trim() || o.build.name,
    enabled: true,
    rule: o.when.rule,
    action: { kind: "build", repoDir: o.repoDir, buildId: o.build.id, ...(Object.keys(values).length ? { params: values } : {}) },
    createdAt: o.now,
    nextAt: o.preview,
    graceMin: o.when.graceMin,
    ...(o.when.waitUntilFree ? { waitUntilFree: true } : {}),
  };
}

/** The receipt after Save. */
export function buildScheduleToast(offline: boolean, editing: boolean): string {
  if (offline) return "queued — the schedule is saved when the link is back";
  return editing ? "schedule saved — the same rule, re-timed" : "schedule saved";
}

/**
 * **Which rule fired this build run**, for Activity's `from the schedule “x”`.
 *
 * Off the run's own `origin` (`schedule:<ruleId>`, `scheduleIdFromOrigin`),
 * joined to the rule's durable row — never matched on a name. The name is the
 * rule's title (the host gives a nameless build rule the build's name); a rule
 * that is gone draws NO chip: absent beats guessed.
 */
export function buildRunFromSchedule(i: Intent, intents: readonly Intent[]): { id: string; name: string } | null {
  if (i.payload.kind !== "build") return null;
  const id = scheduleIdFromOrigin(i.origin);
  if (!id) return null;
  const rule = intents.find((x) => x.id === id);
  if (!rule) return null;
  const name = rule.title?.trim() || (rule.payload.kind === "build" ? rule.payload.name ?? rule.payload.buildId : "") || "";
  return name ? { id, name } : null;
}

/** What a build rule's last run came to, in one word — off the RUN's row,
 *  never the rule's `lastResult` (that only says the run was posted). */
export function lastRunWord(run: Intent): string {
  if (run.state === "failed" || (run.state === "done" && run.result?.ok === false)) return "failed";
  if (run.state === "done") return "ok";
  if (run.state === "canceled") return "cancelled";
  if (run.state === "starting" || run.state === "running") return "running";
  return "waiting";
}
