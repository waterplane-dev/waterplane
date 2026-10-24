/**
 * The screen/log readers a descriptor's `facts` may point at, by NAME
 * (`docs/analysis/backends-design.md` §1.2).
 *
 * A reader is measured against ONE binary's TUI or store and pinned by fixtures,
 * so a descriptor never carries code for one: it NAMES one, and a name this host
 * does not have is refused in words at registration (`registry.ts`) — a reader
 * can therefore never be armed against a TUI it was not written for, and a
 * misspelling in a plugin is a listed-broken plugin, not a silent `false`.
 *
 * Two kinds of name:
 *  - CORE's, in the two tables below — claude's, dispatched where they always
 *    were (`sessions/boxes.ts`, `sessions/ctxseries.ts`, `sessions/record.ts`),
 *    each asking for the exact name it was written for;
 *  - CONTRIBUTED ones, registered by a plugin through `api.screenReader` /
 *    `api.storeReader` (`shared/plugin.ts`'s `PluginScreenReader` /
 *    `PluginStoreReader`) BEFORE its backend names them. The core keeps the
 *    shape every reader has (the gate, the miss budget, the re-reading walk, the
 *    poll contract, "exactly one candidate or none") and asks the contributed
 *    reader only the questions about its own binary. This is how the opencode
 *    extension brings its readers without core knowing opencode exists.
 * A contributed reader that leaves (its plugin switched off) answers nothing:
 * every lookup is by name at CALL time, so a session still running on it reads
 * as having no box and no record — absent, never stale.
 */
import type { BackendFacts, PluginScreenReader, PluginStoreReader } from "@waterplane/shared";
import { PLUGIN_READER_NAME_RE } from "@waterplane/shared";

export const PROMPT_READERS = {
  /** `prompt.ts`: numbered rows, a cursor glyph, an "Enter to confirm" footer; answered by its digit. */
  "claude-numbered": "prompt.ts",
} as const;

export const TRANSCRIPT_READERS = {
  /** `~/.claude/projects/**\/*.jsonl`, read by `transcript.ts` and the ledgers. */
  "claude-jsonl": "claude's jsonl conversation log",
} as const;

/** A core name, or one a plugin contributed (checked at registration, not by the compiler). */
export type PromptReaderName = keyof typeof PROMPT_READERS | (string & {});
export type TranscriptReaderName = keyof typeof TRANSCRIPT_READERS | (string & {});

const SCREEN = new Map<string, PluginScreenReader>();
const STORE = new Map<string, PluginStoreReader>();

function register<R>(kind: string, name: string, reader: R, core: Readonly<Record<string, string>>, map: Map<string, R>): () => void {
  if (typeof name !== "string" || !PLUGIN_READER_NAME_RE.test(name)) {
    throw new Error(`a ${kind} reader name must be a short lowercase word (letters, digits, dashes); got ${JSON.stringify(name)}`);
  }
  if (Object.hasOwn(core, name) || map.has(name)) {
    throw new Error(`a ${kind} reader called \`${name}\` already exists; this host has: ${names(core, map).join(", ")}`);
  }
  if (!reader || typeof reader !== "object") throw new Error(`the ${kind} reader \`${name}\` is not an object`);
  map.set(name, reader);
  return () => { if (map.get(name) === reader) map.delete(name); };
}

/** Register a contributed screen reader. Throws a sentence on a bad or taken name. */
export function registerScreenReader(name: string, reader: PluginScreenReader): () => void {
  for (const k of ["candidate", "read", "prompt", "stillUp", "navTo"] as const) {
    if (typeof (reader as unknown as Record<string, unknown> | null)?.[k] !== "function") throw new Error(`the screen reader \`${name}\` has no ${k}()`);
  }
  return register("screen", name, reader, PROMPT_READERS, SCREEN);
}

/** Register a contributed store reader. Throws a sentence on a bad or taken name. */
export function registerStoreReader(name: string, reader: PluginStoreReader): () => void {
  for (const k of ["updatedAt", "pollUnchanged", "transcript", "toolDetails", "contextSeries", "discover"] as const) {
    if (typeof (reader as unknown as Record<string, unknown> | null)?.[k] !== "function") throw new Error(`the store reader \`${name}\` has no ${k}()`);
  }
  return register("store", name, reader, TRANSCRIPT_READERS, STORE);
}

/** What `screenReaderFor` & co. read: a descriptor's `facts` (`derive.ts` owns the provider rules). */
type WithFacts = { facts?: BackendFacts };
const firstNamed = (b: WithFacts, fact: "dialogs" | "transcript", key: "screen" | "store"): string | null => {
  const list = b.facts?.[fact];
  if (!Array.isArray(list)) return null;
  for (const p of list) { const n = (p as Record<string, unknown>)[key]; if (typeof n === "string") return n; }
  return null;
};

/** The CONTRIBUTED screen reader a descriptor's `facts.dialogs` names — null for core's, none, or a name that left. */
export function screenReaderFor(b: WithFacts): PluginScreenReader | null {
  const n = firstNamed(b, "dialogs", "screen");
  return n ? SCREEN.get(n) ?? null : null;
}

/** The CONTRIBUTED store reader a descriptor's `facts.transcript` names — null for `claude-jsonl`, none, or a name that left. */
export function storeReaderFor(b: WithFacts): PluginStoreReader | null {
  const n = firstNamed(b, "transcript", "store");
  return n ? STORE.get(n) ?? null : null;
}

/** Does `facts.transcript` name a CONTRIBUTED store reader (whether or not it is registered right now)? */
export function namesStoreReader(b: WithFacts): boolean {
  const n = firstNamed(b, "transcript", "store");
  return n !== null && !Object.hasOwn(TRANSCRIPT_READERS, n);
}

/** The names plugins have contributed right now — `derive.ts`'s `factProblems` checks a descriptor against them. */
export function contributedReaders(): { screen: ReadonlySet<string>; store: ReadonlySet<string> } {
  return { screen: new Set(SCREEN.keys()), store: new Set(STORE.keys()) };
}

function names(core: Readonly<Record<string, string>>, map: Map<string, unknown>): string[] {
  return [...Object.keys(core), ...map.keys()];
}
