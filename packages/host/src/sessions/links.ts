/**
 * A SHELL session's links (`SessionInfo.links`, `ShellLink`): the one list two
 * sources feed, and the one place they are merged.
 *
 *  - `addBrowserLink` — the CLI called `$BROWSER`, which in every shell session
 *    is `backends/shell.ts`'s shim, which POSTs the URL to `/api/shell/open` on
 *    loopback. Exact. Kept `BROWSER_KEEP_MS` (10 min) whether or not the URL is
 *    still on screen — the CLI that opened it usually prints nothing else.
 *  - `setScreenLinks` — links read off the rendered grid (the heuristic, WP3's
 *    `shelllinks.ts`, armed on the quiet tick by `armLinksCheck`). Replaces every screen-sourced
 *    entry; an entry keeps its first-seen `at` across repaints, and is retired
 *    the tick it is no longer on screen.
 *
 * Only for a session whose backend has no turns (`caps.turns === false`): a
 * claude session's document stays exactly what it was. Stateless — the list
 * lives on `s.info.links`; `updated` is emitted only on a CHANGE (`sameLinks`).
 * Absent when empty, never `[]`.
 */
import type { ShellLink } from "@waterplane/shared";
import { detectShellLinks } from "../shelllinks.js";
import type { Session, SessionCore } from "./core.js";
import { PROMPT_CHECK_MS, PROMPT_GATE_BYTES, PROMPT_MAX_STALE_MS } from "./knobs.js";

/** How long a `$BROWSER` link stays published with nothing else confirming it. */
export const BROWSER_KEEP_MS = 10 * 60_000;
/** The longest URL accepted — a login URL is long, a 4 KB one is not a login. */
export const LINK_URL_MAX = 4096;
/** Most links a session publishes at once; the newest win. */
const MAX_LINKS = 5;

/** A URL the phone may be handed: http(s), one line, bounded. Null otherwise. */
export function cleanLinkUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (!url || url.length > LINK_URL_MAX || !/^https?:\/\/[^\s]/i.test(url)) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return null;
  // Userinfo in the authority (`https://github.com@evil.tld/x`) is a link that
  // READS as one host and opens another. No login flow needs it; refused for
  // both sources, screen and \$BROWSER alike.
  const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1] ?? "";
  if (authority.includes("@") || authority.includes("\\")) return null;
  return url;
}

/** An `http://` link to THIS desktop (`localhost`/127.0.0.1/[::1]) — useless on a phone. */
export function isLocalLink(url: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/?#]|$)/i.test(url);
}

/** Same list, field for field — the guard every emit hangs off. */
export function sameLinks(a: readonly ShellLink[] | null | undefined, b: readonly ShellLink[] | null | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((l, i) => {
    const m = y[i]!;
    return l.url === m.url && l.source === m.source && l.at === m.at && l.code === m.code && l.line === m.line && l.local === m.local;
  });
}

function shellOf(core: SessionCore, id: string): Session | null {
  const s = core.sessions.get(id);
  return s && s.info.running && s.backend.caps.turns === false ? s : null;
}

/** Order newest-last, cap, publish only on a change. Re-arms the expiry of
 *  the oldest `$BROWSER` link (`armLinksCheck`'s one timer). */
function publish(core: SessionCore, s: Session, next: ShellLink[], awaitingCode?: boolean): boolean {
  next.sort((a, b) => a.at - b.at);
  const list = next.slice(-MAX_LINKS);
  armBrowserExpiry(core, s, list);
  const codeChanged = awaitingCode !== undefined && !!s.info.awaitingCode !== awaitingCode;
  if (sameLinks(s.info.links, list) && !codeChanged) return false;
  if (list.length) s.info.links = list; else delete s.info.links;
  if (awaitingCode) s.info.awaitingCode = true; else if (awaitingCode === false) delete s.info.awaitingCode;
  core.emit("updated", s.info);
  return true;
}

const freshBrowser = (links: readonly ShellLink[] | null | undefined, now: number): ShellLink[] =>
  (links ?? []).filter((l) => l.source === "browser" && now - l.at < BROWSER_KEEP_MS);

/**
 * The shim's report: `url` was handed to `$BROWSER` in session `id`. False —
 * and nothing stored — for an unknown, ended or non-shell session or a URL
 * `cleanLinkUrl` refuses. The same URL again moves to the end with a new `at`.
 */
export function addBrowserLink(core: SessionCore, id: string, raw: unknown, now = Date.now()): boolean {
  const s = shellOf(core, id);
  const url = cleanLinkUrl(raw);
  if (!s || !url) return false;
  const screen = (s.info.links ?? []).filter((l) => l.source === "screen" && l.url !== url);
  const browser = freshBrowser(s.info.links, now).filter((l) => l.url !== url);
  // A code the screen printed beside this very URL is still a fact about it.
  const code = s.info.links?.find((l) => l.url === url)?.code;
  const link: ShellLink = { url, source: "browser", at: now, ...(code ? { code } : {}), ...(isLocalLink(url) ? { local: true } : {}) };
  publish(core, s, [...screen, ...browser, link]);
  return true;
}

