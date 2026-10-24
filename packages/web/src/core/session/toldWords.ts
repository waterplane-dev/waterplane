/**
 * "This agent was not told about the outbox" — the one notice a session whose backend could not
 * be handed the core's instructions (`SessionInfo.told === "none"`: opencode today, any plugin
 * whose CLI has no route for them) gets, ONCE PER BACKEND on this phone.
 *
 * Once, because it is a fact about the backend, not about this session: a strip on every
 * opencode tab would be the same sentence for ever. And said with the way back (the ux skill:
 * anything that goes away by itself names where it returns): the dismissed notice leaves one
 * small icon beside the title, whose tap reads it again. Absent `told` (an older host, or a
 * session from before the field) is NOT "none" — it says nothing, never a guess.
 */
import { LS, lsJson, lsSetJson } from "../../storage.ts";

/** The backend ids this phone has already shown the notice for. Bounded on write. */
const SEEN_MAX = 32;

export const toldSeen = (): string[] => {
  const v = lsJson<unknown>(LS.toldNoticed, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

/** Is the notice owed: told nothing, and not yet shown for this backend here? Pure. */
export function toldNoticeDue(told: string | undefined, backendId: string, seen: readonly string[], kind?: "shell"): boolean {
  return notTold(told, kind) && !seen.includes(backendId);
}

/** Does the session carry the "not told" mark at all (owed or dismissed)? The ONE predicate the
 *  notice and its way-back icon both key off. A SHELL (`BackendInfo.kind`) never does: it runs no
 *  agent, so "was not told about the outbox" would be a wrong why on every shell tab (review R5). */
export const notTold = (told: string | undefined, kind?: "shell"): boolean => told === "none" && kind !== "shell";

export function markToldSeen(backendId: string): void {
  const seen = toldSeen().filter((b) => b !== backendId);
  lsSetJson(LS.toldNoticed, [...seen, backendId].slice(-SEEN_MAX));
}

/** The notice's words, naming the backend and the folder as the agent must write it. */
export const toldText = (label: string): string =>
  `${label} was not told about the outbox, so it may not know that what you should see goes in .claude/outbox/ — say so in your prompt when you want a file here.`;

/** The receipt on dismissal: where it comes back. */
export const toldGoneText = (label: string): string =>
  `Shown once for ${label} on this phone — the crossed-out speech icon beside the title brings it back.`;

/**
 * "Your ask-before rules are not enforced here" — `SessionInfo.askRulesVia === "none"`, said once
 * per backend with the same way back as the outbox notice (it shares `toldNoticed`, keyed
 * `askrules:<id>`). `"native"` (the CLI holds them) and `"gate"` (the host's gate does) are
 * enforced and say nothing; absent (an older host) is never a guess. A shell runs no agent.
 */
export const askRulesNone = (via: string | undefined, kind?: "shell"): boolean => via === "none" && kind !== "shell";
export const askRulesKey = (backendId: string): string => `askrules:${backendId}`;
export const askRulesDue = (via: string | undefined, backendId: string, seen: readonly string[], kind?: "shell"): boolean =>
  askRulesNone(via, kind) && !seen.includes(askRulesKey(backendId));
export const askRulesText = (label: string): string =>
  `Ask-before rules are not enforced in a ${label} session: neither the CLI nor this app's gate can make it stop and ask, so a command your rules would hold back can run without a tap.`;
export const askRulesGoneText = (label: string): string =>
  `Shown once for ${label} on this phone — the shield-with-question-mark icon beside the title brings it back.`;
export function markAskRulesSeen(backendId: string): void {
  const seen = toldSeen().filter((b) => b !== askRulesKey(backendId));
  lsSetJson(LS.toldNoticed, [...seen, askRulesKey(backendId)].slice(-SEEN_MAX));
}
