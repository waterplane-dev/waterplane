// The bind decision, pure: which addresses the daemon listens on (R-security-002).
// The daemon spawns `claude` and has no app-level auth, so without the explicit
// opt-in it only ever binds loopback and the Tailscale IP.
export interface BindPlanInput {
  /** The explicit HOST knob, if any — it replaces the default list. */
  hostEnv?: string | undefined;
  /** Tailscale IP, if found. */
  ip?: string | null | undefined;
  /** WATERPLANE_ALLOW_PUBLIC=1. */
  allowPublic: boolean;
  /** LAN IPs added to the default list (already empty without the opt-in). */
  lanIps: readonly string[];
}

export function planBinds(i: BindPlanInput): { binds: string[]; refused: string[] } {
  const { hostEnv, ip, allowPublic } = i;
  const wanted = hostEnv
    ? [hostEnv]
    : [...new Set([ip, "127.0.0.1", ...i.lanIps].filter(Boolean) as string[])];
  const isSafeBind = (a: string) =>
    allowPublic || a === "127.0.0.1" || a === "::1" || a === "localhost" || (!!ip && a === ip);
  const refused = wanted.filter((a) => !isSafeBind(a));
  let binds = refused.length ? wanted.filter(isSafeBind) : wanted;
  if (binds.length === 0) binds = ["127.0.0.1"];
  return { binds, refused };
}
