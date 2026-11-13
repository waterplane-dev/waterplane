/**
 * The links extension's readers: pure functions over what `lsof`, `tailscale serve status --json`,
 * `gcloud run services list --format=json` and the Firebase Hosting API print. No I/O here, so the
 * tests feed them recorded output. A line or field that does not parse is skipped, never guessed.
 */
import type { FoundLink, LinkEnv } from "../shared/wire.mjs";

export interface Listener { pid: number; proc: string; addr: string; port: number }

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → one row per (pid, address). */
export function parseLsofListen(out: string): Listener[] {
  const rows: Listener[] = [];
  const seen = new Set<string>();
  let pid = 0, proc = "";
  for (const line of out.split("\n")) {
    const tag = line[0], v = line.slice(1);
    if (tag === "p") { pid = Number(v) || 0; proc = ""; }
    else if (tag === "c") proc = v.replace(/\\x20/g, " ");
    else if (tag === "n" && pid) {
      const m = /^(.*):(\d+)$/.exec(v);
      if (!m) continue;
      const addr = m[1]!.replace(/^\[|\]$/g, ""), port = Number(m[2]);
      const k = `${pid} ${addr} ${port}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ pid, proc, addr, port });
    }
  }
  return rows;
}

/** `lsof -a -d cwd -p <pids> -Fpn` → pid → working directory. */
export function parseLsofCwd(out: string): Map<number, string> {
  const m = new Map<number, string>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1)) || 0;
    else if (line[0] === "n" && pid) m.set(pid, line.slice(1));
  }
  return m;
}

/** A repo under the code root: its folder name (what core calls `repoName`) and where it is. A repo
 *  may sit one folder down (`~/dev/watch/watch-monorepo`), so the name is not the first segment. */
export interface RepoDir { name: string; path: string }

/** The repo a path is in: the deepest repo folder holding it, or null outside every one. */
export function repoOf(path: string, repos: readonly RepoDir[]): string | null {
  let best: RepoDir | null = null;
  for (const r of repos) {
    const p = r.path.replace(/\/+$/, "");
    if ((path === p || path.startsWith(p + "/")) && (!best || p.length > best.path.length)) best = { name: r.name, path: p };
  }
  return best?.name ?? null;
}

/** `tailscale serve status --json` → local port → the https front door that proxies to it. */
export function parseServeStatus(json: string): Map<number, string> {
  const m = new Map<number, string>();
  let d: unknown;
  try { d = JSON.parse(json); } catch { return m; }
  const web = (d as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> })?.Web;
  if (!web || typeof web !== "object") return m;
  for (const [hostPort, cfg] of Object.entries(web)) {
    const root = cfg?.Handlers?.["/"]?.Proxy;
    if (typeof root !== "string") continue;
    const target = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?$/.exec(root);
    const hp = /^([^:]+):(\d+)$/.exec(hostPort);
    if (!target || !hp) continue;
    const url = hp[2] === "443" ? `https://${hp[1]}` : `https://${hp[1]}:${hp[2]}`;
    const port = Number(target[1]);
    if (!m.has(port)) m.set(port, url);
  }
  return m;
}

/** The https ports a serve config already uses, so a suggestion does not collide. */
export function servePortsInUse(json: string): Set<number> {
  const s = new Set<number>();
  try {
    const tcp = (JSON.parse(json) as { TCP?: Record<string, unknown> })?.TCP;
    for (const k of Object.keys(tcp ?? {})) if (/^\d+$/.test(k)) s.add(Number(k));
  } catch { /* none */ }
  return s;
}

/** The first free front-door port from 8781 up. */
export function suggestServePort(used: Set<number>, from = 8781): number {
  let p = from;
  while (used.has(p)) p++;
  return p;
}

export const guessEnv = (name: string): LinkEnv => /(^|[^a-z0-9])(stg|staging|stage)([^a-z0-9]|$)/i.test(name) ? "staging" : "prod";

const isLoopback = (a: string) => a === "127.0.0.1" || a === "::1" || a === "localhost";
const isAny = (a: string) => a === "*" || a === "0.0.0.0" || a === "::";
const isTailnet = (a: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^fd7a:115c:a1e0:/i.test(a);

/** Ports at or above this are an OS-picked port: an IDE's helper, a dev server's HMR socket. */
export const EPHEMERAL_FROM = 32768;

/** Processes that listen in a repo but never serve a page: emulators, adb, VM helpers, databases. */
export const NOT_WEB_RE = /^(adb|qemu-system|netsimd|emulator|OrbStack|com\.docker|Docker|postgres|redis-server|mongod|mysqld)/i;

export interface LocalInputs {
  listeners: Listener[];
  cwd: Map<number, string>;
  repos: readonly RepoDir[];
  serve: Map<number, string>;
  servePorts: Set<number>;
  tailnetIp: string | null;
  tailscale: string;
  selfPid: number;
}

/**
 * Listening ports whose process works inside a repo under the code root, one row per port.
 * The phone URL is the serve front door if there is one, else the tailnet address when the port is
 * bound to it (or to every interface), else none — with the serve command that would make one.
 */
export function localFound(i: LocalInputs): FoundLink[] {
  const byPort = new Map<number, { l: Listener; addrs: Set<string>; repo: string }>();
  for (const l of i.listeners) {
    if (l.pid === i.selfPid) continue;
    const dir = i.cwd.get(l.pid);
    const repo = dir ? repoOf(dir, i.repos) : null;
    if (!repo) continue;
    const cur = byPort.get(l.port);
    if (cur) cur.addrs.add(l.addr);
    else byPort.set(l.port, { l, addrs: new Set([l.addr]), repo });
  }
  const used = new Set(i.servePorts);
  const rows: FoundLink[] = [];
  for (const [port, { l, addrs, repo }] of [...byPort].sort((a, b) => a[0] - b[0])) {
    const served = i.serve.get(port);
    const reach = [...addrs].some((a) => isAny(a) || isTailnet(a));
    const url = served ?? (reach && i.tailnetIp ? `http://${i.tailnetIp}:${port}` : null);
    const notWeb = NOT_WEB_RE.test(l.proc);
    const hidden = notWeb || port >= EPHEMERAL_FROM;
    const row: FoundLink = { key: `local:${port}`, kind: "local", repo, label: `${l.proc} :${port}`, url, port, proc: l.proc, env: "dev", hidden };
    if (notWeb) row.note = "an emulator, VM helper or database — not a page";
    else if (hidden) row.note = "an OS-picked port — usually a helper socket, not a page";
    if (!url && !hidden && [...addrs].every(isLoopback)) {
      const front = suggestServePort(used);
      used.add(front);
      row.serveCmd = `${i.tailscale} serve --bg --https=${front} http://127.0.0.1:${port}`;
      row.note = row.note ?? "listens on this desktop only — the phone cannot reach it until it has a front door";
    }
    rows.push(row);
  }
  return rows;
}

interface RunService {
  metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  status?: { url?: string };
}

/** `gcloud run services list --format=json` for one project → found rows (repo filled in later). */
export function parseRunServices(json: string, project: string): FoundLink[] {
  let d: unknown;
  try { d = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(d)) return [];
  const rows: FoundLink[] = [];
  for (const s of d as RunService[]) {
    const name = s?.metadata?.name, url = s?.status?.url;
    if (typeof name !== "string" || typeof url !== "string" || !/^https:\/\//.test(url)) continue;
    const labels = s.metadata?.labels ?? {}, ann = s.metadata?.annotations ?? {};
    const fn = labels["goog-managed-by"] === "cloudfunctions";
    const ingress = ann["run.googleapis.com/ingress"];
    const internal = ingress === "internal" || ingress === "internal-and-cloud-load-balancing";
    const row: FoundLink = {
      key: `run:${project}/${name}`, kind: fn ? "function" : "cloudrun", repo: null, label: name, url, project,
      env: guessEnv(`${name} ${project}`), hidden: fn || internal,
    };
    if (fn) row.note = "a Cloud Function — an endpoint, usually not a page";
    else if (internal) row.note = "internal ingress — not reachable from the internet";
    rows.push(row);
  }
  return rows;
}

/** Firebase Hosting `GET v1beta1/projects/<p>/sites` → one row per site. */
export function parseHostingSites(json: string, project: string): FoundLink[] {
  let d: unknown;
  try { d = JSON.parse(json); } catch { return []; }
  const sites = (d as { sites?: { name?: string; defaultUrl?: string }[] })?.sites;
  if (!Array.isArray(sites)) return [];
  const rows: FoundLink[] = [];
  for (const s of sites) {
    const id = typeof s?.name === "string" ? s.name.split("/").pop() : null;
    if (!id || typeof s.defaultUrl !== "string" || !/^https:\/\//.test(s.defaultUrl)) continue;
    rows.push({ key: `fb:${id}`, kind: "firebase", repo: null, label: id, url: s.defaultUrl, project, env: guessEnv(`${id} ${project}`), hidden: false });
  }
  return rows;
}

/**
 * `git grep -I -o -h -F -e <id1> -e <id2> …` per repo → id → repo with the most mentions. Used for
 * project ids and for Firebase site ids alike.
 * A tie between repos is left unassigned (null): a wrong repo is worse than none.
 */
export function assignProjects(hits: Map<string, string>, projects: readonly string[]): Map<string, string | null> {
  const counts = new Map<string, Map<string, number>>();
  for (const [repo, out] of hits) {
    for (const line of out.split("\n")) {
      const p = line.trim();
      if (!projects.includes(p)) continue;
      const m = counts.get(p) ?? new Map<string, number>();
      m.set(repo, (m.get(repo) ?? 0) + 1);
      counts.set(p, m);
    }
  }
  const out = new Map<string, string | null>();
  for (const p of projects) {
    const m = [...(counts.get(p) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]);
    out.set(p, m.length === 0 || (m.length > 1 && m[0]![1] === m[1]![1]) ? null : m[0]![0]);
  }
  return out;
}
