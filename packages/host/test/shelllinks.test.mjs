/**
 * A shell session's links and codes, read the way the daemon reads them
 * (`host/src/shelllinks.ts`): fixture SCREENS in — rendered grids, wrapped
 * where a terminal wraps — and the published facts out.
 *
 * The wrong answers worth pinning are the false ones: a code-shaped token with
 * no link (a ticket id), a commit SHA beside a URL, a port number, a link the
 * screen has already scrolled away. A missed code costs a copy by hand; an
 * invented one costs a sign-in with the wrong code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectShellLinks, MAX_SCREEN_LINKS } from "../dist/shelllinks.js";

/** A URL as an `width`-column grid holds it, each row indented by `pad`. */
function wrap(url, width = 80, pad = "") {
  const inner = width - pad.length;
  const rows = [];
  for (let i = 0; i < url.length; i += inner) rows.push(pad + url.slice(i, i + inner));
  return rows;
}
const screen = (...rows) => rows.flat().join("\n");

test("gh auth login (device flow): the link carries the code printed above it", () => {
  const r = detectShellLinks(screen(
    "$ gh auth login -h github.com -p https --web",
    "",
    "! First copy your one-time code: ABCD-1234",
    "Open this URL to continue in your web browser: https://github.com/login/device",
    "",
  ));
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].url, "https://github.com/login/device");
  assert.equal(r.links[0].code, "ABCD-1234");
  assert.equal(r.links[0].line, 3);
  assert.equal(r.links[0].local, undefined);
  assert.equal(r.awaitingCode, false);
});

test("gcloud --no-launch-browser: a long Google URL wrapped across rows, then the code prompt", () => {
  const url =
    "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com" +
    "&redirect_uri=https%3A%2F%2Fsdk.cloud.google.com%2Fauthcode.html&scope=openid+https%3A%2F%2Fwww.googleapis.com" +
    "%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform&state=Qx7dYyQe2&prompt=consent" +
    "&access_type=offline&code_challenge=Zx9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd&code_challenge_method=S256";
  // What the program PRINTED: the URL as one string — the proof every
  // multi-row join needs (`provenJoin`); the grid below is how it was drawn.
  const raw = `Go to the following link in your browser:\r\n\r\n    ${url}\r\n\r\nOnce finished, enter the verification code provided in your browser: `;
  const r = detectShellLinks(screen(
    "$ gcloud auth login --no-launch-browser",
    "Go to the following link in your browser, and complete the sign-in prompts:",
    "",
    wrap(url, 80, "    "),
    "",
    "Once finished, enter the verification code provided in your browser: ",
  ), undefined, raw);
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].url, url);
  assert.equal(r.links[0].code, undefined, "no device code here — the code comes BACK from the page");
  assert.equal(r.awaitingCode, true);
  // The TERMINAL's wrap: gcloud indents the URL four spaces and the grid
  // continues it at column 0 — rejoined only with the pane's width in hand.
  const hard = ("    " + url).match(/.{1,80}/g);
  const term = screen("Go to the following link in your browser:", "", hard, "", "Enter the authorization code: ");
  assert.equal(detectShellLinks(term, 80, raw).links[0].url, url);
  assert.equal(detectShellLinks(term, 80, raw).awaitingCode, true);
  // …and with no bytes to prove the join, a URL that fills its row is dropped,
  // never published cut short.
  assert.deepEqual(detectShellLinks(term, 80).links, []);
  // …and a row that merely ends short is never glued to the next one.
  const short = detectShellLinks(screen("    https://example.com/a", "continued"), 80);
  assert.equal(short.links[0].url, "https://example.com/a");
  // …and the older wording.
  const old = detectShellLinks(screen(wrap(url, 80), "", "Enter the authorization code:"), undefined, url + "\r\n\r\nEnter the authorization code:");
  assert.equal(old.links[0].url, url);
  assert.equal(old.awaitingCode, true);
});

test("an answered code prompt is no longer awaiting, and a prompt above the last line is history", () => {
  const url = "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=1";
  assert.equal(detectShellLinks(screen(url, "Enter the authorization code: 4/0AbCdEf")).awaitingCode, false);
  assert.equal(detectShellLinks(screen(url, "Enter the authorization code:", "$ ")).awaitingCode, false);
});

test("firebase login --no-localhost: link plus a paste prompt", () => {
  const url = "https://auth.firebase.tools/login?code_challenge=aBcDeF0123456789&session=4c5d6e7f-1111-2222-3333-444455556666&attest=xyz";
  const r = detectShellLinks(screen(
    "$ firebase login --no-localhost",
    "To sign in to the Firebase CLI:",
    "",
    "1. Take note of your session ID:",
    "",
    "   4C5D6",
    "",
    "2. Visit the URL below on any device and follow the instructions",
    "",
    "   " + url,
    "",
    "3. Paste or enter the authorization code below once you have it:",
    "",
    "? Enter authorization code:",
  ));
  assert.deepEqual(r.links.map((l) => l.url), [url]);
  assert.equal(r.links[0].code, undefined, "a 5-char session id is not a code");
  assert.equal(r.awaitingCode, true);
});

