/** Which model a send's new session starts on — the *model* row's words and the target edits. Split from `sendLabels.ts` (docs/notes/send-architecture.md); pure, no React. */
import { type LaunchOpts } from "@waterplane/shared";
import { type SendTarget } from "./sendTypes.ts";

/** The launch a send's target carries — only the two that OPEN sessions have one. */
export const launchOfTarget = (t: SendTarget): LaunchOpts | undefined =>
  t.kind === "repo" || t.kind === "repos" ? t.launch : undefined;

/** The target with its launch set or (null/undefined) removed — `withBudget`'s
 *  shape: a target that opens no session is returned untouched, and no
 *  `launch: undefined` key is left behind. */
export function withLaunch(t: SendTarget, l: LaunchOpts | null | undefined): SendTarget {
  if (t.kind !== "repo" && t.kind !== "repos") return t;
  const { launch: _drop, ...rest } = t;
  void _drop;
  return (l ? { ...rest, launch: l } : rest) as SendTarget;
}

/** Back on the new-session defaults. */
export const withoutLaunch = (t: SendTarget): SendTarget => withLaunch(t, null);

/**
 * **What a chosen launch is CALLED**, on the chip, the *To* row and the button:
 * the backend only when it is not claude (a claude launch never named its
 * binary), the model or *the default model*, the effort only where one was
 * picked. Absent is the sentence the row opens on — *new-session defaults* —
 * which is what not tapping it means.
 */
export function launchWords(l: LaunchOpts | undefined): string {
  if (!l || (!l.model && !l.effort && !l.backend)) return "new-session defaults";
  const head = l.backend && l.backend !== "claude" ? `${l.backend} · ` : "";
  return `${head}${l.model || "the default model"}${l.effort ? ` · ${l.effort}` : ""}`;
}

/** The `, model …` clause the *To* row and the button append — nothing at all
 *  for a target on the defaults, so an untouched send reads as it always did. */
export const launchClause = (l: LaunchOpts | undefined): string =>
  l && (l.model || l.effort || l.backend) ? `, ${launchWords(l)}` : "";
