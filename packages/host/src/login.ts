/**
 * The `/login` flow, read off the rendered screen.
 *
 * Signing in is the one thing in this app that cannot be done from the app.
 * The CLI prints an OAuth URL, you open it in a browser, and you paste the code
 * it gives you back into the CLI's own input — and on a phone every step of
 * that was hostile: the URL is 300+ characters, so the terminal GRID breaks it
 * across six rows with nothing marking them as one string, which makes it
 * untappable, un-copyable and (at 53 columns of base64) untranscribable. The
 * session sat there `awaitingInput` and the only honest advice was "go to the
 * desk".
 *
 * So the host reassembles the link (`@waterplane/shared`'s `findUrls`) and publishes
 * it on the session, which is what turns it into a button. Two facts, kept
 * apart because they lead to different actions:
 *
 *  - `url` — there is a sign-in link on screen. Open it.
 *  - `awaitingCode` — the CLI is sitting on its paste-the-code input. Send it.
 *
 * The screen can hold LESS than the whole link, and then the bytes say the
 * rest. At phone height the CLI's login panel is a scrolled viewport: the URL's
 * lower rows are off screen, and the scroll indicator (`↓`) is painted over a
 * character of the last row that is shown — measured on claude 2.1.x, where the
 * rejoin stopped at that glyph and the phone opened a link with no `scope`.
 * The CLI also wraps the link in an OSC 8 hyperlink (`assumeSupport`), whose
 * target is the full URL however the grid cut it. So the screen still decides
 * THAT there is a link and which one (its legible prefix); the newest OSC 8
 * target extending that prefix supplies the characters the screen cannot. A
 * link the screen shows cut and nothing completes is published as no link —
 * a button that opens half an OAuth request is a wrong answer, not a partial
 * one.
 *
 * Detection is on the URL's SHAPE, not on the CLI's prose. Partly because the
 * wording is upstream's to change, and partly for the reason `limit.ts` states
 * about banner phrases: a detector that matches printed English fires on a
 * session that happens to be *displaying* that English — and this repo greps
 * itself often enough for that to be a real event, not a hypothetical.
 */
import { findUrls } from "@waterplane/shared";

/** An authorize endpoint. The path is the evidence, so a link merely MENTIONING
 *  a login page (a doc URL in a transcript) is not one of these. */
const AUTHORIZE_RE = /\/(?:oauth|auth|login|signin|sign-in|device)(?:\/|\?|$)/i;

/** …or the query an OAuth authorize URL carries, for a host that routes it
 *  somewhere else. Both are structure, not copy. */
const OAUTH_QUERY_RE = /[?&](?:client_id|redirect_uri|code_challenge|response_type)=/i;

/**
 * The input the CLI parks on while it waits for the pasted code, matched by
 * SHAPE: a prompt marker at the end of a line whose words are about a code. The
 * `[^\n]{0,24}` keeps it from spanning a screen, and building it out of two
 * halves rather than the literal sentence is the same precaution the module
 * header describes.
 */
const CODE_INPUT_RE = new RegExp(String.raw`paste[^\n]{0,24}\bcode\b[^\n]{0,24}[>:❯][ \t]*$`, "im");

/** OSC 8 hyperlink opener: `ESC ] 8 ; params ; URI` ended by BEL or ST. */
const OSC8_RE = /\x1b\]8;[^;\x07\x1b]*;(https?:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g;

/** Every distinct OSC 8 target in a raw byte stream, newest LAST. */
export function hyperlinkTargets(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(OSC8_RE)) {
    const at = out.indexOf(m[1]);
    if (at !== -1) out.splice(at, 1);
    out.push(m[1]);
  }
  return out;
}

export interface DetectedLogin {
  /** The sign-in URL, rejoined across however many rows the grid broke it into. */
  url: string;
  /** The CLI is waiting for the code that URL hands back. */
  awaitingCode: boolean;
}

/** A prefix shorter than scheme + host + a path segment says too little about
 *  WHICH link it is to be completed from the bytes. */
const MIN_PREFIX = 20;

/**
 * Scan a RENDERED screen (headless VT replay — what the user sees, not the byte
 * stream) for a sign-in link. `raw` — the bytes that screen was rendered from —
 * completes a link the screen shows only part of (see the module header).
 *
 * The NEWEST qualifying link wins: a session logged in twice has both on the
 * screen, and the stale one is the one that no longer works.
 */
export function detectLogin(screen: string, raw = ""): DetectedLogin | null {
  const awaitingCode = CODE_INPUT_RE.test(screen);
  const targets = raw ? hyperlinkTargets(raw) : [];
  const complete = (url: string, truncated: boolean): string | null => {
    if (url.length >= MIN_PREFIX) {
      for (let i = targets.length - 1; i >= 0; i--) if (targets[i].startsWith(url)) return targets[i];
    }
    return truncated ? null : url;
  };
  // An OAuth query is proof on its own. A bare `/auth`-shaped path is not — a
  // documentation link in a transcript has that shape — so it only counts while
  // the CLI is visibly sitting on its code input, i.e. while there is a flow to
  // belong to.
  const hits = findUrls(screen.split("\n"))
    .map((h) => complete(h.url, !!h.truncated))
    .filter((u): u is string => !!u)
    .filter((u) => OAUTH_QUERY_RE.test(u) || (awaitingCode && AUTHORIZE_RE.test(u)));
  if (!hits.length) return null;
  return { url: hits[hits.length - 1], awaitingCode };
}

/** Has anything the phone acts on changed? Used to avoid a broadcast per repaint. */
export function sameLogin(a: DetectedLogin | null | undefined, b: DetectedLogin | null | undefined): boolean {
  if (!a || !b) return !a === !b;
  return a.url === b.url && a.awaitingCode === b.awaitingCode;
}
