/**
 * What the remote's own rules demand of the default branch, read async off
 * `gh api` and cached per worktree. Failure of any kind (no gh, no auth, 403,
 * non-GitHub origin) is ABSENT — the caller behaves as direct. Never on a
 * request's hot path: routes use `cachedBranchRules`, which returns what it has
 * and kicks a refresh.
 */
import { classifyBranchRules, type BranchRules } from "@waterplane/shared";
import { forgeFor } from "./forge/index.js";

const TTL_MS = 10 * 60_000;

type Entry = { at: number; value: BranchRules | undefined };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<BranchRules | undefined>>();

async function read(wt: string): Promise<BranchRules | undefined> {
  const forge = await forgeFor(wt);
  const raw = await forge?.rules();
  return raw ? classifyBranchRules(raw.rules, raw.classic, raw.repo) : undefined;
}

/** The rules for this worktree's origin, cached ~10 min; concurrent calls share one read. */
export function branchRules(wt: string): Promise<BranchRules | undefined> {
  const hit = cache.get(wt);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
  const running = inflight.get(wt);
  if (running) return running;
  const p = read(wt)
    .catch(() => undefined)
    .then((value) => {
      cache.set(wt, { at: Date.now(), value });
      return value;
    })
    .finally(() => { inflight.delete(wt); });
  inflight.set(wt, p);
  return p;
}

/** Non-blocking: the cached value (even stale) or undefined, and a refresh kicked when it is stale. */
export function cachedBranchRules(wt: string): BranchRules | undefined {
  const hit = cache.get(wt);
  if (!hit || Date.now() - hit.at >= TTL_MS) void branchRules(wt);
  return hit?.value;
}

/** Forget this worktree's reading (a refused push says the rules changed). */
export function invalidateBranchRules(wt: string): void {
  cache.delete(wt);
}
