import type { OutboxEntry } from "../outbox";
import type { ActivityAction, ActivityActionId } from "./activityTypes.ts";

// ── Small shared pieces ─────────────────────────────────────────────────────

/**
 * Enough to recognise which prompt this was, on a phone.
 *
 * The full words go in `fullText` and the sheet expands to them on a tap. What
 * is deliberately NOT done is what the give-ups ledger does — clip and throw
 * the rest away — because the whole complaint that produced this screen was
 * "I need details for these 39. What was it…".
 */
const TITLE_MAX = 260;

export const clip = (s: string): { title: string; clipped: boolean } => {
  const one = s.trim();
  return one.length > TITLE_MAX ? { title: `${one.slice(0, TITLE_MAX)}…`, clipped: true } : { title: one, clipped: false };
};

/**
 * The WORDS on a queue entry, wherever they happen to live.
 *
 * A `session.create` op carries its prompt inside the op and not in `text`, so
 * reading `e.text` renders the create's label where the person's sentence
 * should be. Exported because the queue bar in `App.tsx` now names the entries
 * it is counting, and two places printing an entry's words must not disagree
 * about which field holds them.
 */
/** The row key a queue entry gets, so a caller pointing this screen AT one of
 *  them (App's queue bar) names it the same way the selector does. */
export const queueRowKey = (ackId: string): string => `queue:${ackId}`;

/** The row key a durable intent gets. Same reason as `queueRowKey`: the
 *  launcher's "waiting here" chip counts intents and opens this screen ON the
 *  ones it counted, and a caller that spells the key itself is a caller that
 *  will spell it differently the day this changes. */
export const intentRowKey = (id: string): string => `intent:${id}`;

/**
 * Which failed row the recovery bar's *Restore* should put back — or null.
 *
 * **Not every failed row is text.** Ops were already excluded because their
 * `text` is a description ("open myapp · main"), and an UPLOAD's is the same kind
 * of thing: the label `file · 1000074239-….jpg`. Restoring one opened the send
 * sheet holding a filename as the message, ready to post the name of a picture
 * that had just failed to upload — which is the exact thing the person was
 * trying to recover FROM. A failed upload's recovery is re-attaching its bytes,
 * never re-sending its label.
 *
 * The newest is the one offered: a bad link tends to kill an upload and then the
 * prompt that names it, and the prompt is the row with the words in it.
 */
export function restorableFailed<T extends { status: string; mode?: string }>(entries: readonly T[]): T | null {
  const text = entries.filter((e) => e.status === "failed" && e.mode !== "op" && e.mode !== "upload");
  return text[text.length - 1] ?? null;
}

/** True when the only thing that failed is files — so *Restore* has nothing to
 *  put in a box, and the honest next step is the attachment's own button. */
export function onlyUploadsFailed<T extends { status: string; mode?: string }>(entries: readonly T[]): boolean {
  const failed = entries.filter((e) => e.status === "failed");
  return failed.length > 0 && failed.every((e) => e.mode === "upload");
}

export function entryProse(e: OutboxEntry): string {
  return e.mode === "op" && e.op?.t === "session.create"
    ? ((e.op as { prompt?: string }).prompt || e.text)
    : e.text;
}

export const act = (
  id: ActivityActionId,
  label: string,
  opts: { disabledReason?: string; danger?: boolean; primary?: boolean; alwaysShown?: boolean; note?: string; confirm?: string } = {},
): ActivityAction => {
  const { note, confirm, ...rest } = opts;
  // `note`/`confirm` only when they SAY something, so a row that has neither
  // keeps exactly the shape it always had.
  return { id, label, ...rest, ...(note ? { note } : {}), ...(confirm ? { confirm } : {}) };
};

/** `null` when there is no reason — so `act(..., { disabledReason: offline("send") })`
 *  is enabled the moment the link is up, with no second branch. */
export const needsLink = (online: boolean, what: string): string | undefined =>
  online ? undefined : `no connection — ${what} needs the desktop`;

export const baseName = (p: string): string => p.split("/").filter(Boolean).pop() || p;

/**
 * How long a recorded failure reason is still ADVICE.
 *
 * The host writes the reason at the moment the delivery fails, and most of its
 * sentences end in an errand: "open the session, clear whatever is blocking it,
 * and re-fire". That was true about one screen at one instant. The row keeps
 * the sentence for ever, which is correct — the stored reason is the historical
 * fact and nothing may edit it — but printing it unframed makes the row go on
 * issuing the instruction. On the phone that produced this screen the row still
 * saying it was twenty-eight days old and the session it named had not existed
 * for weeks, so the most common sentence in the list was an errand nobody could
 * run: worse than saying nothing, because it costs a trip to a session that is
 * gone before the person learns that is all it was.
 *
 * An hour, because what the reason describes is a screen. A session still alive
 * an hour later has moved on from whatever was blocking it, and one that is not
 * cannot be opened at all — either way the errand has expired, while a failure
 * from minutes ago is one a person can genuinely walk over and clear.
 */
const ADVICE_MS = 60 * 60 * 1000;

/**
 * A failure's own words, framed by whether they are still an instruction.
 *
 * Never rewritten, never trimmed: editing the stored reason would be this
 * screen deciding after the fact what the desktop had said, and the reason is
 * the only record of it. Past the window it is quoted and dated in words
 * instead, so an imperative inside it reads as something that was true then
 * rather than the next thing to go and do.
 */
export function recordedFailure(reason: string | undefined, at: number, now: number, fallback: string): string {
  const text = (reason ?? "").trim();
  if (!text) return fallback;
  if (now - at < ADVICE_MS) return text;
  return `recorded when this failed, about a session as it stood then — not something to act on now: “${text}”`;
}
