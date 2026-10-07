/**
 * One way to persist a JSON state file: `jsonstore.ts` (`writeJsonAtomic` /
 * `writeTextAtomic`: tmp + fsync + rename + mode). A store that hand-rolls
 * `writeFileSync(tmp, JSON.stringify(..)); renameSync(tmp, ..)` — or truncates its
 * file in place with a bare `writeFileSync(path, JSON.stringify(..))` — loses the
 * file to a SIGTERM landing mid-write (every `npm run restart`). This is a source
 * scan: a new hit fails unless the file is on the allowlist WITH A REASON.
 * A stale allowlist entry (nothing left to excuse) fails too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));

/** path (from the repo root) → why a hand-rolled write is right there. */
const ALLOW = {
  "packages/host/src/intents/disk.ts": "the intent store is a leaf under `intents/`: it may import only `intents/contract`, so jsonstore is INJECTED (`IntentDeps.files`); the hand-rolled tmp+rename is the fallback a unit fake without it gets",
  "packages/host/src/localusage.ts": "async tmp+rename so a large ledger never blocks the event loop; jsonstore is sync-only",
  "packages/host/src/convfork.ts": "writes a forked conversation .jsonl (the CLI's own transcript), not a state file",
  "packages/host/src/reposkill.ts": "writes the markdown skill text handed to the driven repo's agent, not JSON state",
  "packages/host/src/ocrlocal.ts": "moves a swiftc-compiled OCR helper BINARY into place (copy then rename, mode 755); not a JSON store",
  "packages/host/src/signkey.ts": "moves a keytool-generated binary keystore into place; the tmp name is keytool's output path",
  "packages/host/src/tree.ts": "the one place a user's file is written back from the phone: raw text, preserves the target's mode",
  "packages/host/src/cli/selfupdate.ts": "swaps an install dir / symlink atomically; not a JSON store",
  "packages/host/src/cli/statesnap.ts": "stages a state-snapshot DIRECTORY and renames it into place (and filters `.tmp` names out of what it copies); its one JSON file goes through writeJsonAtomic",
  "packages/host/src/cli/service.ts": "writes a launchd/systemd unit (text), part of the installer",
  "packages/host/src/branddirs.ts": "best-effort pointer note inside a moved state dir, written while the stores are being moved",
  "packages/host/src/compliance.ts": "creates builds.json in a repo with `flag: \"wx\"` (never overwrites) — not atomic on purpose",
  "packages/host/src/dictate.ts": "a one-shot answer sidecar next to the recording, never read back as state",
  "packages/host/src/capture/capturepass.ts": "an outbox artifact (verdict sidecar) for a person to look at, not state",
  "packages/host/src/peers/serve.ts": "a small job marker inside the job's worktree, removed with it",
};

const SELF = "packages/host/src/jsonstore.ts";

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function roots() {
  const r = [join(repo, "packages/host/src")];
  for (const e of readdirSync(join(repo, "packages/extensions"))) {
    try { if (statSync(join(repo, "packages/extensions", e, "host")).isDirectory()) r.push(join(repo, "packages/extensions", e, "host")); } catch { /* no host half */ }
  }
  return r;
}

/** Lines that hand-roll a JSON store write. */
export function offences(src) {
  const lines = src.split("\n");
  const hits = [];
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
    // a tmp sibling being named: `${path}.tmp`, `x + ".tmp"`, `.tmp-<pid>`
    if (/\.tmp(?:[`"'\-]|\$\{)/.test(l)) hits.push([i + 1, "names a .tmp file (tmp + rename by hand)"]);
    // a bare writeFile whose call text holds JSON.stringify (this line and the next three)
    else if (/\bwriteFile(Sync)?\(/.test(l) && /JSON\.stringify/.test(lines.slice(i, i + 4).join(" ").split(";")[0])) {
      hits.push([i + 1, "writeFile of JSON.stringify (non-atomic state write)"]);
    }
  });
  return hits;
}

test("JSON state is written through jsonstore.ts, not by hand", () => {
  const bad = [];
  const seen = new Set();
  for (const root of roots()) {
    for (const f of walk(root)) {
      const rel = relative(repo, f);
      if (rel === SELF) continue;
      const hits = offences(readFileSync(f, "utf8"));
      if (!hits.length) continue;
      if (rel in ALLOW) { seen.add(rel); continue; }
      for (const [n, why] of hits) bad.push(`${rel}:${n}: ${why}`);
    }
  }
  assert.deepEqual(bad, [], `use writeJsonAtomic / writeTextAtomic from jsonstore.ts, or add the file to ALLOW with a reason:\n${bad.join("\n")}`);
  const stale = Object.keys(ALLOW).filter((k) => !seen.has(k));
  assert.deepEqual(stale, [], `allowlist entries with nothing left to excuse — delete them: ${stale.join(", ")}`);
});

test("the scan itself flags the shapes it exists for", () => {
  assert.equal(offences("const tmp = `${p}.tmp`;\nwriteFileSync(tmp, JSON.stringify(x));\nrenameSync(tmp, p);").length, 2);
  assert.equal(offences("writeFileSync(p, JSON.stringify(x, null, 2));").length, 1);
  assert.equal(offences("writeFileSync(p, JSON.stringify({\n a: 1,\n}));").length, 1);
  assert.equal(offences("writeJsonAtomic(p, x, { space: 2 });").length, 0);
  assert.equal(offences("// writeFileSync(p, JSON.stringify(x))").length, 0);
  assert.equal(offences("writeFileSync(p, text);").length, 0);
});
