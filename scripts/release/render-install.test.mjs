// node --test: the installer's plugin catalogue — rendering, the refusal sentences, and the
// clone-verify-place path against a local fixture repo. Temp dirs only; the real installer is
// never pointed at this machine (no node download, no service: the script's plugin functions are
// driven after cutting off its last line, `main "$@"`).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { builtinLines, catalogueLines, installVars, renderInstall } from "./render-install.mjs";
import { PUBKEY_PATH, generateKeys, loadPrivateKey, pubkeyLine, signFile } from "./sign-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TMPL = readFileSync(join(ROOT, "deploy/install.sh.tmpl"), "utf8");
const { NAME, SLUG, MANIFEST } = await installVars({ root: ROOT });
const PLUGINS = JSON.parse(readFileSync(join(ROOT, "deploy/plugins.json"), "utf8"));

const entry = (o = {}) => ({ id: "demo", name: "Demo plugin", repo: "https://example.invalid/demo.git", ref: "v1.0.0", description: "d", listed: true, ...o });

/**
 * The builtins the rendered script is told about: a FIXTURE, not this tree's — the optional one
 * (`optbuiltin`) stands for whichever extension a checkout carries; the public tree has none
 * (the private ones stay out of it), and these sentences must be pinned either way.
 */
const BUILTINS = "optbuiltin|1\nrequirements|0\ntoken-stats|0";

async function render(plugins) {
  const vars = await installVars({ root: ROOT });
  vars.CATALOGUE = catalogueLines({ plugins });
  vars.BUILTINS = BUILTINS;
  return renderInstall(TMPL, vars);
}

function runScript(script, args, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  const f = join(dir, "install.sh");
  writeFileSync(f, script);
  const r = spawnSync("sh", [f, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, ...env } });
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

test("the shipped deploy/plugins.json renders; every listed entry is pinned to a commit", async () => {
  assert.ok(Array.isArray(PLUGINS.plugins));
  for (const p of PLUGINS.plugins.filter((x) => x.listed)) {
    assert.match(p.ref, /^[0-9a-f]{40}$/, `${p.id}: ref is a full commit sha, never a branch or a TODO`);
    assert.ok(!/TODO/.test(p.repo), `${p.id}: a listed entry names its real repo`);
  }
  assert.ok(PLUGINS.plugins.find((p) => p.id === "copilot")?.listed, "Copilot is listed since its real check on 1.0.91");
  const text = await render(PLUGINS.plugins);
  assert.ok(!/@@[A-Z_]+@@/.test(text), "no placeholder left");
  assert.ok(text.includes("copilot|1|1|https://github.com/waterplane-dev/waterplane-plugin-copilot.git|"), "the listed entry is carried");
});

test("the rendered script parses (bash -n and sh -n)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  const f = join(dir, "install.sh");
  writeFileSync(f, await render([entry()]));
  for (const sh of ["bash", "sh"]) assert.equal(spawnSync(sh, ["-n", f]).status, 0, `${sh} -n`);
  rmSync(dir, { recursive: true, force: true });
});

test("catalogueLines checks every field and refuses a TODO on a listed entry", () => {
  assert.throws(() => catalogueLines({ plugins: [entry({ id: "Bad_Id" })] }), /id must match/);
  assert.throws(() => catalogueLines({ plugins: [entry(), entry()] }), /duplicate/);
  assert.throws(() => catalogueLines({ plugins: [entry({ listed: "yes" })] }), /listed/);
  assert.throws(() => catalogueLines({ plugins: [entry({ repo: "http://example.invalid/x.git" })] }), /repo must be/);
  assert.throws(() => catalogueLines({ plugins: [entry({ repo: "https://x.invalid/a b.git" })] }), /repo must be/);
  assert.throws(() => catalogueLines({ plugins: [entry({ ref: "v1; rm -rf ~" })] }), /ref must be/);
  assert.throws(() => catalogueLines({ plugins: [entry({ ref: "--upload-pack=x" })] }), /ref must be/);
  assert.throws(() => catalogueLines({ plugins: [entry({ name: "a$(b)" })] }), /name/);
  assert.throws(() => catalogueLines({ plugins: [entry({ repo: "https://github.com/TODO-org/x.git" })] }), /TODO/);
  assert.doesNotThrow(() => catalogueLines({ plugins: [entry({ repo: "https://github.com/TODO-org/x.git", listed: false })] }));
  assert.equal(catalogueLines({ plugins: [entry({ experimental: true })] }), "demo|1|1|https://example.invalid/demo.git|v1.0.0|Demo plugin");
});

