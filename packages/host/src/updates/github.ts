/**
 * The smallest GitHub client the update check needs: unauthenticated `fetch` with a timeout.
 *
 * Unauthenticated calls are limited to 60 an hour per IP, so the catalogue makes few
 * (`catalog.ts`). Both bases are knobs so a test points them at a fake local server and never
 * touches real GitHub: `WATERPLANE_GITHUB_API` (default api.github.com) and
 * `WATERPLANE_GITHUB_RAW` (default raw.githubusercontent.com). Read at CALL time.
 */
import { BRAND } from "@waterplane/shared";
import { env } from "../env.js";

export const DEFAULT_GITHUB_API = "https://api.github.com";
export const DEFAULT_GITHUB_RAW = "https://raw.githubusercontent.com";
const TIMEOUT_MS = 8_000;

export const githubApi = (): string => (env("GITHUB_API") || DEFAULT_GITHUB_API).replace(/\/+$/, "");
export const githubRaw = (): string => (env("GITHUB_RAW") || DEFAULT_GITHUB_RAW).replace(/\/+$/, "");

/** A GitHub answer that is not a success. `status` 404 is the one callers treat as "not there". */
export class GithubError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); }
}

const headers = (accept: string): Record<string, string> => ({ "user-agent": `${BRAND.slug}/update-check`, accept });

async function get(url: string, accept: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { headers: headers(accept), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  } catch (e) {
    const timeout = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
    throw new GithubError(timeout ? "GitHub did not answer in time" : "GitHub could not be reached", null);
  }
  if (res.ok) return res;
  if (res.status === 404) throw new GithubError("not found", 404);
  const limited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
  throw new GithubError(limited ? "GitHub's hourly limit for unauthenticated calls is used up; try again later" : `GitHub answered HTTP ${res.status}`, res.status);
}

/** JSON from the API. Throws `GithubError` (status 404 = absent). */
export async function ghJson<T>(path: string): Promise<T> {
  const res = await get(`${githubApi()}${path}`, "application/vnd.github+json");
  try { return (await res.json()) as T; } catch { throw new GithubError("GitHub sent something that is not JSON", null); }
}

/** A raw file at `ref`, or null when it is not there. Other failures throw. */
export async function ghRaw(repo: string, ref: string, file: string): Promise<string | null> {
  try {
    const res = await get(`${githubRaw()}/${repo}/${encodeURIComponent(ref)}/${file}`, "text/plain");
    return await res.text();
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) return null;
    throw e;
  }
}
