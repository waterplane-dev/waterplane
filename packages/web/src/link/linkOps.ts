import type { NetOp } from "./linkTypes";
import { emit, invalidate } from "./linkStore";

/**
 * On a good link every request is over before you look up, so nothing needs
 * saying. On a roaming Tailscale path through a DERP relay the SAME request
 * takes ten seconds, and the app used to render exactly nothing in the meantime:
 * the gallery kept the old grid, a filter chip un-highlighted itself on release,
 * and the only honest reading of the screen was "the button is broken".
 *
 * Every HTTP call routed through `api.ts` registers here for its duration; the
 * `NetActivity` strip renders the result. Deliberately NOT a spinner per call
 * site — the point is that ONE place always answers "yes, something is on the
 * wire, and it has been on the wire for N seconds", including for the calls
 * whose own component forgot to show a state.
 *
 * Polls (transcript refresh, usage flush, the roll-up below) must NOT register:
 * a bar that blinks every 6 s on an idle screen is noise, and noise is what
 * makes a real one invisible. They use `fetch` directly rather than the wrapped
 * helpers.
 */

let opSeq = 0;
export const ops: NetOp[] = [];

/** Register a request. Returns the ender — call it in a `finally`. */
export function netBegin(label: string): () => void {
  const op: NetOp = { id: ++opSeq, label, started: Date.now() };
  ops.push(op);
  invalidate("ops");
  emit();
  let ended = false;
  return () => {
    if (ended) return;      // idempotent: a caller that ends twice must not pop someone else's op
    ended = true;
    const i = ops.findIndex((o) => o.id === op.id);
    if (i >= 0) ops.splice(i, 1);
    invalidate("ops");
    emit();
  };
}

/**
 * Human label for a request URL. The strip only shows words after a couple of
 * seconds, so this is for the slow case: "loading files…" beats a spinner with
 * no subject when you are trying to work out which of three taps is stuck.
 */
export function labelForUrl(url: string, method = "GET"): string {
  const path = url.split("?")[0];
  const post = method !== "GET";
  if (path.includes("/artifacts") || path.includes("/api/search")) return "loading files";
  if (path.includes("/inbox/seen")) return "marking inbox read";
  if (path.includes("/inbox")) return post ? "uploading" : "loading inbox";
  if (path.includes("/artifact")) return post ? "deleting file" : "loading file";
  if (path.includes("/git/status")) return "reading git status";
  if (path.includes("/git/diff")) return "loading diff";
  if (path.includes("/git/blob")) return "loading the picture";
  if (path.includes("/git/text")) return "loading the file";
  if (path.includes("/git/branches")) return "loading branches";
  if (path.includes("/git/commit")) return "committing";
  if (path.includes("/git/push")) return "pushing";
  if (path.includes("/git/checkout")) return "switching branch";
  if (path.includes("/git/branch")) return "updating branches";
  if (path.includes("/git/stage")) return "staging";
  if (path.includes("/compliance")) return post ? "applying fixes" : "checking repo setup";
  if (path.includes("/api/slash")) return "loading commands";
  if (path.includes("/api/repos")) return "loading repos";
  if (path.includes("/api/external")) return "looking for sessions";
  if (path.includes("/api/worktree")) return "creating worktree";
  if (path.includes("/api/project")) return "creating project";
  if (path.includes("/api/folder")) return "creating folder";
  if (path.includes("/api/secret")) return post ? "setting secret" : "loading targets";
  if (path.includes("/api/envfiles")) return "loading env files";
  if (path.includes("/api/host/screenshot")) return "capturing screen";
  if (path.includes("/api/host/clipboard")) return "copying to host";
  if (path.includes("/api/host/stat")) return "reading host load";
  if (path.includes("/api/auth")) return "signing in";
  if (path.includes("/api/ui-usage")) return "loading usage";
  return post ? "sending" : "loading";
}
