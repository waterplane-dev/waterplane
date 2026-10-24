/**
 * Shape checks for what a 2.2 source slot answers (`backendsources.ts`: `mode`, `commands`,
 * `tokens.session`, `context.compactions`, `SourceContextSample.window`). Pure, here so the
 * host's consumers and the plugin testkit (`packages/plugin-testkit`, which imports shared's
 * dist) judge an answer by ONE rule. Each returns sentences — empty = the answer may be used;
 * a consumer that gets any drops the WHOLE answer to absent (absent beats wrong), never a
 * clamped or partly-kept one. `null` is always fine: it is "cannot say".
 */
import type { PermissionMode } from "./wire/session.js";

/** The most rows a `CommandSource.list` may answer; a longer list is refused whole. */
export const SOURCE_COMMANDS_MAX = 200;
/** The most compactions a `ContextSource.compactions` may answer; a longer list is refused whole. */
export const SOURCE_COMPACTIONS_MAX = 300;
/** A command name: a slash, then one word of at most 63 more characters (no space, no second slash first). */
export const SOURCE_COMMAND_NAME_RE = /^\/[^\s/][^\s]{0,62}$/;
/** The longest `description` / `args` a command row may carry. */
export const SOURCE_COMMAND_TEXT_MAX = 500;

const finiteNonNeg = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** `ModeSource.current()`: one of the descriptor's `caps.permissionModes`, or null. */
export function sourceModeProblem(m: unknown, modes: readonly PermissionMode[]): string | null {
  if (m === null) return null;
  if (typeof m !== "string") return `the mode must be one of the backend's permissionModes or null; got ${JSON.stringify(m)}`;
  if (!modes.includes(m as PermissionMode)) {
    return modes.length
      ? `the mode "${m}" is not one this backend declares; caps.permissionModes is: ${modes.join(", ")}`
      : `the mode "${m}" was answered, and this backend declares no permissionModes`;
  }
  return null;
}

/** `CommandSource.list()`: at most `SOURCE_COMMANDS_MAX` rows, `/`-prefixed unique names, strings and a boolean. */
export function sourceCommandsProblems(list: unknown): string[] {
  if (list === null) return [];
  if (!Array.isArray(list)) return ["the commands must be a list (or null for cannot say)"];
  if (list.length > SOURCE_COMMANDS_MAX) return [`${list.length} commands were listed; at most ${SOURCE_COMMANDS_MAX} are taken`];
  const out: string[] = [];
  const seen = new Set<string>();
  list.forEach((c: unknown, i) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) { out.push(`command ${i} is not an object`); return; }
    const o = c as Record<string, unknown>;
    if (typeof o.name !== "string" || !SOURCE_COMMAND_NAME_RE.test(o.name)) {
      out.push(`command ${i} is named ${JSON.stringify(o.name)}; a name is a slash and one word, like "/compact"`);
    } else if (seen.has(o.name)) out.push(`${o.name} is listed twice`);
    else seen.add(o.name);
    for (const k of ["description", "args"] as const) {
      if (o[k] === undefined) continue;
      if (typeof o[k] !== "string") out.push(`command ${i}'s ${k} is not text`);
      else if ((o[k] as string).length > SOURCE_COMMAND_TEXT_MAX) out.push(`command ${i}'s ${k} is over ${SOURCE_COMMAND_TEXT_MAX} characters`);
    }
    if (o.local !== undefined && typeof o.local !== "boolean") out.push(`command ${i}'s local is not true or false`);
  });
  return out;
}

/** `TokenSource.session()`: a stamp, then each stated figure finite and ≥ 0; `native` names its unit. */
export function sourceSpendProblems(s: unknown): string[] {
  if (s === null) return [];
  if (!s || typeof s !== "object" || Array.isArray(s)) return ["the session spend must be an object (or null for cannot say)"];
  const o = s as Record<string, unknown>;
  const out: string[] = [];
  if (!finiteNonNeg(o.at)) out.push("the session spend has no `at` (when it was read)");
  for (const k of ["tok", "agentTok", "usd", "agentUsd"] as const) {
    if (o[k] !== undefined && !finiteNonNeg(o[k])) out.push(`spend.${k} is ${JSON.stringify(o[k])}; a stated figure is a finite number ≥ 0, and an unknown one is left out`);
  }
  if (o.native !== undefined) {
    const n = o.native as Record<string, unknown> | null;
    if (!n || typeof n !== "object" || Array.isArray(n)) out.push("spend.native must be { amount, unit, agentAmount? }");
    else {
      if (!finiteNonNeg(n.amount)) out.push(`spend.native.amount is ${JSON.stringify(n.amount)}; it must be a finite number ≥ 0`);
      if (typeof n.unit !== "string" || !n.unit.trim()) out.push("spend.native.unit must name the unit (the backend's own word, never converted)");
      else if (/^\s*(usd|\$|dollars?)\s*$/i.test(n.unit)) out.push("spend.native is for a unit that is not dollars; dollars the CLI states go in `usd`");
      if (n.agentAmount !== undefined && !finiteNonNeg(n.agentAmount)) out.push(`spend.native.agentAmount is ${JSON.stringify(n.agentAmount)}; it must be a finite number ≥ 0`);
    }
  }
  return out;
}

/** `ContextSource.compactions()`: at most `SOURCE_COMPACTIONS_MAX`, oldest first, each stamped, stated fills finite and ≥ 0. */
export function sourceCompactionsProblems(list: unknown): string[] {
  if (list === null) return [];
  if (!Array.isArray(list)) return ["the compactions must be a list (or null for cannot say)"];
  if (list.length > SOURCE_COMPACTIONS_MAX) return [`${list.length} compactions were listed; at most ${SOURCE_COMPACTIONS_MAX} are taken`];
  const out: string[] = [];
  let last = -Infinity;
  list.forEach((c: unknown, i) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) { out.push(`compaction ${i} is not an object`); return; }
    const o = c as Record<string, unknown>;
    if (!finiteNonNeg(o.at)) { out.push(`compaction ${i} has no \`at\``); return; }
    if ((o.at as number) < last) out.push(`compaction ${i} is older than the one before it; the list is oldest first`);
    last = o.at as number;
    for (const k of ["preTok", "postTok"] as const) {
      if (o[k] !== undefined && !finiteNonNeg(o[k])) out.push(`compaction ${i}'s ${k} is ${JSON.stringify(o[k])}; a stated fill is a finite number ≥ 0`);
    }
    if (o.auto !== undefined && typeof o.auto !== "boolean") out.push(`compaction ${i}'s auto is not true or false`);
  });
  return out;
}

/** `ContextSource.sample()`: a stamp and a fill; `window`, when stated, a positive whole number. */
export function sourceContextSampleProblems(c: unknown): string[] {
  if (c === null) return [];
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["a context sample must be an object (or null for cannot say)"];
  const o = c as Record<string, unknown>;
  const out: string[] = [];
  if (!finiteNonNeg(o.at)) out.push("the context sample has no `at`");
  if (!finiteNonNeg(o.usedTok)) out.push(`usedTok is ${JSON.stringify(o.usedTok)}; it must be a finite number ≥ 0`);
  if (o.model !== undefined && typeof o.model !== "string") out.push("model is not text");
  if (o.window !== undefined && !(Number.isInteger(o.window) && (o.window as number) > 0)) {
    out.push(`window is ${JSON.stringify(o.window)}; a stated window is a whole number of tokens above 0, and an unknown one is left out`);
  }
  return out;
}
