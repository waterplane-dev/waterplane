/**
 * The daemon's global state dir, moved OUT of the code root (`branddirs.ts`):
 * where it resolves to, and the one-time boot move from `<root>/<state dir>`.
 *
 * Every case here is a way the move loses state or hides it: an empty new dir
 * booted on while the ledger sits in the old one (`acks.json` is the
 * at-most-once memory — an empty one lets a queued prompt run twice), a second
 * boot moving things twice, a full new dir overwritten, a cross-device copy
 * trusted without checking it, a test reaching a person's real state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, cpSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, LEGACY } from "@waterplane/shared";
import {
  STATE_MOVED_NOTE, bindHostStateDir, defaultRoot, hasState, hostStateDir, liveStateDir, migrateStateDir,
  resolveRoot, resolveStateDir, treeMismatch,
} from "../dist/branddirs.js";
import { checkRoot, checkServiceClaudeDir, checkServiceState, checkState } from "../dist/doctor.js";
import { bakedDirs, plistEnv, plistText, unitEnv, unitText } from "../dist/cli/service.js";

const NEW = BRAND.stateDirName;
const OLD = LEGACY[0].stateDirName;
const P = BRAND.envPrefix;
const fresh = (tag) => mkdtempSync(join(tmpdir(), `statedir-${tag}-`));
const put = (p, text) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };
/** A root holding the old layout: an ack ledger, a session list, a nested dir. */
function oldLayout(tag) {
  const home = fresh(tag);
  const root = join(home, "dev");
  put(join(root, NEW, "acks.json"), '{"a1":{"ok":true}}');
  put(join(root, NEW, "sessions.json"), "[1]");
  put(join(root, NEW, "history", "s1.json"), "{}");
  return { home, root, state: join(home, "state", BRAND.configDirName) };
}

// ── where it resolves ──────────────────────────────────────────────────────

test("the state dir: <PREFIX>STATE_DIR, then $XDG_STATE_HOME/<name>, then ~/.local/state/<name>", () => {
  const home = "/home/sam";
  assert.deepEqual(resolveStateDir({}, home), { dir: join(home, ".local", "state", BRAND.configDirName), source: "default" });
  assert.deepEqual(resolveStateDir({ XDG_STATE_HOME: "/x/state" }, home), { dir: join("/x/state", BRAND.configDirName), source: "xdg" });
  assert.deepEqual(resolveStateDir({ XDG_STATE_HOME: "/x/state", [`${P}STATE_DIR`]: "/srv/wp" }, home), { dir: "/srv/wp", source: "env" });
  assert.deepEqual(resolveStateDir({ XDG_STATE_HOME: "  " }, home).source, "default", "a blank XDG is unset");
  assert.equal(resolveStateDir({ [`${LEGACY[0].envPrefix}STATE_DIR`]: "/old/name" }, home).dir, "/old/name", "the legacy knob spelling works too");
  assert.equal(resolveStateDir({ [`${P}STATE_DIR`]: "rel/dir" }, home).dir, join(process.cwd(), "rel/dir"), "made absolute");
});

test("the code root default is ~/dev, defined once, and says when it was assumed", () => {
  assert.equal(defaultRoot("/home/sam"), "/home/sam/dev");
  assert.deepEqual(resolveRoot({}, "/home/sam", { isDir: () => false, hasGitChild: () => false }).root, "/home/sam/dev");
  assert.deepEqual(resolveRoot({ [`${P}ROOT`]: "/code" }, "/home/sam"), { root: "/code", defaulted: false, picked: "named", tried: [] });
});

test("hostStateDir answers the bound dir for the daemon's root only — a scratch root keeps <root>/<state dir>", () => {
  const scratch = fresh("bind");
  // Before anything is bound (a unit test that never imported env.ts): the old layout.
  assert.equal(hostStateDir(scratch), join(scratch, NEW));
  bindHostStateDir("/daemon/root", "/daemon/state");
  assert.equal(hostStateDir("/daemon/root"), "/daemon/state");
  assert.equal(hostStateDir("/daemon/root/"), "/daemon/state", "compared resolved");
  assert.equal(hostStateDir(scratch), join(scratch, NEW), "another root never reaches the bound dir");
});