test("codex login --device-auth: the one-time code on the row under its label", () => {
  const r = detectShellLinks(screen(
    "$ codex login --device-auth",
    "",
    "1. Open this link in your browser and sign in to your account",
    "   https://auth.openai.com/codex/device",
    "",
    "2. Enter this one-time code (expires in 15 minutes)",
    "   7KQ2-PX4MZ",
    "",
  ));
  assert.equal(r.links[0].url, "https://auth.openai.com/codex/device");
  assert.equal(r.links[0].code, "7KQ2-PX4MZ");
});

test("npm login and tailscale login: a link, no code", () => {
  const npm = detectShellLinks(screen(
    "$ npm login",
    "npm notice Log in on https://registry.npmjs.org/",
    "Login at:",
    "https://www.npmjs.com/login?next=/login/cli/0b1f4c1e-5a2d-4f8e-9a77-3c6d2e1f0a9b",
    "Press ENTER to open in the browser...",
  ));
  assert.deepEqual(npm.links.map((l) => l.url), [
    "https://registry.npmjs.org/",
    "https://www.npmjs.com/login?next=/login/cli/0b1f4c1e-5a2d-4f8e-9a77-3c6d2e1f0a9b",
  ]);
  assert.ok(npm.links.every((l) => !l.code));
  const ts = detectShellLinks(screen(
    "$ tailscale login",
    "",
    "To authenticate, visit:",
    "",
    "\thttps://login.tailscale.com/a/1f2e3d4c5b6a7",
    "",
  ));
  assert.deepEqual(ts.links.map((l) => l.url), ["https://login.tailscale.com/a/1f2e3d4c5b6a7"]);
  assert.equal(ts.links[0].code, undefined);
});

test("git log --oneline beside a URL: SHAs are never codes", () => {
  const r = detectShellLinks(screen(
    "$ git log --oneline -4",
    "27eb8a2 Shell sessions: a plain login shell as a core backend",
    "C1F15E0 Vault: apply the security review",
    "bb392dd brand test: allow extension CLIs by shape",
    "2f753ef Vault: code: ABCDEF12 left in a message",
    "$ git remote -v",
    "origin  https://github.com/example/repo.git (fetch)",
  ));
  assert.deepEqual(r.links.map((l) => l.url), ["https://github.com/example/repo.git"]);
  assert.equal(r.links[0].code, undefined);
});

test("a code-shaped token with no link near it is nothing", () => {
  assert.deepEqual(detectShellLinks(screen("! First copy your one-time code: ABCD-1234", "$ ")).links, []);
  // …nor one more than six rows away.
  const far = detectShellLinks(screen("code: WDJB-MJHT", "", "", "", "", "", "", "", "https://example.com/x"));
  assert.equal(far.links.length, 1);
  assert.equal(far.links[0].code, undefined);
});

test("ports, pids and variables are never codes", () => {
  const r = detectShellLinks(screen(
    "https://example.com/dashboard",
    "listening on port ABCD-1234",
    "pid: WXYZ-9876",
    "echo $ABCD-1234",
  ));
  assert.equal(r.links[0].code, undefined);
});

test("http only for this desktop, flagged local; other http dropped", () => {
  const r = detectShellLinks(screen(
    "Serving at http://localhost:9005/__/auth/handler?code=1",
    "mirror http://example.com/plain",
    "also http://127.0.0.1:8080/",
  ));
  assert.deepEqual(r.links, [
    { url: "http://localhost:9005/__/auth/handler?code=1", line: 0, local: true },
    { url: "http://127.0.0.1:8080/", line: 2, local: true },
  ]);
});

test("a screen that scrolled the URL off publishes no links", () => {
  // gh's flow after the URL row has left the top of the grid: the code is
  // still visible, and with no link it is nothing.
  const r = detectShellLinks(screen(
    "! First copy your one-time code: ABCD-1234",
    "✓ Authentication complete.",
    "- gh config set -h github.com git_protocol https",
    "✓ Logged in as someone",
    "$ ",
  ));
  assert.deepEqual(r.links, []);
  assert.equal(r.awaitingCode, false);
});

test("newest last, deduped, at most three; a painted-over link is dropped", () => {
  const r = detectShellLinks(screen(
    "https://a.example/1",
    "https://b.example/2",
    "https://a.example/1",
    "https://c.example/3",
    "https://d.example/4",
  ));
  assert.equal(MAX_SCREEN_LINKS, 3);
  assert.deepEqual(r.links.map((l) => l.url), ["https://b.example/2", "https://c.example/3", "https://d.example/4"]);
  const cut = detectShellLinks(screen("https://example.com/abc↓def"));
  assert.deepEqual(cut.links, []);
});

