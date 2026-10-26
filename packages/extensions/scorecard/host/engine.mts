/**
 * The scorecard engine: slug → "is it public?" (GitHub) → the OpenSSF Scorecard reply, cached in
 * memory, plus a person's accepts and "scored as" overrides. Everything outside the process (`fetch`,
 * the clock, the state dir, the agent hand-off, the push) is injected so the tests run offline.
 * Nothing polls: a read happens when the phone or the setup checklist asks.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { BRAND, type ComplianceCheck } from "@waterplane/shared";
import { builtInAccept, checkViews, isFailing, isUsableSlug, openCount, own, parseReply, remedyPrompt, scoredDetail, viewerUrl, type Parsed } from "../shared/logic.mjs";
import { CHECK_ID, REASON_MAX, SCORE_FRESH_MS, VISIBILITY_FRESH_MS, type ScoreAccept, type ScoreView } from "../shared/wire.mjs";
import { commonGitDir, slugOfWorktree } from "./gitslug.mjs";
import { loadStore, saveStore, storeFile } from "./store.mjs";

export interface Roots {
  stateDir: string;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
}
export interface Deps {
  push: (data: { at: number; slug: string }) => void;
  handToAgent: (repoId: string, prompt: string, opts: { label: string; key: string }) => Promise<{ ok: true; intentId: string; existing: boolean; state?: string } | { ok: false; reason: string }>;
}
export interface Scope { id: string; name: string; worktree: string }

/** `readAt`: when `parsed` was read; `tryAt`: when the API was last asked (a transient failure keeps the old `parsed`). */
interface Entry { readAt: number; tryAt: number; pub: boolean | null; absent?: string; parsed?: Parsed; transient: boolean; local?: true }
interface Vis { at: number; pub: boolean | null; why?: string; movedTo?: string }

/** Finished rows no longer answer a tap (requirements' ladder, `host/index.mts` there). */
const OVER = new Set(["done", "failed", "canceled", "cancelled", "dropped", "dismissed"]);
/** `plugin-scorecard-` is added by the host; its key rule allows 64 chars in all. */
const KEY_MAX = 64 - "plugin-scorecard-".length;

/** A short, valid backlog key for one (slug, check, score): a re-tap names the same row. */
export function remedyKey(slug: string, check: string, score: number, n = 0): string {
  const h = createHash("sha1").update(`${slug.toLowerCase()}\0${check}\0${score}`).digest("hex").slice(0, 16);
  return (n <= 0 ? `sc-${h}` : `sc-${h}.${n}`).slice(0, KEY_MAX);
}

/** The repo's identity for "scored as": the realpath of its common git dir, so a linked worktree and the primary agree and two folders named alike do not. */
function repoKeyOf(worktree: string): string {
  const dir = commonGitDir(worktree) ?? worktree;
  try { return realpathSync(dir); } catch { return dir; }
}

/** Where the exposure collector writes a private repo's local reading: `<state dir>/scorecard/local/<owner>__<repo>.json` (the scorecard CLI's JSON, verbatim). */
export const localFile = (stateDir: string, slug: string): string => join(stateDir, "scorecard", "local", `${slug.replace(/\//g, "__")}.json`);

const VIS_ERR_MS = 60 * 60_000;
const ERR_FRESH_MS = 10 * 60_000;
const SLUG_CACHE_MS = 30_000;
const HEADERS = { accept: "application/vnd.github+json", "user-agent": `${BRAND.slug}-scorecard` };

export type Engine = ReturnType<typeof createEngine>;