test("builtinLines reads the in-repo extensions and marks an optional one", () => {
  const lines = builtinLines(ROOT, MANIFEST).split("\n");
  assert.ok(lines.includes("token-stats|0"));
  const root = mkdtempSync(join(tmpdir(), "inst-builtins-"));
  try {
    for (const [id, optional] of [["optbuiltin", true], ["core-one", false]]) {
      mkdirSync(join(root, "packages/extensions", id), { recursive: true });
      writeFileSync(join(root, "packages/extensions", id, MANIFEST), JSON.stringify({ id, ...(optional ? { optional: true } : {}) }));
    }
    assert.equal(builtinLines(root, MANIFEST), "core-one|0\noptbuiltin|1");
    assert.equal(builtinLines(root, MANIFEST, ["optbuiltin"]), "core-one|0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--with refuses unknown, unlisted and builtin ids in words, before anything is fetched", async () => {
  const s = await render([entry(), entry({ id: "later", listed: false })]);
  const unknown = runScript(s, ["--with", "nope"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /no plugin called 'nope' is in this installer's catalogue\. Installable plugins: demo\./);
  const unlisted = runScript(s, ["--with", "later"]);
  assert.equal(unlisted.code, 1);
  assert.match(unlisted.out, new RegExp(`known to ${NAME} but not published yet`));
  const builtin = runScript(s, ["--with", "optbuiltin"]);
  assert.equal(builtin.code, 1);
  assert.match(builtin.out, new RegExp(`built into ${NAME} and ships inside the release`));
  assert.match(builtin.out, /--without optbuiltin/);
  const bad = runScript(s, ["--with", "Bad/Id"]);
  assert.match(bad.out, /not a plugin id/);
  for (const r of [unknown, unlisted, builtin, bad]) assert.ok(!/downloading|installing/.test(r.out), "refused before any work");
});

test("--without refuses a non-builtin and a non-optional builtin in words", async () => {
  const s = await render([entry()]);
  const ext = runScript(s, ["--without", "demo"]);
  assert.equal(ext.code, 1);
  assert.match(ext.out, new RegExp(`not a built-in extension of ${NAME}`));
  const core = runScript(s, ["--without", "token-stats"]);
  assert.equal(core.code, 1);
  assert.match(core.out, new RegExp(`part of ${NAME} itself and cannot be switched off`));
});

test("--help lists only listed plugins, or says none yet", async () => {
  assert.match(runScript(await render(PLUGINS.plugins), ["--help"]).out, /--with <id>[\s\S]*copilot {2}GitHub Copilot CLI backend \(experimental\)/);
  assert.match(runScript(await render([entry({ listed: false })]), ["--help"]).out, /--with <id>[\s\S]*\(none yet\)/);
  const out = runScript(await render([entry({ experimental: true }), entry({ id: "hidden", listed: false })]), ["--help"]).out;
  assert.match(out, /demo {2}Demo plugin \(experimental\)/);
  assert.ok(!out.includes("hidden"));
});

// ── the fetch path, against a local repo reached through git's insteadOf ───────────────────

function fixtureRepo(dir, manifestId) {
  const repo = join(dir, "remote");
  mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(repo, MANIFEST), JSON.stringify({ id: manifestId }));
  // A hook that would leave a mark if the installer ever executed plugin code.
  writeFileSync(join(repo, "host.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(dir, "RAN"))}, "x");\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("tag", "v1.0.0");
  return repo;
}

async function drive(manifestId, ref = "v1.0.0") {
  const dir = mkdtempSync(join(tmpdir(), "inst-fetch-"));
  const remote = fixtureRepo(dir, manifestId);
  const script = (await render([entry({ ref })])).replace(/\nmain "\$@"\s*$/, "\n");
  const config = join(dir, "config");
  const driver = `${script}
NODE='${process.execPath}'; TMP='${join(dir, "tmp")}'; mkdir -p "$TMP"
CONFIG_DIR='${config}'; WITH_IDS=' demo'; WITHOUT_IDS=''
resolve_plugins; stage_plugins; place_plugins
`;
  writeFileSync(join(dir, "drive.sh"), driver);
  const r = spawnSync("sh", [join(dir, "drive.sh")], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, HOME: dir,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: "https://example.invalid/demo.git",
    },
  });
  return { dir, config, out: (r.stdout || "") + (r.stderr || ""), code: r.status };
}

test("--with clones at the pinned ref, verifies the manifest id, and never runs plugin code", async () => {
  const r = await drive("demo");
  try {
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(r.config, `plugins/demo/${MANIFEST}`)));
    assert.ok(existsSync(join(r.config, `plugins/demo/.git/${SLUG}-installer-plugin`)), "marked as the installer's");
    assert.ok(!existsSync(join(r.dir, "RAN")), "host.mjs was not executed");
    assert.match(r.out, /none of its code was run here/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("--with refuses a manifest whose id differs from the catalogue's, and a missing ref, installing nothing", async () => {
  const wrongId = await drive("something-else");
  try {
    assert.equal(wrongId.code, 1);
    assert.match(wrongId.out, /declares plugin id 'something-else', not 'demo'\. Nothing was installed\./);
    assert.ok(!existsSync(join(wrongId.config, "plugins/demo")));
  } finally { rmSync(wrongId.dir, { recursive: true, force: true }); }
  const noRef = await drive("demo", "v9.9.9");
  try {
    assert.equal(noRef.code, 1);
    assert.match(noRef.out, /has no tag or commit 'v9\.9\.9'\. Nothing was installed\./);
  } finally { rmSync(noRef.dir, { recursive: true, force: true }); }
});

test("--without writes the per-install switch the registry honours, keeping what was there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inst-without-"));
  try {
    const state = join(dir, "root", ".waterplane");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "plugins.json"), JSON.stringify({ enabled: { other: false } }));
    const script = (await render([entry()])).replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(join(dir, "drive.sh"), `${script}\nNODE='${process.execPath}'; WITHOUT_IDS=' optbuiltin'\napply_without\n`);
    const r = spawnSync("sh", [join(dir, "drive.sh")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, WATERPLANE_ROOT: join(dir, "root") } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(state, "plugins.json"), "utf8")), { enabled: { other: false, optbuiltin: false } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--without on a fresh install writes the host's GLOBAL state dir, never the code root", async () => {
  const script = (await render([entry()])).replace(/\nmain "\$@"\s*$/, "\n");
  const drive = (dir, env) => {
    writeFileSync(join(dir, "drive.sh"), `${script}\nNODE='${process.execPath}'; WITHOUT_IDS='optbuiltin'\napply_without\n`);
    return spawnSync("sh", [join(dir, "drive.sh")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, WATERPLANE_ROOT: join(dir, "root"), ...env } });
  };
  const dir = mkdtempSync(join(tmpdir(), "inst-without-new-"));
  try {
    const r = drive(dir, {});
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".local", "state", "waterplane", "plugins.json"), "utf8")), { enabled: { optbuiltin: false } });
    assert.ok(!existsSync(join(dir, "root")), "nothing written into the code root");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const dir2 = mkdtempSync(join(tmpdir(), "inst-without-env-"));
  try {
    const r = drive(dir2, { XDG_STATE_HOME: join(dir2, "xdg"), WATERPLANE_STATE_DIR: join(dir2, "pinned") });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir2, "pinned", "plugins.json")), "the knob beats XDG, as in the host");
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});

