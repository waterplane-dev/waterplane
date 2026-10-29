/**
 * Every gate the host reads off a backend, DERIVED from its descriptor in one place
 * (backend contract v2, `docs/plans/backend-contract-v2.md` §3.2; final shape in
 * `docs/analysis/backend-v2-impl.md` §2.4).
 *
 * A descriptor says, per fact, which PROVIDERS answer it and in what order (`facts`): its own
 * structured channel (`{source:true}` — ask `sources.<slot>`), a named screen reader, or a named
 * store reader. Every question the host used to ask of a v1 cap (`caps.transcript ===
 * "claude-jsonl"`, `caps.promptBoxes`, `caps.usageLimits`, `backend.id === "claude"`) is a
 * question about that list, asked here — so a cap and a source can never disagree, and a
 * backend that lists fewer providers can only make a fact ABSENT, never wrong.
 *
 * The rule the v1 caps carried survives unchanged: this module decides whether a reader RUNS,
 * never what it answers. Pure: no I/O, no registry; `factProblems` takes the contributed reader
 * names as an argument (`registry.ts` hands them over).
 */
import type { BackendFacts, BackendInfo, BackendSources, FactName, Provider } from "@waterplane/shared";
import { FACT_NAMES } from "@waterplane/shared";
import type { BackendDescriptor } from "./types.js";

/** Core's screen readers, per fact — the names a provider may give without a plugin contributing one.
 *  A fact in neither table (`delivery`; 2.2's `mode` and `commands`) takes `{source:true}` only. */
export const CORE_SCREEN: Readonly<Partial<Record<FactName, readonly string[]>>> = {
  turns: ["silence"], dialogs: ["claude-numbered"], questions: ["question-ts"], asking: ["question-ts"],
  plan: ["planbox"], context: ["context-meter"], limits: ["limit-ts"], usage: ["usage-probe"],
};
/** Core's store readers, per fact. */
export const CORE_STORE: Readonly<Partial<Record<FactName, readonly string[]>>> = {
  transcript: ["claude-jsonl"], context: ["claude-jsonl"], conversations: ["claude-jsonl"], tokens: ["claude-jsonl"],
  agents: ["claude-agents"],
};
/** The facts a CONTRIBUTED reader (`api.screenReader` / `api.storeReader`) may answer. */
const CONTRIBUTED_SCREEN: ReadonlySet<FactName> = new Set(["dialogs"]);
const CONTRIBUTED_STORE: ReadonlySet<FactName> = new Set(["transcript", "context", "conversations", "tokens"]);

/** The `sources` slot a `{source:true}` provider asks, per fact. `asking` and `limits` have none
 *  of their own: a box-less question is `questions`', a wall is `usage.wall` (WP5). */
function slotOf(s: BackendSources | undefined, fact: FactName): boolean {
  if (!s) return false;
  switch (fact) {
    case "asking": return !!s.questions;
    case "limits": return typeof s.usage?.wall === "function";
    default: return !!(s as unknown as Record<string, unknown>)[fact];
  }
}

const isSource = (p: Provider): p is { source: true } => (p as { source?: unknown }).source === true;
const screenOf = (p: Provider): string | null => (typeof (p as { screen?: unknown }).screen === "string" ? (p as { screen: string }).screen : null);
const storeOf = (p: Provider): string | null => (typeof (p as { store?: unknown }).store === "string" ? (p as { store: string }).store : null);

export interface Derived {
  /** At least one provider that can answer: a named reader, or a source whose slot exists now. */
  has(fact: FactName): boolean;
  /** The first named screen reader for this fact, or null. */
  screen(fact: FactName): string | null;
  /** The first named store reader for this fact, or null. */
  store(fact: FactName): string | null;
  /** A `{source:true}` provider is listed AND `sources` has the slot right now. */
  askSource(fact: FactName): boolean;
  /** The turn source rides the CLI itself (claude's hooks curl `/api/hook`): `sources.inBand`. */
  readonly hooksInBand: boolean;
  /** The conversation record is claude's jsonl (`store("transcript") === "claude-jsonl"`). */
  readonly keepsClaudeLog: boolean;
  /** The backend's own source cuts a conversation at a turn (`sources.conversations.fork`, 2.2
   *  consumer: `routes/session.ts` calls it, `convfork.ts`'s `forkViaSource`). */
  readonly sourceForks: boolean;
  /** The `backends` frame's `caps`, exactly today's booleans (byte-pinned). */
  wireCaps(): BackendInfo["caps"];
}

type DeriveIn = Pick<BackendDescriptor, "caps" | "facts" | "sources" | "forkVia">;

const CACHE = new WeakMap<object, { caps: unknown; facts: unknown; sources: unknown; forkVia: unknown; out: Derived }>();

