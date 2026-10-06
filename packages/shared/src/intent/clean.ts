/**
 * `cleanIntentRow` and its per-field cleaners — the one way a row comes off
 * disk or the wire. Every cap here is on a COUNT or a label, never the words.
 *
 * A slice of `../intent.ts`, which is the one door into the intent model —
 * import from there, never from here. Layout and import order:
 * docs/notes/shared-architecture.md.
 */

import { cleanParamValue } from "../buildparams.js";
import type { CaptureBackendId } from "../wire/capture.js";
import { CAPTURE_BACKEND_IDS } from "../wire/capture.js";
import { DEFAULT_GRACE_MIN, INTENT_MAX_STEPS, cleanRule } from "../schedule.js";
import { LAUNCH_WAIT_MS, safeRel } from "../launch.js";
import { cleanAuthor, cleanCategory, cleanHeadline } from "../naming.js";
import { cleanSessionBudget } from "../sessionbudget.js";
import type { AssessPayload, BlockReason, BudgetPass, BuildPayload, CapturePayload, IntentPayload, IntentRequeue, IntentResult, IntentTarget, IntentTrigger, Lifecycle } from "./types.js";
import { REQUEUE_KEEP } from "./types.js";
import type { Intent } from "./row.js";
import { INTENT_MAX_DIRS, INTENT_MAX_NEEDS } from "./row.js";
import { INTENT_BLOCK_ORDER, intentReasonText } from "./words.js";
import { cleanBudgetWaiver } from "./budgetpass.js";

// ── Normalising one row ──────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
};
/** Like `num`, but 0 is a VALUE. `order` is renumbered 0..n by a drag, so
 *  folding zero into "absent" would silently move the top row to the bottom. */
const num0 = (v: unknown): number | undefined => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : undefined;
};

/** `Intent.budgetPass`, read strictly: one of the two windows, two finite
 *  instants in order — anything else is no pass, never a repaired one. */
function cleanBudgetPass(v: unknown): BudgetPass | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Record<string, unknown>;
  if (p.window !== "session" && p.window !== "weekly") return undefined;
  const from = Number(p.from);
  const until = Number(p.until);
  if (typeof p.from !== "number" || typeof p.until !== "number" || !Number.isFinite(from) || !Number.isFinite(until) || !(from < until)) return undefined;
  return { window: p.window, from, until };
}

const LIFECYCLES: readonly Lifecycle[] = ["queued", "blocked", "starting", "running", "done", "failed", "canceled"];
/**
 * Which stored `blockReason` values `cleanIntentRow` accepts — the SAME set as
 * `INTENT_BLOCK_ORDER`, derived from it rather than typed out again.
 *
 * It was a second hand-kept copy of the same thirteen strings in a different
 * order, and nothing checked that they matched: `intentReasonText` is a switch
 * and TypeScript holds it to the union, but two arrays of a union type are two
 * places a new reason can be forgotten, and the forgetting is invisible — a
 * reason missing from this one is silently dropped off every row loaded from
 * disk. Order is irrelevant to a membership test, so the ordered list is the
 * one home and this is a view of it.
 */
const BLOCK_REASONS: ReadonlySet<BlockReason> = new Set(INTENT_BLOCK_ORDER);

/**
 * Normalise one intent off the wire or off disk, or reject it.
 *
 * A stored file is not a trusted value, and neither is a wire draft. The posture:
 * reject anything that could not be acted on, and be defensive about paths
 * because this list is rendered on the phone as well as executed on the host.
 * The host's own containment guards still apply on top; this is the cheap early
 * refusal.
 *
 * The one place it is deliberately STRICT is the trigger.
 * An unknown or absent trigger is rejected outright rather than defaulted to
 * `now`, because every wrong guess in that direction is the same wrong guess:
 * work the sender wanted deferred, run immediately. A bad `state`, by contrast,
 * defaults to `queued` — the harmless direction, and the one the manager
 * recomputes anyway.
 *
 * What it never does is clip words. Every cap below is on a count or on a
 * label; `payload.steps` is passed through untouched, which is the promise the
 * whole store exists to keep.
 */
