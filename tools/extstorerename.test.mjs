/**
 * An extension's host never renames a file aside because a READ failed (E1, 2026-11-18).
 *
 * Core's rule (host/src/jsonstore.ts): a store that cannot be read is never written over and never
 * read as empty; a process-level error (EMFILE/ENFILE/ENOMEM/EAGAIN/EINTR) leaves the file and
 * retries. An extension may not import core, so it uses `readStore`/`writeStore` from
 * `@waterplane/shared` (storefile.ts), which move a file aside ONLY when it read and did not parse.
 * A hand-rolled `try { JSON.parse(readFileSync(p)) } catch { renameSync(p, p + ".corrupt") }` moves a
 * good file aside on EMFILE and starts empty (android-apps' install log did, until this).
 *
 * RULE: in `packages/extensions/*\/host/**\/*.mts` (the vault has its own atomicbook.mts and is out),
 * a `catch` block that calls `renameSync(`/`rename(` and whose `try` read a file (`readFileSync`,
 * `readFile`, `JSON.parse`) fails; so does a rename in the 400 characters after such a catch, or a call
 * in it to a helper of the file that renames. The whole `try` body is searched, however long, and
 * importing `readStore` exempts nothing.
 * ALLOWED is a shrinking list of [file, reason]; it starts empty and only ever loses entries.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCOPE = /^packages\/extensions\/(?!vault\/)[^/]+\/host\/.+\.mts$/;
const OUT = /(?:^|\/)(?:node_modules|dist|test|tests)\/|\.test\.|\.d\.ts$/;
const READS = /readFileSync|readFile\(|JSON\.parse/;
const RENAMES = /\brename(?:Sync)?\(/;

/** [file, reason] — empty on purpose; never add one, route the read through readStore. */
const ALLOWED = [];

/** Index of the `{` that matches the `}` at `close`, scanning backwards; -1 if none. */
function openOf(src, close) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (src[i] === "}") depth++;
    else if (src[i] === "{" && --depth === 0) return i;
  }
  return -1;
}

/** Each `catch {…}` with the WHOLE `try` body before it and the 400 characters that follow it. */
export function catchBlocks(src) {
  const out = [];
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) depth += src[i] === "{" ? 1 : src[i] === "}" ? -1 : 0;
    // The try body is the block that ends right before `catch`; fall back to a wide window if it cannot be found.
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    const open = src[j] === "}" ? openOf(src, j) : -1;
    const before = open >= 0 ? src.slice(open, j + 1) : src.slice(Math.max(0, m.index - 3000), m.index);
    out.push({ before, body: src.slice(re.lastIndex, i - 1), after: src.slice(i, i + 400) });
  }
  return out;
}

/** Names of functions in `src` whose body renames something (a helper a catch could call). */
function renamingHelpers(src) {
  const names = [];
  const NOT = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with"]);
  const sig = "\\([^)]*\\)(?:\\s*:\\s*[^{=;]+?)?";
  // function declarations and expressions (named or not, async), arrows with a block, class/object methods.
  const re = new RegExp(
    "(?:\\bfunction\\s*\\*?\\s*(\\w+)\\s*" + sig + "\\s*\\{)" +
    "|(?:\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:async\\s*)?(?:function\\s*\\*?\\s*\\w*\\s*" + sig + "|" + sig + "\\s*=>)\\s*\\{)" +
    "|(?:(?:^|[{};])[ \\t]*(?:(?:public|private|protected|static|readonly|async)\\s+)*(\\w+)\\s*" + sig + "\\s*\\{)", "gm");
  let m;
  while ((m = re.exec(src))) {
    const name = m[1] ?? m[2] ?? m[3];
    if (NOT.has(name)) continue;
    let depth = 1, i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) depth += src[i] === "{" ? 1 : src[i] === "}" ? -1 : 0;
    if (RENAMES.test(src.slice(re.lastIndex, i - 1))) names.push(name);
  }
  // A brace-less arrow: `const aside = (p) => renameSync(...)` up to the end of the statement.
  const flat = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*(?!\{)([^;\n]*)/g;
  while ((m = flat.exec(src))) if (RENAMES.test(m[2])) names.push(m[1]);
  return names;
}

/**
 * True when `src` renames something because a read failed: inside a catch of a read, in the 400
 * characters after one (a flag set in the catch), or through a helper of this file the catch calls.
 * Importing `readStore` exempts nothing: the rule is about the shape, wherever it sits in a file.
 */
