/**
 * The links engine: the two discoveries (local — fast; cloud — slow, cached), the probes, and the
 * pin edits. State lives in memory with its times; the pins are re-read from disk on every answer,
 * so a hand edit of `links.json` shows on the next open without a restart.
 *
 * Nothing runs until the phone asks — no poller. A discovery already running is joined, not doubled.
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CLOUD_FRESH_MS, LOCAL_FRESH_MS, PIN_ID_RE, isHttpUrl,
  type FoundLink, type LinkEnv, type LinksState, type PinnedLink, type PinnedView, type Probe,
} from "../shared/wire.mjs";
import {
  assignProjects, localFound, parseHostingSites, parseLsofCwd, parseLsofListen, parseRunServices, parseServeStatus, servePortsInUse,
} from "./parse.mjs";
import { pool, type Runner } from "./run.mjs";
import type { RepoDir } from "./parse.mjs";
import { REPO_RE, cleanLabel, isEnv, loadPins, savePins } from "./store.mjs";

export interface Roots {
  root: string;
  file: string;
  lsofBin: string;
  tailscaleBin: string | null;
  gcloudBin: string | null;
  gitBin: string;
  run: Runner;
  fetch: typeof fetch;
  now: () => number;
  selfPid: number;
  probeTimeoutMs: number;
}

const quoteBin = (b: string) => (/\s/.test(b) ? `"${b}"` : b);
const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

export interface Engine {
  state(): Promise<LinksState>;
  discover(o: { cloud?: boolean }): Promise<LinksState>;
  probe(): Promise<LinksState>;
  pin(key: string): Promise<LinksState>;
  add(a: { label: unknown; url: unknown; repo?: unknown; env?: unknown }): Promise<LinksState>;
  edit(a: { id: unknown; label?: unknown; env?: unknown; repo?: unknown }): Promise<LinksState>;
  unpin(id: unknown): Promise<LinksState>;
  /** Settles when every discovery started so far has finished (tests). */
  idle(): Promise<void>;
}