export function cleanIntentRow(raw: unknown, now: number): Intent | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const id = str(r.id);
  const cwd = str(r.cwd);
  if (!id || !cwd) return null;

  const payload = cleanPayload(r.payload);
  if (!payload) return null;

  const trigger = cleanTrigger(r.trigger, Number(r.createdAt) || now);
  if (!trigger) return null;

  const target = cleanTarget(r.target);
  if (!target) return null;

  const createdAt = Number(r.createdAt) || now;
  const state: Lifecycle = LIFECYCLES.includes(r.state) ? r.state : "queued";
  // `blockReason`/`blockDetail` are present iff blocked — enforced here rather
  // than trusted, so a row that was rewritten by hand cannot render a stale
  // sentence under a state it no longer has.
  const blockReason: BlockReason | undefined =
    state === "blocked" && BLOCK_REASONS.has(r.blockReason) ? r.blockReason : undefined;

  // ── The naming pair, dropped PAIRWISE ────────────────────────────────────
  // The AUTHOR is computed first, and the value is only read when there is one:
  // a title that cannot say who wrote it cannot say whether a person may be
  // overwritten, so the honest thing to do with it is to have no title. The
  // other direction goes the same way — an author with nothing to be the author
  // OF is a stamp on a row nobody named — and an author or a kind this app does
  // not know is neither repaired nor rounded, because both repairs are a claim
  // about who typed something.
  //
  // The words are the row's own first step, which is what lets `cleanHeadline`
  // recognise a "title" that is only the opening of the prompt underneath it.
  const rowText = payload.kind === "prompt" ? payload.steps[0] ?? "" : "";
  const headlineBy = cleanAuthor(r.headlineBy);
  const headline = headlineBy ? cleanHeadline(r.headline, rowText) : undefined;
  const categoryBy = cleanAuthor(r.categoryBy);
  const category = categoryBy ? cleanCategory(r.category) : undefined;

  return {
    id: id.slice(0, 64),
    cwd,
    payload,
    target,
    trigger,
    serial: r.serial === true ? true : undefined,
    holdForHost: r.holdForHost === true ? true : undefined,
    pastBudget: cleanBudgetWaiver(r.pastBudget),
    budgetPass: cleanBudgetPass(r.budgetPass),
    auto: r.auto === true ? true : undefined,
    pinned: r.pinned === true ? true : undefined,
    interject: r.interject === true ? true : undefined,
    resume: r.resume === true ? true : undefined,
    // A real three-way: `false` is "keep this one open" and must not read as
    // "nobody said" — so a boolean is kept as it is and nothing else is.
    closeWhenDone: typeof r.closeWhenDone === "boolean" ? r.closeWhenDone : undefined,
    budget: cleanSessionBudget(r.budget) ?? undefined,
    archived: r.archived === true ? true : undefined,
    manual: r.manual === true ? true : undefined,
    order: num0(r.order),
    // Strictly `=== true`: this is a claim that a PERSON placed the row, and a
    // truthy `"yes"` off the wire or out of a hand-edited file is not one. The
    // wrong direction here is cheap to describe and expensive to have — a row
    // wrongly marked hand-placed is a row the smart pick will never move again.
    handOrdered: r.handOrdered === true ? true : undefined,
    attempts: num(r.attempts),
    label: str(r.label).slice(0, 80) || undefined,
    title: str(r.title).slice(0, 200) || undefined,
    headline,
    headlineBy: headline ? headlineBy : undefined,
    category,
    categoryBy: category ? categoryBy : undefined,
    cols: num(r.cols),
    rows: num(r.rows),
    launch: r.launch ?? undefined,
    replaceSessionId: str(r.replaceSessionId) || undefined,
    state,
    blockReason,
    blockDetail: blockReason ? str(r.blockDetail) || intentReasonText(blockReason) : undefined,
    blockSessionId: blockReason === "serial" ? str(r.blockSessionId).slice(0, 128) || undefined : undefined,
    createdAt,
    startedAt: num(r.startedAt),
    settledAt: num(r.settledAt),
    sessionId: str(r.sessionId) || undefined,
    result: r.result && typeof r.result === "object" ? (r.result as IntentResult) : undefined,
    requeues: cleanRequeues(r.requeues),
    // Cleaned strictly, and separately from the list: the two are different
    // facts and a row may honestly carry either without the other (a row
    // written before the count existed has five entries and no count; the
    // count cannot be reconstructed from them and is left absent rather than
    // guessed at from a capped length).
    requeueCount: cleanRequeueCount(r.requeueCount),
    // `null` survives as `null`: it is the explicit "nothing armed", and
    // collapsing it into `undefined` would re-arm a rule the user switched off.
    nextAt: r.nextAt === null ? null : num(r.nextAt),
    lastOccurrence: num(r.lastOccurrence),
    // Kept across the round trip for the reason it is persisted at all: the
    // hold outlives the process, so a restart mid-hold that dropped this would
    // re-arm the bug `Intent.clearedOccurrence` closes on the very next tick.
    clearedOccurrence: num(r.clearedOccurrence),
    missing: Array.isArray(r.missing) ? r.missing.filter((p: unknown): p is string => typeof p === "string") : undefined,
    dismissedAt: num(r.dismissedAt),
    // Kept across the round trip: the wait for a reset is hours long, and a row
    // that forgot it had already followed one resurrection would be requeued at
    // the next wall and typed a second time. See `Intent.followed`.
    followed: r.followed === true ? true : undefined,
    origin: str(r.origin).slice(0, 40) || undefined,
    groupId: str(r.groupId).slice(0, 64) || undefined,
  };
}