export function renamesAsideOnReadError(src) {
  const helpers = renamingHelpers(src);
  return catchBlocks(src).some(({ before, body, after }) =>
    READS.test(before) && (RENAMES.test(body) || RENAMES.test(after)
      || helpers.some((h) => new RegExp(`\\b${h}\\s*\\(`).test(body))));
}

function tracked() {
  try {
    return execFileSync("git", ["ls-files", "-z", "--", "packages/extensions"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 })
      .split("\0").filter(Boolean);
  } catch {
    const walk = (rel) => readdirSync(join(ROOT, rel), { withFileTypes: true }).flatMap((e) =>
      e.name === "node_modules" || e.name === "dist" ? [] : e.isDirectory() ? walk(`${rel}/${e.name}`) : [`${rel}/${e.name}`]);
    return walk("packages/extensions");
  }
}

test("the rule sees the old install-log shape and passes the helper's", () => {
  const old = 'try { JSON.parse(readFileSync(p, "utf8")); }\n catch { try { renameSync(p, `${p}.corrupt-${Date.now()}`); } catch { /* go on */ } }';
  assert.equal(renamesAsideOnReadError(old), true);
  assert.equal(renamesAsideOnReadError('import { readStore } from "@waterplane/shared";\n' + old), true, "a readStore import exempts nothing");
  assert.equal(renamesAsideOnReadError("try {\n" + "// pad\n".repeat(200) + "JSON.parse(readFileSync(p));\n} catch { renameSync(p, q); }"), true, "a long try body still counts");
  assert.equal(renamesAsideOnReadError("let bad = false;\ntry { JSON.parse(readFileSync(p)); } catch { bad = true; }\nif (bad) renameSync(p, q);"), true, "a rename after the catch");
  assert.equal(renamesAsideOnReadError("function aside(p) { renameSync(p, p + '.x'); }\ntry { JSON.parse(readFileSync(p)); } catch { aside(p); }"), true, "a rename through a helper");
  const read = "try { JSON.parse(readFileSync(p)); } catch { this.aside(); }";
  assert.equal(renamesAsideOnReadError("class S { private aside(): void { renameSync(this.p, this.p + '.c'); }\n" + read + " }"), true, "a class method");
  assert.equal(renamesAsideOnReadError("class S { async aside() { renameSync(a, b); }\n" + read + " }"), true, "an async method");
  assert.equal(renamesAsideOnReadError("async function aside(p) { renameSync(p, q); }\ntry { JSON.parse(readFileSync(p)); } catch { aside(p); }"), true, "an async function");
  assert.equal(renamesAsideOnReadError("const aside = function (p) { renameSync(p, q); };\ntry { JSON.parse(readFileSync(p)); } catch { aside(p); }"), true, "a function expression");
  assert.equal(renamesAsideOnReadError("const aside = (p) => renameSync(p, p + '.x');\ntry { JSON.parse(readFileSync(p)); } catch { aside(p); }"), true, "a brace-less arrow");
  assert.equal(renamesAsideOnReadError("class S { tidy(): void { unlinkSync(this.p); }\n" + "try { JSON.parse(readFileSync(p)); } catch { this.tidy(); } }"), false, "a method that does not rename");
  assert.equal(renamesAsideOnReadError("try { writeFileSync(t, b); renameSync(t, p); } catch { unlinkSync(t); }"), false, "a tmp-to-final rename is not an aside");
  assert.equal(renamesAsideOnReadError("try { mkdirSync(d); renameSync(a, b); } catch { /* fresh */ }"), false);
});

test("no extension host renames a file aside in a catch of a read", () => {
  const allowed = new Set(ALLOWED.map(([f]) => f));
  const bad = tracked()
    .filter((f) => SCOPE.test(f) && !OUT.test(f) && existsSync(join(ROOT, f)) && !allowed.has(f))
    .filter((f) => renamesAsideOnReadError(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(bad, [],
    "a read error is not a corrupt file: read through readStore (@waterplane/shared storefile.ts), which moves a file aside only when it parsed badly and leaves an EMFILE/EACCES file where it is");
});

test("ALLOWED is not stale", () => {
  for (const [f] of ALLOWED) assert.ok(existsSync(join(ROOT, f)) && renamesAsideOnReadError(readFileSync(join(ROOT, f), "utf8")), `${f} no longer needs an allowance`);
});
