/**
 * **What this repo's send was last set to, so the next one starts there.**
 *
 * Queueing ten prompts the same way meant making the same four taps ten times:
 * open the sheet, set *when*, send, watch the control snap back to `Send ·
 * now`. The composer's mode reset after every send and on every session switch,
 * and the Send sheet opened on `{kind:"now"}` however the last twenty sends
 * from that repo had been aimed. This file is the memory that stops that.
 *
 * ── Why this is not the setting that was removed ────────────────────────────
 *
 * There WAS a persisted per-repo `sendMode` here once (`waterplane.sendMode`) and it
 * was deleted for a good reason: a repo silently left in *later* turned the
 * primary button into a schedule editor days after anybody chose that, and the
 * only way to find out was to tap it. That bug was **invisibility**, not
 * memory, so the memory comes back with the invisibility designed out:
 *
 *  - **The split button never carries a clock.** Only `now` and `idle` are ever
 *    recalled onto it, and `sendModeLabel` spells both out on the button face —
 *    a repo left in *when it's free* SAYS `When free` before it is tapped.
 *  - **A wall-clock rule is recalled onto the SHEET and nowhere else.** The
 *    sheet draws the rule in words, restates the whole decision on its button
 *    and can be set back to *now* with one tap. The primary button in the
 *    compose bar cannot become a schedule editor because it is never handed a
 *    schedule.
 *  - **A stale one-off expires itself** (`reusableWhen`): a `once` rule whose
 *    instant has passed is not a way anybody wants the next prompt sent, and
 *    recalling one would arm a schedule that fires immediately or never.
 *  - **A chain is never recalled.** `{kind:"after"}` names ONE predecessor row
 *    by id; reusing it would silently park every later prompt behind a row that
 *    settled long ago — the one shape here whose reuse is not what was meant.
 *  - **The AIM is recalled, and only the two answers that can be said.** `this`
 *    and `new` are two standing ways of driving a repo and the strip's aim line
 *    keeps whichever is armed on screen (`composeAimNote`); `other` names one
 *    per-boot session id and is dropped for the chain's reason exactly.
 *
 * Pure and node-tested; `sendMemory.test.mjs` pins the five rules above, which
 * are the ones that turn a convenience back into the bug it replaced.
 */
import type { SendMode, SendWhere } from "./composeSend";
import type { SendWhen } from "./sendIntent";

/** What one repo was last set to. `at` is when, used only to evict. */
export interface SendMemoryEntry {
  /** The split button's armed answer. `now`/`idle` only — see the head. */
  mode?: SendMode;
  /** The sheet's last WHEN, when it was one worth offering again. */
  when?: SendWhen;
  /**
   * The compose strip's last WHERE — `this` or `new`, never `other`.
   *
   * Same rule as `mode` and for the same reason: an aim that cannot be SAID
   * before it is tapped is the invisible state this whole file is written
   * around. `this` and `new` are two standing ways of driving a repo and the
   * aim line says which is armed; `other` names ONE session by a per-boot id,
   * which is exactly why a chain is never recalled either.
   */
  where?: SendWhere;
  at: number;
}

/** Keyed by the repo's `cwd` — the same key every other per-repo decision in
 *  this app uses, and the one a session already carries. */
export type SendMemory = Record<string, SendMemoryEntry>;

/** More repos than anybody drives from one phone; the oldest fall off. */
export const SEND_MEMORY_CAP = 40;

/**
 * The WHEN worth offering again, or null.
 *
 * `now` is remembered like anything else: it is how a person UNDOES a recalled
 * schedule, and dropping it would make "set it back to now" the one decision
 * that never sticks.
 */
export function reusableWhen(w: SendWhen | undefined | null, now: number): SendWhen | null {
  if (!w) return null;
  // A chain is about one row, not about how this repo is driven.
  if (w.kind === "after") return null;
  if (w.kind === "at") {
    // A one-off that has already come round is not a way to send the next
    // prompt — it is a rule that would fire the moment it is saved, or never.
    if (w.rule.kind === "once" && !(typeof w.rule.at === "number" && w.rule.at > now)) return null;
    // The NAME belongs to the schedule somebody wrote, not to the next prompt:
    // ten rows all called "nightly sweep" is a list nobody can read.
    const { name: _drop, ...rest } = w;
    return rest as SendWhen;
  }
  return w;
}