/**
 * The re-queue history, capped by COUNT and by nothing else.
 *
 * Two rules, and they pull in opposite directions on purpose:
 *
 *  • **The cap keeps the NEWEST.** `slice(-REQUEUE_KEEP)` and not `slice(0, n)`:
 *    the list is oldest-first, the entry that explains why the row is queued
 *    right now is the last one, and a cap that kept the front would throw away
 *    the only entry anything renders. The same shape as every other cap here —
 *    `payload.steps` keeps the head because a chain runs forwards, a history
 *    keeps the tail because it is read backwards.
 *
 *  • **Nothing inside an entry is touched.** The carried `result` goes through
 *    whole, `detail` and every `targets[].error` with it. It is a copy of words
 *    a run wrote about somebody's work, and this file does not clip words.
 *
 * An entry that cannot say WHEN or WHO is dropped rather than defaulted, which
 * is the one place this is strict: `by` is a claim about who took a decision —
 * `handOrdered`'s rule — and defaulting it either invents a person who tapped
 * nothing or an assessment run that does not exist. Both are sentences the row
 * would then show under a chip a reader is meant to trust.
 */
function cleanRequeues(v: unknown): IntentRequeue[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: IntentRequeue[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const row = e as Record<string, any>;
    const at = Number(row.at);
    if (!Number.isFinite(at) || at <= 0) continue;
    if (row.by !== "assess" && row.by !== "hand" && row.by !== "run") continue;
    out.push({
      at,
      by: row.by,
      runId: str(row.runId).slice(0, 64) || undefined,
      result: row.result && typeof row.result === "object" ? (row.result as IntentResult) : undefined,
      clockDropped: row.clockDropped === true ? true : undefined,
    });
  }
  if (!out.length) return undefined;
  return out.length > REQUEUE_KEEP ? out.slice(-REQUEUE_KEEP) : out;
}

/**
 * The uncapped re-queue COUNT, which is refused rather than repaired.
 *
 * Every other number on this row is cleaned permissively, because the wrong
 * direction is cheap: a bad `order` sorts a row oddly, a bad `attempts` costs a
 * retry. This one is different — it is rendered as an ORDINAL on a chip a person
 * reads as a warning ("the 9th time"), and there is no such thing as a nearly
 * right count. So the only accepted shape is a real, whole, positive number:
 * not a numeric string (`Number("9")` would happily accept a hand-edited file
 * that meant something else), not a fraction, not a negative, not `Infinity`,
 * not a `true` that `Number()` turns into 1.
 *
 * And zero is refused with them, not stored: "this row has never been put back"
 * is already spelled by the field being absent, and a fact with two spellings
 * is a fact two readers will render two ways. Absent is the honest answer to
 * everything this cannot read, which is `Intent.requeueCount`'s own promise —
 * absent means nobody counted, never zero and never a stale five.
 */
