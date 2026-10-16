/**
 * The router: one table, assembled from the three domain tables.
 *
 * Dispatch is a lookup rather than a `switch`, which is what makes the
 * cross-cutting rules declarable — see `types.ts` for why that mattered.
 * An unknown `t` is ignored on purpose: the wire is versioned
 * (`PROTOCOL_VERSION`) and a client one version ahead sending a message this
 * host has never heard of should be a no-op, not a thrown error that closes a
 * socket carrying ninety other message types that do work.
 */
import { roleAccepts, type ClientMessage, type SendStamp } from "@waterplane/shared";
import type { WebSocket } from "ws";
import type { HostCtx, OpVerdict, RouteArgs, RouteSpec, RouteTable } from "./types.js";
import { sessionRoutes } from "./session.js";
import { workRoutes } from "./work.js";
import { systemRoutes } from "./system.js";

export const ROUTES: RouteTable = { ...sessionRoutes, ...workRoutes, ...systemRoutes };

/** Every message type this host answers. Exported so a boot log and the e2e
 *  scripts can assert the table rather than reading a switch. */
export const HANDLED: readonly string[] = Object.keys(ROUTES);

/** Said when a client names a directory outside the root. Deliberately the same
 *  sentence everywhere it is not overridden — it describes the rule, not the
 *  feature that tripped it. */
const REFUSED = "that folder is outside the configured root";

type AnyArgs = RouteArgs<ClientMessage["t"]>;
type AnySpec = RouteSpec<ClientMessage["t"]>;

export function dispatch(c: HostCtx, ws: WebSocket, msg: ClientMessage): void {
  // Own keys only: `ROUTES` is a plain object, so `{"t":"__proto__"}` or
  // `"toString"` would otherwise resolve off its prototype and reach `spec.run`.
  if (!Object.hasOwn(ROUTES, msg.t)) return;
  const entry = ROUTES[msg.t] as ((a: AnyArgs) => void) | AnySpec | undefined;
  if (!entry) return;
  // A notify link says hello and pings, nothing else: never an attach, so it
  // can never count as somebody watching a session.
  if (!roleAccepts(c.wsRole.get(ws), msg.t)) return;
  const att = c.attached.get(ws)!;
  // A handler that declared no `contain` is handed no directory. The empty
  // string is not a path anything here would accept, so a handler reaching for
  // `dir` it never asked for fails loudly rather than acting on a plausible one.
  const base = { c, msg, ws, att, dir: "" } as AnyArgs;

  if (typeof entry === "function") { entry(base); return; }
  const spec = entry;

  const exec = async (): Promise<OpVerdict> => {
    let dir = "";
    if (spec.contain) {
      const named = (msg as unknown as Record<string, unknown>)[spec.contain];
      const resolved = await c.containRepoDir(named);
      if (!resolved) {
        c.send(ws, { t: "toast", text: spec.refusal ?? REFUSED });
        return { ok: false, reason: `${spec.contain} outside root` };
      }
      dir = resolved;
    }
    const r = spec.run({ ...base, dir });
    return (r ?? { ok: true }) as OpVerdict;
  };

  if (spec.durable) {
    c.durableOp(ws, (msg as { ackId?: string }).ackId, exec, msg as SendStamp);
    return;
  }
  void exec();
}

export type { HostCtx, Route, RouteSpec, RouteTable, OpVerdict, InputVerdict } from "./types.js";
