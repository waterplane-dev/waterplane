/**
 * The shell backend (`backends/shell.ts`, docs/analysis/shell-plan.md): what a
 * shell session is spawned WITH, what it claims it can do, and the `$BROWSER`
 * shim that hands a CLI login's URL to the phone.
 *
 * Plus the links store (`sessions/links.ts`) over a fake core: the merge of the
 * two sources, the 10-minute browser retention, and that a claude session's
 * document is never touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, envName } from "@waterplane/shared";

process.env[envName("CONFIG_DIR")] = mkdtempSync(join(tmpdir(), `${BRAND.slug}-shell-`));
const { shellBackend, ensureBrowserShim, browserShimText, BROWSER_SHIM, backendInfos, derive, resolveBackend } = await import("../dist/backends/index.js");
const { pluginDescriptor } = await import("../dist/plugins/pluginapi.js");
const { addBrowserLink, setScreenLinks, armLinksCheck, BROWSER_KEEP_MS, cleanLinkUrl } = await import("../dist/sessions/links.js");
const { shellOpenRefusal, SHELL_DROP_ENV } = await import("../dist/backends/index.js");
const { droppedEnvNames, paneUnsetNames, tmuxEnvPrefix } = await import("../dist/sessions/tmux.js");
const { recordPrompt } = await import("../dist/sessions/record.js");

const PORT = 8771;

test("argv is a login shell; env carries BROWSER, the session id and the hook port", () => {
  const plan = shellBackend.prepare({ launch: {}, hookPort: PORT, hostSessionId: "ab12cd34", cwd: "/tmp" });
  assert.deepEqual(plan.args, ["-l"]);
  assert.deepEqual(Object.keys(plan.env).sort(), ["BROWSER", envName("HOOK_PORT"), envName("SESSION")].sort());
  assert.equal(plan.env[envName("SESSION")], "ab12cd34");
  assert.equal(plan.env[envName("HOOK_PORT")], String(PORT));
  assert.ok(plan.env.BROWSER.endsWith(`/${BROWSER_SHIM}`));
  assert.equal(plan.sessionId, undefined, "a shell mints no conversation id");
  assert.equal(plan.backendSessionId, undefined);
  assert.deepEqual(shellBackend.spawnEnv, {});
});

test("bin: the knob, else $SHELL, else /bin/sh", () => {
  const key = envName("SHELL_BIN");
  const was = { knob: process.env[key], shell: process.env.SHELL };
  try {
    process.env[key] = "/bin/dash";
    assert.equal(shellBackend.bin(), "/bin/dash");
    delete process.env[key];
    process.env.SHELL = "/bin/zsh";
    assert.equal(shellBackend.bin(), "/bin/zsh");
    delete process.env.SHELL;
    assert.equal(shellBackend.bin(), "/bin/sh");
  } finally {
    if (was.knob === undefined) delete process.env[key]; else process.env[key] = was.knob;
    if (was.shell === undefined) delete process.env.SHELL; else process.env.SHELL = was.shell;
  }
});

test("every resume mode is refused in words", () => {
  for (const resumeMode of ["continue", "pick", "fork"]) {
    assert.throws(() => shellBackend.prepare({ launch: {}, hookPort: PORT, resumeMode }), /A shell has no conversation to continue/);
  }
});

test("caps: nothing claude-shaped is armed, and there are no turns", () => {
  const c = shellBackend.caps;
  const d = derive(shellBackend);
  assert.equal(c.turns, false);
  assert.equal(d.hooksInBand, false);
  assert.equal(d.screen("dialogs"), null);
  assert.equal(d.store("transcript"), null);
  assert.equal(c.slash, "none");
  for (const f of ["turns", "context", "limits", "usage", "asking", "questions", "plan"]) assert.equal(d.has(f), false, f);
  assert.equal(c.remoteControl, false);
  assert.equal(c.effort, undefined);
  assert.deepEqual([...c.permissionModes], []);
  assert.equal(shellBackend.healthScope, false);
  assert.equal(shellBackend.delivery.composerCursorRe, null);
  assert.equal(shellBackend.delivery.isLocalCommand("/help"), false);
  assert.equal(resolveBackend("shell"), shellBackend);
  assert.equal(resolveBackend("claude").caps.turns, true, "claude has turns");
});

test("backendInfos: kind shell for the shell, absent for every agent", () => {
  const infos = backendInfos();
  const shell = infos.find((b) => b.id === "shell");
  assert.equal(shell.kind, "shell");
  assert.deepEqual(shell.models, { aliases: [], ids: [] });
  assert.equal(shell.caps.hooks, false);
  for (const b of infos.filter((b) => b.id !== "shell")) assert.ok(!("kind" in b), `${b.id} must carry no kind`);
});

test("a plugin backend that says nothing about turns HAS turns", () => {
  const def = { id: "stubcli", label: "Stub", bin: () => "stub", prepare: async () => ({ args: [], instructionsVia: "none", askRulesVia: "none" }),
    delivery: { submitKey: "\r", textThenSubmitDelayMs: 0 }, caps: {}, facts: {},
    measured: { versions: [], version: async () => null }, models: async () => ({ aliases: [], ids: [] }) };
  assert.equal(pluginDescriptor(def, "stub").caps.turns, true);
  assert.equal(pluginDescriptor({ ...def, caps: { ...def.caps, turns: false } }, "stub").caps.turns, false);
});

test("the shim: 0700, posts every argument to the loopback route, always exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-"));
  const path = ensureBrowserShim(PORT, dir);
  assert.equal(path, join(dir, BROWSER_SHIM));
  assert.equal(statSync(path).mode & 0o777, 0o700);
  const text = readFileSync(path, "utf8");
  assert.equal(text, browserShimText(PORT));
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.ok(text.includes(`http://127.0.0.1:$port/api/shell/open`));
  assert.ok(text.includes(`\${${envName("HOOK_PORT")}:-${PORT}}`), "the pane's port first, the writer's as fallback");
  assert.ok(text.includes(`session=\${${envName("SESSION")}:-}`));
  assert.ok(text.includes("-m 2"), "bounded: a CLI is never held by its browser");
  assert.match(text, /exit 0\n$/);
  // A loose copy (wrong mode, stale text) is healed.
  writeFileSync(path, "old");
  chmodSync(path, 0o755);
  ensureBrowserShim(PORT, dir);
  assert.equal(readFileSync(path, "utf8"), browserShimText(PORT));
  assert.equal(statSync(path).mode & 0o777, 0o700);
});

// ── the links store (sessions/links.ts) ──────────────────────────────────

function fakeCore(backendId = "shell") {
  const emitted = [];
  const s = { info: { id: "s1", running: true, cwd: "/r" }, backend: resolveBackend(backendId), scrollback: "" };
  const core = { sessions: new Map([["s1", s]]), emit: (ev, info) => { emitted.push(ev); return true; } };
  return { core, s, emitted };
}

test("cleanLinkUrl: http(s), one line, at most 4 KB", () => {
  assert.equal(cleanLinkUrl(" https://x.io/a "), "https://x.io/a");
  for (const bad of ["ftp://x", "javascript:alert(1)", "https://a b", "https://x\ny", "https://" + "a".repeat(5000), 7, null]) assert.equal(cleanLinkUrl(bad), null, String(bad).slice(0, 30));
  // Userinfo: reads as github.com, opens evil.tld — refused for screen and $BROWSER alike.
  for (const bad of ["https://github.com@evil.tld/x", "https://user:pw@github.com/", "http://localhost@evil.tld/"]) assert.equal(cleanLinkUrl(bad), null, bad);
  assert.equal(cleanLinkUrl("https://example.com/a?mail=x@y.z#@"), "https://example.com/a?mail=x@y.z#@", "an @ after the authority is just a path/query character");
});

test("an @ in the authority is refused from both sources", () => {
  const { core, s } = fakeCore();
  assert.equal(addBrowserLink(core, "s1", "https://github.com@evil.tld/login"), false);
  setScreenLinks(core, "s1", [{ url: "https://github.com@evil.tld/login" }], false);
  assert.equal(s.info.links, undefined);
});

test("a $BROWSER link expires on a QUIET shell: publishing arms the one timer for its expiry", async () => {
  const { core, s } = fakeCore();
  const now = Date.now();
  addBrowserLink(core, "s1", "https://github.com/login/device", now);
  assert.ok(s.linksTimer, "a timer is armed with no output at all");
  assert.ok(Math.abs(s.linksDueAt - (now + BROWSER_KEEP_MS)) < 1000, "…for the link's expiry");
  clearTimeout(s.linksTimer); s.linksTimer = null;
  // The same pass, run when that timer fires: nothing on screen to read, the link is past its window.
  addBrowserLink(core, "s1", "https://example.com/old", now - BROWSER_KEEP_MS - 10);
  clearTimeout(s.linksTimer); s.linksTimer = null;
  s.info.links = s.info.links.filter((l) => l.url === "https://example.com/old");
  armLinksCheck(core, s, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.info.links, undefined, "expired with nothing printed");
  if (s.linksTimer) clearTimeout(s.linksTimer);
});

test("a job never opens a shell; a person's tap does", () => {
  const shell = resolveBackend("shell");
  for (const kind of ["backlog", "schedule", "agent", "fanout", "resurrect"]) assert.match(shellOpenRefusal(shell, { kind }), /a job never opens a shell/, kind);
  assert.match(shellOpenRefusal(shell, undefined), /a job never opens a shell/, "no origin is no tap");
  assert.equal(shellOpenRefusal(shell, { kind: "hand" }), null);
  assert.equal(shellOpenRefusal(resolveBackend("claude"), { kind: "backlog" }), null, "an agent backend is any opener's");
});

test("the shell drops the daemon's secrets from the pane's env; claude drops nothing", () => {
  const plan = shellBackend.prepare({ launch: {}, hookPort: PORT, hostSessionId: "ab12cd34", cwd: "/tmp" });
  assert.deepEqual(plan.dropEnv, SHELL_DROP_ENV);
  const names = ["GEMINI_API_KEY", envName("SIDECAR_API_KEY"), envName("CLAUDE_ENDPOINT_KEY_FILE"), envName("CLAUDE_ENDPOINT_KEYCHAIN"), "PATH", "HOME", "LANG", "_API_KEY"];
  assert.deepEqual(droppedEnvNames(plan.dropEnv, names, plan.env), ["GEMINI_API_KEY", envName("CLAUDE_ENDPOINT_KEYCHAIN"), envName("CLAUDE_ENDPOINT_KEY_FILE"), envName("SIDECAR_API_KEY")].sort());
  assert.deepEqual(droppedEnvNames(["*_API_KEY"], ["X_API_KEY"], { X_API_KEY: "mine" }), [], "a name the launch sets itself stays");
  assert.deepEqual(tmuxEnvPrefix({ A: "1" }, ["GEMINI_API_KEY"]), ["/usr/bin/env", "-u", "GEMINI_API_KEY", "A=1"]);
  assert.deepEqual(tmuxEnvPrefix({}, []), []);
  assert.deepEqual(tmuxEnvPrefix({ "-u": "PATH", "": "x", A: "1" }), ["/usr/bin/env", "A=1"], "a key that is not a name never becomes an option to env");
  assert.deepEqual(tmuxEnvPrefix({ "-u": "PATH" }), [], "nothing left ⇒ no prefix");
  assert.equal(resolveBackend("claude").prepare({ launch: {}, hookPort: PORT, hostSessionId: "ab12cd34", cwd: "/tmp" }).dropEnv, undefined);
});

test("every pane runs without TMUX, so a bare `tmux kill-server` in it cannot reach this host's server", () => {
  assert.deepEqual(paneUnsetNames(undefined, ["TMUX", "TMUX_PANE", "PATH"]), ["TMUX"], "claude drops nothing else; TMUX_PANE stays for the vault");
  assert.deepEqual(paneUnsetNames(["*_API_KEY"], ["GEMINI_API_KEY", "TMUX"]), ["TMUX", "GEMINI_API_KEY"]);
  assert.deepEqual(paneUnsetNames(["TMUX"], []), ["TMUX"], "deduped");
  assert.deepEqual(tmuxEnvPrefix({}, paneUnsetNames(undefined, [])), ["/usr/bin/env", "-u", "TMUX"], "an empty spawnEnv still gets the prefix");
});

test("a shell's commands never become prompt history", () => {
  const { core, s, emitted } = fakeCore();
  s.history = [];
  recordPrompt(core, "s1", "export TOKEN=hunter2", "prompt");
  assert.deepEqual(s.history, [], "nothing kept — no history/<id>.json, nothing for the reader or search");
  assert.equal(emitted.length, 0);
});

test("a browser link is published, flagged local when it is this desktop, and kept 10 minutes", () => {
  const { core, s, emitted } = fakeCore();
  assert.equal(addBrowserLink(core, "s1", "https://github.com/login/device", 1000), true);
  assert.deepEqual(s.info.links, [{ url: "https://github.com/login/device", source: "browser", at: 1000 }]);
  assert.equal(emitted.length, 1);
  addBrowserLink(core, "s1", "http://localhost:9005/cb", 2000);
  assert.equal(s.info.links.at(-1).local, true);
  // Screen ticks that do not show it keep it until 10 min have passed.
  setScreenLinks(core, "s1", null, undefined, 1000 + BROWSER_KEEP_MS - 1);
  assert.equal(s.info.links.length, 2);
  setScreenLinks(core, "s1", null, undefined, 2000 + BROWSER_KEEP_MS);
  assert.equal(s.info.links, undefined, "past the window, nothing — absent, never []");
});

test("screen links keep their first-seen at, merge with a browser one, and retire off screen", () => {
  const { core, s, emitted } = fakeCore();
  addBrowserLink(core, "s1", "https://a.io/x", 100);
  setScreenLinks(core, "s1", [{ url: "https://a.io/x", code: "ABCD-EFGH", source: "screen", at: 0 }, { url: "https://b.io/y", line: 3, source: "screen", at: 0 }], true, 200);
  assert.deepEqual(s.info.links, [
    { url: "https://a.io/x", source: "browser", at: 100, code: "ABCD-EFGH" },
    { url: "https://b.io/y", source: "screen", at: 200, line: 3 },
  ]);
  assert.equal(s.info.awaitingCode, true);
  const n = emitted.length;
  setScreenLinks(core, "s1", [{ url: "https://b.io/y", line: 3, source: "screen", at: 0 }], true, 300);
  assert.equal(s.info.links.find((l) => l.url === "https://b.io/y").at, 200, "at survives a repaint");
  assert.equal(emitted.length, n, "same list ⇒ no broadcast");
  setScreenLinks(core, "s1", [], false, 400);
  assert.deepEqual(s.info.links.map((l) => l.url), ["https://a.io/x"], "the screen one retired; the browser one stays");
  assert.equal(s.info.awaitingCode, undefined);
});

test("a screen link hidden only by a SHORTER pane stays: the links bar's own height must not flicker it", () => {
  const { core, s, emitted } = fakeCore();
  const url = "https://registry.npmjs.org/";
  s.scrollback = `$ npm login\r\nnpm notice Log in on ${url}\r\n`;
  s.rows = 40;
  setScreenLinks(core, "s1", [{ url, line: 1 }], false, 100);
  // The bar appeared, the pane shrank, tmux repainted only the rows that fit.
  s.rows = 30;
  const n = emitted.length;
  setScreenLinks(core, "s1", [], false, 200);
  assert.deepEqual(s.info.links?.map((l) => l.url), [url], "held while the pane is shorter and the output still holds it");
  assert.equal(emitted.length, n, "no change ⇒ no broadcast ⇒ no relayout");
  // Output moved past it: the byte tail no longer has the URL.
  s.scrollback = "x".repeat(70 * 1024);
  setScreenLinks(core, "s1", [], false, 300);
  assert.equal(s.info.links, undefined);
});

test("a pane as tall as when the link was seen that no longer shows it retires it", () => {
  const { core, s } = fakeCore();
  const url = "https://a.io/x";
  s.scrollback = `open ${url}\r\n`;
  s.rows = 30;
  setScreenLinks(core, "s1", [{ url }], false, 100);
  setScreenLinks(core, "s1", [], false, 200);
  assert.equal(s.info.links, undefined, "same height ⇒ it really left (clear, scrolled)");
});

test("nothing is stored for an unknown, ended or non-shell session", () => {
  const { core, s } = fakeCore();
  assert.equal(addBrowserLink(core, "nope", "https://a.io"), false);
  s.info.running = false;
  assert.equal(addBrowserLink(core, "s1", "https://a.io"), false);
  assert.equal(s.info.links, undefined);
  const claude = fakeCore("claude");
  assert.equal(addBrowserLink(claude.core, "s1", "https://a.io"), false);
  assert.equal(setScreenLinks(claude.core, "s1", [{ url: "https://a.io", source: "screen", at: 0 }]), false);
  assert.equal(claude.s.info.links, undefined, "a claude session's document is untouched");
});
