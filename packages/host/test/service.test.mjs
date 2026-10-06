/**
 * `cli/service.ts`'s pure half: the plist and unit text, the env it may bake
 * in (never ALLOW_PUBLIC, never the shell's), the path mapping onto the
 * installer's stable symlinks, and the refusal to replace a dev checkout's
 * launchd job — which shares the label with a release install.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND, LEGACY } from "@waterplane/shared";

const S = await import("../dist/cli/service.js");

const spec = {
  program: ["/d/runtime/current/bin/node", `/d/current/bin/${BRAND.slug}.mjs`, "start"],
  workingDir: "/home/u",
  env: { PATH: "/d/runtime/current/bin:/usr/bin", HOME: "/home/u", FOO: 'a "q" & <b> 50%' },
};

test("plist: label, argv, env, KeepAlive, logs — XML-escaped", () => {
  const t = S.plistText({ ...spec, label: BRAND.launchdLabel, outLog: "/l/o.log", errLog: "/l/e.log" });
  assert.match(t, new RegExp(`<string>${BRAND.launchdLabel.replace(/\./g, "\\.")}</string>`));
  assert.match(t, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(t, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(t, /<string>a &quot;q&quot; &amp; &lt;b&gt; 50%<\/string>/);
  assert.match(t, /<key>StandardErrorPath<\/key>\s*<string>\/l\/e\.log<\/string>/);
  assert.deepEqual(S.plistProgram(t), spec.program, "the argv round-trips through the parser status uses");
});

test("unit: Restart=always, quoted ExecStart and Environment, % doubled", () => {
  const t = S.unitText({ ...spec, description: "host" });
  assert.match(t, /^Restart=always$/m);
  assert.match(t, /^WantedBy=default\.target$/m);
  assert.match(t, /^Environment="PATH=\/d\/runtime\/current\/bin:\/usr\/bin"$/m);
  assert.match(t, /^Environment="FOO=a \\"q\\" & <b> 50%%"$/m);
  assert.deepEqual(S.unitProgram(t), spec.program);
});

test("unit: WorkingDirectory is a bare path — systemd refuses a quoted one and never starts the unit", () => {
  const t = S.unitText({ ...spec, workingDir: "/home/a b/50%", description: "host" });
  assert.match(t, /^WorkingDirectory=\/home\/a b\/50%%$/m);
});

test("--env: repeatable, and never the public-bind switch in any spelling", () => {
  const a = S.parseArgs(["install", "--env", "A=1", "--env=B=x=y", "--dry-run"]);
  assert.equal(a.cmd, "install");
  assert.equal(a.dryRun, true);
  assert.deepEqual(a.env, { A: "1", B: "x=y" });
  for (const p of [BRAND.envPrefix, ...LEGACY.map((l) => l.envPrefix)]) {
    assert.throws(() => S.parseArgs(["install", "--env", `${p}ALLOW_PUBLIC=1`]), /refused/);
  }
  assert.throws(() => S.parseArgs(["install", "--env", "PATH=/x"]), /computes PATH/);
  assert.throws(() => S.parseArgs(["install", "--env", "1BAD=x"]), /not a valid/);
  assert.throws(() => S.parseArgs(["install", "--env", "NOEQ"]), /KEY=VALUE/);
  assert.throws(() => S.parseArgs(["frobnicate"]), /unknown argument/);
  assert.equal(S.parseArgs([]).cmd, "help");
});

test("paths map onto the installer's stable symlinks only when they exist", () => {
  const raw = { node: "/d/runtime/node-v24.1.0-darwin-arm64/bin/node", entry: `/d/versions/1.2.3/bin/${BRAND.slug}.mjs` };
  assert.deepEqual(S.stablePaths(raw, () => true),
    { node: "/d/runtime/current/bin/node", entry: `/d/current/bin/${BRAND.slug}.mjs` });
  assert.deepEqual(S.stablePaths(raw, () => false), raw, "no symlink, no rewrite");
  // selfupdate.ts restarts a service only if its text names the data dir: the
  // generated file must carry `/d/...` via the stable links, never versions/<v>.
  const st = S.stablePaths(raw, () => true);
  const plist = S.plistText({ program: [st.node, st.entry, "start"], workingDir: "/h", env: { PATH: "/x" },
    label: BRAND.launchdLabel, outLog: "/o", errLog: "/e" });
  assert.ok(plist.includes("/d/runtime/current/bin/node") && plist.includes("/d/current/bin/"));
  assert.doesNotMatch(plist, /versions\//);
  const npm = { node: "/usr/local/bin/node", entry: `/usr/local/lib/node_modules/x/bin/${BRAND.slug}.mjs` };
  assert.deepEqual(S.stablePaths(npm, () => true), npm, "an npm -g install is left as it is");
});

test("PATH: given dirs first, platform defaults after, deduped, nulls dropped", () => {
  assert.equal(S.composePath(["/n/bin", null, "/usr/bin", "/c/bin"], "linux"),
    "/n/bin:/usr/bin:/c/bin:/usr/local/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin");
  assert.match(S.composePath([], "darwin"), /^\/opt\/homebrew\/bin:/);
});

test("WSL without systemd: both fixes, the exact Task Scheduler line, and the idle-VM caveat", () => {
  const lines = S.wslAdviceLines("Ubuntu", `/home/u/.local/bin/${BRAND.slug} start`, false).join("\n");
  assert.match(lines, /\[boot\]\n\s+systemd=true/);
  assert.match(lines, /wsl --shutdown/);
  assert.ok(lines.includes(`/tr "wsl.exe -d Ubuntu -e /home/u/.local/bin/${BRAND.slug} start"`), lines);
  assert.match(lines, /vmIdleTimeout/);
  const withSystemd = S.wslAdviceLines(undefined, "x start", true).join("\n");
  assert.doesNotMatch(withSystemd, /systemd=true/);
  assert.match(withSystemd, /vmIdleTimeout/, "the idle caveat holds with systemd too");
});

test("a dev checkout's job is refused without --force, and the sentence names it", () => {
  const checkout = ["/opt/homebrew/bin/node", "/Users/u/dev/repo/packages/host/dist/main.js"];
  const ex = S.classify(checkout, (d) => d === "/Users/u/dev/repo");
  assert.deepEqual(ex.kind, "checkout");
  assert.equal(ex.repo, "/Users/u/dev/repo");
  const s = S.conflictSentence(ex, "/p.plist", false);
  assert.match(s, /\/Users\/u\/dev\/repo/);
  assert.match(s, /deploy\/uninstall-service\.sh/);
  assert.match(s, /--force/);
  assert.equal(S.conflictSentence(ex, "/p.plist", true), null);
  // Same path shape but no .git: not a checkout, nothing to refuse.
  assert.equal(S.classify(checkout, () => false).kind, "other");
  const rel = S.classify(spec.program, () => false);
  assert.equal(rel.kind, "release");
  assert.equal(S.conflictSentence(rel, "/p.plist", false), null);
  assert.equal(S.conflictSentence(null, "/p.plist", false), null);
});