/**
 * The gates for one descriptor. Cached per descriptor and re-derived when `caps`, `facts`,
 * `sources` or `forkVia` answer a different object — a plugin's getters (opencode's
 * `OPENCODE_SERVE`) are read through on every call, so a knob flip is seen at once.
 */
export function derive(d: DeriveIn): Derived {
  const caps = d.caps;
  const facts = d.facts ?? {};
  const sources = d.sources;
  const forkVia = d.forkVia;
  const hit = CACHE.get(d);
  if (hit && hit.caps === caps && hit.facts === facts && hit.sources === sources && hit.forkVia === forkVia) return hit.out;
  const out = build(caps, facts, sources, forkVia);
  CACHE.set(d, { caps, facts, sources, forkVia, out });
  return out;
}

function build(caps: DeriveIn["caps"], facts: BackendFacts, sources: BackendSources | undefined, forkVia: DeriveIn["forkVia"]): Derived {
  const list = (f: FactName): readonly Provider[] => (Array.isArray(facts[f]) ? facts[f]! : []);
  const askSource = (f: FactName): boolean => list(f).some(isSource) && slotOf(sources, f);
  const screen = (f: FactName): string | null => { for (const p of list(f)) { const n = screenOf(p); if (n) return n; } return null; };
  const store = (f: FactName): string | null => { for (const p of list(f)) { const n = storeOf(p); if (n) return n; } return null; };
  const has = (f: FactName): boolean => list(f).some((p) => (isSource(p) ? slotOf(sources, f) : !!(screenOf(p) || storeOf(p))));
  const keepsClaudeLog = store("transcript") === "claude-jsonl";
  const hooksInBand = askSource("turns") && sources?.inBand === true;
  // The conversation list, from the slot: claude's own jsonl (picked by claude's interactive
  // picker, cut by `convfork.ts`) or a plugin's `ConversationSource` (listed on the phone's sheet).
  // A source's `fork()` joins `fork` because `routes/session.ts` now CALLS it (`convfork.ts`'s
  // `forkViaSource`, P4b2) — the wire boolean and the route that honours it land together (review R3).
  const claudeConvs = store("conversations") === "claude-jsonl";
  const listsConvs = claudeConvs || askSource("conversations");
  const sourceForks = askSource("conversations") && typeof sources?.conversations?.fork === "function";
  return Object.freeze({
    has, screen, store, askSource, hooksInBand, keepsClaudeLog, sourceForks,
    // Key order is the wire's (the pin compares bytes).
    wireCaps: (): BackendInfo["caps"] => ({
      contextMeter: screen("context") === "context-meter",
      usageLimits: has("limits"),
      transcript: store("transcript") !== null || askSource("transcript"),
      slash: caps.slash !== "none",
      // Which reader is not the phone's business: a box that needs walking says so on the BOX
      // (`DetectedPrompt.nav`).
      promptBoxes: screen("dialogs") !== null || askSource("dialogs"),
      hooks: askSource("turns"),
      effort: !!caps.effort?.length,
      remoteControl: caps.remoteControl,
      // `fork`: `convfork.ts` copies claude's FILE, the backend's server forks it itself, or its
      // source does (`conversations.fork`).
      // `resumePick`: a conversation list to pick from.
      // `contextSeries`: a history can be drawn — a record to read it out of, or a live gauge.
      fork: claudeConvs || forkVia === "server" || sourceForks,
      resumePick: listsConvs,
      contextSeries: store("transcript") !== null || screen("context") === "context-meter" || askSource("transcript") || askSource("context"),
      permissionModes: [...caps.permissionModes],
      // 2.2: only where the descriptor declares a narrower launch set — claude's frame does not move.
      ...(caps.launchModes ? { launchModes: [...caps.launchModes] } : {}),
      ...(caps.spendUnit ? { spendUnit: caps.spendUnit } : {}),
      // v2 additions: ABSENT where no provider answers (absent = not offered on the phone; an
      // older host sends none of these). Never `false`. `efforts` is sent whenever `effort` is
      // true; absent-with-`effort` is how the phone reads an older host (claude's ladder).
      ...(caps.effort?.length ? { efforts: [...caps.effort] } : {}),
      ...(askSource("questions") ? { questions: true as const } : {}),
      ...(has("plan") ? { plan: true as const } : {}),
      ...(has("usage") ? { usage: true as const } : {}),
      ...(has("agents") ? { agents: true as const } : {}),
      ...(has("conversations") ? { conversations: true as const } : {}),
      // 2.2 (`docs/plans/backend-parity-v3.md` §7): only a source can answer either, so absent
      // unless one does — claude's frame does not move.
      ...(askSource("mode") ? { modes: true as const } : {}),
      ...(askSource("commands") ? { commands: true as const } : {}),
    }),
  });
}

/**
 * Walk one fact: providers in order; a provider answering null (or throwing) passes to the next;
 * an empty walk is ABSENT (null). A `{source:true}` whose slot is missing is skipped, unasked.
 */
