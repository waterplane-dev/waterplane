/**
 * The look a repo takes over its own waiting items, just before one of them
 * fires — the host half.
 *
 * `@waterplane/shared`'s `smartpick.ts` decides; this file is everything that touches
 * the world: the tick-box's state, the guard ladder that says whether a pass is
 * bought at all, the one unattended `claude -p` it buys, the record it leaves on
 * disk, the mutations it performs, and the undo that takes them all back.
 *
 * ── The shape this copies, and every flag it keeps ─────────────────────────
 *
 * `sessions/record.ts`'s `nameTab` is the precedent CLAUDE.md names: `haiku`,
 * `--setting-sources user`, `--tools ""`, its own system prompt, the result
 * PERSISTED so a restart re-derives nothing. The argv is `sidecar.ts`'s
 * `runSmartPickTask` and its header justifies each flag; the persistence is
 * `.waterplane/smartpick.json` below. The one thing this adds that the summary has
 * not got is a WATCHDOG, because a summary runs off a turn boundary with nobody
 * waiting and this one holds a person's next backlog item behind it.
 *
 * ── What one pass costs, measured ──────────────────────────────────────────
 *
 * **About $0.0014 and about 3 seconds**, measured on the real prompt against the
 * installed binary (2026-09-17, this desktop).
 *
 * It was not that to begin with. Phase 0's warning was that thinking, not input
 * size, is what this call is billed for; the real prompt showed the same three
 * items costing $0.0067–$0.025 and taking 13–36 s, with 1,044–3,371 thinking
 * tokens, for a conclusion identical to the one a no-thinking run reached in
 * 2.8 s. Two runs in three blew through the 20 s watchdog — so with thinking on,
 * this feature would have bought a completion, timed out, discarded the answer
 * as `late` and fired the original order, every time, for ever.
 *
 * `runSmartPickTask`'s argv therefore carries `--thinking disabled` (see its
 * header for the table). `SMARTPICK_SYSTEM` asks for the same thing in words and
 * that alone did NOT work — it was asked for, and 2,644 thinking tokens were
 * spent anyway — but the paragraph stays, because it costs nothing and it is the
 * only lever on the local engine, which has no such flag.
 *
 * ── The promise the whole file is arranged around ──────────────────────────
 *
 * **Every failure fires the original order, and nothing is ever destroyed.**
 * A timeout, a failed run, an account block, an unreadable answer, an id that
 * does not exist, an answer that arrives after the watchdog let the row go —
 * each writes a record against the SAME fingerprint the pass started on, so the
 * next tick reads "nothing has changed" and the item fires exactly as it would
 * have with the feature off. And a merge ARCHIVES its originals (`edit({
 * archived: true })`) — never cancel, never dismiss, never remove — so every
 * word anybody typed is still in the store, listed under *archived*, one tap
 * from coming back. Those two properties are what made the user's "apply it all
 * automatically" choice a safe one to implement.
 *
 * **And a clock is never decided here.** A one-off with an instant on it is an
 * ordinary backlog row (`isTimedWorkRow`) and therefore an ordinary candidate —
 * the pass sees it, with its clock, in the prompt — but the rules for what may
 * be done to it are `shared/smartpick.ts`'s and they are all refusals: its slot
 * is pinned, it is never the pick, and it merges only with a twin on the
 * identical clock, which the merged row then carries. This file asks the LIVE
 * rows the same question once more at apply time (`apply`), because the seconds
 * a pass spends thinking are seconds in which somebody can drop a clock.
 */

export { SMARTPICK_SYSTEM, smartpickPrompt } from "./smartpick/hspprompt.js";
export { SmartPickStore } from "./smartpick/hspstore.js";
export type { SmartPickIntents, SmartPickDeps } from "./smartpick/hspdeps.js";
export { SmartPick } from "./smartpick/hspclass.js";
export { isCandidateRow, mergedRowId } from "./smartpick/hsphelpers.js";