test("the daemon's root is compared by REALPATH: /var vs /private/var, or a symlinked root, is still the root", () => {
  const home = fresh("real");
  const root = join(home, "dev"); mkdirSync(root);
  const link = join(home, "code"); symlinkSync(root, link, "dir");
  bindHostStateDir(link, join(home, "st"));
  assert.equal(hostStateDir(link), join(home, "st"));
  assert.equal(hostStateDir(realpathSync(root)), join(home, "st"), "the resolved spelling of the same root");
  assert.equal(hostStateDir(root), join(home, "st"));
  assert.notEqual(hostStateDir(home), join(home, "st"));
});

test("a process that does not migrate reads wherever the state is NOW", () => {
  const { root, state } = oldLayout("live");
  assert.equal(liveStateDir(root, state), join(root, NEW), "not moved yet — the old dir, never an empty new one");
  put(join(state, "acks.json"), "{}");
  assert.equal(liveStateDir(root, state), state, "the new dir once it holds state");
  const empty = fresh("live-empty");
  assert.equal(liveStateDir(join(empty, "dev"), join(empty, "s")), join(empty, "s"), "nothing anywhere ⇒ the new dir");
});

// ── the move ───────────────────────────────────────────────────────────────

test("fresh install: nothing anywhere, nothing created", () => {
  const home = fresh("fresh");
  const root = join(home, "dev"); mkdirSync(root);
  const state = join(home, "state", "wp");
  const r = migrateStateDir(root, state);
  assert.equal(r.action, "fresh");
  assert.equal(r.dir, state);
  assert.ok(!existsSync(state), "the move creates nothing; the first store write does");
  assert.deepEqual(readdirSync(root), [], "and nothing is written into the code root");
});

test("move: the old dir is renamed whole, a symlink is left at the old place, and a rerun touches nothing", () => {
  const { root, state } = oldLayout("move");
  const r = migrateStateDir(root, state);
  assert.equal(r.action, "moved", r.note);
  assert.equal(r.dir, state);
  assert.equal(readFileSync(join(state, "acks.json"), "utf8"), '{"a1":{"ok":true}}', "the ack ledger survives byte for byte");
  assert.ok(existsSync(join(state, "history", "s1.json")));
  assert.ok(lstatSync(join(root, NEW)).isSymbolicLink(), "a pointer at the old place");
  assert.equal(readlinkSync(join(root, NEW)), state);
  assert.equal(readFileSync(join(root, NEW, "sessions.json"), "utf8"), "[1]", "old paths still resolve");
  assert.match(r.note, /moved .* to .*symlink/);

  const again = migrateStateDir(root, state);
  assert.equal(again.action, "current", "idempotent");
  assert.equal(again.note, undefined);
  assert.equal(readFileSync(join(state, "acks.json"), "utf8"), '{"a1":{"ok":true}}');
});

test("an EMPTY new dir (made by hand, or an earlier mkdir) does not block the move", () => {
  const { root, state } = oldLayout("emptynew");
  mkdirSync(state, { recursive: true });
  const r = migrateStateDir(root, state);
  assert.equal(r.action, "moved", r.note);
  assert.ok(existsSync(join(state, "acks.json")));
});

test("both hold state: what the new dir lacks is merged in, a collision stays in the old dir, nothing overwritten", () => {
  const { root, state } = oldLayout("both");
  put(join(state, "acks.json"), '{"newer":{"ok":true}}');
  const r = migrateStateDir(root, state);
  assert.equal(r.action, "merged", r.note);
  assert.equal(r.dir, state);
  assert.equal(r.from, join(root, NEW));
  assert.deepEqual(r.kept, ["acks.json"]);
  assert.match(r.note, /BOTH .* held state — merged 2 entries .*in BOTH and stayed in .*: acks\.json/);
  assert.equal(readFileSync(join(state, "acks.json"), "utf8"), '{"newer":{"ok":true}}', "never overwritten");
  assert.equal(readFileSync(join(state, "sessions.json"), "utf8"), "[1]", "what the new dir lacked moved in");
  assert.ok(existsSync(join(state, "history", "s1.json")));
  assert.ok(lstatSync(join(root, NEW)).isDirectory(), "the old dir is still a real dir");
  assert.equal(readFileSync(join(root, NEW, "acks.json"), "utf8"), '{"a1":{"ok":true}}', "its copy of the collision untouched");
  assert.match(readFileSync(join(root, NEW, STATE_MOVED_NOTE), "utf8"), /ALSO in the new one/, "and a note saying why it is there");
  const again = migrateStateDir(root, state);
  assert.equal(again.action, "merged", "a rerun moves nothing more and says so again");
  assert.deepEqual(again.kept, ["acks.json"]);
  assert.match(again.note, /merged 0 entries/);
});