export function createEngine(roots: Roots, deps: Deps) {
  const timeout = roots.timeoutMs ?? 10_000;
  const file = storeFile(roots.stateDir);
  const key = (slug: string): string => slug.toLowerCase();
  const entries = new Map<string, Entry>();
  const vis = new Map<string, Vis>();
  const inflight = new Map<string, Promise<void>>();
  const slugCache = new Map<string, { at: number; slug: string | null; from: "remote" | "set" | null }>();

  const slugOf = (worktree: string): { slug: string | null; from: "remote" | "set" | null } => {
    const hit = slugCache.get(worktree);
    if (hit && roots.now() - hit.at < SLUG_CACHE_MS) return hit;
    const set = own(loadStore(file).scoredAs, repoKeyOf(worktree));
    const r = set ? { slug: set, from: "set" as const } : (() => { const s = slugOfWorktree(worktree); return { slug: s, from: s ? "remote" as const : null }; })();
    slugCache.set(worktree, { at: roots.now(), ...r });
    return r;
  };

  const fresh = (e: Entry): boolean => roots.now() - e.tryAt < (e.transient ? ERR_FRESH_MS : SCORE_FRESH_MS);

  async function isPublic(slug: string, force: boolean): Promise<Vis> {
    const k = key(slug);
    const c = vis.get(k);
    if (c && !(force && c.pub !== true) && roots.now() - c.at < (c.pub === null ? VIS_ERR_MS : VISIBILITY_FRESH_MS)) return c;
    let v: Vis;
    try {
      const r = await roots.fetch(`https://api.github.com/repos/${slug}`, { headers: HEADERS, signal: AbortSignal.timeout(timeout) });
      if (r.status === 200) {
        const j = (await r.json()) as { private?: unknown; full_name?: unknown } | null;
        const now = typeof j?.full_name === "string" ? j.full_name : "";
        if (now && now.toLowerCase() !== slug.toLowerCase() && j?.private === false) v = { at: roots.now(), pub: false, movedTo: now };
        else v = j && j.private === false ? { at: roots.now(), pub: true } : { at: roots.now(), pub: false };
      } else if (r.status === 404) v = { at: roots.now(), pub: false };
      else v = { at: roots.now(), pub: null, why: `GitHub answered ${r.status}` };
    } catch (e) { v = { at: roots.now(), pub: null, why: (e as Error).message || "no answer" }; }
    vis.set(k, v);
    return v;
  }

  /** The local reading of a private repo, or null (no file, unreadable, not a Scorecard reply: absent, never a guess). */
  function readLocal(slug: string, at: number): Entry | null {
    for (const s of new Set([slug, slug.toLowerCase()])) {
      let body: unknown;
      try { body = JSON.parse(readFileSync(localFile(roots.stateDir, s), "utf8")); } catch { continue; }
      const p = parseReply(body);
      if (p.ok) return { readAt: at, tryAt: at, pub: false, transient: false, parsed: p.value, local: true };
    }
    return null;
  }

  async function doRead(slug: string, force: boolean): Promise<Entry> {
    const v = await isPublic(slug, force);
    const at = roots.now();
    if (v.pub === null) return { readAt: at, tryAt: at, pub: null, transient: true, absent: `could not ask GitHub whether ${slug} is public: ${v.why}` };
    if (v.movedTo) return { readAt: at, tryAt: at, pub: false, transient: false, absent: `${slug} has moved on GitHub to ${v.movedTo} — set "scored as" to ${v.movedTo} (or update the remote)` };
    if (!v.pub) {
      const local = readLocal(slug, at);
      if (local) return local;
      return { readAt: at, tryAt: at, pub: false, transient: false, absent: `${slug} is not public on GitHub (private, or no such repo) — Scorecard scores public repos only. A private repo gets a local reading when it is an exposure target: the daily exposure runner scores it with the scorecard CLI` };
    }
    try {
      const r = await roots.fetch(`https://api.securityscorecards.dev/projects/github.com/${slug}`, { headers: { accept: "application/json", "user-agent": HEADERS["user-agent"] }, signal: AbortSignal.timeout(timeout) });
      if (r.status === 404) return { readAt: at, tryAt: at, pub: true, transient: false, absent: `not scored yet — no Scorecard results published for github.com/${slug}; the ossf/scorecard-action workflow publishes them` };
      if (r.status !== 200) return { readAt: at, tryAt: at, pub: true, transient: true, absent: `the Scorecard API answered ${r.status} for github.com/${slug}` };
      let body: unknown;
      try { body = await r.json(); } catch { return { readAt: at, tryAt: at, pub: true, transient: true, absent: "the Scorecard API's reply was not JSON" }; }
      const p = parseReply(body);
      if (!p.ok) return { readAt: at, tryAt: at, pub: true, transient: true, absent: p.reason };
      return { readAt: at, tryAt: at, pub: true, transient: false, parsed: p.value };
    } catch (e) { return { readAt: at, tryAt: at, pub: true, transient: true, absent: `could not reach the Scorecard API: ${(e as Error).message || "no answer"}` }; }
  }

  function kick(slug: string, force = false): Promise<void> {
    const k = key(slug);
    const have = inflight.get(k);
    if (have) return have;
    const p = doRead(slug, force).catch((e): Entry => ({ readAt: roots.now(), tryAt: roots.now(), pub: null, transient: true, absent: `the Scorecard read failed: ${(e as Error).message}` }))
      .then((e) => {
        // A blip (5xx, network, timeout, a bad body) never replaces a good reading: keep it, retry later.
        const prev = entries.get(k);
        entries.set(k, e.transient && prev?.parsed ? { ...prev, tryAt: e.tryAt, transient: true } : e); inflight.delete(k); deps.push({ at: roots.now(), slug }); });
    inflight.set(k, p);
    return p;
  }

  function view(scope: Scope): ScoreView {
    const { slug, from } = slugOf(scope.worktree);
    const st = loadStore(file);
    const base: ScoreView = { repo: scope.id, slug, slugFrom: from, score: null, checks: [], open: 0, readAt: null, ...(st.problem ? { problem: st.problem } : {}) };
    if (!slug) return { ...base, absent: "no GitHub remote — Scorecard reads github.com repos; set which public repo this one is scored as" };
    const e = entries.get(key(slug));
    if (!e) return { ...base, absent: "not read yet" };
    const v: ScoreView = { ...base, readAt: e.readAt };
    if (!e.parsed) return { ...v, absent: e.absent ?? "no reading" };
    const checks = checkViews(e.parsed.checks, own(st.accepts, key(slug)));
    v.score = e.parsed.score; v.checks = checks; v.open = openCount(checks);
    if (e.local) v.local = true; else v.viewerUrl = viewerUrl(slug);
    if (e.parsed.date) v.date = e.parsed.date;
    if (e.parsed.commit) v.commit = e.parsed.commit;
    if (e.parsed.scorecardVersion) v.scorecardVersion = e.parsed.scorecardVersion;
    return v;
  }

  /** A scored slug and its entry, or throws a sentence saying why not. */
  function scored(scope: Scope): { slug: string; e: Entry & { parsed: Parsed } } {
    const { slug } = slugOf(scope.worktree);
    if (!slug) throw new Error("this repo has no GitHub remote and no \"scored as\" repo — set one first");
    const e = entries.get(key(slug));
    if (!e?.parsed) throw new Error(e?.absent ?? `${slug} has not been read yet — refresh first`);
    return { slug, e: e as Entry & { parsed: Parsed } };
  }

  return {
    slugOf,
    read(scope: Scope): ScoreView {
      const { slug } = slugOf(scope.worktree);
      if (slug) { const e = entries.get(key(slug)); if (!e || !fresh(e)) void kick(slug); }
      return view(scope);
    },
    async refresh(scope: Scope): Promise<ScoreView> {
      const { slug } = slugOf(scope.worktree);
      if (slug) await kick(slug, true);
      return view(scope);
    },
    accept(scope: Scope, check: unknown, reasonIn: unknown): ScoreView {
      const reason = typeof reasonIn === "string" ? reasonIn.replace(/\s+/g, " ").trim() : "";
      if (!reason) throw new Error("say why in a sentence — an accept without a reason is not kept");
      if (reason.length > REASON_MAX) throw new Error(`keep the reason to ${REASON_MAX} characters (it is ${reason.length})`);
      const { slug, e } = scored(scope);
      const c = e.parsed.checks.find((x) => x.name === check);
      if (!c) throw new Error(`the reading has no check called "${String(check)}"`);
      if (!isFailing(c.score)) throw new Error(`${c.name} is ${c.score < 0 ? "inconclusive" : "10/10"} — it is not failing, so there is nothing to accept`);
      const built = builtInAccept(c.name);
      if (built) throw new Error(`${c.name} is already accepted built in: ${built}`);
      const st = loadStore(file);
      (st.accepts[key(slug)] ??= Object.create(null) as Record<string, ScoreAccept>)[c.name] = { reason, at: new Date(roots.now()).toISOString(), score: c.score };
      saveStore(file, st);
      return view(scope);
    },
    unaccept(scope: Scope, check: unknown): ScoreView {
      const name = String(check);
      const built = builtInAccept(name);
      if (built) throw new Error(`${name}'s accept ships with ${BRAND.displayName} (${built}) and cannot be withdrawn`);
      const { slug } = slugOf(scope.worktree);
      if (!slug) throw new Error("this repo has no GitHub remote and no \"scored as\" repo");
      const st = loadStore(file);
      const per = own(st.accepts, key(slug));
      if (!per || !own(per, name)) throw new Error(`no accept of ${name} is on file for ${slug} — nothing to withdraw`);
      delete per[name];
      if (!Object.keys(per).length) delete st.accepts[key(slug)];
      saveStore(file, st);
      return view(scope);
    },
    scoredAs(scope: Scope, slugIn: unknown): ScoreView {
      if (slugIn === undefined) throw new Error("which repo should this be scored as? the call gave no owner/name (null puts it back to the git remote)");
      const st = loadStore(file);
      const rk = repoKeyOf(scope.worktree);
      if (slugIn === null) delete st.scoredAs[rk];
      else {
        const s = typeof slugIn === "string" ? slugIn.trim() : "";
        if (!isUsableSlug(s)) throw new Error("that is not a GitHub owner/name (letters, digits, dashes; one slash)");
        st.scoredAs[rk] = s;
      }
      saveStore(file, st);
      slugCache.clear();
      return this.read(scope);
    },
    async remedy(scope: Scope, check: unknown): Promise<{ intentId: string; existing: boolean; state?: string }> {
      const { slug, e } = scored(scope);
      const c = e.parsed.checks.find((x) => x.name === check);
      if (!c) throw new Error(`the reading has no check called "${String(check)}"`);
      if (!isFailing(c.score)) throw new Error(`${c.name} is not failing (${c.score < 0 ? "inconclusive" : "10/10"}) — there is nothing to fix`);
      const prompt = remedyPrompt(slug, c);
      // One waiting item per (check, score). A row that is OVER (done/failed/dropped) must not answer every
      // later tap while the score has not moved: the next key (`.1`, `.2`, …) makes a new item.
      for (let n = 0; n < 50; n++) {
        const r = await deps.handToAgent(scope.id, prompt, { label: `Scorecard: ${c.name}`, key: remedyKey(slug, c.name, c.score, n) });
        if (!r.ok) throw new Error(r.reason);
        if (r.existing && r.state && OVER.has(r.state)) continue;
        return { intentId: r.intentId, existing: r.existing === true, ...(r.state ? { state: r.state } : {}) };
      }
      throw new Error(`fifty finished fixes for ${c.name} are already filed at ${c.score}/10 — look at them in the backlog first`);
    },
    /** The setup row. Synchronous, cache only; a missing or stale reading starts one in the background. */
    row(worktree: string): ComplianceCheck | null {
      const { slug } = slugOf(worktree);
      if (!slug) return null;
      const e = entries.get(key(slug));
      if (!e || !fresh(e)) void kick(slug);
      // A private repo has a row only when it has a LOCAL reading (the exposure runner's); never "not public" noise.
      if (!e || (e.pub !== true && !e.local)) return null;
      const mk = (status: "pass" | "warn", detail: string): ComplianceCheck => ({ id: CHECK_ID, label: e.local ? "OpenSSF Scorecard (scored locally)" : "OpenSSF Scorecard", status, detail, fix: null, watch: true, ...(status === "pass" ? {} : { advisory: true as const }) });
      if (!e.parsed) return e.transient ? null : mk("warn", e.absent ?? "no Scorecard reading");
      const st = loadStore(file);
      const checks = checkViews(e.parsed.checks, own(st.accepts, key(slug)));
      const note = st.problem ? ` — ${st.problem}` : "";
      return mk(openCount(checks) ? "warn" : "pass", scoredDetail(e.parsed.score, checks) + note);
    },
  };
}
