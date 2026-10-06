/**
 * `/api/onboard*` — the first-app job's HTTP side (`onboard.ts`; plan WP6). Reached through
 * `handleApi`, so the Origin/Host gate and the token gate in `server/http.ts` have already run.
 *
 *   GET  /api/onboard/plan?name=&path=android|web[&description=][&setup=0]
 *        read-only: the steps that apply on this desktop and the consent lines (what, where, size).
 *   GET  /api/onboard          the current (or last) job, for a phone that reconnects.
 *   POST /api/onboard          { answers, consent, confirm } — start; refused in words without the consent
 *                              the plan requires, or while a job runs.
 *   POST /api/onboard/resume   { consent?, confirm? } — carry on a stopped job (consent may only be added).
 *
 * Progress is pushed as `onboard.progress` over the one socket; these routes never wait on a step.
 *
 * Consent is the phone's, checked here (`confirmgate.ts`): the plan GET mints a one-shot `confirm`
 * bound to the path and the consent ids it listed, and a stopped job's GET mints one bound to that
 * job; a start, or a resume that ADDS consent, needs a browser `Origin` and that token.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { CLAUDE_SIGN_IN_FIX } from "./doctor.js";
import type { OnboardManager } from "./onboard.js";
import { ONBOARD_RESUME_SCOPE, ONBOARD_START_SCOPE, confirmGate, gateRefusal } from "./confirmgate.js";

export interface OnboardRouteDeps {
  onboard: OnboardManager | undefined;
  json(res: ServerResponse, data: unknown, status?: number): void;
  readJson(req: IncomingMessage): Promise<{ answers?: unknown; consent?: unknown; confirm?: unknown } | null>;
  /** Is claude signed in here (cached; null when unreadable). Absent ⇒ never asked. */
  signedIn?(): Promise<"in" | "out" | null>;
}

/** The consent ids a body ticks (anything but `true` is not consent). */
function ticked(consent: unknown): string[] {
  if (!consent || typeof consent !== "object") return [];
  return Object.entries(consent as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k);
}

function answersPath(answers: unknown): string {
  return answers && typeof answers === "object" ? String((answers as { path?: unknown }).path ?? "") : "";
}

export async function handleOnboardRoutes(req: IncomingMessage, res: ServerResponse, path: string, url: URL, d: OnboardRouteDeps): Promise<boolean> {
  if (path !== "/api/onboard" && !path.startsWith("/api/onboard/")) return false;
  const method = req.method ?? "GET";
  const ob = d.onboard;
  if (!ob) { d.json(res, { ok: false, error: "this host runs no onboarding job" }, 404); return true; }

  if (path === "/api/onboard/plan" && method === "GET") {
    const q = url.searchParams;
    const plan = ob.plan({
      name: q.get("name") ?? "",
      path: q.get("path") ?? "",
      description: q.get("description") ?? undefined,
      setup: q.get("setup") !== "0",
    });
    if (plan.ok && (await d.signedIn?.()) === "out") plan.signIn = `claude is not signed in on this desktop. ${CLAUDE_SIGN_IN_FIX}`;
    d.json(res, plan.ok ? { ...plan, confirm: confirmGate.mint(ONBOARD_START_SCOPE, plan.path, plan.consent.map((l) => l.id)) } : plan);
    return true;
  }
  if (path === "/api/onboard" && method === "GET") {
    const job = ob.current();
    d.json(res, { ok: true, job, ...(job?.state === "stopped" ? { confirm: confirmGate.mint(ONBOARD_RESUME_SCOPE, job.id) } : {}) });
    return true;
  }
  if (path === "/api/onboard" && method === "POST") {
    const body = await d.readJson(req);
    const why = gateRefusal(req, body?.confirm, ONBOARD_START_SCOPE, answersPath(body?.answers), ticked(body?.consent));
    if (why) { d.json(res, { ok: false, error: `${why} — nothing was started` }, 403); return true; }
    const r = ob.start(body?.answers, body?.consent);
    if (r.ok) confirmGate.consume(body?.confirm);
    if (r.ok) d.json(res, r);
    else d.json(res, { ok: false, error: r.error, ...(r.missing ? { missing: r.missing } : {}) }, r.status);
    return true;
  }
  if (path === "/api/onboard/resume" && method === "POST") {
    const body = await d.readJson(req);
    // A plain carry-on adds nothing; a resume that ADDS consent is a consent screen like the start.
    const adds = ticked(body?.consent);
    if (adds.length) {
      const why = gateRefusal(req, body?.confirm, ONBOARD_RESUME_SCOPE, ob.current()?.id ?? "");
      if (why) { d.json(res, { ok: false, error: `${why} — nothing was resumed` }, 403); return true; }
    }
    const r = ob.resume(body?.consent);
    if (r.ok && adds.length) confirmGate.consume(body?.confirm);
    if (r.ok) d.json(res, r);
    else d.json(res, { ok: false, error: r.error }, r.status);
    return true;
  }
  d.json(res, { ok: false, error: "GET /api/onboard[/plan], POST /api/onboard[/resume]" }, 405);
  return true;
}
