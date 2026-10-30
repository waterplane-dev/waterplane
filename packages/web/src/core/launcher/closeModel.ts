/**
 * `CloseSheet.tsx`'s pure half: which sessions a bulk close is looking at, and
 * every number its facet chips and its foot say.
 *
 * Same shape as `Backlog.tsx`'s age/status cross-count and `RepoGroup`'s
 * roll-up chips (CLAUDE.md: a count on a control is a filter): FACETS are
 * ANDed together (state AND idle-for AND underneath AND …), the OPTIONS
 * within one facet are ORed (tick "working" and "waiting for your answer" and
 * a row matching either stays in), and every chip's own number is read with
 * THAT facet's own current selection set aside — "what would ticking this
 * option show, given what every OTHER facet already picked" — the same
 * self-exclusion `backlogCounts` uses for its age/status pair, generalised to
 * seven axes instead of two. A facet whose every option reads 0 is a sentence
 * on the sheet, never a dead row of chips (`Unavailable.tsx`'s rule, applied
 * to a filter rather than a verb).
 *
 * `SessionStatus` is handed in as `ctx.statusOf` rather than imported from
 * `sessionFacts.tsx` — that reader is a `.tsx` module node cannot load, and
 * `model.ts` already keeps this file testable the same way for the same
 * reason.
 */
import type { SessionInfo } from "@waterplane/shared";
import { shellsSummary } from "@waterplane/shared";
import type { OutboxEntry } from "../../outbox.ts";
import { convoStart, inactiveMs, inactivityKnown } from "../../format.ts";

// ── State (`sessionStatus`'s own buckets, handed in) ────────────────────────
export type CloseState = "coding" | "wait" | "done" | "limit" | "exited";
export const CLOSE_STATE_OPTIONS: readonly CloseState[] = ["wait", "limit", "coding", "done", "exited"];
// closed: the close facets are in-memory filter picks from this build's option lists
export const CLOSE_STATE_LABEL: Record<CloseState, string> = {
  coding: "working", wait: "waiting for your answer", done: "idle", limit: "at the usage limit", exited: "exited",
};

// ── Idle-for / open-for (same edges, two different clocks) ──────────────────
export type TimeEdge = "1h" | "6h" | "1d" | "3d";
export const TIME_EDGE_OPTIONS: readonly TimeEdge[] = ["1h", "6h", "1d", "3d"];
export const TIME_EDGE_MS: Record<TimeEdge, number> = { "1h": 3600e3, "6h": 6 * 3600e3, "1d": 24 * 3600e3, "3d": 3 * 24 * 3600e3 };
// closed: an in-memory filter pick from this build's option list
export const TIME_EDGE_LABEL: Record<TimeEdge, string> = { "1h": "> 1h", "6h": "> 6h", "1d": "> 1d", "3d": "> 3d" };

// ── Underneath: what is still running, independent of `state` ───────────────
export type UnderFacet = "agents" | "shellsLive" | "shellsQuiet" | "nothing";
export const UNDER_OPTIONS: readonly UnderFacet[] = ["agents", "shellsLive", "shellsQuiet", "nothing"];
// closed: an in-memory filter pick from this build's option list
export const UNDER_LABEL: Record<UnderFacet, string> = {
  agents: "agents running", shellsLive: "shells live", shellsQuiet: "shells quiet", nothing: "nothing running",
};

/**
 * What a row draws in the "underneath" facet — INDEPENDENT booleans, never a
 * bucket: a session can be both `agents` and `shellsLive` at once, so
 * `nothing` is its own predicate ("none of the above", read straight off the
 * session) rather than something derived from the other three failing to
 * match, or a session with an absent `shellList` and no agents would answer
 * every option `false` and none `true`.
 *
 * `unknown` NEVER reads as quiet here — the shared rule (`shells.ts`'s own
 * comment on `shellsSummary`) holds for a closing decision too: a shell this
 * phone has watched for one poll, with nothing yet to compare against, is not
 * proof that nothing is running. It counts as LIVE instead, the conservative
 * side of "is it safe to say nothing is running".
 *
 * A `shellList` that has never arrived (an OLD host: only the boolean
 * `shells`) is not the same as one that arrived empty — `s.shells === true`
 * reads as `shellsLive`, since there is no richer reading to say otherwise
 * and "nothing running" would be a claim this build cannot back up.
 * `foreground` shells are excluded already, by `shellsSummary` itself.
 */
