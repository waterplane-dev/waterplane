/**
 * `lan-cert issue|show|remove` (`cli/lancert.ts`), on temp dirs: what is written and printed, that no
 * private key is in either, that `lan-tls.json` is never touched, and that every refusal changes nothing.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envName } from "@waterplane/shared";
import { issuedLines, LAN_CERT_HELP, parseLanCertArgs, run, untrustLines } from "../dist/cli/lancert.js";
import { ensureSelfSigned, lanTlsFile } from "../dist/lantls.js";
import { browserCertFile } from "../dist/lanca.js";

const scratch = mkdtempSync(join(tmpdir(), "lancert-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const r = join(scratch, `d${n++}`); mkdirSync(r); return r; };
const NAME = "desk.home.arpa";
const IPS = ["192.168.1.20", "10.0.0.7"];

/** A root whose host has served TLS once, and a folder for `ca.cer`. */
function desktop() {
  const root = fresh();
  const m = ensureSelfSigned(root, IPS, ["mac.local"]);
  return { root, out: fresh(), pin: m.spki, tls: readFileSync(lanTlsFile(root)) };
}
/** Run the command with everything injected; what it printed is returned. */
async function cli(root, args, deps = {}) {
  const printed = [];
  const { log, error } = console;
  console.log = console.error = (s) => { printed.push(String(s)); };
  try {
    const code = await run(args, { root, ips: IPS, restart: "RESTART", ask: null, ...deps });
    return { code, text: printed.join("\n") };
  } finally { Object.assign(console, { log, error }); }
}
const issue = (d, more = [], deps = {}) => cli(d.root, ["issue", "--name", NAME, "--out", d.out, ...more], deps);
/** Nothing private anywhere but in `lan-tls.json`, which is byte for byte what it was. */
function noLeak(d, text) {
  assert.deepEqual(readFileSync(lanTlsFile(d.root)), d.tls, "lan-tls.json is unchanged");
  assert.doesNotMatch(text, /PRIVATE|BEGIN/);
  for (const dir of [dirname(lanTlsFile(d.root)), d.out]) {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.name === "lan-tls.json" || !f.isFile()) continue;
      assert.doesNotMatch(readFileSync(join(dir, f.name), "latin1"), /PRIVATE/, f.name);
      assert.doesNotMatch(f.name, /\.tmp$/, "no temp file is left");
    }
  }
}

test("args: a name is required and never assumed, unknown words are refused", () => {
  assert.match(parseLanCertArgs(["issue"]).error, /needs --name.*desk\.home\.arpa/);
  assert.match(parseLanCertArgs(["issue", "--name"]).error, /needs a value/);
  assert.match(parseLanCertArgs(["issue", "--name", "--yes"]).error, /needs a value/);
  assert.match(parseLanCertArgs(["issue", "--name="]).error, /needs a value/);
  assert.match(parseLanCertArgs(["renew"]).error, /unknown command/);
  assert.match(parseLanCertArgs(["issue", "--name", NAME, "--force"]).error, /unknown option/);
  assert.match(parseLanCertArgs(["remove", "--yes"]).error, /unknown option/);
  assert.deepEqual(parseLanCertArgs(["issue", "--name=Desk.Home.Arpa", "--out=x", "--any-name", "--yes"]), { cmd: "issue", name: NAME, out: "x", anyName: true, yes: true });
  for (const h of [[], ["help"], ["-h"], ["issue", "--help"]]) assert.equal(parseLanCertArgs(h).cmd, "help");
  assert.match(LAN_CERT_HELP, /desk\.home\.arpa/);
});

