/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/shared-architecture.md. */
import { type SmartPickCandidate } from "./ssptypes.js";

// ── The fingerprint ──────────────────────────────────────────────────────────

/**
 * 64-bit FNV-1a over a string, as 16 hex characters.
 *
 * **Deliberately not a cryptographic hash.** `crypto.subtle` is async and
 * `node:crypto` is not available in the browser bundle, and this module must be
 * synchronous and node-runnable: `shared/dist` is what e2e pins and what the
 * host imports directly. A hand-rolled sync FNV-1a is the only shape that is one
 * function for both ends.
 *
 * A collision costs ONE SKIPPED PASS — the host reads "nothing has changed since
 * the last look" about a backlog that did change, and the next item fires in the
 * order it already had. It can never cause a wrong mutation: the fingerprint
 * gates whether a pass is bought, never what a pass does. That is the entire
 * risk budget, and it is why 64 bits is enough.
 *
 * Hashes UTF-16 code units rather than UTF-8 bytes. Both ends call this one
 * function, so the only property that matters is determinism.
 */
export function fingerprint(s: string): string {
  const PRIME = 1099511628211n;
  const MASK = 0xffffffffffffffffn;
  let h = 14695981039346656037n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}

/** The cheap repo facts a pass is allowed to reason from. Degraded facts (a git
 *  spawn that failed) are empty, never invented — the pass still runs on the
 *  words. */
export interface SmartPickFacts {
  branch: string;
  /** `"<code> <path>"` per uncommitted file, sorted and capped by the host. */
  dirty: string[];
  /** The last few commit subjects, newest first. */
  commits: string[];
}

/**
 * "Has anything changed since the last look?" — the one question that decides
 * whether a pass is bought at all.
 *
 * Includes `order` and `handOrdered` on purpose. A drag is a change worth
 * re-looking at (the pass must honour a position a person just set), and the
 * state the pass leaves behind has to hash to what the confirming tick sees —
 * otherwise every applied pass immediately looks changed again and the repo buys
 * a completion per tick for ever.
 *
 * `id` is in there too: two items whose words happen to match are still two
 * items, and dropping one of them is a change.
 *
 * `steps` is in there because it changes what a pass may DO with an item and is
 * invisible in `text`, which is only turn ONE: editing turns 2..n of a chain,
 * or a one-turn item becoming a chain (which stops it being mergeable), left
 * the fingerprint saying "nothing has changed since the last look" about a list
 * whose merge options had changed.
 *
 * `atKey` is in there because a re-timed row is a different row to decide
 * about: it changes which slot the sort may touch, whether the pick may name it
 * and what it may be merged with. Without it, *drop the clock* or an edit from
 * *tonight 21:00* to *tomorrow 09:00* left the repo reading "nothing has changed
 * since the last look" and the pass was skipped. The KEY rather than the `at`
 * sentence for `SmartPickCandidate.atKey`'s reason — the grace and the
 * host-wide hold are invisible in the sentence, and the sentence is
 * locale-formatted. `holdForHost` rides BESIDE the key rather than inside it,
 * because the key carries the hold only for a row that has a clock — and *drop
 * the clock* leaves the hold behind on a row that has not, which is the shape a
 * merge could silently un-hold.
 *
 * `clipped` is deliberately NOT in here, though it is the same kind of fact.
 * The fingerprint is always taken over the STORE's candidates, never over the
 * clipped copies the prompt builder makes, so the field is constant by
 * construction at every call site — and a hashed field that cannot vary is
 * coverage that looks present and is not. Whether an item clips is a function
 * of the texts and their order, which are hashed already.
 */
export function smartpickFingerprint(
  items: readonly SmartPickCandidate[],
  facts: SmartPickFacts,
): string {
  return fingerprint(JSON.stringify({
    // `pastBudget` is appended only when set, so a repo with no waiver keeps
    // the fingerprint it already had and is not re-looked at for nothing.
    i: items.map((c) => [c.id, c.text, c.label ?? "", c.order, c.resume ? 1 : 0, c.handOrdered ? 1 : 0, c.steps ?? 1, c.atKey ?? "", c.holdForHost ? 1 : 0, ...(c.pastBudget ? [1] : [])]),
    r: [facts.branch, facts.dirty, facts.commits],
  }));
}