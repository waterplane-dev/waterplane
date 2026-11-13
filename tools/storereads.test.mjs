/**
 * A store that saves a file reads it through the store layer (design review, lost-read audit B).
 *
 * `writeJsonAtomic` replaces whatever is at the path. `readJsonGuarded(Detail)` (jsonstore.ts) is what makes
 * that safe: a present file the host could not read — corrupt, the wrong shape, or unreadable (EACCES, EIO) —
 * is moved to `<name>.corrupt-<ts>` BEFORE the fallback is saved over the name. A raw
 * `JSON.parse(readFileSync(…))` in a `catch { fresh }` skips that, so the next save erases bytes nobody read
 * (localledger.ts's catalogue did exactly that).
 *
 * SCOPE: git-tracked files under packages/host/src and packages/extensions/*\/host (tests and dist out; outside
 * a git checkout the directories are walked). A file is judged only if it uses an atomic writer
 * (writeJsonAtomic / writeTextAtomic / writeTextAtomicKeepMode / writeAtomic, the vault's own) AND holds a
 * raw `JSON.parse(readFileSync(` / `JSON.parse(await readFile(` (a `fs.` / `fsp.` prefix counts).
 *
 * ALLOWED: file -> [[snippet on the parsing line, reason]]. A reason is one of: the file is only READ here (the
 * person's, a CLI's, a repo's package.json), a legacy source left in place on purpose, the site has its own
 * refuse-to-overwrite guard, or the save never builds on what the read found (it replaces the file wholesale, and
 * replacing a corrupt one is the point). Adding a load-then-save of the SAME file is not an allowance, it is the
 * bug: route it through readJsonGuarded. There is no list of known offenders: every site is either routed or
 * allowed with its reason, and a new one fails until it is one of the two.
 *
 * PRIVATE EXTENSIONS (deploy/public-allowlist.txt) are absent in the public snapshot: an entry for an absent
 * file is skipped; one whose file is present but whose snippet is gone is stale and fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCOPE = /^packages\/(?:host\/src|extensions\/[^/]+\/host)\/.+\.(?:ts|mts|mjs)$/;
const OUT = /(?:^|\/)(?:node_modules|dist|test|tests)\/|\.test\.|\.d\.ts$/;
const WRITER = /\b(?:writeJsonAtomic|writeTextAtomic|writeTextAtomicKeepMode|writeAtomic)\b/;
const RAW_PARSE = /JSON\.parse\(\s*(?:await\s+)?(?:\w+\.)?(?:readFileSync|readFile)\(/;

/** Only read here, or guarded by the site itself, or a legacy source left in place. */
const ALLOWED = {
  "packages/extensions/android-apps/host/installlog.mts": [
    ["const parsed = JSON.parse(readFileSync(this.path", "persist() moves a file that does not parse (or cannot be read) aside right before every write: the same rule, hand-rolled"],
    ["try { JSON.parse(readFileSync(this.path", "that check itself, before the move-aside"],
  ],
  "packages/host/src/backlog/backlogstore.ts": [["const raw = JSON.parse(readFileSync(path", "a legacy file read for migration, left where it is by design (the line says so)"]],
  "packages/host/src/billing.ts": [["const j = JSON.parse(readFileSync(join(dir, f)", "claude's own settings.json, read for apiKeyHelper, never written here"]],
  "packages/host/src/builds.ts": [["const arr = JSON.parse(readFileSync(path", "save() refuses to overwrite or delete a builds file that exists but does not parse (a repo's file is never moved aside)"]],
  "packages/host/src/cli/selfupdate.ts": [["const r = JSON.parse(readFileSync(join(root, \"release.json\")", "release.json is read for the version, never written here"]],
  "packages/host/src/cli/statesnap.ts": [["const m = JSON.parse(readFileSync(join(snapDir, SNAPSHOT_META)", "reads a snapshot's meta; the writer builds it fresh in a tmp dir"]],
  "packages/host/src/decisionlog.ts": [["try { parsed = JSON.parse(readFileSync(old", "the retired oracle-log.json: read once for migration, then renamed to .migrated, never written"]],
  "packages/host/src/exposure.ts": [
    ["const v = JSON.parse(readFileSync(file, \"utf8\"));\n    if (!v || typeof v !== \"object\" || Array.isArray(v)) return { ok: false, why: \"not an object\" };\n    return { ok: true, data: v as", "accepts: every writer returns 'not overwriting it' on ok:false"],
    ["return { ok: true, data: cleanTriageFile(v) }", "triage: every writer returns 'not overwriting it' on ok:false"],
  ],
  "packages/host/src/lantls.ts": [["const key = p256((JSON.parse(readFileSync(lanTlsFile(root)", "the doctor's pin read, 'reads and never writes'; the store itself reads through readJsonGuardedDetail"]],
  "packages/host/src/lanid.ts": [["const j = JSON.parse(readFileSync(file", "a corrupt lan-identity.json is replaced by a new identity on purpose (documented on lanIdentity): every phone re-learns it over the trusted path, as on first use; nothing is built on the bytes of the old one"]],
  "packages/host/src/localledger.ts": [["table = parseUserPrices(JSON.parse(readFileSync(file", "the person's own prices file: read, never written by the host"]],
  "packages/host/src/sessions/tmux.ts": [["const rec = JSON.parse(readFileSync(p", "reclaimStaleLive reads each live record for its mtime and tmuxSocket and may DELETE a stale one; it never writes one back (the writer saves a new record from memory), and an unparseable record gives no facts, so it is kept"]],
  "packages/host/src/updates/installrecord.ts": [["const o = JSON.parse(readFileSync(p", "the record is replaced wholesale after a clone or update that succeeded; nothing in the new one is built on the old bytes, and an unreadable one only reads as 'put there by hand', which refuses the update before any write"]],
  "packages/host/src/repohealthapproval.ts": [
    ["const pkg = JSON.parse(readFileSync(join(d, \"package.json\")", "a repo's package.json, read for its name, never written here"],
    ["const self = JSON.parse(readFileSync(join(d, \"package.json\")", "a repo's package.json, read for its name, never written here"],
    ["meta = JSON.parse(readFileSync(join(dir, \"package.json\")", "a repo's package.json, read for its name, never written here"],
  ],
  "packages/host/src/secrets.ts": [["const parsed = JSON.parse(readFileSync(cfg", "the person's write-targets config: read, never written (the writes are the targets and .gitignore)"]],
};

