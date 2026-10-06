/**
 * The server-side half of "the second tap IS the consent" (first-app plan, "Review fixes").
 *
 * Three things this daemon can do on a person's behalf are consent, not convenience: accept
 * Google's Android SDK licence and download a toolchain (`android-toolchain`), make a signing key
 * (`signing-key`), write a repo's Claude settings (`auto-compact`) — the `CONFIRM_GATED_FIXES` —
 * and start or widen the first-app job (`POST /api/onboard`, `/resume` with consent). The phone
 * asks for them with a two-tap confirm or a consent screen; before this gate, the HOST took the
 * caller's word for it. Any Origin-less POST (curl, the `claude` agent this daemon spawns, a
 * plugin's script) could tick the box.
 *
 * The gate, per request:
 *   (a) an `Origin` header that passes `origin.ts` — every browser sends one on a POST, a script
 *       has to forge one on purpose; Origin-less is refused HERE (never by loosening origin.ts,
 *       which keeps allowing Origin-less everywhere else);
 *   (b) a one-shot token minted by the GET that DRAWS the confirm (the compliance report, the
 *       onboard plan, the stopped job), bound to what it confirms: the worktree + fix id, the
 *       onboard path + the consent ids that screen listed, or the job id.
 *
 * Honest about its reach: a process running as this user can run `sdkmanager` itself; nothing in
 * the daemon can stop that. What it stops is the accident — one documented POST from an agent or
 * a plugin that silently accepts a licence. Taking these paths now means a GET, reading a token,
 * and forging a browser header: a deliberate act, and the log says it happened.
 *
 * A token is consumed only when the action it gates was accepted, so a refusal for some other
 * reason (a job already running) leaves the screen's token usable; a used one never works twice.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { CONFIRM_GATED_FIXES, type ComplianceReport } from "@waterplane/shared";
import { originHeaderAllowed } from "./origin.js";

export const CONFIRM_TTL_MS = 15 * 60_000;
const MAX_LIVE = 64;

interface Entry { scope: string; bind: string; allowed: ReadonlySet<string> | null; expiresAt: number }

export interface ConfirmGate {
  mint(scope: string, bind: string, allowed?: Iterable<string>): string;
  /** Null = may proceed (call `consume` once the action was accepted); else the refusal. */
  check(token: unknown, scope: string, bind: string, asked?: Iterable<string>): string | null;
  consume(token: unknown): void;
  /** Tests. */
  size(): number;
}

export function createConfirmGate(now: () => number = Date.now): ConfirmGate {
  const live = new Map<string, Entry>();
  const sweep = () => {
    const t = now();
    for (const [k, e] of live) if (e.expiresAt <= t) live.delete(k);
    while (live.size > MAX_LIVE) live.delete(live.keys().next().value as string);
  };
  return {
    mint(scope, bind, allowed) {
      const token = randomBytes(16).toString("hex");
      live.set(token, { scope, bind, allowed: allowed ? new Set(allowed) : null, expiresAt: now() + CONFIRM_TTL_MS });
      sweep();
      return token;
    },
    check(token, scope, bind, asked) {
      sweep();
      if (typeof token !== "string" || !token) return "no confirm token — confirm it on the phone's screen";
      const e = live.get(token);
      if (!e) return "this confirm has expired or was already used — open the screen again";
      if (e.scope !== scope || e.bind !== bind) return "this confirm was for something else — open the screen again";
      if (e.allowed && asked) {
        const extra = [...asked].filter((a) => !e.allowed!.has(a));
        if (extra.length) return `not on the screen you confirmed: ${extra.join(", ")}`;
      }
      return null;
    },
    consume(token) { if (typeof token === "string") live.delete(token); },
    size() { sweep(); return live.size; },
  };
}

/** The one gate the routes share (process-wide, per host boot — a restart drops every token). */
export const confirmGate = createConfirmGate();

/** (a): a browser's POST. Null = has an allowed `Origin`; else the refusal. */
export function browserOriginRefusal(req: Pick<IncomingMessage, "headers">): string | null {
  const o = req.headers.origin;
  const origin = Array.isArray(o) ? o[0] : o;
  if (!origin || !origin.trim()) return "this needs the phone's confirm: a request with no Origin cannot give consent";
  if (!originHeaderAllowed(origin)) return "origin not allowed";
  return null;
}

/** (a) then (b) in one call. */
export function gateRefusal(req: Pick<IncomingMessage, "headers">, token: unknown, scope: string, bind: string, asked?: Iterable<string>, gate: ConfirmGate = confirmGate): string | null {
  return browserOriginRefusal(req) ?? gate.check(token, scope, bind, asked);
}

export const FIX_SCOPE = "fix";
export const ONBOARD_START_SCOPE = "onboard.start";
export const ONBOARD_RESUME_SCOPE = "onboard.resume";
export const fixBind = (worktree: string, fixId: string) => `${worktree}\0${fixId}`;

/** A report the phone will draw: one token per confirm-gated fix it offers, for that worktree. */
export function withFixConfirms<R extends ComplianceReport>(worktree: string, report: R, gate: ConfirmGate = confirmGate): R {
  const ids = [...new Set(report.checks.map((c) => c.fix).filter((f): f is string => !!f && CONFIRM_GATED_FIXES.includes(f)))];
  if (!ids.length) return report;
  return { ...report, confirm: Object.fromEntries(ids.map((id) => [id, gate.mint(FIX_SCOPE, fixBind(worktree, id))])) };
}

/**
 * `POST …/compliance/fix`: null when the list may run (consume the token after), else the
 * refusal and its status. A gated id runs ALONE — never inside a "Fix all" list.
 */
export function fixGateRefusal(req: Pick<IncomingMessage, "headers">, worktree: string, fixes: string[], token: unknown, gate: ConfirmGate = confirmGate): { error: string; status: number } | null {
  const gated = fixes.filter((f) => CONFIRM_GATED_FIXES.includes(f));
  if (!gated.length) return null;
  if (fixes.length > 1) return { status: 400, error: `${gated.join(", ")} needs its own confirm and is never part of a list — nothing was applied` };
  const why = gateRefusal(req, token, FIX_SCOPE, fixBind(worktree, gated[0]), undefined, gate);
  return why ? { status: 403, error: `${why} — nothing was applied` } : null;
}