test("issue: the record is 0600 and public, ca.cer is the CA's DER, the key and the pin do not move", async () => {
  const d = desktop();
  const r = await issue(d);
  assert.equal(r.code, 0, r.text);
  const file = browserCertFile(d.root);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(rec.name, NAME);
  assert.equal(rec.spki, d.pin);
  const cer = readFileSync(join(d.out, "ca.cer"));
  assert.equal(new X509Certificate(cer).ca, true);
  const sha = createHash("sha256").update(cer).digest("hex").toUpperCase();
  assert.equal(sha, rec.caSha256);
  assert.deepEqual(readdirSync(d.out), ["ca.cer"]);
  for (const must of [sha, NAME, "192.168.1.20", "10.0.0.7", "Get-FileHash ca.cer", "certutil -user -addstore Root ca.cer", "192.168.1.20 desk.home.arpa", "RESTART", `https://${NAME}:`, file]) {
    assert.ok(r.text.includes(must), `prints ${must}\n${r.text}`);
  }
  noLeak(d, r.text);
});

test("issue: no key yet, a broken key, a bad name or a bad folder each refuse with the way out and write nothing", async () => {
  const none = { root: fresh(), out: fresh() };
  const a = await issue(none);
  assert.equal(a.code, 1);
  assert.match(a.text, new RegExp(`start the host once with ${envName("ALLOW_PUBLIC")}=1`));
  assert.equal(existsSync(lanTlsFile(none.root)), false, "a key is never minted here");
  assert.deepEqual(readdirSync(none.out), []);

  // own leaf knobs set and no lan-tls.json: starting the host once cannot help, and the text says what to unset
  const kc = envName("TLS_CERT");
  const hadKc = process.env[kc];
  process.env[kc] = "/x.pem";
  try {
    const k = await issue({ root: fresh(), out: fresh() });
    assert.equal(k.code, 1);
    assert.match(k.text, /TLS_CERT.*are set.*will not help\. Unset both and restart.*start the host once/s);
  } finally { if (hadKc === undefined) delete process.env[kc]; else process.env[kc] = hadKc; }

  const d = desktop();
  const writes = async (args, why) => {
    const r = await cli(d.root, args);
    assert.equal(r.code, 1);
    assert.match(r.text, why);
    assert.equal(existsSync(browserCertFile(d.root)), false);
    noLeak(d, r.text);
  };
  await writes(["issue", "--name", "192.168.1.20", "--out", d.out], /is an address/);
  await writes(["issue", "--name", "desk.example.com", "--out", d.out], /--any-name/);
  const own = hostname().toLowerCase().replace(/\.local$/, "").split(".")[0];
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(own)) {
    await writes(["issue", "--name", `${own}.local`, "--out", d.out], /already opens this desktop/);
    await writes(["issue", "--name", `${own}.local`, "--any-name", "--out", d.out], /already opens this desktop/);
  }
  await writes(["issue", "--name", NAME, "--out", join(d.out, "nope")], /existing folder/);
  writeFileSync(join(d.out, "ca.cer"), "somebody else's");
  await writes(["issue", "--name", NAME, "--out", d.out], /not the certificate this desktop issued last/);
  assert.equal(readFileSync(join(d.out, "ca.cer"), "utf8"), "somebody else's");
  rmSync(join(d.out, "ca.cer"));
  const target = join(fresh(), "elsewhere");
  symlinkSync(target, join(d.out, "ca.cer"));
  await writes(["issue", "--name", NAME, "--out", d.out], /not a plain file/);
  assert.equal(existsSync(target), false, "a link is not followed");
  rmSync(join(d.out, "ca.cer"));

  writeFileSync(lanTlsFile(d.root), "{broken");
  const b = await issue(d);
  assert.equal(b.code, 1);
  assert.match(b.text, /never makes a new one/);
  assert.equal(readFileSync(lanTlsFile(d.root), "utf8"), "{broken", "left where it is");
  assert.deepEqual(readdirSync(dirname(lanTlsFile(d.root))), ["lan-tls.json"]);
});

test("issue: no name is a usage error, and nothing is taken in its place", async () => {
  const d = desktop();
  const r = await cli(d.root, ["issue", "--out", d.out]);
  assert.equal(r.code, 2);
  assert.match(r.text, /needs --name/);
  assert.equal(existsSync(browserCertFile(d.root)), false);
  assert.deepEqual(readdirSync(d.out), []);
});