function tracked() {
  try {
    return execFileSync("git", ["ls-files", "-z", "--", "packages"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 })
      .split("\0").filter(Boolean);
  } catch {
    const walk = (rel) => readdirSync(join(ROOT, rel), { withFileTypes: true }).flatMap((e) =>
      e.name === "node_modules" || e.name === "dist" ? [] : e.isDirectory() ? walk(`${rel}/${e.name}`) : [`${rel}/${e.name}`]);
    return walk("packages");
  }
}

const files = tracked().filter((f) => SCOPE.test(f) && !OUT.test(f) && existsSync(join(ROOT, f)));
const text = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

/** The raw-parse hits of every file that also uses an atomic writer: [file, 1-based line, statement text]. */
function hits() {
  const out = [];
  for (const [f, t] of text) {
    if (!WRITER.test(t)) continue;
    const lines = t.split("\n");
    lines.forEach((l, i) => {
      if (RAW_PARSE.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)) out.push([f, i + 1, lines.slice(i, i + 3).join("\n")]);
    });
  }
  return out;
}

const allowed = (table, f, stmt) => (table[f] ?? []).some(([snip]) => stmt.includes(snip));

test("a file that writes with an atomic writer reads through readJsonGuarded, unless it only reads that file", () => {
  const bad = hits().filter(([f, , stmt]) => !allowed(ALLOWED, f, stmt));
  assert.deepEqual(bad.map(([f, n]) => `${f}:${n}`), [],
    "a raw JSON.parse(readFileSync(…)) in a file that writes atomically: if it reads a file this host also saves, use readJsonGuarded(Detail) so a corrupt or unreadable file is kept aside; if it only reads, add it to ALLOWED with the reason");
});

test("no allowance is stale: every entry's snippet is still in its (present) file", () => {
  const stale = [];
  for (const [f, entries] of Object.entries(ALLOWED)) {
    if (!existsSync(join(ROOT, f))) continue; // a private extension, absent in the public snapshot
    if (!text.has(f)) { stale.push(`${f}: no longer tracked or in scope`); continue; }
    const h = hits().filter(([hf]) => hf === f);
    for (const [snip] of entries) if (!h.some(([, , stmt]) => stmt.includes(snip))) stale.push(`${f}: ${snip}`);
  }
  assert.deepEqual(stale, [], "remove the allowance");
});