test("each code goes to its NEAREST link only", () => {
  const r = detectShellLinks(screen(
    "https://docs.example.com/help",
    "",
    "",
    "Your code is QWER-TYUI",
    "https://github.com/login/device",
  ));
  assert.equal(r.links[0].code, undefined);
  assert.equal(r.links[1].code, "QWER-TYUI");
});

test("degrades to null, never throws", () => {
  assert.equal(detectShellLinks(null), null);
  assert.deepEqual(detectShellLinks(""), { links: [], awaitingCode: false });
});

test("a join across rows must be in the bytes: git's remote: and a bare $ are never glued on", () => {
  // git push: the hint URL is the last thing on a SHORT row, and the next row
  // is the same inset, URL-charactered and short — findUrls' flush-run shape.
  const gitRows = [
    "remote:",
    "remote: Create a pull request for 'feat/x' on GitHub by visiting:",
    "remote:      https://github.com/acme/widgets/pull/new/feat/x",
    "remote:",
    "To github.com:acme/widgets.git",
  ];
  const gitRaw = gitRows.join("\r\n") + "\r\n";
  for (const raw of [gitRaw, undefined]) {
    const r = detectShellLinks(screen(gitRows), 100, raw);
    assert.deepEqual(r.links.map((l) => l.url), ["https://github.com/acme/widgets/pull/new/feat/x"], `raw ${raw ? "given" : "absent"}`);
  }
  // A URL that happens to fill the row exactly, then the shell's prompt.
  const url = "https://example.com/" + "a".repeat(80 - "https://example.com/".length);
  const rows = ["$ cat link.txt", url, "$"];
  const proven = detectShellLinks(screen(rows), 80, `$ cat link.txt\r\n${url}\r\n$ `);
  assert.deepEqual(proven.links.map((l) => l.url), [url], "the URL ended where the bytes say it did — no `$` on it");
  assert.deepEqual(detectShellLinks(screen(rows), 80).links, [], "no bytes: a row-filling URL could go on, so nothing");
  // A repaint positions row by row: cursor moves never prove two rows are one string.
  const repaint = `\x1b[1;1H$ cat link.txt\x1b[K\x1b[2;1H${url}\x1b[3;1H$`;
  assert.deepEqual(detectShellLinks(screen(rows), 80, repaint).links.map((l) => l.url), [url]);
  const gitRepaint = gitRows.map((r, i) => `\x1b[${i + 1};1H${r}\x1b[K`).join("");
  assert.deepEqual(detectShellLinks(screen(gitRows), 100, gitRepaint).links.map((l) => l.url), ["https://github.com/acme/widgets/pull/new/feat/x"]);
});

test("a long gcloud URL the terminal hard-wrapped is still rejoined from tmux's own bytes", () => {
  const url = "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=325559.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fsdk.cloud.google.com%2Fauthcode.html&state=abc";
  const grid = ("  " + url).match(/.{1,100}/g);
  // tmux passes a wrapped line through as one run, escapes around it.
  const raw = `Go to the following link in your browser:\x1b[K\r\n\x1b[K\r\n  ${url}\x1b[K\r\n\r\nEnter the authorization code: `;
  const r = detectShellLinks(screen("Go to the following link in your browser:", "", grid, "", "Enter the authorization code: "), 100, raw);
  assert.equal(r.links[0].url, url);
  assert.equal(r.awaitingCode, true);
});

test("errno names, all-letter words and time ranges are not codes", () => {
  const near = "https://registry.npmjs.org/-/v1/login";
  const npm = detectShellLinks(screen(
    "npm ERR! request to " + near + " failed",
    "npm ERR! code: 'ECONNREFUSED'",
    "npm ERR! errno ECONNREFUSED",
  ));
  assert.equal(npm.links[0].url, near);
  assert.equal(npm.links[0].code, undefined, "ECONNREFUSED is an errno");
  const node = detectShellLinks(screen("Error code: ENOENT-1", "see https://nodejs.org/api/errors.html"));
  assert.equal(node.links[0].code, undefined, "ENOENT-1 is an errno");
  const word = detectShellLinks(screen("Status code: PENDING", "https://example.com/status"));
  assert.equal(word.links[0].code, undefined, "a labelled word with no digit and no dash is prose");
  const hours = detectShellLinks(screen("Support hours 0900-1700 at https://example.com/help"));
  assert.equal(hours.links[0].code, undefined, "a time range is not a device code");
  // …and the shapes that ARE codes still are.
  assert.equal(detectShellLinks(screen("code: EFGH-1234", "https://github.com/login/device")).links[0].code, "EFGH-1234");
  assert.equal(detectShellLinks(screen("Your one-time code: 4X7-K2Q9", "https://example.com/activate")).links[0].code, "4X7-K2Q9");
});
