/**
 * The merges the person asked for on the PR card whose outcome no reading has settled yet
 * (`prs.ts`' `asked` records), kept across a host restart.
 *
 * Why it is on disk: a queued merge can take hours, and this host restarts several times a day
 * (`npm run restart` after every host edit). A record held only in memory was forgotten by the
 * restart, so the PR landing later read as somebody else's merge — no base pull, no head delete —
 * while the tap's receipt had promised both.
 *
 * One file, `<state dir>/pr-merges-asked.json`, `{ [worktree]: { [prNumber]: StoredAsk } }`,
 * written with `writeJsonAtomic` and read with `readJsonGuarded` (the host persistence rule).
 * Every row is cleaned on the way in; one that does not clean is dropped, never repaired.
 * The age bound is `prs.ts`' (it reads the state first), not this file's.
 *
 * The key is the checkout's PATH, which a folder rename changes. So each record also carries
 * `origin` — what the PR belongs to independent of where the checkout sits (the forge slug of the
 * origin remote, else the remote URL as configured); with the PR number and head branch that is the
 * identity of the merge. A record whose folder is gone is moved to the one listed checkout with that
 * origin (`rehomeTarget`); never a guess between several. A record without `origin` (written before
 * it existed) stays under its path, as before, and ages out.
 */
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";
import { ghOfRemote } from "./exposurewatch.js";

/** What survives a restart: the tap's facts. The in-flight tidy promise and the tap flag do not. */
export interface StoredAsk { method: string; head: string; base: string; at: number; origin?: string }

/** The repo identity of an origin remote URL: `owner/repo` for GitHub (ssh and https spell it the
 *  same), else the URL with its credentials dropped — an http(s) URL loses user and password on
 *  every host (`https://user:TOKEN@ghe.corp/o/r` was written to the state file and the log verbatim),
 *  any other URL its password; scp-style `git@host:o/r` carries no secret and stays as written.
 *  Absent for no remote. Also run on a stored record on the way in, so an older file is scrubbed. */
export function originKey(url: string | null | undefined): string | undefined {
  const u = url?.trim();
  if (!u) return undefined;
  const gh = ghOfRemote(u);
  if (gh) return gh;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // Unparseable but scheme-shaped: cut any userinfo by hand rather than keep a possible secret.
    return u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
  }
}

/** Where a record whose checkout folder is gone belongs: the ONE listed checkout (other than the
 *  gone path) whose origin is the record's. `matches` says how many there were, for the log when it
 *  is not exactly one; no `origin` on the record is no match. */
export function rehomeTarget(rec: { origin?: string }, gone: string, repos: { path: string; origin?: string }[]): { to?: string; matches: number } {
  if (!rec.origin) return { matches: 0 };
  const hits = repos.filter((r) => r.path !== gone && r.origin === rec.origin);
  return hits.length === 1 ? { to: hits[0].path, matches: 1 } : { matches: hits.length };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function cleanAsk(v: unknown): StoredAsk | undefined {
  if (!isObj(v)) return undefined;
  const { method, head, base, at } = v;
  if (typeof method !== "string" || typeof head !== "string" || typeof base !== "string") return undefined;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return undefined;
  const origin = typeof v.origin === "string" ? originKey(v.origin) : undefined;
  return origin ? { method, head, base, at, origin } : { method, head, base, at };
}

/** Every stored record, by worktree then PR number. A missing or corrupt file is an empty map. */
export function loadAskedMerges(path: string): Map<string, Map<number, StoredAsk>> {
  const out = new Map<string, Map<number, StoredAsk>>();
  const raw = readJsonGuarded<Record<string, unknown>>(path, {}, isObj);
  for (const [wt, rows] of Object.entries(raw)) {
    if (!isObj(rows)) continue;
    const m = new Map<number, StoredAsk>();
    for (const [k, v] of Object.entries(rows)) {
      const n = Number(k);
      const a = cleanAsk(v);
      if (Number.isInteger(n) && n > 0 && a) m.set(n, a);
    }
    if (m.size) out.set(wt, m);
  }
  return out;
}

/** Replace the file with these records. A failed write is said in the log and never throws:
 *  the record in memory still holds until the next restart. */
export function saveAskedMerges(path: string, byWt: Map<string, Map<number, StoredAsk>>): void {
  const doc: Record<string, Record<string, StoredAsk>> = {};
  for (const [wt, m] of byWt) {
    if (!m.size) continue;
    doc[wt] = Object.fromEntries([...m].map(([n, a]) => [String(n), { method: a.method, head: a.head, base: a.base, at: a.at, ...(a.origin ? { origin: a.origin } : {}) }]));
  }
  try { writeJsonAtomic(path, doc); } catch (e) { console.warn(`[prs] could not keep the asked merges on disk: ${(e as Error)?.message ?? e}`); }
}
