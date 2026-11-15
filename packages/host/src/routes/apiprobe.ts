/**
 * The lookup probe's routes (R-metrics-071, `probe.ts`), relative to `/api/repos/:id/`.
 *
 * - `GET probe` — the pool at HEAD (or the sentence why none), the defaults, the live status and
 *   the source sentence. Reads git; spends nothing.
 * - `GET probe/results` — this desktop's stored results for the repo, newest first, each with its
 *   analysis. Reads a file.
 * - `POST probe/start` — the one route that spends: a POST (origin.ts: no GET changes state), the
 *   body's `accepted` is the estimate the person saw before the tap, refused in words unless it
 *   still covers the estimate. "Tap-started" is enforced HERE, not only by the phone's button
 *   (`confirmgate.ts`): the start needs a browser `Origin` and the one-shot `confirm` token the
 *   `GET probe` that drew the card minted for this worktree, consumed only when the run began —
 *   so a script or a driven session cannot start 200 questions with an `accepted` it wrote itself.
 *   Answers at once; the run is detached and read back via `GET probe`.
 *
 * None is on `passive.ts`'s allowlist (default-deny). Always 200 with `ok`: a refusal is an answer.
 */
import type { IncomingMessage } from "node:http";
import type { ProbeStartBody, ProbeView } from "@waterplane/shared";
import { hostStateDir } from "../branddirs.js";
import { confirmGate, gateRefusal, type ConfirmGate } from "../confirmgate.js";
import { probeRunner } from "../probe.js";
import { json, readJson } from "./apiio.js";
import { route, type ApiEntry, type RepoReq } from "./apitable.js";

export const PROBE_SCOPE = "probe.start";

/** The view the phone will draw: idle, it carries the token the start needs (a running view mints none — the poll would otherwise fill the gate). */
export function withProbeConfirm(wt: string, view: ProbeView, gate: ConfirmGate = confirmGate): ProbeView {
  if (view.status.state === "running") return view;
  return { ...view, confirm: gate.mint(PROBE_SCOPE, wt) };
}

/** The start's gate: null = may proceed (consume the token once the run began), else the refusal as a probe answer. */
export function probeStartRefusal(req: Pick<IncomingMessage, "headers">, wt: string, body: ProbeStartBody | null, gate: ConfirmGate = confirmGate): { ok: false; refused: string } | null {
  const why = gateRefusal(req, body?.confirm, PROBE_SCOPE, wt, undefined, gate);
  return why ? { ok: false, refused: `${why} — nothing ran` } : null;
}

export const PROBE_REPO_ROUTES: readonly ApiEntry<RepoReq>[] = [
  route<RepoReq>("GET", "probe", async ({ res, wt }, ctx) => {
    json(res, withProbeConfirm(wt, await probeRunner(hostStateDir(ctx.root)).view(wt)));
    return true;
  }),
  route<RepoReq>("GET", "probe/results", async ({ res, wt }, ctx) => {
    json(res, probeRunner(hostStateDir(ctx.root)).resultsView(wt));
    return true;
  }),
  route<RepoReq>("POST", "probe/start", async ({ req, res, wt }, ctx) => {
    const body = await readJson(req, { optional: true }) as ProbeStartBody | null;
    const refused = probeStartRefusal(req, wt, body);
    if (refused) { json(res, refused, 200); return true; }
    const ans = await probeRunner(hostStateDir(ctx.root)).start(wt, body);
    if (ans.ok) confirmGate.consume(body?.confirm);
    json(res, ans, 200);
    return true;
  }),
];
