/**
 * "Share → waterplane" from another app, as the Android shell hands it over.
 *
 * `ShellShare.java` copies what was shared into the app's own cache and calls
 * `window.shellShare(json)` with `{ files: [{ url, name, type, size }], text }`,
 * each url a `http://localhost/_capacitor_file_/…` the page can `fetch` on its
 * own origin. This module only TAKES it: parse, keep the last one until a
 * listener registers (a cold start shares before React has mounted), hand it
 * on. Where it goes is asked of the person (`features/images`'s share sheet) —
 * any app can share to this one, so a share is never acted on unasked.
 *
 * A no-op in the browser, where nothing calls the global.
 */
import { defineShellGlobal } from "./shellBridge";

export interface SharedFile {
  url: string;
  name: string;
  type: string;
  size: number;
}
export interface SharedItems {
  files: SharedFile[];
  text: string;
}

const FILE_PREFIX = "/_capacitor_file_/";

/**
 * The shell's JSON, checked. Null for anything malformed or empty. A file URL
 * must be on THIS page's origin and under the shell's file route — the global
 * is reachable by any script on the page, and the share sheet fetches these.
 */
export function parseShare(json: string, origin: string): SharedItems | null {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { files?: unknown; text?: unknown };
  const files: SharedFile[] = [];
  if (Array.isArray(o.files)) {
    for (const f of o.files as Array<Record<string, unknown>>) {
      if (!f || typeof f.url !== "string" || typeof f.name !== "string") continue;
      let u: URL;
      try { u = new URL(f.url); } catch { continue; }
      if (u.origin !== origin || !u.pathname.startsWith(FILE_PREFIX)) continue;
      const name = f.name.split(/[\\/]/).pop()?.trim() || "shared";
      files.push({
        url: u.href,
        name,
        type: typeof f.type === "string" ? f.type : "",
        size: typeof f.size === "number" && f.size >= 0 ? f.size : 0,
      });
    }
  }
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!files.length && !text) return null;
  return { files, text };
}

let pending: SharedItems | null = null;
const handlers = new Set<(s: SharedItems) => void>();

/** Register for shares; drains one that arrived before anybody listened. */
export function onShellShare(fn: (s: SharedItems) => void): () => void {
  handlers.add(fn);
  if (pending) {
    const s = pending;
    pending = null;
    fn(s);
  }
  return () => { handlers.delete(fn); };
}

/**
 * Define `window.shellShare`. Always answers true once it has looked — the
 * shell retries a falsy answer for 20 s, and a share held here is taken by the
 * next `onShellShare`.
 */
export function installShellShare(): void {
  defineShellGlobal("Share", (json: string): boolean => {
    const s = parseShare(json, window.location.origin);
    if (!s) return true;
    if (handlers.size === 0) { pending = s; return true; }
    for (const fn of handlers) fn(s);
    return true;
  });
}
