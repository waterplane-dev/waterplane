/**
 * Small per-row words: a span of time, the typed label, the edit form's session options, and the way to the session a serial row waits behind.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogItem, SessionInfo } from "@waterplane/shared";
import { netStalledOf, sessionPickLabel, typedName, waitedSessionName } from "@waterplane/shared";

/**
 * A SPAN of time ("took 4m"), as opposed to `format.ts`'s `dur`, which takes an
 * instant and measures it against now. Kept here rather than added there
 * because it is the only caller and `dur`'s signature is load-bearing in eight
 * other files.
 */
export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * The label a person typed, when they typed one. `Backlog`'s add() fills `label`
 * with the first 40 characters of the text, so the overwhelming majority of
 * labels are a TRUNCATION, not a name — and rendering that truncation instead of
 * the text is why a row showed "For this and all other things that need" and
 * stopped mid-sentence. A label that is a prefix of its own text tells you
 * nothing the text does not.
 *
 * The COMPARISON is `@waterplane/shared`'s (`typedName`), not this file's: the schedule
 * card asks the same question of `ScheduleEntry.name` against its prompt, and
 * Activity asks it of `Intent.title` — three surfaces, one rule, because two
 * copies of it is how one screen titles a row by a fragment the other one hides.
 * Only the slice length differs, and it is the caller's fact: `add()` cuts at 40,
 * the host cuts at 120. The wrapper stays because eight call sites read as
 * `realLabel(it)` and a `BacklogItem` is what they have in hand.
 */
export function realLabel(it: BacklogItem): string | null {
  return typedName(it.label, it.text, 40);
}

/** The label on the option that clears the aim — a session of the row's own. */
export const NEW_SESSION_OPTION = "A new session (default)";
/**
 * …and the option that stands for a target that is no longer there.
 *
 * It names the state rather than the session, because the session is what this
 * app no longer has: it left the list, so there is no title to quote. Worded as
 * the group head and the row chip word it (*Aimed at a session that closed* /
 * *target closed — held*), so the three surfaces that say this say it once.
 */
export const CLOSED_TARGET_OPTION = "→ the session it was aimed at (closed)";
export interface EditTargetOption { value: string; label: string }
/**
 * **What the session picker in the backlog's edit form may offer — including
 * the target it cannot reach any more.**
 *
 * The picker used to be built from the live sessions alone and then fell back
 * to `""` whenever the row's target was not among them:
 *
 * ```ts
 * const val = sess.some((s) => s.id === editTarget) ? editTarget : "";
 * ```
 *
 * which drew *A new session (default)* over a row aimed at a session that had
 * closed while the field behind it still held the dead id. Picking the option
 * already selected fires no `onChange`, so `saveEdit`'s *changed fields only*
 * test found the target unchanged, sent no patch for it, and closed the editor:
 * **Save saved nothing, and said nothing.** That is the one row on this sheet
 * whose group head and whose two refusal notes (`runAgainClosedNote`,
 * `sessionBlocker`'s chip) all tell a person to *edit it to pick another
 * session, or take the aim off* — the exact move the form could not make.
 *
 * So the dead target is an OPTION, the way `RepoSelect`'s `keepValue` keeps a
 * repo that has gone: the select then shows what the row actually says, and
 * choosing *a new session* is a real change that a real patch follows. One
 * list, so the value shown and the value saved cannot disagree.
 *
 * With no live sessions and no target there is nothing to choose — a single
 * option is not a question — and the caller draws no select at all.
 */
export function editTargetOptions(
  sessions: readonly { id: string; title: string; tabTitle?: string }[],
  target: string,
): EditTargetOption[] {
  const out: EditTargetOption[] = [{ value: "", label: NEW_SESSION_OPTION }];
  // `sessionPickLabel`, not `s.title`: four sessions open in one repo made this
  // select four identical options, and the aim is the one thing this form
  // exists to change. One reader for every place a session is CHOSEN.
  for (const s of sessions) out.push({ value: s.id, label: `→ ${sessionPickLabel(s)}` });
  if (target && !sessions.some((s) => s.id === target)) out.push({ value: target, label: CLOSED_TARGET_OPTION });
  return out;
}

/**
 * The way to the session a `serial` row waits behind (`holderSessionId`), or
 * null — not waiting, an older host, or the session gone. Its work STALLED on
 * the API in `items` ⇒ that row (`itemId`). A question open in it reads *answer in 'x'* (the one thing that lets this row start), else
 * *open 'x'*; the name is `waitedSessionName`, the host sentence's own.
 */
export function holderOffer(
  it: Pick<BacklogItem, "status" | "holderSessionId">,
  sessions: readonly Pick<SessionInfo, "id" | "running" | "title" | "tabTitle" | "firstPrompt" | "prompt" | "awaitingInput" | "asking" | "netRetry">[],
  items: readonly Pick<BacklogItem, "id" | "status" | "sessionId">[] = [],
): { sessionId: string; label: string; title: string; itemId?: string; cut?: string } | null {
  const s = it.status === "queued" && it.holderSessionId ? sessions.find((x) => x.id === it.holderSessionId && x.running) : undefined;
  if (!s) return null;
  // A holder STALLED on the API (R-connection-024): the way on is THAT ROW (`netStalledOf`), an ids cut.
  const stalled = items.find((x) => x.sessionId === s.id && netStalledOf({ state: x.status, sessionId: x.sessionId }, [s]));
  if (stalled) return { sessionId: s.id, itemId: stalled.id, cut: "the stalled item this row waits behind", label: "show the stalled item", title: "this row waits behind an item stalled on the API — it starts once that one gets a reply or you settle it" };
  const raw = waitedSessionName(s) ?? "the session";
  const name = raw.length > 32 ? `${raw.slice(0, 31)}…` : raw;
  return s.awaitingInput || s.asking || (s.prompt && s.prompt.kind !== "trust")
    ? { sessionId: s.id, label: `answer in '${name}'`, title: "this row waits until that question is answered — open the session to answer it" }
    : { sessionId: s.id, label: `open '${name}'`, title: "the automatic session this row waits behind — it starts when that one is idle" };
}