export function underneathOf(s: SessionInfo, now: number, opt: UnderFacet): boolean {
  const agents = !!s.agents?.length;
  let live: boolean;
  let quiet: boolean;
  if (s.shellList) {
    const sum = shellsSummary(s.shellList, now);
    live = sum.working + sum.waiting + sum.unknown > 0;
    quiet = !live && sum.quiet > 0;
  } else {
    live = !!s.shells;
    quiet = false;
  }
  if (opt === "agents") return agents;
  if (opt === "shellsLive") return live;
  if (opt === "shellsQuiet") return quiet;
  return !agents && !live && !quiet;
}

// ── Words at stake: what closing would lose or strand ────────────────────────
export type StakesFacet = "draft" | "queued" | "none";
export const STAKES_OPTIONS: readonly StakesFacet[] = ["draft", "queued", "none"];
// closed: an in-memory filter pick from this build's option list
export const STAKES_LABEL: Record<StakesFacet, string> = {
  draft: "unsent draft on this phone", queued: "prompts queued for it", none: "nothing waiting",
};

/**
 * Mutually exclusive, unlike `underneath`: a row is IN one of these three, so
 * the pool sums to the scope the way `convoStart`'s three answers do. A draft
 * outranks a queued prompt when a row somehow carries both — it is the one
 * only THIS phone holds, so it is the more local thing at stake.
 */
export function stakesOf(s: SessionInfo, draftIds: ReadonlySet<string>, outbox: readonly OutboxEntry[]): StakesFacet {
  if (draftIds.has(s.id)) return "draft";
  // A failed send is not "queued" — `queuedKeysByRepo` excludes it for the
  // same reason (Activity is where a failure is triaged, not this sheet).
  if (outbox.some((e) => e.sessionId === s.id && e.status !== "failed")) return "queued";
  return "none";
}

// ── Conversation: never started / started (`convoStart`'s first two) ────────
export type ConvoFacet = "fresh" | "started";
export const CONVO_OPTIONS: readonly ConvoFacet[] = ["fresh", "started"];
// closed: an in-memory filter pick from this build's option list
export const CONVO_LABEL: Record<ConvoFacet, string> = { fresh: "never started", started: "started" };

// ── The facet selection, and the context every predicate reads ──────────────
export interface CloseFacets {
  state: ReadonlySet<CloseState>;
  idleOver: ReadonlySet<TimeEdge>;
  openOver: ReadonlySet<TimeEdge>;
  under: ReadonlySet<UnderFacet>;
  stakes: ReadonlySet<StakesFacet>;
  convo: ReadonlySet<ConvoFacet>;
  /** Scope `"*"` only — a repo-scoped close has its repo fixed already. */
  repo: ReadonlySet<string>;
}
export const EMPTY_CLOSE_FACETS: CloseFacets = {
  state: new Set(), idleOver: new Set(), openOver: new Set(), under: new Set(), stakes: new Set(), convo: new Set(), repo: new Set(),
};

export interface CloseCtx {
  now: number;
  repoName: (s: SessionInfo) => string;
  statusOf: (s: SessionInfo) => CloseState;
  draftIds: ReadonlySet<string>;
  outbox: readonly OutboxEntry[];
}

function within<T>(opts: ReadonlySet<T>, test: (o: T) => boolean): boolean {
  return opts.size === 0 || [...opts].some(test);
}

function matches(s: SessionInfo, f: CloseFacets, ctx: CloseCtx): boolean {
  return within(f.state, (o) => ctx.statusOf(s) === o)
    && within(f.idleOver, (o) => inactiveMs(s) >= TIME_EDGE_MS[o])
    && within(f.openOver, (o) => ctx.now - s.createdAt >= TIME_EDGE_MS[o])
    && within(f.under, (o) => underneathOf(s, ctx.now, o))
    && within(f.stakes, (o) => stakesOf(s, ctx.draftIds, ctx.outbox) === o)
    && within(f.convo, (o) => convoStart(s) === o)
    && within(f.repo, (o) => ctx.repoName(s) === o);
}

/** The rows a bulk close is currently looking at — every facet ANDed, every
 *  option within one ORed. This is the list the foot sends and the list the
 *  row cards render. */
export function closeCut(scope: readonly SessionInfo[], f: CloseFacets, ctx: CloseCtx): SessionInfo[] {
  return scope.filter((s) => matches(s, f, ctx));
}

/** `f` with one facet's own selection cleared — what a chip in THAT facet is
 *  cross-counted against: every other facet's active filter, none of this
 *  one's. */
function withoutFacet<K extends keyof CloseFacets>(f: CloseFacets, key: K): CloseFacets {
  return { ...f, [key]: EMPTY_CLOSE_FACETS[key] };
}

