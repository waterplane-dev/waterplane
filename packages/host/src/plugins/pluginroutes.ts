/**
 * A plugin's own HTTP routes (`api.route`, plugin API 1.2): registration with
 * its refusals, and the runner `* /api/plugin/<id>/*` (`routes/apisystem.ts`)
 * hands a request to. Matched with the core's own `matchSegs`, so a plugin
 * pattern means exactly what a core one does. Served by `handleApi`, i.e.
 * behind the origin/Host gate and the token gate like every core route —
 * nothing here can widen either. docs/notes/plugins.md, the API table.
 */
import type { PluginHttpMethod, PluginHttpReply, PluginHttpRequest } from "@waterplane/shared";
import { matchSegs } from "../routes/apitable.js";

export interface PluginRoute {
  method: PluginHttpMethod;
  pattern: string;
  segs: readonly string[];
  fn: (req: PluginHttpRequest) => PluginHttpReply | Promise<PluginHttpReply>;
}

const METHODS: readonly string[] = ["GET", "POST", "PUT", "DELETE"];
/** A literal segment: URL-safe without encoding. */
const LITERAL = /^[A-Za-z0-9._~-]+$/;
const PARAM = /^:[a-z][a-zA-Z0-9]{0,31}$/;

/** Why `pattern` cannot be a plugin route, or null. */
export function pluginRouteProblem(method: unknown, pattern: unknown, taken: readonly PluginRoute[]): string | null {
  if (typeof method !== "string" || !METHODS.includes(method)) return `a plugin route answers ${METHODS.join(", ")}, not ${JSON.stringify(method ?? null)}`;
  if (typeof pattern !== "string" || !pattern) return "a plugin route needs a pattern, e.g. \"status\" or \"items/:id\"";
  const segs = pattern.split("/");
  const bad = segs.find((s, i) => !((LITERAL.test(s) && s !== "." && s !== "..") || PARAM.test(s) || (s === "*" && i === segs.length - 1)));
  if (bad !== undefined) return `route pattern ${JSON.stringify(pattern)}: ${JSON.stringify(bad)} is not a literal segment, a :name or a trailing *`;
  if (segs[0] === "hook" || segs[0] === "*" || segs[0]!.startsWith(":")) return `route pattern ${JSON.stringify(pattern)} must start with a literal other than "hook" (the hook sink's)`;
  if (taken.some((r) => r.method === method && r.pattern === pattern)) return `this plugin already serves ${method} ${pattern}`;
  return null;
}

export function makePluginRoute(method: PluginHttpMethod, pattern: string, fn: PluginRoute["fn"]): PluginRoute {
  return { method, pattern, segs: pattern.split("/"), fn };
}

/** The handler's answer, made safe to send: a real status, a JSON body. */
export function cleanReply(out: unknown): { status: number; body: unknown } {
  const r = (out ?? {}) as PluginHttpReply;
  const status = Number.isInteger(r.status) && r.status! >= 200 && r.status! <= 599 ? r.status! : 200;
  let body: unknown = r.body ?? {};
  try { if (JSON.stringify(body) === undefined) body = {}; } catch { body = {}; }
  return { status, body };
}

/** The first of `routes` answering `method` at `parts`, with its match — or null. */
export function findPluginRoute(routes: readonly PluginRoute[], method: string, parts: readonly string[]):
  { route: PluginRoute; params: Record<string, string>; rest: string[] } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = matchSegs(route.segs, parts);
    if (m) return { route, ...m };
  }
  return null;
}
