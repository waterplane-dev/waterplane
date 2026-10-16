/**
 * The code folder a person chose on the phone (`rootchoice.ts`): the knob beats it, it beats the
 * guess, a typed path is checked before it is kept, and the host restarts itself only under a
 * supervisor that will bring it back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BRAND, rootNeedsAsking } from "@waterplane/shared";
import { resolveRoot } from "../dist/branddirs.js";
import { cleanRootInput, hostSupervisor, readChosenRoot, writeChosenRoot } from "../dist/rootchoice.js";
import { checkRoot } from "../dist/doctor.js";

const P = BRAND.envPrefix;
const fake = (dirs, repos = []) => ({ isDir: (p) => dirs.includes(p), hasGitChild: (p) => repos.includes(p) });

test("rootchoice: the knob beats a chosen folder, a chosen folder beats the guess", () => {
  assert.equal(resolveRoot({ [`${P}ROOT`]: "/work" }, "/h", fake(["/h/dev"]), "/picked").picked, "named");
  const r = resolveRoot({}, "/h", fake(["/h/dev"], ["/h/dev"]), "/picked");
  assert.deepEqual(r, { root: "/picked", defaulted: false, picked: "chosen", tried: [] });
  assert.equal(resolveRoot({}, "/h", fake(["/h/dev"]), undefined).picked, "found");
});

test("rootchoice: kept and read back; absent, corrupt or relative reads as none", () => {
  const d = mkdtempSync(join(tmpdir(), "rootchoice-"));
  const f = join(d, "root.json");
  assert.equal(readChosenRoot(f), undefined);
  writeChosenRoot("/srv/code", f);
  assert.equal(readChosenRoot(f), "/srv/code");
  writeFileSync(f, JSON.stringify({ root: "relative/dir" }));
  assert.equal(readChosenRoot(f), undefined);
  writeFileSync(f, "{not json");
  assert.equal(readChosenRoot(f), undefined);
});

test("rootchoice: a typed folder must exist, be absolute and not be the whole disk; ~ expands", () => {
  const home = mkdtempSync(join(tmpdir(), "rootchoice-home-"));
  mkdirSync(join(home, "dev"));
  assert.deepEqual(cleanRootInput("~/dev", home), { ok: true, root: join(home, "dev") });
  assert.deepEqual(cleanRootInput(` ${join(home, "dev")}/ `, home), { ok: true, root: join(home, "dev") });
  assert.match(cleanRootInput("", home).error, /Type the folder/);
  assert.match(cleanRootInput("dev", home).error, /full path/);
  assert.match(cleanRootInput("/", home).error, /whole disk/);
  assert.match(cleanRootInput(join(home, "nope"), home).error, /not a folder/);
});

test("rootchoice: only a real launchd job or systemd unit counts as supervised", () => {
  assert.equal(hostSupervisor({ XPC_SERVICE_NAME: BRAND.launchdLabel }, () => ""), "launchd");
  assert.equal(hostSupervisor({ XPC_SERVICE_NAME: "application.com.apple.Terminal.123" }, () => ""), null);
  assert.equal(hostSupervisor({}, () => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${BRAND.slug}.service\n`), "systemd");
  // A shell inside a terminal that itself runs as a user service: INVOCATION_ID set, not our unit.
  assert.equal(hostSupervisor({ INVOCATION_ID: "abc" }, () => "0::/user.slice/user@1000.service/app.slice/gnome-terminal-server.service\n"), null);
});

test("rootchoice: the dialog asks for a guessed folder or a vanished choice, never a named one", () => {
  assert.equal(rootNeedsAsking({ picked: "found", rootExists: true, pending: null }), true);
  assert.equal(rootNeedsAsking({ picked: "fallback", rootExists: false, pending: null }), true);
  assert.equal(rootNeedsAsking({ picked: "named", rootExists: false, pending: null }), false);
  assert.equal(rootNeedsAsking({ picked: "chosen", rootExists: true, pending: null }), false);
  assert.equal(rootNeedsAsking({ picked: "chosen", rootExists: false, pending: null }), true);
  assert.equal(rootNeedsAsking({ picked: "found", rootExists: true, pending: "/x" }), false, "saved, waiting for a restart");
});

test("rootchoice: the doctor names where a chosen folder is kept, and how to undo a vanished one", () => {
  const ok = checkRoot(process.cwd(), false, "chosen", "/cfg/root.json");
  assert.equal(ok.status, "ok");
  assert.match(ok.detail, new RegExp(`chosen on the phone, kept in /cfg/root.json; ${P}ROOT overrides it`));
  const gone = checkRoot("/nowhere/code", false, "chosen", "/cfg/root.json");
  assert.equal(gone.status, "fail");
  assert.match(gone.fix, /Settings → Code folder, or delete \/cfg\/root.json/);
});