export async function walk<T>(d: DeriveIn, fact: FactName, ask: (p: Provider) => Promise<T | null> | T | null): Promise<T | null> {
  const providers = Array.isArray(d.facts?.[fact]) ? d.facts[fact]! : [];
  for (const p of providers) {
    if (isSource(p) && !slotOf(d.sources, fact)) continue;
    try {
      const v = await ask(p);
      if (v !== null && v !== undefined) return v;
    } catch { /* a provider that throws has not answered; the next one is asked */ }
  }
  return null;
}

/** claude's folder-trust words, squashed — the same literal as `backends/claude.ts`'s
 *  `TRUST_PROMPT_RE` (pinned equal by `delivertrust.test.mjs`). Asked of EVERY backend's screen,
 *  whatever it declares: Gemini's and Copilot's trust questions use the same words. */
const CLAUDE_TRUST_WORDS = /trustthisfolder|createdoroneyoutrust|doyoutrust/;

/** What delivery and auto-fire may do about a folder-trust question on this backend's screen. */
export interface TrustRule {
  /** Delivery answers the box itself — `delivery.autoAcceptsTrust`, the claude family only. */
  readonly autoAccept: boolean;
  /** The backend as a person knows it, for the sentence when it is NOT answered. */
  readonly who: string;
  /** Does this SQUASHED screen show a trust question: claude's words, or the backend's own
   *  `delivery.trustPromptRe`? */
  asks(squashed: string): boolean;
  /** The refusal when `autoAccept` is false: nothing typed, the person answers it. */
  readonly refusal: string;
}

/**
 * The trust rule for one descriptor (null = a backend this host cannot name: never answered).
 * Pure. A plugin's regex is copied without `g`/`y` so `test()` keeps no `lastIndex` between screens.
 */
export function trustRule(d: Pick<BackendDescriptor, "delivery" | "label"> | null): TrustRule {
  const own = d?.delivery?.trustPromptRe ?? null;
  const re = own && (own.global || own.sticky) ? new RegExp(own.source, own.flags.replace(/[gy]/g, "")) : own;
  const who = d?.label || "this CLI";
  return {
    autoAccept: d?.delivery?.autoAcceptsTrust === true,
    who,
    asks: (s) => CLAUDE_TRUST_WORDS.test(s) || (re ? re.test(s) : false),
    refusal: `${who} is asking whether to trust this folder — answer it on the phone or in the terminal`,
  };
}

/**
 * Every reason a `facts` value cannot be registered, as sentences — empty when it can. Takes the
 * value loosely typed on purpose: a plugin hands over whatever it wrote. `readers` = the names
 * plugins have CONTRIBUTED (core's are known here).
 */
export function factProblems(facts: unknown, readers: { screen: ReadonlySet<string>; store: ReadonlySet<string> }): string[] {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return ["`facts` must be an object of provider lists, one per fact"];
  const out: string[] = [];
  for (const [fact, v] of Object.entries(facts as Record<string, unknown>)) {
    if (!(FACT_NAMES as readonly string[]).includes(fact)) {
      out.push(`there is no fact called \`${fact}\`; the facts are: ${FACT_NAMES.join(", ")}`);
      continue;
    }
    const f = fact as FactName;
    if (!Array.isArray(v)) { out.push(`facts.${f} must be a list of providers`); continue; }
    for (const p of v as unknown[]) {
      if (!p || typeof p !== "object") { out.push(`facts.${f} holds ${JSON.stringify(p)}, which is not a provider ({source:true}, {screen}, or {store})`); continue; }
      const keys = Object.keys(p);
      const o = p as Record<string, unknown>;
      if (keys.length === 1 && o.source === true) continue;
      if (keys.length === 1 && typeof o.screen === "string") {
        const known = [...(CORE_SCREEN[f] ?? []), ...(CONTRIBUTED_SCREEN.has(f) ? readers.screen : [])];
        if (!known.includes(o.screen)) out.push(noReader("screen", f, o.screen, known));
        continue;
      }
      if (keys.length === 1 && typeof o.store === "string") {
        const known = [...(CORE_STORE[f] ?? []), ...(CONTRIBUTED_STORE.has(f) ? readers.store : [])];
        if (!known.includes(o.store)) out.push(noReader("store", f, o.store, known));
        continue;
      }
      out.push(`facts.${f} holds ${JSON.stringify(p)}, which is not a provider ({source:true}, {screen:"<name>"}, or {store:"<name>"})`);
    }
  }
  return out;
}

function noReader(kind: string, fact: FactName, name: string, known: string[]): string {
  return known.length
    ? `facts.${fact}: no ${kind} reader called \`${name}\` answers ${fact}; this host has: ${known.join(", ")}`
    : `facts.${fact}: no ${kind} reader called \`${name}\` answers ${fact}; ${fact} takes no ${kind} reader here, only {source:true}`;
}
