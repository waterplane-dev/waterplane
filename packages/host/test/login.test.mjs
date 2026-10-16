/**
 * The `/login` screen, read the way the daemon reads it (`host/src/login.ts`).
 *
 * The fixture is a rendered SCREEN, not a byte stream — a grid, with the OAuth
 * URL broken across rows exactly as a phone-width terminal breaks it, because
 * that break is the whole problem this detector exists for.
 *
 * Two wrong answers matter and they are not symmetric. A missed link leaves the
 * one flow that cannot be completed from the app looking like a session that is
 * merely thinking; a false one puts a sign-in button on a session nobody asked
 * to sign in. Hence the shape rules the module documents, pinned here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectLogin, hyperlinkTargets, loginCandidate, sameLogin } from "../dist/login.js";

const URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile&state=cQb7hRqDdxKqM6fnqs6N6jdsYfHWu9J0ZWwDdOxnhpw";

/** The link as a 53-column grid holds it: N full rows and a short last one. */
function grid(url, width = 53) {
  const rows = [];
  for (let i = 0; i < url.length; i += width) rows.push(url.slice(i, i + width));
  return rows;
}

const screen = (over = {}) => {
  const { code = true, url = URL } = over;
  return [
    "  Login",
    "",
    "  Browser didn't open? Use the url below to sign in",
    "",
    ...grid(url),
    "",
    ...(code ? ["  Paste code here if prompted >"] : []),
    "",
    "  Esc to cancel",
  ].join("\n");
};

test("the wrapped sign-in link comes back whole", () => {
  const hit = detectLogin(screen());
  assert.equal(hit.url, URL);
  assert.equal(hit.awaitingCode, true);
});

test("an OAuth link stands on its own — no code input needed", () => {
  const hit = detectLogin(screen({ code: false }));
  assert.equal(hit.url, URL);
  assert.equal(hit.awaitingCode, false);
});

test("an ordinary session with no link publishes nothing", () => {
  assert.equal(detectLogin("  ✻ Crunched for 0s · 3 shells still running\n\n  › \n"), null);
});

test("a documentation link that merely LOOKS auth-shaped is not a sign-in", () => {
  // No OAuth query, and no code input on screen for it to belong to.
  assert.equal(detectLogin("  see https://docs.example.com/auth/ for the setup\n"), null);
});

test("…but the same shape counts while the CLI sits on its code input", () => {
  const s = "  https://sso.example.com/device\n\n  Paste code here if prompted >\n";
  assert.equal(detectLogin(s).url, "https://sso.example.com/device");
});

test("the newest link wins — a second sign-in leaves the dead one on screen", () => {
  const old = URL.replace("code=true", "code=stale");
  const s = [...grid(old), "", ...grid(URL), "", "  Paste code here if prompted >"].join("\n");
  assert.equal(detectLogin(s).url, URL);
});

// Measured on claude 2.1.x at 54 columns: the panel scrolled, its `↓` painted
// over the last shown row of the link, and the rest of the link off screen.
const CUT = [
  "   Login",
  "",
  ...grid(URL, 54).slice(0, 3),
  grid(URL, 54)[3].slice(0, 52) + "↓" + grid(URL, 54)[3].slice(53),
  "",
  "✻ Cooked for 0s · done 10:28 AM",
].join("\n");
/** The CLI's OSC 8 wrapping of the link — per row, BEL-terminated, as measured. */
const osc8 = (url, st = "\x07") => `\x1b]8;id=8f8eow;${url}${st}${url.slice(0, 54)}\x1b]8;;${st}`;

test("a link the screen shows cut is completed from its OSC 8 target", () => {
  assert.equal(detectLogin(CUT, "noise" + osc8(URL)).url, URL);
  assert.equal(detectLogin(CUT, osc8(URL, "\x1b\\")).url, URL);
});

test("…and is NO link when nothing completes it — half an OAuth request is wrong, not partial", () => {
  assert.equal(detectLogin(CUT), null);
  assert.equal(detectLogin(CUT, osc8("https://claude.com/cai/oauth/authorize?code=true&client_id=other")), null);
});

test("an older link in the bytes loses to the newest one extending the same prefix", () => {
  const old = URL.replace("cQb7", "dead");
  assert.equal(detectLogin(CUT, osc8(old) + osc8(URL)).url, URL);
  assert.deepEqual(hyperlinkTargets(osc8(URL) + osc8(old) + osc8(URL)), [old, URL]);
});

test("sameLogin is what stops a broadcast per repaint", () => {
  const a = { url: URL, awaitingCode: false };
  assert.equal(sameLogin(a, { ...a }), true);
  assert.equal(sameLogin(a, { ...a, awaitingCode: true }), false);
  assert.equal(sameLogin(a, null), false);
  assert.equal(sameLogin(null, null), true);
});

// claude 2.1.293's sign-in screen draws NO dialog footer — it ends on the code
// input — so the render that reads the link must be bought by the link itself.
// Bytes shaped as the CLI writes them (measured, fresh config dir, 54 columns):
// one row per write, each wrapped in an OSC 8 hyperlink to the whole URL.
const strip = (s) => s.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[ -/]*[@-~]|\r/g, "");

test("the link's own shape opens the render gate, footer or not", () => {
  const osc = grid(URL, 54)
    .map((row) => `\x1b]8;id=ecs8f0;${URL}\x07\x1b[38;5;246m${row}\x1b[39m\x1b]8;;\x07\r\r\n`)
    .join("");
  const raw = ` Browser didn't open? Use the url below to\r\n${osc} Paste code here if prompted >`;
  assert.equal(loginCandidate(raw, strip(raw)), true);
  // A terminal that dropped the hyperlinks still has the rows; their breaks
  // fall inside `client_id`, and the gate reads across them.
  const plain = grid(URL, 54).map((r) => `\x1b[38;5;246m${r}\x1b[39m\r\n`).join("");
  assert.equal(loginCandidate(plain, strip(plain)), true);
  assert.ok(detectLogin(strip(raw).replace(/\r/g, "")));
});

test("an ordinary busy tail does not buy a render", () => {
  const raw = "\x1b[2K✻ Crunching… (12s · esc to interrupt)\r\n\x1b]8;;https://example.com/docs\x07docs\x1b]8;;\x07\r\n";
  assert.equal(loginCandidate(raw, strip(raw)), false);
});
