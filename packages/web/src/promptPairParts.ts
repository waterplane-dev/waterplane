/**
 * The two verbatim prompts a session row shows: where it started and where it
 * stands. No model in the loop — the words are the person's own. The decision
 * of WHICH parts show is pure so it is tested without a DOM; `PromptPair.tsx`
 * only draws it.
 */
export interface PromptPairParts {
  first?: string;
  /** The latest prompt, or the pinned one (which replaces it). */
  now?: string;
  nowKind?: "latest" | "pinned";
}

export function promptPairParts(o: { firstPrompt?: string; lastPrompt?: string; pinnedPrompt?: string }): PromptPairParts {
  const first = o.firstPrompt?.trim() || undefined;
  const pinned = o.pinnedPrompt?.trim() || undefined;
  const now = pinned ?? (o.lastPrompt?.trim() || undefined);
  const out: PromptPairParts = {};
  if (first) out.first = first;
  if (now && now !== first) {
    out.now = now;
    out.nowKind = pinned ? "pinned" : "latest";
  } else if (!first && now) {
    // Only a latest prompt is known (history trimmed): say it as the latest.
    out.now = now;
    out.nowKind = pinned ? "pinned" : "latest";
  }
  return out;
}
