/**
 * HTTP JSON/file API — the FRAME. Returns true if the request was handled here.
 *
 * The HTTP twin of `routes/index.ts`: the CORS reflection, the preflight
 * answer, and dispatch over the one ordered table in `routes/apiroutes.ts`,
 * assembled from the domain tables in `routes/api*.ts` (host-architecture.md,
 * "api.ts — the HTTP routes as tables"). The origin/Host gate,
 * `OPAQUE_READ_ROUTES` and the token gate run BEFORE this, in
 * `server/http.ts` — no table re-checks or widens them.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { corsHeaders } from "./origin.js";
import { answerBadBody, json } from "./routes/apiio.js";
import { dispatchApi, type ApiCtx } from "./routes/apitable.js";
import { API_ROUTES } from "./routes/apiroutes.js";

/**
 * The answer to a CORS preflight on `/api/*`. `server/http.ts` calls it AHEAD of
 * the token gate (a preflight never carries credentials), and `handleApi` for
 * any that reach it. Headers only; the caller's origin was already checked.
 */
export function answerPreflight(req: IncomingMessage, res: ServerResponse): void {
  for (const [k, v] of Object.entries(corsHeaders(req.headers))) res.setHeader(k, v);
  res.writeHead(204, {
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    // EVERY custom header the client can send on an /api call has to be named
    // here, or the browser fails the preflight and the real request is never
    // made. That failure is invisible from the host — nothing arrives, nothing
    // is logged — and on the client it surfaces as a bare transport error,
    // which the send queue reads as "the link is down" and retries forever.
    //
    // `x-dedupe` is the one that was missing, and it is on EVERY queued image
    // upload (files.ts uses it to answer a re-send with the file already on
    // disk instead of writing a second copy). So in the Android shell — the
    // only cross-origin client, `http://localhost` → `http://100.x:8770` — no
    // attached image could ever reach the inbox, while its queue entry
    // hammered the POST on the lane-release timer and held the lane, so the
    // prompts queued behind it never went out either.
    //
    // `range` / `if-range` / `if-none-match` are auto-download's resume
    // (web/pull.ts) and the conditional GETs in httpio.ts. `authorization`
    // is the Android shell's device token (`Bearer`, auth.ts) over LAN.
    "access-control-allow-headers": "Content-Type,Authorization,X-File-Name,X-Dedupe,Range,If-Range,If-None-Match",
    // A preflight per upload chunk on a DERP-relayed path is a round trip we
    // can just not spend.
    "access-control-max-age": "600",
  });
  res.end();
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, ctx: ApiCtx): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (!path.startsWith("/api/")) return false;

  // CORS, set once for every reply below (writeHead merges with setHeader).
  // Reflects the caller's origin only when it is one we serve on — the app is
  // same-origin and needs none of this; the old blanket `*` let any web page
  // read the API. Callers that fail the check never reach here (main.ts gates).
  for (const [k, v] of Object.entries(corsHeaders(req.headers))) res.setHeader(k, v);

  if (method === "OPTIONS") { answerPreflight(req, res); return true; }

  // Every route, first match wins (`routes/apitable.ts`); none ⇒ the 404 it always was. A body that is not the JSON its route reads (`readJson` → `BadBody`) is answered HERE, once, in words — never a 500.
  if (await dispatchApi(API_ROUTES, { req, res, url, path, method }, path.split("/"), ctx).catch((err: unknown) => { if (answerBadBody(res, err)) return true; throw err; })) return true;

  json(res, { error: "not found" }, 404);
  return true;
}