test("a new dir holding only desktop noise (.DS_Store) is NOT state: the old dir moves whole", () => {
  const { root, state } = oldLayout("dsstore");
  put(join(state, ".DS_Store"), "junk");
  assert.equal(hasState(state), false);
  const r = migrateStateDir(root, state, undefined, () => 7);
  assert.equal(r.action, "moved", r.note);
  assert.equal(readFileSync(join(state, "acks.json"), "utf8"), '{"a1":{"ok":true}}', "the daemon boots WITH its ack ledger");
  assert.ok(existsSync(join(`${state}.noise-7`, ".DS_Store")), "the noise was set aside, not deleted");
});

test("a new dir holding only a .env a person put there: the ack ledger is merged in, the .env kept", () => {
  const { root, state } = oldLayout("envonly");
  put(join(root, NEW, ".env"), "WATERPLANE_ALLOWED_HOSTS=old.example\n");
  put(join(state, ".env"), "GEMINI_API_KEY=new\n");
  const r = migrateStateDir(root, state);
  assert.equal(r.action, "merged", r.note);
  assert.equal(r.dir, state);
  assert.equal(readFileSync(join(state, "acks.json"), "utf8"), '{"a1":{"ok":true}}', "never booted on a dir with no acks.json");
  assert.equal(readFileSync(join(state, ".env"), "utf8"), "GEMINI_API_KEY=new\n", "the new .env wins");
  assert.equal(readFileSync(join(root, NEW, ".env"), "utf8"), "WATERPLANE_ALLOWED_HOSTS=old.example\n", "the old one kept, named in the note");
  assert.deepEqual(r.kept, [".env"]);
  assert.match(r.note, /in BOTH and stayed .*: \.env/);
});

test("merge: if the ack ledger cannot move, nothing else does and the OLD dir is bound", () => {
  const { root, state } = oldLayout("ackfail");
  put(join(state, ".env"), "X=1\n");
  const ops = {
    rename(a, b) { if (a.endsWith("acks.json")) { const e = new Error("busy"); e.code = "EBUSY"; throw e; } renameSync(a, b); },
    copy() { throw new Error("unreached"); },
  };
  const r = migrateStateDir(root, state, ops);
  assert.equal(r.action, "failed");
  assert.equal(r.dir, join(root, NEW), "booting on the new dir would have no at-most-once memory");
  assert.match(r.note, /ack ledger could not be moved/);
  assert.ok(existsSync(join(root, NEW, "sessions.json")) && !existsSync(join(state, "sessions.json")), "nothing else moved");
});

test("merge across devices: each entry copied, verified, swapped in, the source renamed aside", () => {
  const { root, state } = oldLayout("mergexdev");
  put(join(state, ".env"), "X=1\n");
  const ops = {
    rename(a, b) {
      if (a.startsWith(join(root, NEW) + "/") && b.startsWith(state + "/")) { const e = new Error("EXDEV"); e.code = "EXDEV"; throw e; }
      renameSync(a, b);
    },
    copy(a, b) { cpSync(a, b, { recursive: true }); },
  };
  const r = migrateStateDir(root, state, ops, () => 9);
  assert.equal(r.action, "merged", r.note);
  assert.equal(readFileSync(join(state, "acks.json"), "utf8"), '{"a1":{"ok":true}}');
  assert.ok(existsSync(join(state, "history", "s1.json")));
  assert.ok(existsSync(join(root, NEW, "acks.json.moved-9")), "the old bytes kept, renamed aside");
  assert.equal(hasState(join(root, NEW)), false, "an aside copy is not state to merge again");
});

test("an interrupted cross-device copy (swapped in, old never renamed aside) is finished, not merged", () => {
  const { root, state } = oldLayout("finish");
  cpSync(join(root, NEW), state, { recursive: true, preserveTimestamps: true });
  const r = migrateStateDir(root, state, undefined, () => 5);
  assert.equal(r.action, "copied", r.note);
  assert.equal(r.aside, join(root, `${NEW}.moved-5`));
  assert.ok(lstatSync(join(root, NEW)).isSymbolicLink());
});