/**
 * What the screen shows NOW (`found`, null = nothing / could not read). Every
 * screen-sourced entry is replaced; a URL seen before keeps its `at`; a URL the
 * `$BROWSER` shim already reported stays ONE entry (browser-sourced), taking
 * the screen's code. Browser entries past `BROWSER_KEEP_MS` drop here.
 * `awaitingCode` undefined leaves the flag as it is.
 */
export function setScreenLinks(core: SessionCore, id: string, found: readonly Omit<ShellLink, "source" | "at">[] | null, awaitingCode?: boolean, now = Date.now()): boolean {
  const s = shellOf(core, id);
  if (!s) return false;
  const before = new Map((s.info.links ?? []).map((l) => [l.url, l]));
  const browser = freshBrowser(s.info.links, now);
  const byUrl = new Map(browser.map((l) => [l.url, l]));
  const screen: ShellLink[] = [];
  for (const f of found ?? []) {
    const url = cleanLinkUrl(f.url);
    if (!url) continue;
    const b = byUrl.get(url);
    if (b) { if (f.code && b.code !== f.code) byUrl.set(url, { ...b, code: f.code }); continue; }
    if (screen.some((l) => l.url === url)) continue;
    const prev = before.get(url);
    screen.push({
      url, source: "screen", at: prev?.at ?? now,
      ...(typeof f.line === "number" ? { line: f.line } : {}),
      ...(f.code ? { code: f.code } : {}),
      ...(f.local || isLocalLink(url) ? { local: true } : {}),
    });
  }
  return publish(core, s, [...byUrl.values(), ...screen], awaitingCode);
}


/** The raw byte tail a wrapped link must be found whole in — a login URL is ≤ 4 KB, a screen of output a few. */
const LINKS_PROOF_BYTES = 64 * 1024;
/** Grid rows the links read covers — the visible screen of a phone-sized pane. */
const LINKS_SCREEN_ROWS = 40;
/** The cheap gate over the raw byte tail: no scheme and no code word, no render. Built in halves (`shelllinks.ts`). */
const LINKS_GATE_RE = new RegExp("https?://|c" + "ode", "i");

/**
 * Arm the screen-links read for a shell session: the prompt check's debounce
 * with a ceiling (`PROMPT_CHECK_MS` quiet, `PROMPT_MAX_STALE_MS` at most since
 * the last read), earliest-wins. One render per pass, never two in flight, and
 * no render at all while the byte tail carries neither a URL nor a code word
 * and nothing is published that a render could retire. A throw = no links.
 */
export function armLinksCheck(core: SessionCore, s: Session, inMs?: number): void {
  if (s.backend.caps.turns !== false || !s.info.running) return;
  const delay = inMs ?? Math.max(0, Math.min(PROMPT_CHECK_MS, (s.lastLinksCheckAt ?? 0) + PROMPT_MAX_STALE_MS - Date.now()));
  const due = Date.now() + delay;
  if (s.linksTimer && (s.linksDueAt ?? 0) <= due) return;
  if (s.linksTimer) clearTimeout(s.linksTimer);
  s.linksDueAt = due;
  s.linksTimer = setTimeout(() => { s.linksTimer = null; checkLinks(core, s); }, delay);
  s.linksTimer.unref?.();
}

/**
 * A `$BROWSER` link expires `BROWSER_KEEP_MS` after it arrived even on a shell
 * that prints nothing more — and a quiet shell arms no check of its own (only
 * output does). So every publish arms the same one-shot timer for the oldest
 * browser link's expiry; earliest-wins means a sooner screen read keeps its
 * slot, and that read re-publishes, which arms this again.
 */
function armBrowserExpiry(core: SessionCore, s: Session, list: readonly ShellLink[]): void {
  const oldest = list.filter((l) => l.source === "browser").reduce((m, l) => Math.min(m, l.at), Infinity);
  if (oldest === Infinity) return;
  armLinksCheck(core, s, Math.max(0, oldest + BROWSER_KEEP_MS - Date.now()) + 50);
}

function checkLinks(core: SessionCore, s: Session): void {
  if (!shellOf(core, s.info.id) || s.copyMode || s.linksRendering) return;
  s.lastLinksCheckAt = Date.now();
  if (!s.info.links?.some((l) => l.source === "screen") && !s.info.awaitingCode && !LINKS_GATE_RE.test(s.scrollback.slice(-PROMPT_GATE_BYTES))) {
    // Nothing on screen to read — but a `$BROWSER` link may have run out.
    // Same list minus the expired, re-armed for the next (`publish`).
    if (s.info.links?.length) setScreenLinks(core, s.info.id, [], undefined);
    return;
  }
  s.linksRendering = true;
  void core.screenText(s.info.id, LINKS_SCREEN_ROWS)
    .then((screen) => {
      // The byte tail is the PROOF for a link joined across rows (`provenJoin`).
      const read = detectShellLinks(screen, s.cols, s.scrollback.slice(-LINKS_PROOF_BYTES));
      setScreenLinks(core, s.info.id, read?.links ?? null, read?.awaitingCode ?? false);
    })
    .catch(() => { setScreenLinks(core, s.info.id, null, false); })
    .finally(() => { s.linksRendering = false; });
}
