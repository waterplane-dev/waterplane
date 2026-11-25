/**
 * The app tab without VS Code: which address may be framed, whether a waterplane host answers there,
 * the page that frames it, and the one message the framed app may send. `apppanel.ts` is the tab.
 *
 * The bridge, version 1, is ONE message, app to extension:
 *
 *     { shell: "vscode", v: 1, op: "open", url }      posted to window.parent
 *
 * The page's script takes it only from the frame it made AND from the framed origin, in exactly that
 * shape, and hands `{ op: "open", url }` on; the extension checks the URL again here and opens it in
 * the person's browser. Everything else is dropped and nothing is ever answered. There is no
 * clipboard, no prompt and no session op in this bridge, and there never will be: what drives a
 * session stays between the app and its host. The app's half is `packages/web/src/vscodeShell.ts`.
 */
import { BRAND } from "@waterplane/shared";
import { DEFAULT_DESKTOP_URL, desktopBase } from "./hostlink.js";

/** How long the one check before framing may take: the host is on this machine or it is not there. */
export const APP_PROBE_MS = 3_000;
/** At most one link opens per this many ms; the rest are dropped. */
export const OPEN_EVERY_MS = 500;
const MAX_URL = 2_048;

export const INSTALL_DOCS = `https://github.com/${BRAND.githubOrg}/${BRAND.slug}/blob/main/docs/install.md`;
export const DOCS = `https://github.com/${BRAND.githubOrg}/${BRAND.slug}#readme`;

// ---- may it be opened at all --------------------------------------------------------------------

/** Why the app is not opened from here, or null. `web` = VS Code's own window runs in a browser. */
export function remoteRefusal(remoteName: string | undefined, web: boolean): string | null {
  if (!remoteName && !web) return null;
  const where = remoteName ? `a remote machine (${remoteName})` : "another machine, behind a browser window";
  return `VS Code is running on ${where}. There, 127.0.0.1 is shared with everyone who has an account on that machine, so ${BRAND.name} sessions are not opened from here.`;
}

/** The origin to frame: the setting when it is set, else the default. A non-loopback one is a sentence. */
export function appBase(setting: string): { base: string } | { off: string } {
  const b = desktopBase(setting.trim() || DEFAULT_DESKTOP_URL);
  if ("off" in b) return b;
  const u = new URL(b.base);
  // A content-security-policy source cannot name an IPv6 literal, so the frame would stay blank.
  if (u.hostname.startsWith("[")) return { off: `VS Code cannot show ${u.host} in a tab. Put http://127.0.0.1:${u.port || "80"} in ${BRAND.slug}.desktopUrl instead.` };
  return { base: u.origin };
}

// ---- is it a waterplane host --------------------------------------------------------------------

/** `GET /api/health` as every host version answers it: ok, the protocol number and the root it serves. */
export function isHostHealth(doc: unknown): boolean {
  if (!doc || typeof doc !== "object") return false;
  const d = doc as { ok?: unknown; protocol?: unknown; root?: unknown };
  return d.ok === true && Number.isInteger(d.protocol) && typeof d.root === "string";
}

/** `answered` = something is listening there, so opening the address in a browser shows something. */
export type Probe = { ok: true } | { ok: false; answered: boolean; why: string };

/** One GET, loopback only (`appBase`), no redirect followed off it. Never throws. */
export async function probeHost(base: string, ms = APP_PROBE_MS): Promise<Probe> {
  const signal = AbortSignal.timeout(ms);
  let res: Response;
  try {
    res = await fetch(`${base}/api/health`, { signal, redirect: "manual", headers: { accept: "application/json" } });
  } catch {
    return {
      ok: false, answered: false,
      why: signal.aborted
        ? `The ${BRAND.name} desktop at ${base} did not answer within ${Math.round(ms / 1000)} s.`
        : `No ${BRAND.name} desktop answered at ${base}. Start it on this machine, then check again.`,
    };
  }
  if (res.ok) {
    let doc: unknown = null;
    try { doc = await res.json(); } catch { /* not JSON, or cut off: not a host */ }
    if (isHostHealth(doc)) return { ok: true };
  } else {
    void res.body?.cancel().catch(() => {});
  }
  return { ok: false, answered: true, why: `Something answered at ${base}, but it is not a ${BRAND.name} desktop.` };
}

