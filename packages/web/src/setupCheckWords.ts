/**
 * Every sentence the Setup check sheet draws that the shared findings words do not already say
 * (`@waterplane/shared` `findings/words.ts` owns the saving, backends, passed and not-checked
 * lines — this file only adds the sheet's own frame around them). Pure.
 */
import type { BillingProfile, EvidenceRoute, Finding, FindingScope, FindingSaving } from "@waterplane/shared";
import { BRAND, savingWords } from "@waterplane/shared";
export { clearRowWords, groupCountWords, groupUnreadWords } from "@waterplane/shared";

/** The scope chips' words. */
export const SCOPE_WORDS: Record<FindingScope | "all", string> = { all: "all repos", repo: "this repo", machine: "this machine", account: "account" };

export const SCOPE_EXPLAIN =
  "All repos: each rule that is open in a repo, once, with the repos it is open in. This repo: what its files and this repo's sessions cost. This machine: the desktop's own setup and its agents' habits across every repo. Account: the plan and usage. A machine or account finding is never listed under a repo.";

/** The saving line: the shared saving sentence, then how many sessions it rests on. Empty when none. */
export function savingLine(s: FindingSaving | undefined, profile?: BillingProfile): string {
  if (!s) return "";
  const base = savingWords(s, profile);
  if (!base) return "";
  const n = s.sessions;
  const r = s.repos;
  const rest = n ? ` · ${n} session${n === 1 ? "" : "s"}${r && r > 1 ? ` in ${r} repos` : ""}` : "";
  return `${base}${rest}`;
}

/** "waterplane install · 2" — the fold at the end of a group. */
export const installHead = (n: number): string => `${BRAND.displayName} install · ${n}`;
/** "waived · 1" — what was set aside on purpose; each row can be taken back. */
export const waivedHead = (n: number): string => `waived · ${n}`;
export const passedHead = (n: number): string => `checked, nothing to fix · ${n}`;
export const notCheckedHead = (n: number): string => `not checked · ${n}`;

/** The control on the evidence door: where the proof is. */
export function evidenceLabel(r: EvidenceRoute): string {
  switch (r.screen) {
    case "alwayson": return "always-on list";
    case "readings": return "repo readings";
    case "tokens": return "token stats";
    case "skills": return "skills & plugins";
    case "permissions": return "permission rules";
    case "context": return "that session";
    case "file": return "the file";
    default: return "the evidence"; // a route a newer host adds
  }
}

/** A door is drawn only for a screen that can land: the permissions door needs its extension switched on. */
export const doorOffered = (r: EvidenceRoute, permissionsOn = false): boolean => r.screen !== "permissions" || permissionsOn;

/** The "n of N" bar's sentence, against the unfiltered count. */
export const cutBarWords = (shown: number, all: number): string => `${shown} of ${all} shown — only what the badge counts`;

/** The line beside a write remedy: exactly what the tap will do. */
export function writePlanWords(plan: "append" | "replace" | "upToDate" | "refuse", target: string, lines: number, why?: string): string {
  if (plan === "append") return `append to ${target}, ${lines} lines`;
  if (plan === "replace") return `replace the older block in ${target} with the current ${lines} lines`;
  if (plan === "upToDate") return `${target} already has the current rules`;
  return why ?? `${target} is left as it is`;
}

/** Why a machine/account scope has nothing to show when nothing is known yet. */
export const PENDING_WORDS = "The first sweep of this desktop is still running. Open this again in a moment; nothing is checked yet.";

/** A source the host could not read this time, said once under the list. */
export const absentWords = (a: { what: string; why: string }): string => `Could not read ${a.what}: ${a.why}`;

export const NO_REPO_WORDS = "Pick a repo above to see its own findings; this machine and account are listed without one.";
export const REMEDY_NEEDS_REPO = "Open a session in a repo first: the agent needs a folder to work in.";

/** Re-exported so a row can word its weight without importing shared twice. */
export const weightWords = (f: Pick<Finding, "weight">): string => (f.weight === "finding" ? "counted in the repo's badge" : "advice, not counted in the badge");

// ---- all repos (ALL-REPOS.md §3) -------------------------------------------------------------

/** "in 7 of 33 repos", and where the rule could not run, "· not checked in 2". The count is a control. */
/** The bar over one rule's repos. */
/** A group's sentence as a clause after "where": no capital, no final stop ("The instruction file does not…" → "the instruction file does not…"). */
const asClause = (what: string): string => {
  const t = what.replace(/\.$/, "");
  return /^[A-Z][a-z]/.test(t) ? t[0]!.toLowerCase() + t.slice(1) : t;
};
export const repoCutWords = (shown: number, all: number, what: string): string => {
  const sentence = /\.$/.test(what);
  // Nothing narrowed: the group's own line (`in 30 of 30 repos`) already said how many, so the bar says only which rule this is.
  if (shown >= all) return sentence ? what : `the open ${what} finding`;
  return sentence ? `${shown} of ${all} repos · only repos where ${asClause(what)}` : `${shown} of ${all} repos · only repos with an open ${what} finding`;
};
/** A repo row's second line in a rule's list: its saving, else how many findings this rule holds there (only when more than one). */
export const repoRowWords = (saving: string, findings: number): string => saving || (findings > 1 ? `${findings} findings` : "");
/** The bar over a repo's own check cut to one rule. */
export const screenCutWords = (shown: number, all: number): string => `${shown} of ${all} findings shown — only the ones about this spend`;
export const ruleCutWords = (shown: number, all: number): string => `${shown} of ${all} findings · only this rule`;
export const clearHead = (n: number): string => `nothing open · ${n} repo${n === 1 ? "" : "s"}`;
export const unreadHead = (n: number): string => `not checked · ${n} repo${n === 1 ? "" : "s"}`;
export const hiddenReposWords = (n: number): string => `${n} hidden repo${n === 1 ? " is" : "s are"} not listed`;
export const ALL_EMPTY = (n: number): string => `Nothing to fix in any of the ${n} repo${n === 1 ? "" : "s"} checked.`;
export const allPendingWords = (done: number, total: number): string => `Checking every repo is still running: ${done} of ${total} repos checked so far. What is in so far is listed.`;