/** One facet's chip counts: for each of `options`, how many rows would be in
 *  the cut if THIS option (and only this option) were the facet's selection,
 *  combined with every OTHER facet's actual selection. Never counts this
 *  facet's own current picks — that is what makes ticking a second option in
 *  the same facet read as "adds these", not "recount everything I already see". */
export function facetCounts<K extends string>(
  scope: readonly SessionInfo[], f: CloseFacets, ctx: CloseCtx,
  key: keyof CloseFacets, options: readonly K[], test: (s: SessionInfo, o: K) => boolean,
): Record<K, number> {
  const base = withoutFacet(f, key);
  const inBase = scope.filter((s) => matches(s, base, ctx));
  const out = {} as Record<K, number>;
  for (const o of options) out[o] = inBase.filter((s) => test(s, o)).length;
  return out;
}

export interface CloseCounts {
  state: Record<CloseState, number>;
  idleOver: Record<TimeEdge, number>;
  openOver: Record<TimeEdge, number>;
  under: Record<UnderFacet, number>;
  stakes: Record<StakesFacet, number>;
  convo: Record<ConvoFacet, number>;
  repo: Record<string, number>;
  /** Rows whose `inactiveMs` is a restart artifact rather than a real
   *  reading (`inactivityKnown`), among what the OTHER facets (not
   *  `idleOver` itself) already narrowed the scope to — the honesty line
   *  "idle for" carries beside its chips. */
  idleUnknown: number;
}

/** Every chip's number, in one call — so the sheet and its test read one
 *  reading of one pool, never seven separate walks that could disagree. */
export function closeFacetCounts(scope: readonly SessionInfo[], f: CloseFacets, ctx: CloseCtx, repoNames: readonly string[]): CloseCounts {
  const idleBase = withoutFacet(f, "idleOver");
  return {
    state: facetCounts(scope, f, ctx, "state", CLOSE_STATE_OPTIONS, (s, o) => ctx.statusOf(s) === o),
    idleOver: facetCounts(scope, f, ctx, "idleOver", TIME_EDGE_OPTIONS, (s, o) => inactiveMs(s) >= TIME_EDGE_MS[o]),
    openOver: facetCounts(scope, f, ctx, "openOver", TIME_EDGE_OPTIONS, (s, o) => ctx.now - s.createdAt >= TIME_EDGE_MS[o]),
    under: facetCounts(scope, f, ctx, "under", UNDER_OPTIONS, (s, o) => underneathOf(s, ctx.now, o)),
    stakes: facetCounts(scope, f, ctx, "stakes", STAKES_OPTIONS, (s, o) => stakesOf(s, ctx.draftIds, ctx.outbox) === o),
    convo: facetCounts(scope, f, ctx, "convo", CONVO_OPTIONS, (s, o) => convoStart(s) === o),
    repo: facetCounts(scope, f, ctx, "repo", repoNames, (s, o) => ctx.repoName(s) === o),
    idleUnknown: scope.filter((s) => matches(s, idleBase, ctx) && !inactivityKnown(s)).length,
  };
}

/** The one-line honesty disclosure for the "idle for" facet — said whenever
 *  any row in scope cannot really answer it, whether or not the facet is
 *  currently ticked (a chip whose count is inflated by a guess is worth
 *  flagging before the tap, not only after). */
export function idleUnknownNote(n: number): string {
  if (!n) return "";
  return `${n} session${n === 1 ? " has" : "s have"} no readable activity record — ${n === 1 ? "its" : "their"} `
    + `quiet time is measured only since the last desktop restart, so "idle for" may read shorter than it has `
    + `been. "Open for" is unaffected.`;
}

/** The filter bar's own sentence: what is in the cut, against the scope, and
 *  the facets in words — `Backlog.tsx`'s "n of N" plus a clear. */
export function closeFacetWords(f: CloseFacets): string {
  const parts: string[] = [];
  if (f.state.size) parts.push([...f.state].map((o) => CLOSE_STATE_LABEL[o]).join(" or "));
  if (f.idleOver.size) parts.push(`idle ${[...f.idleOver].map((o) => TIME_EDGE_LABEL[o]).join(" or ")}`);
  if (f.openOver.size) parts.push(`open ${[...f.openOver].map((o) => TIME_EDGE_LABEL[o]).join(" or ")}`);
  if (f.under.size) parts.push([...f.under].map((o) => UNDER_LABEL[o]).join(" or "));
  if (f.stakes.size) parts.push([...f.stakes].map((o) => STAKES_LABEL[o]).join(" or "));
  if (f.convo.size) parts.push([...f.convo].map((o) => CONVO_LABEL[o]).join(" or "));
  if (f.repo.size) parts.push([...f.repo].join(" or "));
  return parts.join(" · ");
}
export function closeFilterBarLabel(cutLen: number, scopeLen: number, f: CloseFacets): string {
  const words = closeFacetWords(f);
  return `${cutLen} of ${scopeLen} in scope${words ? ` · ${words}` : ""}`;
}
export const closeFacetsActive = (f: CloseFacets): boolean =>
  f.state.size + f.idleOver.size + f.openOver.size + f.under.size + f.stakes.size + f.convo.size + f.repo.size > 0;

