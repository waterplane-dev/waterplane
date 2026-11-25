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
  assignProjects, localFound, parseLsofCwd, parseLsofListen, parseServeStatus, servePortsInUse,
} from "./parse.mjs";
import type { OptInAnswer } from "@waterplane/shared";
import { scanCloud, type CloudScan } from "./cloudscan.mjs";
import { firstLine, pool } from "./run.mjs";
import type { RepoDir } from "./parse.mjs";
import { REPO_RE, cleanLabel, isEnv, loadCloudLook, loadPins, saveCloudLook, savePins } from "./store.mjs";
import { loadSignIn, lookWith, type SignIn, type SignInRoots } from "./signin.mjs";

export interface Roots extends SignInRoots {
  root: string;
  file: string;
  /** Where the last look with the sign-in command is kept. */
  cloudFile: string;
  lsofBin: string;
  tailscaleBin: string | null;
  gitBin: string;
  fetch: typeof fetch;
  now: () => number;
  selfPid: number;
  probeTimeoutMs: number;
}

const quoteBin = (b: string) => (/\s/.test(b) ? `"${b}"` : b);

export interface Engine {
  state(): Promise<LinksState>;
  discover(o: { cloud?: boolean }): Promise<LinksState>;
  lookSignIn(): Promise<LinksState>;
  probe(): Promise<LinksState>;
  pin(key: string): Promise<LinksState>;
  add(a: { label: unknown; url: unknown; repo?: unknown; env?: unknown }): Promise<LinksState>;
  edit(a: { id: unknown; label?: unknown; env?: unknown; repo?: unknown }): Promise<LinksState>;
  unpin(id: unknown): Promise<LinksState>;
  /** Whether this repo has a pin — the Opt-ins card's answer. Reads the pins file only. */
  optIn(repo: string | null): Promise<OptInAnswer>;
  /** Settles when every discovery started so far has finished (tests). */
  idle(): Promise<void>;
}

export function createEngine(r: Roots, changed: () => void): Engine {
  let local: FoundLink[] = [], cloud: FoundLink[] = [];
  let serve = new Map<number, string>();
  let localAt: number | null = null, cloudAt: number | null = null, cloudTriedAt: number | null = null;
  let signIn: SignIn | null = null, signInRun = false;
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

  async function take(scan: CloudScan, at: number): Promise<void> {
    const rows = scan.rows;
    const ownSite = (row: FoundLink) => row.kind === "firebase" && row.label !== row.project;
    const sites = [...new Set(rows.filter(ownSite).map((row) => row.label))];
    const own = scan.projects.length ? await cloudRepos(scan.projects, sites) : null;
    for (const row of rows) row.repo = (ownSite(row) ? own?.bySite.get(row.label) : own?.byProject.get(row.project!)) ?? null;
    rows.sort((a, b) => (a.repo ?? "~").localeCompare(b.repo ?? "~") || a.key.localeCompare(b.key));
    cloud = rows;
    cloudNotes = scan.notes;
    cloudAt = at;
  }

  /** The look that runs by itself: this desktop's own gcloud sign-in. It never runs the sign-in
   *  command — it only finds out whether a person could. What an earlier look found stays when this one fails. */
  async function discoverCloud(): Promise<void> {
    await remembered();
    if (!r.gcloudBin) { signIn = null; cloud = []; cloudNotes = ["No gcloud command on this desktop — deployed services are not looked for."]; cloudAt = r.now(); return; }
    const scan = await scanCloud({ run: r.run, gcloudBin: r.gcloudBin, fetch: r.fetch }, null);
    const named = scan.failed?.signIn ? await loadSignIn(r.signInFile) : null;
    signIn = typeof named === "string" ? null : named;
    if (!scan.failed) return take(scan, r.now());
    cloudNotes = typeof named === "string" ? [named] : signIn ? [] : [`gcloud did not list projects: ${scan.failed.why}${scan.failed.signIn ? " Signed in? `gcloud auth login`." : ""}`];
  }

  async function discoverSignIn(s: SignIn): Promise<void> {
    const scan = await lookWith(r, s);
    if (typeof scan === "string") { cloudNotes = [scan]; return; }
    if (scan.failed) { cloudNotes = [`gcloud did not list projects with ${s.name}: ${scan.failed.why}`]; return; }
    await take(scan, r.now());
    await saveCloudLook(r.cloudFile, { at: cloudAt!, rows: cloud }).catch((e: Error) => { cloudNotes = [...cloudNotes, `This look is not kept past a restart: ${e.message}`]; });
  }

  let recall: Promise<void> | null = null;
  /** The last look with the sign-in command, read once, before anything could have replaced it. */
  const remembered = (): Promise<void> => (recall ??= loadCloudLook(r.cloudFile).then((l) => { if (l && cloudAt == null) { cloud = l.rows; cloudAt = l.at; } }));

  const startLocal = () => (localRun ??= discoverLocal().catch((e) => { localNotes = [`Local discovery failed: ${(e as Error).message}`]; })
    .finally(() => { localRun = null; changed(); }));
  const startCloud = () => (cloudRun ??= discoverCloud().catch((e) => { cloudNotes = [`Cloud discovery failed: ${(e as Error).message}`]; })
    .finally(() => { cloudRun = null; cloudTriedAt = r.now(); changed(); }));

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
    await remembered();
    return {
      pinned: l.links.map(view), found: [...local, ...cloud], localAt, cloudAt,
      discovering: { local: !!localRun, cloud: !!cloudRun }, notes: [...l.problems, ...localNotes, ...cloudNotes], file: r.file,
      ...(signIn ? { signIn: { name: signIn.name, looking: signInRun } } : {}),
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
      if (cloudRun || o.cloud || cloudTriedAt == null || r.now() - cloudTriedAt > CLOUD_FRESH_MS) void startCloud();
      return state();
    },
    async lookSignIn() {
      if (signInRun) return state();
      await cloudRun; // a look of the desktop's own may be finding out that this one is not needed
      const s = signIn;
      if (!s) throw new Error("no sign-in command is named on this desktop, or gcloud is signed in by itself — look again");
      if (!cloudRun) {
        signInRun = true;
        cloudRun = discoverSignIn(s).catch((e) => { cloudNotes = [`The look with ${s.name} failed: ${(e as Error).message}`]; })
          .finally(() => { cloudRun = null; signInRun = false; cloudTriedAt = r.now(); changed(); });
      }
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
    async optIn(repo) {
      if (!repo) return { state: "unknown", detail: "This desktop does not list this repo, so its links could not be looked up." };
      const l = await loadPins(r.file);
      const n = l.links.filter((p) => p.repo === repo).length;
      if (n) return { state: "on", detail: `${n} link${n === 1 ? " is" : "s are"} pinned for ${repo}.` };
      return l.writable ? { state: "off", detail: `No link is pinned for ${repo}.` } : { state: "unknown", detail: l.problems[0] ?? "The pins could not be read." };
    },
    async idle() { await Promise.all([localRun, cloudRun]); },
  };
}
