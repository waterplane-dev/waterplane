/**
 * Pure rules of the snippet list and its picker (node-tested, `logic.test.mjs`): which list a
 * person sees, what ticking does, how ticked snippets become one block of words.
 */

export interface SnippetLike { id: string; title: string; text: string }

/** Shipped for a person who has no list at all. Backend-agnostic; ids are stable so "add the starters" can tell what is present. */
export const STARTERS: readonly SnippetLike[] = [
  { id: "starter-plan", title: "Plan first", text: "Write a short plan and wait for my OK before you change code." },
  { id: "starter-small", title: "Small change", text: "Tie this into the existing code and features; no new abstractions unless needed." },
  { id: "starter-review", title: "Review", text: "When done, review your change for bugs and fix what you find before you finish." },
  { id: "starter-workflow", title: "Use a workflow", text: "Use a workflow (several agents) for this; show me a cost estimate first and wait for my OK." },
  { id: "starter-tests", title: "Run the tests", text: "Run the tests and tell me what failed, with the output." },
  { id: "starter-commit", title: "Commit", text: "Commit when done, with a clear message." },
  { id: "starter-show", title: "Show me", text: "Put anything I should look at in .claude/outbox/ so I can see it on my phone." },
  { id: "starter-short", title: "Short answer", text: "Answer short: conclusion first." },
];

export interface SnippetView { list: SnippetLike[]; starter: boolean }

/**
 * What the picker and the manage sheet show, from the RAW stored value of the synced key. Starters
 * appear only when the key does not exist at all: an empty saved list is a choice (the person
 * emptied it), and an unreadable value is never replaced by words nobody wrote. Nothing here
 * writes; starters reach storage only when the person saves an edit.
 */
export function snippetView(raw: string | null): SnippetView {
  if (raw === null || raw === "") return { list: STARTERS.map((s) => ({ ...s })), starter: true };
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return { list: v as SnippetLike[], starter: false };
  } catch { /* fall through */ }
  return { list: [], starter: false };
}

/** The starters a list does not hold yet (compared by text), for "add the starters" — it only ever appends. */
export function missingStarters(list: readonly SnippetLike[]): SnippetLike[] {
  const have = new Set(list.map((s) => s.text.trim()));
  return STARTERS.filter((s) => !have.has(s.text)).map((s) => ({ ...s }));
}

/** A tap ticks, a second tap unticks; the order is the order of the taps. */
export function toggleTick(order: readonly string[], id: string): string[] {
  return order.includes(id) ? order.filter((x) => x !== id) : [...order, id];
}

/** The ticked snippets in tap order; ids no longer in the list (edited away meanwhile) drop out. */
export function tickedSnippets<T extends { id: string }>(list: readonly T[], order: readonly string[]): T[] {
  const byId = new Map(list.map((s) => [s.id, s]));
  return order.flatMap((id) => { const s = byId.get(id); return s ? [s] : []; });
}

/** Ticked snippets as one block, each on its own line. */
export function joinSnippets(picked: readonly { text: string }[]): string {
  return picked.map((s) => s.text.trim()).filter(Boolean).join("\n");
}

/** The insert button: bare when one is ticked, with the count when several are. */
export function insertLabel(n: number): string {
  return n > 1 ? `Insert ${n}` : "Insert";
}

/** The list with the most recently inserted first (ids in `recent`, newest first); the rest keep
 *  their saved order. Only an order for display: the stored list is never rewritten. */
export function byRecent<T extends { id: string }>(list: readonly T[], recent: readonly string[]): T[] {
  const rank = new Map(recent.map((id, i) => [id, i]));
  return list.map((s, i) => ({ s, i })).sort((a, b) => {
    const ra = rank.get(a.s.id) ?? Infinity, rb = rank.get(b.s.id) ?? Infinity;
    return ra === rb ? a.i - b.i : ra - rb;
  }).map((x) => x.s);
}

/** `recent` after inserting `ids` (the first inserted ends up first), capped. */
export function noteRecent(recent: readonly string[], ids: readonly string[], cap = 50): string[] {
  const now = [...ids];
  return [...now, ...recent.filter((id) => !now.includes(id))].slice(0, cap);
}