test("a crash between rename and pointer: the next boot puts the pointer back — and never invents one", () => {
  const { root, state } = oldLayout("repair");
  assert.equal(migrateStateDir(root, state).action, "moved");
  rmSync(join(root, NEW)); // the symlink, as if the crash came first
  const r = migrateStateDir(root, state);
  assert.equal(r.action, "current");
  assert.match(r.note, /pointer .* was missing/);
  assert.ok(lstatSync(join(root, NEW)).isSymbolicLink());
  // A fresh install whose state dir already holds state, and a root that never had one: nothing written there.
  const home = fresh("repair-fresh");
  const root2 = join(home, "dev"); mkdirSync(root2);
  put(join(home, "s", "acks.json"), "{}");
  assert.equal(migrateStateDir(root2, join(home, "s")).note, undefined);
  assert.deepEqual(readdirSync(root2), [], "no pointer in a code folder state never lived in");
});

test("stale <new>.incoming-* staging copies are removed on the next boot; the old dir is not touched", () => {
  const { root, state } = oldLayout("incoming");
  put(join(`${state}.incoming-123`, "acks.json"), "{}");
  put(join(`${state}.incoming-x`, "keep"), "not ours: no number");
  const r = migrateStateDir(root, state);
  assert.equal(r.action, "moved");
  assert.match(r.note, /removed 1 stale staging copy/);
  assert.ok(!existsSync(`${state}.incoming-123`));
  assert.ok(existsSync(`${state}.incoming-x`));
});

test("cross-device: copy, verify, swap in, rename the old aside — never delete it", () => {
  const { root, state } = oldLayout("exdev");
  const calls = [];
  const ops = {
    rename(a, b) {
      calls.push(["rename", a, b]);
      if (a === join(root, NEW) && b === state) { const e = new Error("cross-device link not permitted"); e.code = "EXDEV"; throw e; }
      renameSync(a, b);
    },
    copy(a, b) { calls.push(["copy", a, b]); cpSync(a, b, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true }); },
  };
  const r = migrateStateDir(root, state, ops, () => 1234);
  assert.equal(r.action, "copied", r.note);
  assert.equal(r.dir, state);
  assert.equal(r.aside, join(root, `${NEW}.moved-1234`));
  assert.equal(readFileSync(join(state, "acks.json"), "utf8"), '{"a1":{"ok":true}}');
  assert.equal(readFileSync(join(root, `${NEW}.moved-1234`, "acks.json"), "utf8"), '{"a1":{"ok":true}}', "the old bytes are kept, renamed aside");
  assert.ok(lstatSync(join(root, NEW)).isSymbolicLink(), "and a pointer at the old name");
  assert.ok(!existsSync(`${state}.incoming-1234`), "the staging copy was swapped in, not left behind");
  assert.deepEqual(calls.map((c) => c[0]), ["rename", "copy", "rename", "rename"]);
  assert.equal(migrateStateDir(root, state, ops).action, "current", "idempotent: the aside dir is not state to move again");
});

test("cross-device copy that does not verify: nothing swapped in, the OLD dir stays in use", () => {
  const { root, state } = oldLayout("badcopy");
  const ops = {
    rename(a, b) { if (b === state && a === join(root, NEW)) { const e = new Error("EXDEV"); e.code = "EXDEV"; throw e; } renameSync(a, b); },
    copy(a, b) { cpSync(a, b, { recursive: true }); writeFileSync(join(b, "acks.json"), "{}"); }, // a truncated ledger
  };
  const r = migrateStateDir(root, state, ops, () => 1);
  assert.equal(r.action, "failed");
  assert.equal(r.dir, join(root, NEW), "bind the old dir — booting on an empty ledger would re-run prompts");
  assert.match(r.note, /did not verify: acks\.json differs/);
  assert.ok(!existsSync(state), "nothing half-made at the new place");
  assert.ok(!existsSync(`${state}.incoming-1`), "our own bad copy removed");
  assert.equal(readFileSync(join(root, NEW, "acks.json"), "utf8"), '{"a1":{"ok":true}}', "the old ledger untouched");
});

test("a rename that fails for another reason: the old dir stays in use, untouched", () => {
  const { root, state } = oldLayout("eperm");
  const ops = { rename() { const e = new Error("operation not permitted"); e.code = "EPERM"; throw e; }, copy() { throw new Error("unreached"); } };
  const r = migrateStateDir(root, state, ops);
  assert.equal(r.action, "failed");
  assert.equal(r.dir, join(root, NEW));
  assert.match(r.note, /could not move .*\(operation not permitted\)/);
});