/** What the split button may be recalled to. A clock never reaches it. */
export function reusableMode(m: SendMode | undefined | null): SendMode | null {
  return m === "now" || m === "idle" ? m : null;
}

/**
 * The aim worth offering again, or null.
 *
 * `other` is dropped on the way IN as well as on the way out: it names a
 * session id that dies with the desktop's process, so a remembered one is
 * either gone (a refusal on a send nobody meant to aim anywhere odd) or, worse,
 * reused by a session nobody picked. The two answers left are about how a
 * person drives a REPO, which is what this map is keyed on.
 */
export function reusableWhere(w: SendWhere | undefined | null): SendWhere | null {
  return w === "this" || w === "new" ? w : null;
}

/**
 * Write one repo's answer, bounded.
 *
 * Returns a fresh map — the caller persists it — and merges rather than
 * replaces: the composer decides `mode` and the sheet decides `when`, and
 * neither may erase what the other last said.
 */
export function rememberSend(
  mem: SendMemory,
  cwd: string | null | undefined,
  patch: { mode?: SendMode; when?: SendWhen | null; where?: SendWhere | null },
  now: number,
  cap = SEND_MEMORY_CAP,
): SendMemory {
  if (!cwd) return mem;
  const prev = mem[cwd];
  const next: SendMemoryEntry = { ...prev, at: now };
  if (patch.mode !== undefined) {
    const m = reusableMode(patch.mode);
    if (m) next.mode = m; else delete next.mode;
  }
  if (patch.when !== undefined) {
    const w = reusableWhen(patch.when, now);
    if (w) next.when = w; else delete next.when;
  }
  if (patch.where !== undefined) {
    const w = reusableWhere(patch.where);
    if (w) next.where = w; else delete next.where;
  }
  const out: SendMemory = { ...mem, [cwd]: next };
  const keys = Object.keys(out);
  if (keys.length <= cap) return out;
  // Oldest decision first — the repos you have not sent to in months.
  keys.sort((a, b) => (out[a].at ?? 0) - (out[b].at ?? 0));
  for (const k of keys.slice(0, keys.length - cap)) delete out[k];
  return out;
}

/** The mode this repo's composer should open on. Never null: the button has to
 *  say something, and with nothing remembered that is `Send`. */
export function recallMode(mem: SendMemory, cwd: string | null | undefined): SendMode {
  if (!cwd) return "now";
  return reusableMode(mem[cwd]?.mode) ?? "now";
}

/**
 * The aim this repo's compose strip should open on. Never null: the strip has
 * to be on one of the three, and with nothing remembered that is the session
 * you are looking at.
 */
export function recallWhere(mem: SendMemory, cwd: string | null | undefined): SendWhere {
  if (!cwd) return "this";
  return reusableWhere(mem[cwd]?.where) ?? "this";
}

/** The WHEN the sheet should open on for this repo, or null to leave the
 *  caller's own answer alone. Re-checked for staleness at READ time, because a
 *  one-off remembered this morning is not still ahead this evening. */
export function recallWhen(mem: SendMemory, cwd: string | null | undefined, now: number): SendWhen | null {
  if (!cwd) return null;
  return reusableWhen(mem[cwd]?.when, now);
}

/**
 * The line the sheet says when it opened on a remembered answer.
 *
 * It has to exist because the sheet's WHEN row is COLLAPSED on open: without a
 * sentence, a schedule set a week ago is exactly the invisible state the old
 * per-repo mode was deleted for. It names the repo, because the memory is per
 * repo and that is the part nobody would guess.
 */
export function recalledWhenNote(repoName: string): string {
  return `When is set the way you last sent to ${repoName} — open When to change it`;
}