// ---- the one message ----------------------------------------------------------------------------

/** The URL to open, normalised, or null: http(s), no sign-in inside it, nothing invisible, not endless. */
export function openableUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_URL) return null;
  // C0, DEL, C1: `new URL` silently strips some of these, so they are refused before it sees them.
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return null;
  }
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
  return u.href.length > MAX_URL ? null : u.href;
}

/** What the page's script forwards: exactly `{ op: "open", url }`, its URL checked again. */
export function openMessage(m: unknown): string | null {
  if (!m || typeof m !== "object") return null;
  const keys = Object.keys(m).sort().join();
  const d = m as { op?: unknown; url?: unknown };
  return keys === "op,url" && d.op === "open" ? openableUrl(d.url) : null;
}

/** The buttons of the page that says why. */
export type StopOp = "check" | "browser" | "install" | "docs";

/** A tap on one of `offered`, or null. The framed app's page offers none. */
export function stopMessage(m: unknown, offered: readonly StopOp[]): StopOp | null {
  if (!m || typeof m !== "object" || Object.keys(m).join() !== "op") return null;
  return offered.find((o) => o === (m as { op: unknown }).op) ?? null;
}

/** True at most once per `OPEN_EVERY_MS`. */
export class OpenGate {
  private last = -Infinity;
  allow(now: number): boolean {
    if (now - this.last < OPEN_EVERY_MS) return false;
    this.last = now;
    return true;
  }
}

// ---- the two pages ------------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** A value inside a script element: JSON, with nothing that could end the element. */
const js = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");

const page = (nonce: string, csp: string[], css: string, body: string, script: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${[...csp, `style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`].map(esc).join("; ")}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(BRAND.name)}</title>
<style nonce="${nonce}">${css}</style>
</head><body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;

/** The page's one listener: the frame it made, the framed origin, exactly the one message. */
export function bridgeScript(origin: string): string {
  return `
(() => {
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById("app");
  const origin = ${js(origin)};
  window.addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow || e.origin !== origin) return;
    const d = e.data;
    if (!d || typeof d !== "object" || Object.keys(d).sort().join() !== "op,shell,url,v") return;
    if (d.shell !== "vscode" || d.v !== 1 || d.op !== "open" || typeof d.url !== "string") return;
    vscode.postMessage({ op: "open", url: d.url });
  });
})();
`;
}

/** The app, full size. `base` is reduced to its origin by URL parsing; padding 0 undoes VS Code's own 20px. */
export function appHtml(base: string, nonce: string): string {
  const origin = new URL(base).origin;
  return page(
    nonce,
    ["default-src 'none'", `frame-src ${origin}`],
    "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}",
    `<iframe id="app" title="${esc(BRAND.name)}" src="${esc(`${origin}/`)}" allow="clipboard-write"></iframe>`,
    bridgeScript(origin),
  );
}

const STOP_LABEL: Record<StopOp, string> = { check: "Check again", browser: "Open in browser", install: "How to install", docs: "Read the docs" };

/** A sentence and the buttons that go with it; no buttons = something is still being checked. */
export function stopHtml(why: string, offered: readonly StopOp[], nonce: string): string {
  return page(
    nonce,
    ["default-src 'none'"],
    "html,body{margin:0;padding:0}main{max-width:34rem;margin:0 auto;padding:2rem 1.25rem;line-height:1.5}"
      + "div{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}"
      + "button{font:inherit;padding:.35rem .8rem;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}"
      + "button:first-child{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}"
      + "button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}",
    `<main><p role="status">${esc(why)}</p>${offered.length ? `<div>${offered.map((o) => `<button type="button" data-op="${o}">${STOP_LABEL[o]}</button>`).join("")}</div>` : ""}</main>`,
    offered.length
      ? `const vscode=acquireVsCodeApi();for(const b of document.querySelectorAll("button"))b.addEventListener("click",()=>vscode.postMessage({op:b.dataset.op}));`
      : "",
  );
}