test("a legacy-named dir under the root is moved too, when nothing renamed it first", () => {
  const home = fresh("legacy");
  const root = join(home, "dev");
  put(join(root, OLD, "acks.json"), "{}");
  const state = join(home, "s");
  const r = migrateStateDir(root, state);
  assert.equal(r.action, "moved", r.note);
  assert.equal(r.from, join(root, OLD));
  assert.ok(existsSync(join(state, "acks.json")));
});

test("the brand rename's symlink (legacy → current) is not state to move", () => {
  const { root, state } = oldLayout("chain");
  symlinkSync(NEW, join(root, OLD), "dir"); // what branddirs' brand move leaves
  const r = migrateStateDir(root, state);
  assert.equal(r.action, "moved");
  assert.equal(r.from, join(root, NEW));
  assert.equal(readFileSync(join(root, OLD, "acks.json"), "utf8"), '{"a1":{"ok":true}}', "the old-old name resolves through both links");
  assert.equal(migrateStateDir(root, state).action, "current");
});

test("e2e pins the state dir AT <root>/<state dir>: that is 'same', and nothing moves", () => {
  const { root } = oldLayout("same");
  const r = migrateStateDir(root, join(root, NEW));
  assert.equal(r.action, "same");
  assert.ok(lstatSync(join(root, NEW)).isDirectory() && !lstatSync(join(root, NEW)).isSymbolicLink());
});

test("a note-only dir at the old place is not state (the pointer when a symlink was impossible)", () => {
  const home = fresh("note");
  const root = join(home, "dev");
  put(join(root, NEW, STATE_MOVED_NOTE), "moved");
  assert.equal(hasState(join(root, NEW)), false);
  assert.equal(migrateStateDir(root, join(home, "s")).action, "fresh");
});

test("treeMismatch: names, kinds, sizes and bytes", () => {
  const a = fresh("tree-a"), b = fresh("tree-b");
  put(join(a, "x", "y.json"), "12"); put(join(b, "x", "y.json"), "12");
  assert.equal(treeMismatch(a, b), null);
  writeFileSync(join(b, "x", "y.json"), "13");
  assert.equal(treeMismatch(a, b), "x/y.json differs", "same size, different bytes");
  writeFileSync(join(b, "x", "y.json"), "12"); put(join(b, "z"), "");
  assert.equal(treeMismatch(a, b), "z is extra");
});

// ── the doctor's rows ──────────────────────────────────────────────────────

test("doctor: a defaulted root that does not exist says it was a guess and how to name the real one", () => {
  const c = checkRoot("/nowhere/dev", true);
  assert.equal(c.status, "fail");
  assert.match(c.detail, /none of the usual ones .* exists, so the phone would list no repos/);
  assert.match(c.fix, new RegExp(`--env ${P}ROOT=`));
  assert.match(checkRoot("/nowhere/dev", false).detail, /does not exist$/, "a named root that is missing keeps its old sentence");
});

test("doctor: the state row names the dir, and warns while an old under-root dir still holds state", () => {
  const { root, home } = oldLayout("doctor");
  const saved = { s: process.env[`${P}STATE_DIR`] };
  process.env[`${P}STATE_DIR`] = join(home, "st");
  try {
    const pending = checkState(root);
    assert.equal(pending.status, "warn");
    assert.match(pending.detail, /still in .*inside the code folder; it belongs in .*st/);
    migrateStateDir(root, join(home, "st"));
    const done = checkState(root);
    assert.equal(done.status, "ok");
    assert.match(done.detail, new RegExp(`host state in .*st \\(${P}STATE_DIR\\)`));
  } finally {
    if (saved.s === undefined) delete process.env[`${P}STATE_DIR`]; else process.env[`${P}STATE_DIR`] = saved.s;
  }
});

test("doctor: a state dir the host cannot write FAILS, saying new work is refused and a retry may run twice", { skip: process.getuid?.() === 0 && "root ignores directory modes" }, () => {
  const home = fresh("doctor-ro");
  const st = join(home, "st");
  mkdirSync(st, { recursive: true });
  const saved = { s: process.env[`${P}STATE_DIR`] };
  process.env[`${P}STATE_DIR`] = st;
  chmodSync(st, 0o500);
  try {
    const c = checkState(join(home, "dev"));
    assert.equal(c.status, "fail");
    assert.match(c.detail, /is not writable \(EACCES\)/);
    assert.match(c.detail, /a retry after a restart may run twice/);
    assert.match(c.fix, /writable/);
  } finally {
    chmodSync(st, 0o700);
    if (saved.s === undefined) delete process.env[`${P}STATE_DIR`]; else process.env[`${P}STATE_DIR`] = saved.s;
  }
  // Writable again ⇒ the ordinary row.
  process.env[`${P}STATE_DIR`] = st;
  try { assert.equal(checkState(join(home, "dev")).status, "ok"); } finally {
    if (saved.s === undefined) delete process.env[`${P}STATE_DIR`]; else process.env[`${P}STATE_DIR`] = saved.s;
  }
});

