/**
 * Dictation setup (`dictatesetup.ts`): POST starts ONE job on a person's tap,
 * GET reads it. Not on the passive allowlist (`passive.ts` default-denies): a
 * kids' device installs nothing. Side-effecting ⇒ POST only; a refusal is a 409
 * with a sentence and starts nothing.
 */
import { json, readBody } from "./apiio.js";
import { route, type ApiEntry } from "./apitable.js";
import { dictateSetupState, startDictateSetup } from "../dictatesetup.js";

export const DICTATE_ROUTES: readonly ApiEntry[] = [
  route("GET", "/api/host/dictate/setup", async ({ res }) => {
    json(res, dictateSetupState());
    return true;
  }),
  // Body `{model: id}` → 202 `{ok:true}`, or 409 `{ok:false, error}`.
  route("POST", "/api/host/dictate/setup", async ({ req, res }) => {
    let body: { model?: unknown } | null = {};
    try { body = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}"); } catch { /* refused below */ }
    const r = startDictateSetup(body?.model);
    json(res, r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 202 : 409);
    return true;
  }),
];