function cleanRequeueCount(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function cleanPayload(v: unknown): IntentPayload | BuildPayload | AssessPayload | CapturePayload | null {
  const raw = (v && typeof v === "object" ? v : {}) as Record<string, any>;
  if (raw.kind === "capture") {
    const targetId = str(raw.targetId);
    // Nothing to point at ⇒ a row that can only ever fail. `build`'s rule.
    if (!targetId) return null;
    // An unrecognised backend is DROPPED, not coerced: "window" is the whole
    // desktop, so a bad value silently defaulting would hand back a
    // real-looking picture of the wrong thing. Absent is the honest state —
    // the run resolves the backend from the target's own config anyway, and a
    // row that shows no backend is a row that claims nothing.
    const backend = CAPTURE_BACKEND_IDS.includes(raw.backend) ? (raw.backend as CaptureBackendId) : undefined;
    return {
      kind: "capture",
      targetId: targetId.slice(0, 64),
      name: str(raw.name).slice(0, 120) || undefined,
      backend,
      watch: raw.watch === true ? true : undefined,
    };
  }
  if (raw.kind === "build") {
    const buildId = str(raw.buildId);
    if (!buildId) return null;
    // Values are cleaned with the one rule (`cleanParamValue`): one line,
    // bounded, no control characters. A row read back off disk reaches a shell,
    // so the file is exactly as untrusted as the wire.
    let params: Record<string, string> | undefined;
    if (raw.params && typeof raw.params === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.params as Record<string, unknown>)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)) continue;
        const val = cleanParamValue(v);
        if (val) out[k] = val;
      }
      if (Object.keys(out).length) params = out;
    }
    return {
      kind: "build",
      buildId: buildId.slice(0, 64),
      name: str(raw.name).slice(0, 120) || undefined,
      cmd: typeof raw.cmd === "string" ? raw.cmd : undefined,
      cwd: str(raw.cwd) || undefined,
      params,
    };
  }
  // An assessment reads the repo and names its own inputs, so the only thing
  // that can be on it is the CUT it was asked about — and that has to survive
  // the round trip through disk, or a run reconciled after a restart silently
  // widens to the whole repo. Absent (and an empty array, which no caller may
  // mean: a scope of nothing is refused at the start, never stored) reads as
  // "the whole repo", which is what every row written before this field is.
  if (raw.kind === "assess") {
    const ids = Array.isArray(raw.ids)
      ? raw.ids.filter((s: unknown): s is string => typeof s === "string" && !!s.trim())
      : [];
    return ids.length ? { kind: "assess", ids } : { kind: "assess" };
  }
  if (raw.kind !== "prompt") return null;
  // Note the absence of any `.slice()` on the text itself. A step is trimmed of
  // nothing but the empties around it; what the user wrote is what is stored.
  const steps: string[] = Array.isArray(raw.steps)
    ? raw.steps.filter((s: unknown): s is string => typeof s === "string" && !!s.trim()).slice(0, INTENT_MAX_STEPS)
    : [];
  // An intent with nothing to say cannot run, and storing it would only produce
  // a row that fails forever.
  return steps.length ? { kind: "prompt", steps } : null;
}

/**
 * A target that names nothing runnable is rejected; an ABSENT one falls back to
 * `{kind:"repo"}`.
 *
 * The asymmetry is on purpose and is the mirror of the trigger's: `cwd` is
 * always known, so "run it in this repo" is the only reading an absent target
 * can have and it defers to the same gate as everything else. A target that
 * names a session with no id, or a sweep with no repos, is a different thing —
 * the sender meant something specific and it did not survive.
 *
 * ── The non-fresh repo target is RETIRED, and this is where it goes ─────────
 *
 * A `{kind:"repo"}` with no `fresh` used to mean "the repo's ONE backlog
 * session, shared by every item that repo ever queues". That reading is gone,
 * and it is gone for a number this repo already computes: `sessioncost.ts` says
 * a conversation at 2.5× its baseline stops paying for itself past ~13 turns,
 * at 5× past ~5, and a shared session of unrelated items reaches 5× within a
 * handful of them — each item reads its own files into the window and none of
 * that helps the next one. It is exactly the shape of the measurement in
 * `CLAUDE.md`: 124 conversations out of 8,968 grew past 200k and were 76% of
 * every token spent. Unattended work appended to one window for ever is that
 * shape with nobody watching it.
 *
 * So the default becomes a session per item, and a person who WANTS the shared
 * context now says so — `{kind:"session"}`, or `fresh` plus `resume`. Rows
 * already on disk and bundles pinned to an older APK both send the old shape;
 * both get the new default here rather than a second code path, which is the
 * whole reason the normalisation lives in the one function every row enters
 * through. `intents.json` gains `schema: 2` for the same migration, with the
 * `*.bak` beside it — this is the shared half of it.
 */
function cleanTarget(v: unknown): IntentTarget | null {
  if (v == null) return repoFresh();
  // Present but not an object: the sender named something, and it is not
  // anything we can read. Refuse rather than fall back.
  if (typeof v !== "object") return null;
  const raw = v as Record<string, any>;
  switch (raw.kind) {
    case "session": {
      const sessionId = str(raw.sessionId);
      if (!sessionId) return null;
      // Carried, never minted: this end cannot look a conversation up, so a
      // missing one stays missing (the row then behaves exactly as every
      // session-targeted row did before the field existed).
      const resumeConvId = str(raw.resumeConvId);
      return resumeConvId ? { kind: "session", sessionId, resumeConvId } : { kind: "session", sessionId };
    }
    case "repos": {
      const dirs = [...new Set(
        (Array.isArray(raw.dirs) ? raw.dirs : []).filter((d: unknown): d is string => typeof d === "string" && !!d.trim()).map((d: string) => d.trim()),
      )].slice(0, INTENT_MAX_DIRS);
      return dirs.length ? { kind: "repos", dirs } : null;
    }
    case "sessions": {
      const ids = [...new Set(
        (Array.isArray(raw.sessionIds) ? raw.sessionIds : []).filter((s: unknown): s is string => typeof s === "string" && !!s.trim()).map((s: string) => s.trim()),
      )].slice(0, INTENT_MAX_DIRS);
      return ids.length ? { kind: "sessions", sessionIds: ids } : null;
    }
    case "shell":
      return { kind: "shell" };
    case "repo":
      // `fresh` is not read at all: there is one reading of "this repo" now.
      return repoFresh();
    default:
      // Not absent, but not anything either — a shape from a version we do not
      // have. Refuse rather than pick one.
      return raw.kind === undefined ? repoFresh() : null;
  }
}