// ── the https front door: finish_https, driven with a fake `tailscale` on PATH ─────────────────
const ENV_PREFIX = (await installVars({ root: ROOT })).ENV_PREFIX;

async function frontDoor(serveJson, { port, files = {}, env = {}, lead = "", noTailscale = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-front-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  writeFileSync(join(bin, "tailscale"), `#!/bin/sh
case "$1 $2" in
  "serve status") cat <<'J'
${serveJson}
J
  ;;
  "status --json") printf '%s\\n' '{' '  "Self": {' '    "DNSName": "mac.tail1234.ts.net.",' '  },' '  "Peer": {' '    "DNSName": "other.tail1234.ts.net."' '  }' '}' ;;
  "serve --bg") echo "RAN: $*" >> "${join(dir, "ran")}" ;;
esac
`, { mode: 0o755 });
  const script = (await render([])).replace(/\nmain "\$@"\s*$/, "\n");
  // No tailscale: find_tailscale also looks in /Applications, so it is stubbed rather than hidden.
  const none = noTailscale ? "find_tailscale() { :; }\n" : "";
  writeFileSync(join(dir, "drive.sh"), `${script}\n${none}finish_https '${lead}' || echo FINISH_FAILED\n`);
  const r = spawnSync("sh", [join(dir, "drive.sh")], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...(port ? { [`${ENV_PREFIX}PORT`]: String(port) } : {}), ...env },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const ran = existsSync(join(dir, "ran"));
  rmSync(dir, { recursive: true, force: true });
  return { out, code: r.status, ran };
}
const serveTo = (key, target) => JSON.stringify({ Web: { [key]: { Handlers: { "/": { Proxy: target } } } } }, null, 2);

test("front door: a serve already proxying the host port is reported, never re-created", async () => {
  const r = await frontDoor(serveTo("mac.tail1234.ts.net:8443", "http://127.0.0.1:8770"));
  assert.equal(r.code, 0);
  assert.match(r.out, /open this on your phone.*https:\/\/mac\.tail1234\.ts\.net:8443/);
  assert.doesNotMatch(r.out, /Run:/);
});

test("front door: a serve to ANOTHER port does not count as fronting this host", async () => {
  const r = await frontDoor(serveTo("mac.tail1234.ts.net:443", "http://127.0.0.1:3000"));
  assert.match(r.out, /Run:\s+tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:8770/, "443 is taken, so another https port");
  assert.match(r.out, /already serves something else/);
});

test("front door: no serve prints the exact line, the prerequisite and the https URL LAST; non-interactive runs nothing", async () => {
  const r = await frontDoor("{}");
  const lines = r.out.trim().split("\n");
  assert.match(r.out, /Run:\s+tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:8770/);
  assert.match(r.out, /MagicDNS and HTTPS certificates/);
  assert.match(lines[lines.length - 1], /Then open on your phone: https:\/\/mac\.tail1234\.ts\.net$/, "Self's name, not a peer's");
  assert.doesNotMatch(r.out, /\[y\/N\]/, "no prompt without a terminal");
  assert.equal(r.ran, false, "nothing ran without consent");
});

test("front door: the port follows the configured one, never an assumed 8770", async () => {
  const r = await frontDoor("{}", { port: 9001 });
  assert.match(r.out, /http:\/\/127\.0\.0\.1:9001/);
});

test("front door: the port is read from the host's .env files in the host's order when the shell has none", async () => {
  const K = `${ENV_PREFIX}PORT`;
  const cfg = `.config/${(await installVars({ root: ROOT })).CONFIG_NAME}/.env`;
  const state = `.local/state/${(await installVars({ root: ROOT })).CONFIG_NAME}/.env`;
  const inst = `.local/share/${(await installVars({ root: ROOT })).SLUG}/current/.env`;
  let r = await frontDoor("{}", { files: { [state]: `${K}=9100\n` } });
  assert.match(r.out, /127\.0\.0\.1:9100/, "the state dir's .env");
  r = await frontDoor("{}", { files: { [state]: `${K}=9100\n`, [inst]: `export ${K}="9200"\n` } });
  assert.match(r.out, /127\.0\.0\.1:9200/, "the install's .env beats the state dir's");
  r = await frontDoor("{}", { files: { [state]: `${K}=9100\n`, [inst]: `${K}=9200\n`, [cfg]: `# a comment\n${K}=9300 # trailing\n` } });
  assert.match(r.out, /127\.0\.0\.1:9300/, "the per-user config beats both");
  r = await frontDoor("{}", { port: 9001, files: { [cfg]: `${K}=9300\n` } });
  assert.match(r.out, /127\.0\.0\.1:9001/, "the shell beats every file");
  r = await frontDoor(serveTo("mac.tail1234.ts.net:8443", "http://127.0.0.1:9300"), { files: { [cfg]: `${K}=9300\n` } });
  assert.match(r.out, /open this on your phone.*https:\/\/mac\.tail1234\.ts\.net:8443/, "a serve to the FILE's port counts as fronted");
});

test("front door: one coherent ending — the lead goes on the https line, no tailscale fails quietly for the caller", async () => {
  const r = await frontDoor(serveTo("mac.tail1234.ts.net:8443", "http://127.0.0.1:8770"), { lead: "done — " });
  assert.match(r.out.trim().split("\n").pop(), /done — open this on your phone .*https:\/\/mac\.tail1234\.ts\.net:8443$/);
  const none = await frontDoor("{}", { noTailscale: true });
  assert.equal(none.out.trim(), "FINISH_FAILED", "nothing printed; the caller says Tailscale is missing");
  const text = await render([]);
  assert.doesNotMatch(text, /Open the URL doctor printed/, "no 'done, open the URL' ahead of 'that URL is insecure'");
  assert.doesNotMatch(text, /~\/\.config\/\$SLUG|\.config\/waterplane-?host/, "the config dir is CONFIG_NAME's, never the slug's");
});

// ── tmux is required: ensure_tmux, driven with a PATH that holds only fake binaries ───────────
// The PATH is ONLY the fake dir, so the machine's real tmux (and brew, apt-get) cannot be found;
// the function uses nothing but shell builtins and the fakes. No terminal ⇒ never a prompt.

async function tmuxCheck({ os, fakes = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "inst-tmux-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "RAN ${name} $*" >> "${join(dir, "ran")}"\n${body}\n`, { mode: 0o755 });
  }
  const script = (await render([])).replace(/\nmain "\$@"\s*$/, "\n");
  writeFileSync(join(dir, "drive.sh"), `${script}\nOS='${os}'\nensure_tmux\necho ENSURED\n`);
  const r = spawnSync("/bin/sh", [join(dir, "drive.sh")], { encoding: "utf8", env: { PATH: bin, HOME: dir } });
  const out = (r.stdout || "") + (r.stderr || "");
  const ran = existsSync(join(dir, "ran")) ? readFileSync(join(dir, "ran"), "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  return { out, code: r.status, ran };
}

test("tmux present: reported with its version, nothing installed", async () => {
  const r = await tmuxCheck({ os: "linux", fakes: { tmux: 'echo "tmux 3.4"', "apt-get": "" } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /found tmux \(tmux 3\.4\)/);
  assert.match(r.out, /ENSURED/);
  assert.doesNotMatch(r.ran, /apt-get/);
});

test("tmux missing on macOS with brew, non-interactive: stops with the exact brew command, runs nothing", async () => {
  const r = await tmuxCheck({ os: "darwin", fakes: { brew: "" } });
  assert.equal(r.code, 1);
  assert.match(r.out, /tmux was not found/);
  assert.match(r.out, /Install it with: brew install tmux — then re-run this installer\./);
  assert.doesNotMatch(r.out, /\[y\/N\]/, "no prompt without a terminal");
  assert.doesNotMatch(r.out, /ENSURED/);
  assert.equal(r.ran, "", "brew was never run without consent");
});

test("tmux missing on macOS without brew: names Homebrew and the command", async () => {
  const r = await tmuxCheck({ os: "darwin" });
  assert.equal(r.code, 1);
  assert.match(r.out, /Install Homebrew \(https:\/\/brew\.sh\), then run: brew install tmux/);
});

test("tmux missing on Linux: the package manager that is HERE, in the exact command", async () => {
  const apt = await tmuxCheck({ os: "linux", fakes: { "apt-get": "", dnf: "" } });
  assert.equal(apt.code, 1);
  assert.match(apt.out, /Install it with: sudo apt-get install -y tmux/, "apt wins over dnf");
  assert.equal(apt.ran, "");
  assert.match((await tmuxCheck({ os: "linux", fakes: { dnf: "" } })).out, /sudo dnf install -y tmux/);
  assert.match((await tmuxCheck({ os: "linux", fakes: { pacman: "" } })).out, /sudo pacman -S --noconfirm tmux/);
  const none = await tmuxCheck({ os: "linux" });
  assert.equal(none.code, 1);
  assert.match(none.out, /Install tmux with your distribution's package manager/);
});

test("the old 'tmux is optional' wording is gone from the installer", () => {
  assert.doesNotMatch(TMPL, /tmux is optional/);
  assert.match(TMPL, /\n {2}check_prereqs\n {2}ensure_tmux\n/, "main() checks tmux right after the other prerequisites");
});

// ── the publisher's signature (install_release) ─────────────────────────────
// A fixture release in a temp dir, signed with a THROWAWAY key that the rendered script is given
// in place of the real one; install_release is driven alone, with this test's own node as $NODE.

test("the rendered installer carries deploy/release-pubkey.pem as its release key", async () => {
  const pem = readFileSync(join(ROOT, PUBKEY_PATH), "utf8");
  const text = renderInstall(TMPL, await installVars({ root: ROOT }));
  assert.ok(text.includes(`RELEASE_PUBKEY='${pubkeyLine(pem)}'`), "the committed key, one line, single-quoted");
  assert.match(TMPL, /\n {2}install_node\n(.*\n)*? {2}install_release\n/, "the Node that checks the signature is installed (and checksum-verified) first");
});

function signedRelease(dir, { sign = true, key = generateKeys() } = {}) {
  const v = "9.9.9";
  const top = join(dir, "build", `${SLUG}-${v}`);
  mkdirSync(join(top, "bin"), { recursive: true });
  writeFileSync(join(top, "bin", `${SLUG}.mjs`), "");
  writeFileSync(join(top, "release.json"), JSON.stringify({ version: v }));
  const rel = join(dir, "rel");
  mkdirSync(rel);
  const tarball = join(rel, `${SLUG}-${v}.tar.gz`);
  execFileSync("tar", ["-czf", tarball, "-C", join(dir, "build"), `${SLUG}-${v}`], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(`${tarball}.sha256`, `${sha}  ${SLUG}-${v}.tar.gz\n`);
  if (sign) signFile(loadPrivateKey(key.privatePem), `${tarball}.sha256`);
  return { rel, tarball, key };
}

async function installSigned(dir, rel, pubPem, env = {}) {
  const vars = await installVars({ root: ROOT });
  vars.RELEASE_PUBKEY = pubkeyLine(pubPem);
  const script = renderInstall(TMPL, vars).replace(/\nmain "\$@"\s*$/, "\n");
  const data = join(dir, "data");
  writeFileSync(join(dir, "drive.sh"), `${script}
NODE='${process.execPath}'; TMP='${join(dir, "tmp")}'; mkdir -p "$TMP"
DATA='${data}'; BASE='${rel}'; VERSION='9.9.9'
install_release
`);
  const r = spawnSync("sh", [join(dir, "drive.sh")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, ...env } });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), installed: existsSync(join(data, "versions", "9.9.9")) };
}

test("install_release: a release signed by the installer's key installs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inst-sig-"));
  try {
    const { rel, key } = signedRelease(dir);
    const r = await installSigned(dir, rel, key.publicPem);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /verified the publisher's signature/);
    assert.ok(r.installed);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("install_release: no .sig, another key's .sig, or a .sha256 altered after signing installs nothing", async () => {
  const cases = {
    "missing": (s) => { rmSync(`${s.tarball}.sha256.sig`); return s.key.publicPem; },
    "wrong key": () => generateKeys().publicPem,
    "tampered .sha256": (s) => { writeFileSync(`${s.tarball}.sha256`, readFileSync(`${s.tarball}.sha256`, "utf8") + "\n"); return s.key.publicPem; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const dir = mkdtempSync(join(tmpdir(), "inst-sig-"));
    try {
      const s = signedRelease(dir);
      const r = await installSigned(dir, s.rel, mutate(s));
      assert.notEqual(r.code, 0, `${name}: refused`);
      assert.match(r.out, /Nothing was installed/, name);
      assert.ok(!r.installed, `${name}: nothing unpacked`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("install_release: INSECURE_SKIP_SIG=1 installs an unsigned release, and says so loudly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inst-sig-"));
  try {
    const { rel } = signedRelease(dir, { sign: false });
    const r = await installSigned(dir, rel, generateKeys().publicPem, { [`${ENV_PREFIX}INSECURE_SKIP_SIG`]: "1" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /WARNING: .*INSECURE_SKIP_SIG=1 — NOT checking who published/);
    assert.ok(r.installed);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
