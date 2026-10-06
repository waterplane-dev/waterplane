/**
 * What a *Recently closed* row may say about the session it stands for.
 *
 * The row is persisted (`.waterplane/closed-sessions.json`) and broadcast whole on
 * every change, so every string on it is CLIPPED here (`CLOSED_TEXT_CAP`) — the
 * stack is bounded by count on the host and by size here. Every fact beyond
 * the original id/cwd/title/closedAt is optional and ABSENT means the host did
 * not know: an older row, a close no code path names. Never a guessed value.
 */
import type { ClosedSession, SessionOrigin, SessionOriginKind, ClosedBy } from "./wire/session.js";
import type { Intent } from "./intent.js";
import { ORIGIN_AGENT, ORIGIN_SCHEDULE_PREFIX, isFanoutRow } from "./intent.js";
import { itemHeadline } from "./naming.js";

/** Longest string a closed row carries in any one field. */
export const CLOSED_TEXT_CAP = 200;

/** One line, trimmed, at most `CLOSED_TEXT_CAP` chars (an ellipsis marks a
 *  cut); empty ⇒ `undefined`, so the field is absent rather than blank. */
export function clipClosedText(t: unknown, cap = CLOSED_TEXT_CAP): string | undefined {
  if (typeof t !== "string") return undefined;
  const one = t.replace(/\s+/g, " ").trim();
  if (!one) return undefined;
  return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
}

/**
 * How a session opened FOR an intent row should be described. The row's
 * `origin` says who posted it; the trigger says whether a clock fired it.
 */
export function sessionOriginOfIntent(i: Pick<Intent, "id" | "origin" | "trigger" | "label" | "headline" | "payload" | "groupId" | "title">): SessionOrigin {
  let kind: SessionOriginKind;
  if (isFanoutRow(i as Intent)) kind = "fanout";
  else if (i.origin === ORIGIN_AGENT) kind = "agent";
  else if (i.origin?.startsWith(ORIGIN_SCHEDULE_PREFIX) || i.trigger?.kind === "at") kind = "schedule";
  else kind = "backlog";
  const text = i.payload?.kind === "prompt" ? (i.payload.steps[0] ?? "") : "";
  const label = clipClosedText(itemHeadline({ label: i.label, text, headline: i.headline }) ?? i.title ?? text);
  return { kind, itemId: i.id, ...(label ? { itemLabel: label } : {}) };
}

/**
 * Was a session with this origin opened by MACHINERY for queued work — a
 * backlog item, a schedule, an agent's posted prompt, a fan-out target — or
 * reopened at a limit reset while working for one (`resurrect` carrying the
 * `itemId`)? `hand`, `fork`, a bare `resurrect` and no origin at all are a
 * person's. The intent ladder's serial rung reads this
 * (`SerialSessionState.automatic`): a hand session never holds a serial row.
 */
export function isAutomaticOrigin(o: Pick<SessionOrigin, "kind" | "itemId"> | undefined | null): boolean {
  if (!o) return false;
  if (o.kind === "resurrect") return !!o.itemId;
  return o.kind === "backlog" || o.kind === "schedule" || o.kind === "agent" || o.kind === "fanout";
}

/** The settled outcome of an item, for its closed row — and NOTHING for a row
 *  that has not settled, because "running" on a row that has closed is a
 *  sentence about the past that was never true of it. */
export function closedItemFacts(i: Pick<Intent, "state" | "result"> | undefined): Pick<ClosedSession, "itemState" | "itemOk" | "itemDetail"> {
  if (!i || (i.state !== "done" && i.state !== "failed" && i.state !== "canceled")) return {};
  const detail = clipClosedText(i.result?.detail);
  return {
    itemState: i.state,
    ...(typeof i.result?.ok === "boolean" ? { itemOk: i.result.ok } : {}),
    ...(detail ? { itemDetail: detail } : {}),
  };
}

const CLOSED_BY: ReadonlySet<string> = new Set<ClosedBy>(["you", "replaced", "auto-done", "auto-slot", "exited", "limit"]);
const KINDS: ReadonlySet<string> = new Set<SessionOriginKind>(["hand", "fork", "backlog", "schedule", "agent", "fanout", "resurrect"]);
const ITEM_STATES: ReadonlySet<string> = new Set(["done", "failed", "canceled"]);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * A row read back off disk (or the wire): the four required fields must be
 * there or the row is dropped (`null`); every optional one is kept only in its
 * own shape and clipped. An old row with none of the new fields comes back
 * exactly as it was.
 */
export function cleanClosedRow(raw: unknown): ClosedSession | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.cwd !== "string" || typeof r.title !== "string" || num(r.closedAt) === undefined) return null;
  const out: ClosedSession = { ...(r as unknown as ClosedSession) };
  const keep = <K extends keyof ClosedSession>(k: K, ok: boolean) => { if (!ok) delete out[k]; };
  keep("closedBy", typeof r.closedBy === "string" && CLOSED_BY.has(r.closedBy));
  keep("kind", typeof r.kind === "string" && KINDS.has(r.kind));
  keep("itemState", typeof r.itemState === "string" && ITEM_STATES.has(r.itemState));
  keep("itemOk", typeof r.itemOk === "boolean");
  for (const k of ["exitCode", "exitSignal", "openedAt", "lastActiveAt"] as const) keep(k, num(r[k]) !== undefined);
  // The per-turn AI summary is retired: a row an older build persisted still
  // carries one, and it is dropped here rather than carried on to the wire.
  delete (out as unknown as Record<string, unknown>).summary;
  keep("turns", num(r.turns) !== undefined && (r.turns as number) > 0);
  for (const k of ["resumedAs", "itemId", "itemLabel", "itemDetail", "fromSession", "firstPrompt", "lastPrompt", "tabTitle", "model", "unadopted"] as const) {
    if (r[k] === undefined) continue;
    const v = clipClosedText(r[k]);
    if (v === undefined) delete out[k]; else out[k] = v;
  }
  return out;
}