test("doctor: warns when the installed service would keep state somewhere else than this shell", () => {
  const svc = { file: "/x/svc.plist", env: { HOME: "/home/sam" } };
  const here = { HOME: "/home/sam", XDG_STATE_HOME: "/xdg" };
  const c = checkServiceState(svc, here);
  assert.equal(c.status, "warn");
  assert.match(c.detail, /keeps host state in \/home\/sam\/\.local\/state\/.* but this shell resolves \/xdg\//);
  assert.match(c.fix, /service install --force/);
  assert.equal(checkServiceState({ file: "/x", env: { HOME: "/h", [`${P}STATE_DIR`]: "/same" } }, { [`${P}STATE_DIR`]: "/same" }), null, "agreeing is silent");
  assert.equal(checkServiceState(null, here), null, "no service, no row");
});

test("doctor: warns when the installed service would run claude against another config dir than this shell", () => {
  const svc = { file: "/x/svc.plist", env: { HOME: "/home/sam" } };
  const c = checkServiceClaudeDir(svc, { HOME: "/home/sam", CLAUDE_CONFIG_DIR: "/cfg" });
  assert.equal(c.status, "warn");
  assert.match(c.detail, /config in \/home\/sam\/\.claude, but this shell's claude uses \/cfg$/);
  assert.match(c.fix, /service install --force.*unset CLAUDE_CONFIG_DIR here/);
  const baked = { file: "/x", env: { HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" } };
  assert.match(checkServiceClaudeDir(baked, {}).fix, /set CLAUDE_CONFIG_DIR=\/cfg here/);
  assert.equal(checkServiceClaudeDir(baked, { CLAUDE_CONFIG_DIR: "/cfg" }), null, "agreeing is silent");
  assert.equal(checkServiceClaudeDir(null, {}), null, "no service, no row");
});

test("service install bakes the RESOLVED state dir, the root and CLAUDE_CONFIG_DIR only when named, and they read back out of the plist and the unit", () => {
  assert.deepEqual(bakedDirs({ XDG_STATE_HOME: "/xdg" }, "/home/sam", "/cwd"), { [`${P}STATE_DIR`]: `/xdg/${BRAND.configDirName}` },
    "an unnamed root is NOT baked: the daemon re-derives ~/dev from HOME and still knows it was defaulted");
  const baked = bakedDirs({ XDG_STATE_HOME: "/xdg", [`${P}ROOT`]: "code", CLAUDE_CONFIG_DIR: "/cfg/claude" }, "/home/sam", "/cwd");
  assert.deepEqual(baked, { [`${P}ROOT`]: "/cwd/code", [`${P}STATE_DIR`]: `/xdg/${BRAND.configDirName}`, CLAUDE_CONFIG_DIR: "/cfg/claude" });
  assert.equal(bakedDirs({ CLAUDE_CONFIG_DIR: "  " }, "/h", "/cwd").CLAUDE_CONFIG_DIR, undefined, "blank is unset, like the CLI");
  assert.equal(bakedDirs({ CLAUDE_CONFIG_DIR: "rel" }, "/h", "/cwd").CLAUDE_CONFIG_DIR, "/cwd/rel");
  assert.equal(bakedDirs({ [`${P}STATE_DIR`]: "rel" }, "/h", "/cwd")[`${P}STATE_DIR`], "/cwd/rel", "absolute, against the installing shell's cwd");
  const env = { PATH: "/bin", HOME: "/home/sam", ...baked, ODD: 'a "q" & <b> 50%' };
  const spec = { program: ["/n", "/e", "start"], workingDir: "/home/sam", env };
  assert.deepEqual(plistEnv(plistText({ ...spec, label: "l", outLog: "/o", errLog: "/e" })), env);
  assert.deepEqual(unitEnv(unitText({ ...spec, description: "d" })), env);
});
