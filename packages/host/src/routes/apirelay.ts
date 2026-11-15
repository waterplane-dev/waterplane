/**
 * `POST /api/relay` — one frame from the background relay (`server/bgrelay.ts`;
 * DTOs `shared/wire/messages/relay.ts`). Body `{frame, waitMs?}` →
 * 200 `{ack}` | 200 `{pending:true}` | 422 `{refused}`.
 *
 * Behind the same gates as every `/api/` route (`server/http.ts`: origin +
 * Host, the token gate). NOT on the passive allowlist (`passive.ts`
 * default-denies, so a kids' phone is refused 403 before this runs). POST
 * only: it types into a session; any other verb is 405 with nothing run.
 */
import { json, readJson } from "./apiio.js";
import { route, type ApiEntry } from "./apitable.js";

export const RELAY_ROUTES: readonly ApiEntry[] = [
  route("POST", "/api/relay", async ({ req, res }, ctx) => {
    if (!ctx.relay) { json(res, { refused: "the background relay is not running on this host" }, 503); return true; }
    const body = await readJson(req);
    const r = await ctx.relay(body);
    json(res, r.body, r.status);
    return true;
  }),
  route("*", "/api/relay", ({ res }) => {
    json(res, { error: "POST only" }, 405);
    return true;
  }),
];
