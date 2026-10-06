/**
 * **One send, described in four answers.**
 *
 * Twelve entry points used to each hard-code a different combination of the
 * same four decisions, force them in a different order, and store the draft
 * somewhere different. The compose bar decided WHEN by cycling a per-repo mode
 * nobody could see; the Start sheet decided WHERE by which repo you had tapped;
 * the fan-out sheet decided HOW MANY by existing at all; the pad decided
 * nothing and then asked for everything, one button per answer. So "queue this
 * one for later" was available in one sheet and missing from the next, and
 * whether N repos ran together or one at a time was never a choice at
 * composition time — it was a property of the sheet you happened to open, or a
 * repair made afterwards in the queue manager.
 *
 * The four axes, kept apart on purpose:
 *
 *  - **WHAT** — `prompts`: one prompt, or a chain delivered one turn at a time.
 *  - **WHERE** — `target`: a live session, a new session in a repo (optionally
 *    picking up that repo's last conversation), N repos, or a shell command
 *    with no agent at all.
 *  - **WHEN** — `when`: now, when the target is free, at a wall-clock time, or
 *    after another piece of work has finished.
 *  - **HOW MANY AT ONCE** — `sequential`, and only where it can mean anything.
 *
 * This file is the vocabulary and the pure rules over it: what a decision is
 * CALLED (the primary button restates the whole thing, which is the only way a
 * one-button sheet can be honest about four axes), and why it is refused. It
 * holds no React and no send path — `dispatchIntent` in `App.tsx` maps an
 * intent onto the paths that already exist, and adds none.
 */
export * from "./sendIntent/sendTypes.ts";
export * from "./sendIntent/sendClock.ts";
export * from "./sendIntent/sendLabels.ts";
export * from "./sendIntent/sendChain.ts";
export * from "./sendIntent/sendRule.ts";
export * from "./sendIntent/sendRetime.ts";