/** The one reading of "this repo" there is now. A function rather than a shared
 *  constant so no caller can mutate the default out from under the next row. */
const repoFresh = (): IntentTarget => ({ kind: "repo", fresh: true });

/**
 * A configured grace, in minutes — or `NaN` for **nobody said**, which each
 * trigger then answers in its own way.
 *
 * `Number(null)` is 0 and so is `Number("")`, and 0 is the most destructive
 * value this field has: it means "skip it unless it can start now". So `null`
 * — JSON's spelling of absent, what an `intent.update` carries to CLEAR the
 * field, and what any client serialising an unset optional sends — became a
 * deadline on a chain that was documented as having none, and `""` off a
 * hand-edited file did the same. Both now fall in with `undefined`, which is
 * `DEFAULT_GRACE_MIN` on `at` and no deadline at all on `after`.
 *
 * `cleanRule` already reads `minPctLeft` this way, two functions away in
 * `schedule.ts`, for the same reason: a count-shaped field where absent and
 * zero are different answers cannot be read through `Number()` alone.
 */
const graceOf = (raw: unknown): number =>
  raw == null || raw === "" ? NaN : Math.round(Number(raw));

function cleanTrigger(v: unknown, createdAt: number): IntentTrigger | null {
  const raw = (v && typeof v === "object" ? v : {}) as Record<string, any>;
  switch (raw.kind) {
    case "now":
      return { kind: "now" };
    case "idle":
      return { kind: "idle" };
    case "budget":
      return { kind: "budget" };
    case "at": {
      const rule = cleanRule(raw.rule);
      const g = graceOf(raw.graceMin);
      return {
        kind: "at",
        rule,
        graceMin: Number.isFinite(g) ? Math.min(7 * 24 * 60, Math.max(0, g)) : DEFAULT_GRACE_MIN,
        keepAfterRun: raw.keepAfterRun === true ? true : undefined,
      };
    }
    case "after": {
      const id = str(raw.id).slice(0, 64);
      // A chain that names nothing is refused outright, and the row goes with
      // it. That is the same call `cleanTarget` makes for a `session` target
      // with no id, and for the same reason: the two harmless-looking
      // alternatives are both wrong here. Defaulting to `now` runs work whose
      // whole point was to wait, and keeping the trigger with an empty id
      // stores a row that can never be released and can never say what it is
      // waiting for.
      if (!id) return null;
      const g = graceOf(raw.graceMin);
      return {
        kind: "after",
        id,
        onlyIfOk: raw.onlyIfOk === true ? true : undefined,
        // A week is the same ceiling `at` uses. Absent stays ABSENT rather
        // than becoming `DEFAULT_GRACE_MIN`: the default for a chain is no
        // deadline at all, and filling one in here would quietly bin every
        // chain whose predecessor finished while the desktop was shut.
        graceMin: Number.isFinite(g) ? Math.min(7 * 24 * 60, Math.max(0, g)) : undefined,
        title: str(raw.title).slice(0, 200) || undefined,
      };
    }
    case "files": {
      // `safeRel` (`launch.ts`) is the guard, for the reason it has always been:
      // a stored path with a `..` in it is a bug wherever it came from, and this
      // list is rendered on the phone as well as stat'd on the host.
      const needs = (Array.isArray(raw.needs) ? raw.needs : [])
        .filter((p: unknown): p is string => typeof p === "string" && !!p.trim() && safeRel(p))
        .map((p: string) => p.trim())
        .slice(0, INTENT_MAX_NEEDS);
      const deadlineAt = Number(raw.deadlineAt);
      return {
        kind: "files",
        needs,
        deadlineAt: Number.isFinite(deadlineAt) && deadlineAt > 0 ? deadlineAt : createdAt + LAUNCH_WAIT_MS,
      };
    }
    default:
      // See `cleanIntentRow`: defaulting an unreadable trigger to `now` would
      // run, immediately, work whose whole point was that it should not.
      return null;
  }
}
