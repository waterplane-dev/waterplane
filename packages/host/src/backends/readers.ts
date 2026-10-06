/**
 * The screen/log readers a descriptor's `caps` may point at, by NAME
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
import type { PluginScreenReader, PluginStoreReader } from "@waterplane/shared";
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

/** The contributed screen reader a caps value names — null for core's, `false`, or a name that left. */
export function screenReaderFor(caps: { promptBoxes?: unknown }): PluginScreenReader | null {
  return typeof caps.promptBoxes === "string" ? SCREEN.get(caps.promptBoxes) ?? null : null;
}

/** The contributed store reader a caps value names — null for `claude-jsonl`, `none`, or a name that left. */
export function storeReaderFor(caps: { transcript?: unknown }): PluginStoreReader | null {
  return typeof caps.transcript === "string" ? STORE.get(caps.transcript) ?? null : null;
}

/** Does this caps value name a contributed store reader (whether or not it is registered right now)? */
export function namesStoreReader(caps: { transcript?: unknown }): boolean {
  const t = caps.transcript;
  return typeof t === "string" && t !== "none" && !Object.hasOwn(TRANSCRIPT_READERS, t);
}

function names(core: Readonly<Record<string, string>>, map: Map<string, unknown>): string[] {
  return [...Object.keys(core), ...map.keys()];
}

/** The sentence for a reader name this host does not have. */
function noReader(kind: string, name: string, list: string[]): string {
  return `no ${kind} reader called \`${name}\`; this host has: ${list.join(", ")}`;
}

/**
 * Every reader a caps object names that this host does not have, as sentences.
 * Empty ⇒ all named readers exist. Takes the caps loosely typed on purpose: a
 * plugin hands over a string the compiler never saw.
 */
export function readerProblems(caps: { promptBoxes?: unknown; transcript?: unknown }): string[] {
  const out: string[] = [];
  const pb = caps.promptBoxes;
  if (pb !== false && !(typeof pb === "string" && (Object.hasOwn(PROMPT_READERS, pb) || SCREEN.has(pb)))) {
    out.push(noReader("screen", String(pb), names(PROMPT_READERS, SCREEN)));
  }
  const tr = caps.transcript;
  if (tr !== "none" && !(typeof tr === "string" && (Object.hasOwn(TRANSCRIPT_READERS, tr) || STORE.has(tr)))) {
    out.push(noReader("transcript", String(tr), names(TRANSCRIPT_READERS, STORE)));
  }
  return out;
}
