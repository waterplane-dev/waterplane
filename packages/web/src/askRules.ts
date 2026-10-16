/**
 * Ask rules on the phone — the pure half (docs/plans/agent-authority.md §2).
 *
 * The list lives on the DESKTOP (`GET/PUT /api/askrules`); the phone edits a copy and sends the
 * whole list back. Two surfaces read it: Settings › Sessions › *ask before* (the list, add,
 * remove, the suggested rules) and Repo readings (one on/off per rule for THIS repo, written as
 * `offIn` with the repo's `worktreePath`, kept in that spelling; the host's `rulesFor` resolves each
 * entry by realpath at launch, since a linked worktree's path is not always resolved).
 *
 * Nothing here applies anything: every function returns the NEXT list for a tap to send, and the
 * suggested rules are added only by the person's tap, exactly the missing ones.
 */
import { ASK_RULE_MAX_CHARS, ASK_RULES_MAX, askRuleId, cleanAskRule } from "@waterplane/shared";
import type { AskRule } from "@waterplane/shared";

/** The one line that is always true about the list, said near its top. */
export const ASK_RULES_TRUTH =
  "claude stops and asks you before a matching command — in sessions started after a change. Other backends take no rule.";

/** The receipt at the moment of a save: when it applies, and what it does not reach. */
export function savedReceipt(dropped = 0): string {
  const base = "Saved. claude sessions started from now on ask; a running session keeps the rules it launched with.";
  return dropped > 0 ? `${base} The desktop dropped ${dropped} it could not read.` : base;
}

/**
 * What the phone says when the desktop could not read its stored list at boot: it is running
 * with NO rules, which must not read as "no rules yet". Null when nothing was lost.
 */
export function lostWords(lost: { movedTo: string | null; error: string } | undefined): string | null {
  if (!lost) return null;
  const kept = lost.movedTo ? ` Its bytes were kept as ${lost.movedTo}.` : "";
  return `The desktop could not read its saved ask rules when it started (${lost.error}), so claude sessions since then ` +
    `ran with none.${kept} Add them again; the next save clears this.`;
}

/** Why a typed rule cannot be added, in words; null when it can. */
export function addRefusal(rules: readonly AskRule[], raw: string): string | null {
  const s = raw.trim();
  if (!s) return "Type a rule first, like Bash(git push * main).";
  if (s.length > ASK_RULE_MAX_CHARS) return `A rule is at most ${ASK_RULE_MAX_CHARS} characters.`;
  const rule = cleanAskRule(s);
  if (!rule) return "That is not a permission rule — write it as a tool and a pattern, like Bash(git push * main).";
  if (rules.some((r) => r.rule === rule)) return "That rule is already on the list.";
  if (rules.length >= ASK_RULES_MAX) return `The list holds at most ${ASK_RULES_MAX} rules — remove one first.`;
  return null;
}

/** The list with a typed rule appended; the same list when `addRefusal` would refuse it. */
export function withRule(rules: readonly AskRule[], raw: string): AskRule[] {
  if (addRefusal(rules, raw)) return [...rules];
  const rule = cleanAskRule(raw)!;
  return [...rules, { id: freeId(rules, rule), rule }];
}

function freeId(rules: readonly AskRule[], rule: string): string {
  const base = askRuleId(rule);
  let id = base;
  for (let n = 2; rules.some((r) => r.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** The suggested rules this list does not hold yet, in the suggested order. */
export function missingSuggested(rules: readonly AskRule[], suggested: readonly string[]): string[] {
  const have = new Set(rules.map((r) => r.rule));
  return suggested.filter((s) => !have.has(s));
}

/** The list plus exactly the missing suggested rules (up to the cap). */
export function withSuggested(rules: readonly AskRule[], suggested: readonly string[]): AskRule[] {
  let out = [...rules];
  for (const s of missingSuggested(rules, suggested)) {
    if (out.length >= ASK_RULES_MAX) break;
    out = withRule(out, s);
  }
  return out;
}

/** How many of the missing suggested rules one tap would actually add (the cap may cut it). */
export function suggestedAddable(rules: readonly AskRule[], suggested: readonly string[]): number {
  return withSuggested(rules, suggested).length - rules.length;
}

export function withoutRule(rules: readonly AskRule[], id: string): AskRule[] {
  return rules.filter((r) => r.id !== id);
}

/** Is this rule switched off in the repo at `path`? */
export function isOffIn(rule: AskRule, path: string): boolean {
  return !!rule.offIn?.includes(path);
}

/** The list with one rule switched off (or back on) in one repo. */
export function withOffIn(rules: readonly AskRule[], id: string, path: string, off: boolean): AskRule[] {
  return rules.map((r) => {
    if (r.id !== id) return r;
    const rest = (r.offIn ?? []).filter((p) => p !== path);
    const offIn = off ? [...rest, path] : rest;
    const { offIn: _drop, ...bare } = r;
    return offIn.length ? { ...bare, offIn } : bare;
  });
}

/** A repo path as a person reads it: the repo's name when the phone knows it, else the last segment. */
export function repoLabel(path: string, repos: readonly { worktreePath: string; repoName: string; branch?: string; isPrimary?: boolean }[]): string {
  const r = repos.find((x) => x.worktreePath === path);
  if (r) return r.isPrimary === false && r.branch ? `${r.repoName} (${r.branch})` : r.repoName;
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** The line under a rule in Settings: where it is off, or nothing when it is on everywhere. */
export function offInWords(rule: AskRule, repos: Parameters<typeof repoLabel>[1]): string | null {
  const off = rule.offIn ?? [];
  if (!off.length) return null;
  return `off in ${off.map((p) => repoLabel(p, repos)).join(", ")}`;
}

/** The per-repo summary line: how many of the rules ask in this repo. */
export function hereWords(rules: readonly AskRule[], path: string): string {
  if (!rules.length) return "No ask rules yet — Settings › Sessions › ask before adds them.";
  const off = rules.filter((r) => isOffIn(r, path)).length;
  if (!off) return `All ${rules.length} ask here.`;
  return `${rules.length - off} of ${rules.length} ask here; ${off} switched off in this repo.`;
}

/** The wire body for a PUT: what the phone shows, nothing more. */
export function putBody(rules: readonly AskRule[]): { rules: AskRule[] } {
  return { rules: rules.map((r) => (r.offIn?.length ? { id: r.id, rule: r.rule, offIn: [...r.offIn] } : { id: r.id, rule: r.rule })) };
}
