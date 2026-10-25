/**
 * The week-end burn's two routes (`weekburn.ts`): the status the sheet draws,
 * and the sheet's one write — the weekly pick, `recurring`, the stop line.
 *
 * Not on the passive allowlist (`passive.ts` default-denies): a kids' device
 * picks nothing. The write is POST (side effects never on GET); a refusal is
 * 409 with a sentence and changes nothing.
 */
import type { WeekBurnStatus } from "@waterplane/shared";
import { json, readJson } from "./apiio.js";
import { route, type ApiEntry } from "./apitable.js";

const unwired = { error: "the week-end burn is not running on this host" };

export const WEEKBURN_ROUTES: readonly ApiEntry[] = [
  route("GET", "/api/weekburn", ({ res }, ctx) => {
    if (!ctx.weekBurn) { json(res, unwired, 503); return true; }
    json(res, ctx.weekBurn.status() satisfies WeekBurnStatus);
    return true;
  }),
  // Body `{repos?: string[], recurring?: boolean, stopPct?: number, sameAsLast?: true}` → WeekBurnStatus.
  // Repos are checked against the discovered list (unknown dropped); a non-empty list binds the pick to
  // this week's reset, an empty one cancels this week (live rows finish).
  route("POST", "/api/weekburn", async ({ req, res }, ctx) => {
    if (!ctx.weekBurn) { json(res, unwired, 503); return true; }
    const body = await readJson(req, { optional: true });
    const r = await ctx.weekBurn.update(body && typeof body === "object" ? body : {});
    if ("error" in r) json(res, r, 409); else json(res, r.status);
    return true;
  }),
];
