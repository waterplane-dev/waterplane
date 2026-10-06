/**
 * tmux is REQUIRED (`tmuxreq.ts`): the retired knob is ignored (and said to be),
 * the refusal sentence, the per-platform install command, the doctor rows, and
 * that the login service no longer bakes a tmux knob.
 * Pure, from injected facts — no tmux is run and the real PATH is never consulted
 * except by `onPath` against a temp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveLocale, onPath, parseTmuxVersion, tmuxChecks, tmuxInstallCommand, tmuxKnobSet,
  tmuxMissingSentence, tmuxVersionNumber,
} from "../dist/tmuxreq.js";
import { plistEnv, plistText, serviceEnv, unitEnv, unitText } from "../dist/cli/service.js";
import { BRAND } from "@waterplane/shared";

const K = `${BRAND.envPrefix}TMUX`;
const byId = (cs) => Object.fromEntries(cs.map((c) => [c.id, c]));
const has = (...bins) => (b) => bins.includes(b);
const facts = (o = {}) => ({
  platform: "darwin", path: "/opt/homebrew/bin/tmux", versionOut: "tmux 3.5a",
  installCmd: "brew install tmux", env: { LANG: "en_US.UTF-8" }, ...o,
});

test("the retired knob: any non-empty value counts as SET (and is ignored)", () => {
  assert.equal(tmuxKnobSet(undefined), false);
  assert.equal(tmuxKnobSet(""), false);
  assert.equal(tmuxKnobSet("  "), false);
  assert.equal(tmuxKnobSet("0"), true);
  assert.equal(tmuxKnobSet("1"), true);
});

test("install command: the package manager that is here, in a fixed order", () => {
  assert.equal(tmuxInstallCommand("darwin", has("brew")), "brew install tmux");
  assert.equal(tmuxInstallCommand("darwin", has()), null, "no brew ⇒ no command to name");
  assert.equal(tmuxInstallCommand("linux", has("apt-get", "dnf")), "sudo apt-get install -y tmux");
  assert.equal(tmuxInstallCommand("linux", has("dnf")), "sudo dnf install -y tmux");
  assert.equal(tmuxInstallCommand("linux", has("pacman")), "sudo pacman -S --noconfirm tmux");
  assert.equal(tmuxInstallCommand("linux", has()), null);
  assert.equal(tmuxInstallCommand("win32", has("apt-get")), null);
});

test("the refusal names the command, says nothing started, and offers no way round tmux", () => {
  const s = tmuxMissingSentence("linux", "sudo apt-get install -y tmux");
  assert.match(s, /tmux was not found/);
  assert.match(s, /no session was started/);
  assert.match(s, /Install it with: sudo apt-get install -y tmux/);
  assert.doesNotMatch(s, new RegExp(K), "there is no escape hatch to name");
  assert.match(tmuxMissingSentence("darwin", null), /Install Homebrew \(https:\/\/brew\.sh\), then: brew install tmux/);
  assert.match(tmuxMissingSentence("win32", null), /Native Windows is not supported: run it inside WSL2/);
});

test("version parsing", () => {
  assert.equal(parseTmuxVersion("tmux 3.4"), "3.4");
  assert.equal(parseTmuxVersion("tmux 3.3a\n"), "3.3a");
  assert.equal(parseTmuxVersion("tmux next-3.6"), "next-3.6");
  assert.equal(parseTmuxVersion("garbage"), null);
  assert.deepEqual(tmuxVersionNumber("3.3a"), [3, 3]);
  assert.deepEqual(tmuxVersionNumber("next-3.6"), [3, 6]);
  assert.equal(tmuxVersionNumber("master"), null);
});

test("doctor: missing tmux FAILS with the install command", () => {
  const c = byId(tmuxChecks(facts({ path: null, versionOut: null, platform: "linux", installCmd: "sudo dnf install -y tmux" })));
  assert.equal(c.tmux.status, "fail");
  assert.match(c.tmux.detail, /refuses to start sessions/);
  assert.match(c.tmux.fix, /Install it with: sudo dnf install -y tmux/);
  assert.equal(c["tmux-locale"], undefined, "no locale row about a tmux that is not there");
});

test("doctor: present tmux is ok with version and path; older than 3.3 warns naming the option", () => {
  const ok = byId(tmuxChecks(facts()));
  assert.equal(ok.tmux.status, "ok");
  assert.match(ok.tmux.detail, /tmux 3\.5a at \/opt\/homebrew\/bin\/tmux/);
  const old = byId(tmuxChecks(facts({ versionOut: "tmux 3.2a" })));
  assert.equal(old.tmux.status, "warn");
  assert.match(old.tmux.detail, /3\.2a is older than 3\.3.*allow-passthrough/);
  assert.equal(byId(tmuxChecks(facts({ versionOut: "tmux master" }))).tmux.status, "ok", "an unparsable version is reported, never guessed old");
  assert.equal(byId(tmuxChecks(facts({ versionOut: null }))).tmux.status, "ok", "an unreadable version still has a binary");
});

test("doctor: a still-set knob is a warning saying it is IGNORED, and tmux is still checked", () => {
  const c = byId(tmuxChecks(facts({ knob: "0" })));
  assert.equal(c["tmux-knob"].status, "warn");
  assert.match(c["tmux-knob"].detail, new RegExp(`${K}=0 is ignored: every session runs inside tmux`));
  assert.equal(c.tmux.status, "ok", "the knob does not turn the real check off");
  assert.equal(byId(tmuxChecks(facts()))["tmux-knob"], undefined, "unset ⇒ no row");
  assert.equal(byId(tmuxChecks(facts({ knob: "0", path: null })))["tmux-knob"].status, "warn", "said beside a missing tmux too");
});

test("doctor: the locale trap — only a SET non-UTF-8 locale warns; none at all is covered by ptyEnv", () => {
  assert.equal(byId(tmuxChecks(facts({ env: {} })))["tmux-locale"].status, "ok");
  assert.match(byId(tmuxChecks(facts({ env: {} })))["tmux-locale"].detail, /LANG=en_US\.UTF-8 and -u/);
  assert.match(byId(tmuxChecks(facts({ platform: "linux", env: {} })))["tmux-locale"].detail, /LANG=C\.UTF-8 and -u/, "Linux gets the locale glibc always has");
  assert.match(byId(tmuxChecks(facts({ platform: "linux", env: { LANG: "C" } })))["tmux-locale"].fix, /such as C\.UTF-8/);
  assert.equal(byId(tmuxChecks(facts({ env: { LANG: "C.UTF-8" } })))["tmux-locale"].status, "ok");
  assert.equal(byId(tmuxChecks(facts({ env: { LANG: "en_US.utf8" } })))["tmux-locale"].status, "ok");
  const bad = byId(tmuxChecks(facts({ env: { LANG: "en_US.UTF-8", LC_ALL: "C" } })))["tmux-locale"];
  assert.equal(bad.status, "warn", "LC_ALL beats a UTF-8 LANG");
  assert.match(bad.detail, /LC_ALL=C is not a UTF-8 locale/);
  assert.deepEqual(effectiveLocale({ LC_CTYPE: "UTF-8", LANG: "C" }), { name: "LC_CTYPE", value: "UTF-8" });
  assert.equal(effectiveLocale({}), null);
});

test("onPath finds an executable file and nothing else", () => {
  const d = mkdtempSync(join(tmpdir(), "tmuxreq-"));
  try {
    writeFileSync(join(d, "tmux"), "#!/bin/sh\n");
    assert.equal(onPath("tmux", d), null, "not executable ⇒ not found");
    chmodSync(join(d, "tmux"), 0o755);
    assert.equal(onPath("tmux", `/nonexistent:${d}`), join(d, "tmux"));
    assert.equal(onPath("tmux", ""), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the login service bakes no tmux knob, and the installing shell's is NOT carried", () => {
  const env = serviceEnv("/bin", "/home/sam", { [K]: "0" }, "/cwd", {});
  assert.equal(env[K], undefined);
  const spec = { program: ["/n", "/e", "start"], workingDir: "/home/sam", env };
  assert.equal(plistEnv(plistText({ ...spec, label: "l", outLog: "/o", errLog: "/e" }))[K], undefined);
  assert.equal(unitEnv(unitText({ ...spec, description: "d" }))[K], undefined);
});
