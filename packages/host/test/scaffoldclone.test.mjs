/**
 * `cloneUrl` / `cloneRepo` — the New sheet's clone tab. The URL comes off a phone and
 * goes to `git`, so the refusals are the subject: every transport but https/ssh, an
 * option-shaped URL, a folder outside the root. The clone itself runs through an
 * injected runner (no network): what matters is the argv it is handed — transports
 * pinned, `--` before the URL, the target inside the root — and that a refusal never
 * reaches it. The phone's drops are excluded locally, never committed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { cloneUrl, cloneRepo } = await import("../dist/scaffold.js");
const { BRAND } = await import("@waterplane/shared");

const root = () => mkdtempSync(join(tmpdir(), "wp-scaffold-clone-"));

test("cloneUrl: the three shapes a person pastes, named by their last segment", () => {
  assert.deepEqual(cloneUrl("https://github.com/acme/widget.git"), { url: "https://github.com/acme/widget.git", name: "widget" });
  assert.deepEqual(cloneUrl("  https://github.com/acme/widget/  "), { url: "https://github.com/acme/widget/", name: "widget" });
  assert.equal(cloneUrl("git@github.com:acme/widget.git").name, "widget");
  assert.equal(cloneUrl("ssh://git@host.example:2222/team/thing.git").name, "thing");
  assert.equal(cloneUrl("host.example:repo").name, "repo");
});

test("cloneUrl: everything else git would accept is refused in words", () => {
  for (const bad of [
    "", "   ",
    "ext::sh -c touch% /tmp/pwned",
    "ext::sh",
    "file:///etc",
    "/Users/someone/repo",
    "../other",
    "http://github.com/acme/widget",
    "git://github.com/acme/widget",
    "ftp://x/y",
    "--upload-pack=touch /tmp/x",
    "-oProxyCommand=x:y",
    "git@-oProxyCommand=x:y",
    "ssh://-oProxyCommand=x/y",
    "https://github.com/acme/wid get",
    "https://github.com/acme/w\nidget",
    "https://github.com/",
    "fd::1",
  ]) {
    const r = cloneUrl(bad);
    assert.ok("error" in r && r.error.length > 0, `refused: ${JSON.stringify(bad)} → ${JSON.stringify(r)}`);
  }
  assert.match(cloneUrl("http://github.com/a/b").error, /https/);
});

test("cloneRepo: argv pins the transports, `--` before the URL, target inside the root", async () => {
  const r = root();
  const calls = [];
  const run = async (args, opts) => {
    calls.push({ args, opts });
    const target = args[args.length - 1];
    mkdirSync(join(target, ".git", "info"), { recursive: true });
    writeFileSync(join(target, ".git", "info", "exclude"), "# git ls-files --others --exclude-from=.git/info/exclude");
  };
  const res = await cloneRepo(r, r, "https://github.com/acme/widget.git", undefined, run);
  assert.ok(!("error" in res), JSON.stringify(res));
  assert.equal(calls.length, 1);
  const { args, opts } = calls[0];
  const target = res.path;
  assert.ok(target.endsWith("/widget"));
  assert.deepEqual(args.slice(0, 6), ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always"]);
  assert.ok(args.includes("--no-recurse-submodules"));
  const dd = args.indexOf("--");
  assert.deepEqual(args.slice(dd + 1), ["https://github.com/acme/widget.git", target]);
  assert.equal(opts.env.GIT_TERMINAL_PROMPT, "0");
  assert.ok(opts.timeout > 0);

  // The drops exist and are excluded LOCALLY — the clone's own .gitignore is never written.
  assert.ok(existsSync(join(target, ".claude", "outbox")));
  assert.ok(!existsSync(join(target, ".gitignore")));
  const ex = readFileSync(join(target, ".git", "info", "exclude"), "utf8");
  for (const l of [".claude/inbox/", ".claude/outbox/", `${BRAND.stateDirName}/`]) assert.ok(ex.split("\n").includes(l), l);
  assert.ok(ex.startsWith("# git ls-files"), "existing exclude kept");
});

test("cloneRepo: a refusal never reaches git", async () => {
  const r = root();
  let ran = 0;
  const run = async () => { ran++; };
  mkdirSync(join(r, "widget"));
  assert.match((await cloneRepo(r, r, "https://github.com/acme/widget", undefined, run)).error, /already exists/);
  assert.ok("error" in (await cloneRepo(r, r, "file:///etc", undefined, run)));
  const outside = mkdtempSync(join(tmpdir(), "wp-clone-out-"));
  assert.match((await cloneRepo(r, outside, "https://github.com/acme/x", undefined, run)).error, /escapes root/);
  assert.equal(ran, 0);
  // A traversal-shaped name is slugged to a plain folder INSIDE the root, never followed.
  const named = await cloneRepo(r, r, "https://github.com/acme/x", "../../escape", run);
  assert.equal(dirname(named.path), realpathSync(r));
});

test("cloneRepo: a chosen name wins; git's complaint comes back as the sentence", async () => {
  const r = root();
  const run = async () => {
    const e = new Error("Command failed");
    e.stderr = "Cloning into '/x/mine'...\nfatal: repository 'https://github.com/acme/nope/' not found\n";
    throw e;
  };
  const res = await cloneRepo(r, r, "https://github.com/acme/nope", "mine", run);
  assert.match(res.error, /git clone failed: fatal: repository .* not found/);
  assert.doesNotMatch(res.error, /Cloning into/);
});