export function createEngine(r: Roots, changed: () => void): Engine {
  let local: FoundLink[] = [], cloud: FoundLink[] = [];
  let serve = new Map<number, string>();
  let localAt: number | null = null, cloudAt: number | null = null;
  let localRun: Promise<void> | null = null, cloudRun: Promise<void> | null = null;
  let localNotes: string[] = [], cloudNotes: string[] = [];
  const probes = new Map<string, Probe>();
  let writeChain: Promise<unknown> = Promise.resolve();

  async function discoverLocal(): Promise<void> {
    const notes: string[] = [];
    const ls = await r.run(r.lsofBin, ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeoutMs: 15_000 });
    if (ls.timedOut || (ls.code !== 0 && !ls.stdout)) notes.push(`lsof did not list the listening ports${ls.timedOut ? " within 15 s" : ls.error ? ` (${ls.error})` : ""}.`);
    const listeners = parseLsofListen(ls.stdout);
    const pids = [...new Set(listeners.map((l) => l.pid))].filter((p) => p !== r.selfPid);
    const cwdOut = pids.length ? await r.run(r.lsofBin, ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { timeoutMs: 15_000 }) : null;
    let serveJson = "", tailnetIp: string | null = null;
    if (r.tailscaleBin) {
      const [s, ip] = await Promise.all([
        r.run(r.tailscaleBin, ["serve", "status", "--json"], { timeoutMs: 10_000 }),
        r.run(r.tailscaleBin, ["ip", "-4"], { timeoutMs: 10_000 }),
      ]);
      serveJson = s.stdout;
      if (s.code !== 0) notes.push(`tailscale serve status did not answer${s.error ? ` (${s.error})` : ""} — front doors are not known.`);
      tailnetIp = /^100\.\d+\.\d+\.\d+$/.test(firstLine(ip.stdout)) ? firstLine(ip.stdout) : null;
    } else notes.push("No tailscale command on this desktop — the phone URLs of local ports are not known.");
    serve = parseServeStatus(serveJson);
    local = localFound({
      listeners, cwd: parseLsofCwd(cwdOut?.stdout ?? ""), repos: await repoDirs(), serve, servePorts: servePortsInUse(serveJson),
      tailnetIp, tailscale: quoteBin(r.tailscaleBin ?? "tailscale"), selfPid: r.selfPid,
    });
    localNotes = notes;
    localAt = r.now();
  }

  /** Repos under the code root, and one folder down when a folder is not a repo itself
   *  (`watch/watch-monorepo`) — the same repos core lists, by the same folder name. */
  async function repoDirs(): Promise<RepoDir[]> {
    const out: RepoDir[] = [];
    const isRepo = async (p: string) => { try { await stat(join(p, ".git")); return true; } catch { return false; } };
    const kids = async (p: string) => { try { return (await readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".") && REPO_RE.test(d.name)).map((d) => d.name); } catch { return []; } };
    for (const n of await kids(r.root)) {
      const p = join(r.root, n);
      if (await isRepo(p)) { out.push({ name: n, path: p }); continue; }
      for (const m of await kids(p)) if (await isRepo(join(p, m))) out.push({ name: m, path: join(p, m) });
    }
    // Two repos with one folder name would be one chip; the first keeps it, the other is left out.
    return out.filter((d, i) => out.findIndex((o) => o.name === d.name) === i);
  }

  /**
   * Who owns each cloud row. A project goes to the repo whose `.firebaserc` names it, else the one
   * that mentions it most. A Firebase site that is NOT the project's default site goes to the repo
   * that mentions the site id most — one project often hosts many apps, and the repo naming the
   * project is not the one that deploys every site in it. No mention, no repo: a wrong repo is worse.
   */
  async function cloudRepos(projects: string[], sites: string[]): Promise<{ byProject: Map<string, string | null>; bySite: Map<string, string | null> }> {
    const repos = await repoDirs();
    const exact = new Map<string, string>();
    for (const repo of repos) {
      try {
        const rc = JSON.parse(await readFile(join(repo.path, ".firebaserc"), "utf8")) as { projects?: Record<string, unknown> };
        for (const p of Object.values(rc.projects ?? {})) if (typeof p === "string" && projects.includes(p) && !exact.has(p)) exact.set(p, repo.name);
      } catch { /* none */ }
    }
    const hits = new Map<string, string>();
    const argv = ["grep", "-I", "-o", "-h", "-F", ...[...projects, ...sites].flatMap((p) => ["-e", p])];
    await pool(repos, 4, async (repo) => {
      const g = await r.run(r.gitBin, ["-C", repo.path, ...argv], { timeoutMs: 15_000 });
      if (g.stdout) hits.set(repo.name, g.stdout);
    });
    const byProject = assignProjects(hits, projects);
    for (const [p, repo] of exact) byProject.set(p, repo);
    return { byProject, bySite: assignProjects(hits, sites) };
  }

  async function discoverCloud(): Promise<void> {
    const notes: string[] = [];
    if (!r.gcloudBin) { cloud = []; cloudNotes = ["No gcloud command on this desktop — deployed services are not looked for."]; cloudAt = r.now(); return; }
    const pl = await r.run(r.gcloudBin, ["projects", "list", "--format=value(projectId)", "--quiet"], { timeoutMs: 30_000 });
    const projects = pl.stdout.split("\n").map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9-]{4,62}$/.test(s));
    if (pl.code !== 0) notes.push(`gcloud did not list projects: ${firstLine(pl.stderr) || pl.error || "no reason given"}. Signed in? \`gcloud auth login\`.`);
    const tok = projects.length ? await r.run(r.gcloudBin, ["auth", "print-access-token", "--quiet"], { timeoutMs: 20_000 }) : null;
    const token = tok?.code === 0 ? firstLine(tok.stdout) : "";
    const rows: FoundLink[] = [];
    await pool(projects, 3, async (p) => {
      const s = await r.run(r.gcloudBin!, ["run", "services", "list", `--project=${p}`, "--format=json", "--quiet"], { timeoutMs: 60_000 });
      if (s.code === 0) rows.push(...parseRunServices(s.stdout, p));
      else if (!/not been used|not enabled|SERVICE_DISABLED/i.test(s.stderr)) notes.push(`Cloud Run in ${p} did not answer: ${firstLine(s.stderr) || s.error || (s.timedOut ? "timed out after 60 s" : "no reason")}`);
      if (!token) return;
      try {
        const res = await r.fetch(`https://firebasehosting.googleapis.com/v1beta1/projects/${encodeURIComponent(p)}/sites`, {
          headers: { authorization: `Bearer ${token}`, "x-goog-user-project": p }, signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) rows.push(...parseHostingSites(await res.text(), p));
      } catch { /* hosting not set up, or unreachable: no row, said by its absence */ }
    });
    if (projects.length && !token) notes.push("gcloud gave no access token — Firebase Hosting sites are not looked for.");
    const ownSite = (row: FoundLink) => row.kind === "firebase" && row.label !== row.project;
    const sites = [...new Set(rows.filter(ownSite).map((row) => row.label))];
    const own = projects.length ? await cloudRepos(projects, sites) : null;
    for (const row of rows) row.repo = (ownSite(row) ? own?.bySite.get(row.label) : own?.byProject.get(row.project!)) ?? null;
    rows.sort((a, b) => (a.repo ?? "~").localeCompare(b.repo ?? "~") || a.key.localeCompare(b.key));
    cloud = rows;
    cloudNotes = notes;
    cloudAt = r.now();
  }

  const startLocal = () => (localRun ??= discoverLocal().catch((e) => { localNotes = [`Local discovery failed: ${(e as Error).message}`]; })
    .finally(() => { localRun = null; changed(); }));
  const startCloud = () => (cloudRun ??= discoverCloud().catch((e) => { cloudNotes = [`Cloud discovery failed: ${(e as Error).message}`]; cloudAt = r.now(); })
    .finally(() => { cloudRun = null; changed(); }));

  function view(p: PinnedLink): PinnedView {
    const probe = probes.get(p.id) ?? null;
    if (p.url) return { ...p, openUrl: p.url, probe };
    const f = local.find((l) => l.port === p.port);
    const listening = localAt == null ? null : !!f;
    const openUrl = f?.url ?? serve.get(p.port!) ?? null;
    const v: PinnedView = { ...p, openUrl, listening, probe };
    if (!openUrl) v.why = localAt == null ? "not looked up yet" : f ? "listens on this desktop only — it needs a front door (see Found)" : `nothing listens on :${p.port} and it has no front door`;
    return v;
  }

  async function state(): Promise<LinksState> {
    const l = await loadPins(r.file);
    return {
      pinned: l.links.map(view), found: [...local, ...cloud], localAt, cloudAt,
      discovering: { local: !!localRun, cloud: !!cloudRun }, notes: [...l.problems, ...localNotes, ...cloudNotes], file: r.file,
    };
  }

  /** One pin edit at a time, over a fresh read; refuses in words while the file has problems. */
  function mutate(fn: (links: PinnedLink[]) => PinnedLink[]): Promise<LinksState> {
    const job = writeChain.then(async () => {
      const l = await loadPins(r.file);
      if (!l.writable) throw new Error(l.problems[0] ?? `${r.file} cannot be written`);
      await savePins(r.file, fn(l.links));
    });
    writeChain = job.catch(() => undefined);
    return job.then(state);
  }

  const newId = () => `p:${randomBytes(6).toString("hex")}`;
  const repoArg = (v: unknown): string | null | undefined => v === null ? null : typeof v === "string" && REPO_RE.test(v) ? v : undefined;

  async function probeOne(p: PinnedView): Promise<void> {
    if (!p.openUrl) { probes.delete(p.id); return; }
    const t0 = r.now();
    const once = (method: string) => r.fetch(p.openUrl!, { method, redirect: "manual", signal: AbortSignal.timeout(r.probeTimeoutMs) });
    try {
      let res = await once("HEAD");
      if (res.status === 405 || res.status === 501) res = await once("GET");
      void res.body?.cancel().catch(() => undefined);
      probes.set(p.id, { at: r.now(), state: res.status < 500 ? "up" : "down", status: res.status, ms: r.now() - t0 });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      const why = err.name === "TimeoutError" ? `no answer within ${Math.round(r.probeTimeoutMs / 1000)} s` : err.cause?.code ?? err.message;
      probes.set(p.id, { at: r.now(), state: "down", error: why, ms: r.now() - t0 });
    }
  }

  return {
    state,
    async discover(o) {
      if (localRun || localAt == null || r.now() - localAt > LOCAL_FRESH_MS || o.cloud) void startLocal();
      if (cloudRun || o.cloud || cloudAt == null || r.now() - cloudAt > CLOUD_FRESH_MS) void startCloud();
      return state();
    },
    async probe() {
      await localRun;
      const s = await state();
      await pool(s.pinned, 6, probeOne);
      return state();
    },
    async pin(key) {
      const f = [...local, ...cloud].find((x) => x.key === key);
      if (!f) throw new Error("that link is not in the last discovery — look again and pin it from the fresh list");
      return mutate((links) => {
        if (links.some((p) => p.from === key)) return links;
        const p: PinnedLink = { id: newId(), repo: f.repo, label: f.kind === "local" ? `${f.repo ?? f.proc} :${f.port}` : f.label, env: f.env, from: key };
        if (f.kind === "local") p.port = f.port; else p.url = f.url!;
        return [...links, p];
      });
    },
    async add(a) {
      const label = cleanLabel(a.label);
      if (!label) throw new Error("a link needs a name");
      if (!isHttpUrl(a.url)) throw new Error("only an http:// or https:// address can be pinned");
      const repo = repoArg(a.repo) ?? null;
      const env: LinkEnv = isEnv(a.env) ? a.env : "prod";
      return mutate((links) => [...links, { id: newId(), label, url: a.url as string, repo, env }]);
    },
    async edit(a) {
      if (typeof a.id !== "string" || !PIN_ID_RE.test(a.id)) throw new Error("not a pin id");
      const label = a.label === undefined ? undefined : cleanLabel(a.label);
      if (a.label !== undefined && !label) throw new Error("a link needs a name");
      if (a.env !== undefined && !isEnv(a.env)) throw new Error("env is dev, staging or prod");
      const repo = a.repo === undefined ? undefined : repoArg(a.repo);
      if (a.repo !== undefined && repo === undefined) throw new Error("not a repo folder name");
      let hit = false;
      const out = await mutate((links) => links.map((p) => {
        if (p.id !== a.id) return p;
        hit = true;
        return { ...p, ...(label ? { label } : {}), ...(a.env !== undefined ? { env: a.env as LinkEnv } : {}), ...(repo !== undefined ? { repo } : {}) };
      }));
      if (!hit) throw new Error("that pin is not in the file any more");
      return out;
    },
    async unpin(id) {
      if (typeof id !== "string" || !PIN_ID_RE.test(id)) throw new Error("not a pin id");
      probes.delete(id);
      return mutate((links) => links.filter((p) => p.id !== id));
    },
    async idle() { await Promise.all([localRun, cloudRun]); },
  };
}