// ── The foot: what one tap actually sends ────────────────────────────────────
/**
 * Is this row kept out of the close? A session a TIMED prompt is aimed at
 * (`timed`) starts kept: the prompt was written into this session on purpose,
 * and a bulk close is the one way it gets closed without anybody looking at
 * it. So there `kept` records the OVERRIDE — a tap puts it back in the close —
 * and the sheet says what is being spared (`timedKeptNote`), never silently.
 */
export function isKept(id: string, kept: ReadonlySet<string>, timed: ReadonlySet<string> = new Set()): boolean {
  return timed.has(id) ? !kept.has(id) : kept.has(id);
}

/** The cut, minus the rows kept (by hand, or by a timed prompt) — the list
 *  `session.remove` actually goes out for. Per-row "keep" is never persisted;
 *  it is this sheet's own scratch state (`CloseSheet.tsx`), gone the moment it
 *  closes. */
export function closeSendList(cut: readonly SessionInfo[], kept: ReadonlySet<string>, timed?: ReadonlySet<string>): SessionInfo[] {
  return cut.filter((s) => !isKept(s.id, kept, timed));
}

/** The sentence for the sessions a timed prompt keeps out of this close. The
 *  truth about what closing would do is in it: the desktop reopens the
 *  conversation at that time, so keeping is about not paying a cold start, and
 *  not about losing the prompt. "" when there are none. */
export function timedKeptNote(n: number): string {
  if (!n) return "";
  return `${n} session${n === 1 ? " is" : "s are"} kept open: a timed prompt is aimed at ${n === 1 ? "it" : "each"}. `
    + `Closed anyway, the desktop reopens that conversation when the prompt's time comes — the shield on the row puts ${n === 1 ? "it" : "one"} back in this close.`;
}
/** Every background shell that close would stop, fully, across the send
 *  list — CLAUDE.md's "closing a session stops its shells" said as a count. */
export function closeShellsAtStake(list: readonly SessionInfo[]): number {
  return list.reduce((n, s) => n + (s.shellList?.length ?? 0), 0);
}
/** Rows on their way out that are sitting on an unanswered box — closing
 *  answers nothing, it just ends the process, so the foot names how many. */
export function closeWaitingCount(list: readonly SessionInfo[], ctx: Pick<CloseCtx, "statusOf">): number {
  return list.filter((s) => ctx.statusOf(s) === "wait").length;
}
/** The foot button's own words — "" when there is nothing to send, which is
 *  what makes the button ABSENT (`Unavailable.tsx`: N=0 is a sentence, not a
 *  greyed control). */
export function closeFootLabel(n: number, shells: number): string {
  if (!n) return "";
  return shells > 0 ? `close ${n} · stops ${shells} background shell${shells === 1 ? "" : "s"}` : `close ${n}`;
}
/** The one toast for the one tap, whatever the cut turned out to hold.
 *
 * "stopping", never "stopped": this fires at the TAP, before a single kill has
 * actually landed (`shellsStopped`/`shellsLeft` come back later, on the
 * host's `session.closed` — see `features/shells/actions.ts`). Claiming the
 * past tense here is the same defect as a "stopped" toast that fires before
 * the kill: it says something happened that has not happened yet. */
export function closeToast(n: number, shells: number, spared: number | string, repo?: string): string {
  const base = `archived ${n} session${n === 1 ? "" : "s"}${repo ? ` in ${repo}` : ""}`;
  const bits = [
    shells > 0 ? `stopping ${shells} background shell${shells === 1 ? "" : "s"}` : "",
    // A number is starred-only (the old shape); words are `markedWords`'.
    typeof spared === "string" ? (spared ? `kept ${spared}` : "") : spared > 0 ? `kept ${spared} starred` : "",
  ].filter(Boolean).join(", ");
  return `${base}${bits ? `, ${bits}` : ""} — the conversation${n === 1 ? " is" : "s are"} kept: reopen under `
    + `"Recently closed" or Archive`;
}