test("issue: a record or a folder that cannot be written leaves everything as it was", async (t) => {
  const d = desktop();
  mkdirSync(browserCertFile(d.root)); // a directory where the file goes
  const r = await issue(d, ["--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.text, /Nothing was changed/);
  assert.deepEqual(readdirSync(d.out), []);
  rmSync(browserCertFile(d.root), { recursive: true });
  noLeak(d, r.text);

  if (process.getuid?.() === 0) return t.skip("root writes anywhere");
  await issue(d);
  const [record, cer] = [readFileSync(browserCertFile(d.root)), readFileSync(join(d.out, "ca.cer"))];
  const unchanged = async (dir) => {
    chmodSync(dir, 0o500);
    try {
      const x = await issue(d, ["--yes"]);
      assert.equal(x.code, 1);
      assert.match(x.text, /Nothing was changed/);
    } finally { chmodSync(dir, 0o700); }
    assert.deepEqual(readFileSync(browserCertFile(d.root)), record);
    assert.deepEqual(readFileSync(join(d.out, "ca.cer")), cer);
  };
  await unchanged(d.out);
  await unchanged(dirname(browserCertFile(d.root)));
});

test("issue again: says the old trust ends, with its SHA-1, and asks first", async () => {
  const d = desktop();
  await issue(d);
  const file = browserCertFile(d.root);
  const before = readFileSync(file, "utf8");
  const old = JSON.parse(before);
  const same = () => { assert.equal(readFileSync(file, "utf8"), before); };

  const noTty = await issue(d);
  assert.equal(noTty.code, 1);
  assert.match(noTty.text, /no terminal to ask on/);
  same();
  const asked = [];
  const no = await issue(d, [], { ask: async (q) => { asked.push(q); return false; } });
  assert.equal(no.code, 1);
  assert.match(no.text, /Nothing was changed/);
  assert.deepEqual(asked, ["Replace it? [y/N] "]);
  assert.ok(no.text.includes(`certutil -user -delstore Root ${old.caSha1}`));
  assert.match(no.text, /must trust the new one/);
  assert.doesNotMatch(no.text, /stop working/, "the same name keeps its passkeys");
  same();

  const yes = await issue(d, [], { ask: async () => true });
  assert.equal(yes.code, 0, yes.text);
  const next = JSON.parse(readFileSync(file, "utf8"));
  assert.notEqual(next.caSha256, old.caSha256);
  assert.equal(next.spki, old.spki);
  assert.equal(createHash("sha256").update(readFileSync(join(d.out, "ca.cer"))).digest("hex").toUpperCase(), next.caSha256, "the ca.cer issued before is replaced");
  const moved = await cli(d.root, ["issue", "--name", "desk.local", "--out", d.out, "--yes"]);
  assert.equal(moved.code, 0, moved.text);
  assert.match(moved.text, /Passkeys made for desk\.home\.arpa stop working/);
  noLeak(d, yes.text + moved.text);
});

test("show: nothing yet, a good one, an expired one, one on another key, and a file that does not read", async () => {
  const d = desktop();
  const none = await cli(d.root, ["show"]);
  assert.equal(none.code, 0);
  assert.match(none.text, /No browser certificate has been issued/);
  await issue(d);
  const rec = JSON.parse(readFileSync(browserCertFile(d.root), "utf8"));
  const good = await cli(d.root, ["show"]);
  assert.equal(good.code, 0);
  assert.match(good.text, /39[67] days left/);
  assert.ok(good.text.includes(rec.caSha256) && good.text.includes(rec.caSha1));
  const late = await cli(d.root, ["show"], { now: new Date(Date.now() + 400 * 86_400_000) });
  assert.equal(late.code, 1);
  assert.match(late.text, /expired on .*lan-cert issue --name desk\.home\.arpa/s);
  noLeak(d, good.text + late.text);
  const key = envName("ALLOWED_HOSTS");
  const had = process.env[key];
  process.env[key] = NAME;
  try {
    const dialed = await cli(d.root, ["show"]);
    assert.equal(dialed.code, 1);
    assert.match(dialed.text, /not served: .*already opens this desktop.*lan-cert remove/s);
    const goneDialed = await cli(d.root, ["show"], { now: new Date(Date.now() + 400 * 86_400_000) });
    assert.equal(goneDialed.code, 1);
    assert.match(goneDialed.text, /already opens this desktop.*lan-cert remove/s);
    assert.doesNotMatch(goneDialed.text, /issue --name desk\.home\.arpa/);
  } finally { if (had === undefined) delete process.env[key]; else process.env[key] = had; }
  writeFileSync(lanTlsFile(d.root), readFileSync(lanTlsFile(desktop().root)));
  const foreign = await cli(d.root, ["show"]);
  assert.equal(foreign.code, 1);
  assert.match(foreign.text, /another key/);
  writeFileSync(browserCertFile(d.root), "{");
  const broken = await cli(d.root, ["show"]);
  assert.equal(broken.code, 1);
  assert.match(broken.text, /not JSON/);
});

test("remove: deletes the record alone and prints how a laptop stops trusting it", async () => {
  const d = desktop();
  await issue(d);
  const { caSha1 } = JSON.parse(readFileSync(browserCertFile(d.root), "utf8"));
  const r = await cli(d.root, ["remove"]);
  assert.equal(r.code, 0, r.text);
  assert.equal(existsSync(browserCertFile(d.root)), false);
  assert.ok(r.text.includes(`certutil -user -delstore Root ${caSha1}`) && r.text.includes(`security delete-certificate -Z ${caSha1}`));
  assert.match(r.text, /only while the key in this desktop's lan-tls\.json stays private/);
  noLeak(d, r.text);
  const again = await cli(d.root, ["remove"]);
  assert.equal(again.code, 0);
  assert.match(again.text, /Nothing was changed/);
  writeFileSync(browserCertFile(d.root), "{");
  const broken = await cli(d.root, ["remove"]);
  assert.equal(broken.code, 0);
  assert.match(broken.text, /its SHA-1 is not known/);
  assert.equal(existsSync(browserCertFile(d.root)), false);
});

test("the steps name an address even when there is none, and the port is the plan's", () => {
  const base = { name: NAME, caFile: "/x/ca.cer", caSha256: "AB", caSha1: "CD", notAfter: new Date("2027-12-26T12:00:00Z"), stateFile: "/s", ips: [], port: 9443, restart: "R" };
  const text = issuedLines(base).join("\n");
  assert.match(text, /<this desktop's address on the LAN>/);
  assert.match(text, /https:\/\/desk\.home\.arpa:9443/);
  assert.match(text, /2027-12-26/);
  assert.ok(untrustLines("CD", NAME).join("\n").includes("-delstore Root CD"));
});

test("the real command line: the state dir of the environment, no terminal, no key in its output", () => {
  const d = desktop();
  const state = dirname(lanTlsFile(d.root));
  const entry = fileURLToPath(new URL("../dist/cli/entry.js", import.meta.url));
  const go = (...args) => spawnSync(process.execPath, [entry, "lan-cert", ...args], {
    encoding: "utf8", cwd: d.out,
    env: { PATH: process.env.PATH, HOME: fresh(), [envName("STATE_DIR")]: state, [envName("ROOT")]: d.root, [envName("ALLOW_PUBLIC")]: "1", [envName("PORT")]: "9000" },
  });
  const r = go("issue", "--name", NAME);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(d.out, "ca.cer")), "ca.cer goes to the current folder");
  assert.ok(existsSync(join(state, "lan-browser.json")));
  assert.equal(go("issue", "--name", NAME).status, 1, "a second one asks, and there is no terminal");
  assert.equal(go("show").status, 0);
  assert.equal(go("issue").status, 2);
  noLeak(d, r.stdout + r.stderr);
});
