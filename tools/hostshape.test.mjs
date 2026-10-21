/**
 * The host's SHAPE: the three big files only shrink, and the folders they are
 * cut into (`sessions/`, `intents/`, `server/`) stay the slices the target
 * architecture says they are.
 *
 * ── Why this is a test and not a sentence ───────────────────────────────────
 *
 * `webshape.test.mjs`'s argument, one package over. `sessions.ts`,
 * `intents/manager.ts` and `main.ts` hold 11.5k of the host's lines and every
 * daemon change conflicts in one of them. The split only pays while it is
 * one-way, so each line count is a RATCHET that goes down with every commit
 * that moves code out. The rest pins what makes a move a MOVE rather than a
 * copy (a method left behind in the facade and also defined in its slice runs
 * whichever the arrow on the core picks), what makes a type file a type file,
 * what makes a `server/` file a factory rather than a script, and that the
 * `dist/` contract — the exports tests and importers rest on — survives.
 *
 * Written BEFORE any code moves: today `sessions/` and `server/` do not exist
 * and `intents/` holds only the facade and `adapters.ts`, so most checks below
 * are vacuous on day one and start biting with the first slice. All of it is
 * read as TEXT: no build, no import. Reasoning and the per-check rationale:
 * docs/notes/host-architecture.md, "Caps and ratchets".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { headModules } from "./skillmap.mjs";
import { warnLongFiles } from "./longfiles.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES = join(ROOT, "packages");
const SRC = join(PACKAGES, "host", "src");
const SKILLS = join(ROOT, ".claude", "skills");

/**
 * The most lines each big file may have. **Lower the number when you move code
 * out**, in the same commit — that is the ratchet. Raising one is a decision
 * about the file every change conflicts in, never a way to pass. End state:
 * `sessions.ts` ≤ 1,100, `intents/manager.ts` ≤ 450, `main.ts` ≤ 700 (planned as 650;
 * host-architecture.md, "Result", says why it stops at 700).
 */
const MAX_LINES = {
  "sessions.ts":         700,
  // 314 → 316 (2026-10-08, store writes that fail are refusals): one core entry (`lastWriteError`,
  // which post/upsert/fire word their refusal from) and its public read for the routes; the
  // behaviour lives in `intents/disk.ts`, `write.ts` and `fire.ts`. Far under the 450 end state.
  "intents/manager.ts":  316,
  // 684 → 686 (2026-10-02, first-app WP6): a new subsystem's import + its one `ctx` line; the job
  // itself lives in `onboard.ts` and its wiring in `server/firstapp.ts`. Still under the 700 end state.
  // 686 → 690 (2026-10-09, burn-rate push): the watcher's import + construction + one observe line; the rule lives in burnwatch.ts / shared burn.ts.
  "main.ts":             690,
  // The ledger readers' barrels (docs/notes/host-architecture.md, "Ledger readers as landed"):
  // they only re-export, so they only shrink.
  "ctxlog.ts":           60,
  "transcript.ts":       40,
  // capture.ts / backlog.ts were 1,143 / 1,133 lines; now facades over capture/capture*.ts and backlog/.
  "capture.ts":          300,
  "backlog.ts":          250,
  // The HTTP router: its routes move into `routes/api*.ts` tables (C1, host-architecture.md,
  // "api.ts — the HTTP routes as tables"); it keeps the frame — CORS, preflight, dispatch.
  "api.ts":              74,
  // routes/work.ts was 1,013 lines of handlers; now the barrel over routes/work/ (host-architecture.md, "The rest of the host").
  "routes/work.ts":      30,
  // sidecar.ts was 1,122 lines; now its header doc and the re-exports over sidecar/.
  "sidecar.ts":          90,
  // The ONE delivery implementation (CLAUDE.md: never fork it), 1,442 lines; a facade over
  // `deliver/` — `deliverPrompt`, `deliverToNewSession`, the audit row (host-architecture.md,
  // "The deliver slices"). Moved, never copied: it only shrinks.
  "deliver.ts":          157,
  // The echo proof deliver.ts rests on, 894 of the 900 cap until 2026-10-21 (d01ebdd4): split by
  // subject into the text rule (echo.ts) and the box on rendered rows (composer.ts). Its notes were
  // trimmed once to fit (a8203f2b) — over this line, cut by subject again, never the comments.
  "echo.ts":             500,
  "composer.ts":         500,
};

/** Each HTTP route table in `routes/` (`api*.ts`). Not `MAX_SLICE_LINES`: a table is a
 *  list of short handlers, and one past this is a domain that wants its own file. */
const MAX_API_TABLE_LINES = 500;

/** A slice is never the class moved one folder down. The number eslint's
 *  `max-lines` warns at — here it fails. */
const MAX_SLICE_LINES = 900;
/** …and the two newer folders hold the stricter line the split brief set: 500. */
const TIGHT_DIRS = { capture: 500, backlog: 500, "routes/work": 500, sidecar: 500, deliver: 500 };

/** Folder → the facade whose slices live there, and the files there that are
 *  NOT slices (they have their own numbers above, or none). */
const SLICE_DIRS = {
  sessions: { facade: "sessions.ts", notSlices: [] },
  intents: { facade: "intents/manager.ts", notSlices: ["manager.ts", "adapters.ts"] },
  server: { facade: "main.ts", notSlices: [] },
  ctxlog: { facade: "ctxlog.ts", notSlices: [] },
  transcript: { facade: "transcript.ts", notSlices: [] },
  // The two leaf backends' siblings (`android.ts` … `window.ts`) predate the split and are not its slices.
  capture: { facade: "capture.ts", notSlices: ["android.ts", "garmin.ts", "pixels.ts", "types.ts", "web.ts", "window.ts"] },
  backlog: { facade: "backlog.ts", notSlices: [] },
  "routes/work": { facade: "routes/work.ts", notSlices: [] },
  sidecar: { facade: "sidecar.ts", notSlices: [] },
  deliver: { facade: "deliver.ts", notSlices: [] },
};

/** The ledger readers' slices are held to the split brief's cap, not the 900. */
const LEDGER_SLICE_LINES = 500;

// Early warning (never fails): host files past 800 lines, under whatever cap applies.
warnLongFiles("host", SRC);

const lines = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
const read = (rel) => readFileSync(join(SRC, rel), "utf8");
/** Code, not prose (queue.test.mjs's `code()`). */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** `.ts` files directly in `src/<dir>/`, as `<dir>/<name>`. */
function dirFiles(dir) {
  const d = join(SRC, dir);
  if (!existsSync(d)) return [];
  return readdirSync(d, { recursive: true })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${dir}/${f.split("\\").join("/")}`)
    .sort();
}
/** `capture/`'s older backend files keep their old, shared basenames; only its new slices are held to the naming rules. */
const named = (dir) => (dir === "capture" ? slices(dir) : dirFiles(dir));
const slices = (dir) => dirFiles(dir).filter((f) => !SLICE_DIRS[dir].notSlices.includes(f.slice(dir.length + 1)));

test("the three big files do not grow", () => {
  const over = [];
  for (const [rel, max] of Object.entries(MAX_LINES)) {
    const n = lines(read(rel));
    if (n > max) over.push(`${rel} is ${n} lines, over its ${max} ratchet by ${n - max}`);
    else if (n < max - 50) console.log(`# ${rel} is ${n} lines — lower MAX_LINES["${rel}"] in tools/hostshape.test.mjs to lock that in`);
  }
  assert.deepEqual(
    over, [],
    `New behaviour belongs in a slice (sessions/, intents/, server/) — see\n` +
    `docs/notes/host-architecture.md. Raise MAX_LINES in tools/hostshape.test.mjs only\n` +
    `as a decision, never to make this pass.`,
  );
});

test(`no slice is over ${MAX_SLICE_LINES} lines`, () => {
  const over = [];
  for (const dir of Object.keys(SLICE_DIRS)) {
    for (const f of slices(dir)) {
      const n = lines(read(f));
      const cap = TIGHT_DIRS[dir] ?? MAX_SLICE_LINES;
      if (n > cap) over.push(`${f}: ${n} lines (cap ${cap})`);
    }
  }
  assert.deepEqual(over, [], `A slice at ${MAX_SLICE_LINES}+ lines is the class moved one folder down — cut it again.`);
});

test(`no ctxlog/ or transcript/ slice is over ${LEDGER_SLICE_LINES} lines`, () => {
  const over = [];
  for (const dir of ["ctxlog", "transcript"]) {
    for (const f of slices(dir)) {
      const n = lines(read(f));
      if (n > LEDGER_SLICE_LINES) over.push(`${f}: ${n} lines`);
    }
  }
  assert.deepEqual(over, [], `A ledger-reader slice is held to ${LEDGER_SLICE_LINES} lines — cut it again by subject.`);
});

test(`no HTTP route table is over ${MAX_API_TABLE_LINES} lines`, () => {
  const over = dirFiles("routes")
    .filter((f) => /^routes\/api[^/]*\.ts$/.test(f))
    .map((f) => [f, lines(read(f))])
    .filter(([, n]) => n > MAX_API_TABLE_LINES)
    .map(([f, n]) => `${f}: ${n} lines`);
  assert.deepEqual(over, [], `Cut the table by domain — see host-architecture.md, "api.ts — the HTTP routes as tables".`);
});

test("the type files hold only types", () => {
  const bad = [];
  const TYPE_ONLY = [/\bfunction /, /\bclass /, /=> \{/, /\bnew /, /\bset(?:Interval|Timeout)\b/];
  for (const rel of ["sessions/core.ts", "server/ctx.ts", "deliver/delivertypes.ts"]) {
    if (!existsSync(join(SRC, rel))) continue; // not written yet
    const c = code(read(rel));
    for (const re of TYPE_ONLY) if (re.test(c)) bad.push(`${rel}: has ${re}`);
  }
  // contract.ts is allowed its four pure helpers; no class, no timer.
  if (existsSync(join(SRC, "intents/contract.ts"))) {
    const c = code(read("intents/contract.ts"));
    for (const re of [/\bclass /, /\bset(?:Interval|Timeout)\b/]) if (re.test(c)) bad.push(`intents/contract.ts: has ${re}`);
  }
  assert.deepEqual(bad, [], `sessions/core.ts and server/ctx.ts are the contract a slice is written against — types only.`);
});

test("main.ts exports nothing", () => {
  const ex = read("main.ts").split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /^export\b/.test(l));
  assert.deepEqual(ex.map(([n, l]) => `main.ts:${n}: ${l}`), [], `The entry point is never a library: move what is exported into a server/ or flat module.`);
});

test("the facades keep the exports the dist/ contract rests on", () => {
  const missing = [];
  // Every name that appears in an `export` statement: a declaration, or a
  // `export { … }` / `export type { … }` list (with or without `from`).
  const exported = (text) => {
    const names = new Set();
    for (const m of text.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/gm)) names.add(m[1]);
    for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
      for (const part of m[1].split(",")) {
        const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
        if (n) names.add(n);
      }
    }
    return names;
  };
  const s = read("sessions.ts");
  if (!/^export class SessionManager\b/m.test(s)) missing.push("sessions.ts: export class SessionManager");
  const sx = exported(s);
  for (const n of ["tmuxEnvPrefix", "sweepSessionStores"]) if (!sx.has(n)) missing.push(`sessions.ts: export ${n}`);
  const m = read("intents/manager.ts");
  if (!/^export class IntentManager\b/m.test(m)) missing.push("intents/manager.ts: export class IntentManager");
  const mx = exported(m);
  for (const n of ["ORIGIN_SCHEDULE_WORK", "ORIGIN_SCHEDULE_SWEEP", "ExecutorResult", "IntentExecutors", "IntentDeps"]) {
    if (!mx.has(n)) missing.push(`intents/manager.ts: export ${n}`);
  }
  assert.deepEqual(missing, [], `Tests import dist/sessions.js and dist/intents/manager.js, and host modules import these names — a slice re-exports through its facade (\`export { x } from "./sessions/tmux.js"\`).`);
});

/**
 * A method header in a class: modifiers, a name, a parameter list, and `{` at
 * the END of the line — so a one-line delegation (`{ return this.x.f(); }`),
 * which ends in `}`, is not one, and neither is an indented statement.
 */
const HEADER = /^\s{2}(?:private |protected |static |readonly |async |get |set )*(\w+)\(.*\{\s*$/;
const FUNC = /^(?:export )?(?:async )?function (\w+)\(/;
/** A `server/` slice's definitions live INSIDE its factory, indented — so for
 *  main.ts against server/ both a nested `function x(` and a `const x = (…) =>`
 *  count (main's own top-level ones included: `fmtSize`, `textOf`). Without
 *  this the check could never fire for server/: every function there is nested. */
const NESTED_FUNC = /^\s*(?:export )?(?:async )?function (\w+)\(/;
const ARROW = /^(\s*)(?:export )?const (\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?\(.*\)\s*(?::[^=]+)?=>/;
const NOT_METHODS = new Set(["constructor", "if", "for", "while", "switch", "catch", "function"]);
const defsIn = (text, { headers, nested = false, arrows = false }) => {
  const out = new Set();
  for (const l of code(text).split("\n")) {
    const f = (nested ? NESTED_FUNC : FUNC).exec(l)?.[1];
    if (f) out.add(f);
    const a = arrows ? ARROW.exec(l) : null;
    if (a && (nested || a[1] === "")) out.add(a[2]);
    const h = headers ? HEADER.exec(l)?.[1] : null;
    if (h && !NOT_METHODS.has(h)) out.add(h);
  }
  return out;
};

test("a move is a move: no name defined both in a facade and in one of its slices", () => {
  const dup = [];
  for (const [dir, { facade }] of Object.entries(SLICE_DIRS)) {
    // main.ts is a script: its definitions are top-level functions, and a
    // server/ slice's are too. The two class facades compare method headers.
    const isMain = facade === "main.ts";
    const facadeDefs = defsIn(read(facade), { headers: !isMain, arrows: isMain });
    for (const f of slices(dir)) {
      for (const name of defsIn(read(f), { headers: !isMain, nested: isMain, arrows: isMain })) {
        if (facadeDefs.has(name)) dup.push(`${name}: defined in ${facade} AND ${f}`);
      }
    }
  }
  assert.deepEqual(
    dup, [],
    `A copy-then-delete move left the original behind. Delete it from the facade (a one-line\n` +
    `delegation is fine), or name the slice's function for what it is (\`rowFor\`, not \`get\`).`,
  );
});

/**
 * `main.ts` fills `ctx` incrementally (`const ctx = {} as ServerCtxDraft`), and
 * a cast is not checked for completeness: a member nobody assigns compiles and
 * is `undefined` at runtime, where the old `HostCtx` literal was a compile
 * error. So: every member of `HostCtx` and `ServerCtx` is assigned in main.ts —
 * `ctx.<name> = …` or inside an `Object.assign(ctx, { … })` — exactly once.
 */
test("main.ts assigns every HostCtx + ServerCtx member exactly once", () => {
  if (!existsSync(join(SRC, "server/ctx.ts"))) return; // before M1
  const members = (rel, iface) => {
    const c = code(read(rel));
    const body = new RegExp(`^export interface ${iface}\\b[^{]*\\{([\\s\\S]*?)^\\}`, "m").exec(c)?.[1] ?? "";
    return [...body.matchAll(/^ {2}(?:readonly )?(\w+)\??\s*[:(]/gm)].map((m) => m[1]);
  };
  const want = [...members("routes/types.ts", "HostCtx"), ...members("server/ctx.ts", "ServerCtx")];
  const main = code(read("main.ts"));
  const got = [...main.matchAll(/\bctx\.(\w+)\s*=(?!=)/g)].map((m) => m[1]);
  for (const m of main.matchAll(/Object\.assign\(\s*ctx\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
    for (const part of m[1].split(",")) {
      const k = part.trim().split(/\s*:/)[0];
      if (/^\w+$/.test(k)) got.push(k);
    }
  }
  const missing = [...new Set(want)].filter((n) => !got.includes(n));
  const twice = [...new Set(got.filter((n, i) => got.indexOf(n) !== i))];
  assert.ok(want.length > 60, `parsed only ${want.length} ctx members — the interface regex has drifted`);
  assert.deepEqual({ missing, twice }, { missing: [], twice: [] },
    `Every ctx member is assigned once in main.ts, right after its definition — a missing one is undefined at runtime.`);
});

test("nothing runs at import time in server/", () => {
  const ALLOWED = /^(?:import |export |type |interface |const [A-Z_]+ = |\}|\/\*|\s*\*|\/\/)/;
  const bad = [];
  for (const f of dirFiles("server")) {
    read(f).split("\n").forEach((l, i) => {
      if (l.trim() === "" || /^\s/.test(l)) return;
      if (!ALLOWED.test(l)) bad.push(`${f}:${i + 1}: ${l.slice(0, 80)}`);
    });
  }
  assert.deepEqual(
    bad, [],
    `A server/ module exports factories: registration happens inside an exported wire…/create…/make…/install…\n` +
    `function called by main.ts, in boot order — never at import, never as module state.`,
  );
});

test("local/host-boundary is wired for the host and pinned", () => {
  const cfg = readFileSync(join(ROOT, "eslint.config.js"), "utf8");
  const block = /\{\s*files:\s*\[\s*"packages\/host\/src\/\*\*\/\*\.(?:ts|\{ts\})"\s*\],\s*plugins:\s*\{\s*local\s*\},\s*rules:\s*\{\s*"local\/host-boundary":\s*"error"\s*\}/;
  assert.ok(block.test(cfg), `eslint.config.js must apply "local/host-boundary": "error" to packages/host/src/**/*.ts — the lint rule IS the slice boundary.`);
  assert.ok(existsSync(join(ROOT, "tools", "hostboundary.test.mjs")), `tools/hostboundary.test.mjs pins the rule both ways; it must exist.`);
});

test("every file in sessions/, intents/, server/ has a basename unique across packages/", () => {
  const seen = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) seen.set(e.name, [...(seen.get(e.name) ?? []), p.slice(PACKAGES.length + 1)]);
    }
  };
  walk(PACKAGES);
  const bad = [];
  for (const dir of Object.keys(SLICE_DIRS)) {
    for (const f of named(dir)) {
      const all = seen.get(basename(f)) ?? [];
      if (all.length > 1) bad.push(`${basename(f)}: ${all.join(", ")}`);
    }
  }
  assert.deepEqual(bad, [], `The skill map and claudemd.test.mjs route modules by BASENAME — pick a name no other file has (wall.ts, not limit.ts).`);
});

/**
 * Every file in the three folders is named by a sub-skill bullet HEAD. Scope
 * choice: ALL files there, `manager.ts` and `adapters.ts` included — both are
 * already heads in `host-work`, so the check passes today without
 * special-casing, and it bites on the first new slice.
 */
test("every file in sessions/, intents/, server/ is named by a sub-skill bullet head", () => {
  const heads = (skill) => {
    const p = join(SKILLS, skill, "SKILL.md");
    return existsSync(p) ? headModules(readFileSync(p, "utf8")) : new Set();
  };
  const OWNER = { sessions: "host-core", intents: "host-work", server: "host", ctxlog: "host-ledgers", transcript: "host-ledgers", capture: "host-machine", backlog: "host-work", "routes/work": "host-work", sidecar: "host-spenders", deliver: "host-core" };
  const bad = [];
  for (const [dir, skill] of Object.entries(OWNER)) {
    const routed = heads(skill);
    for (const f of named(dir)) if (!routed.has(basename(f))) bad.push(`${f}: no \`- \` bullet head in .claude/skills/${skill}/SKILL.md names \`${basename(f)}\``);
  }
  assert.deepEqual(
    bad, [],
    `A slice nobody routes to is a slice whose rules nobody loads. Name it in the owning skill's bullet head,\n` +
    `then regenerate the host router's map line (claudemd.test.mjs prints it).`,
  );
});

/**
 * A `server/` factory reads `ctx.<x>` at CALL time and never binds a member at
 * construction (host-architecture.md, "How a slice reaches shared state"):
 * `main.ts` fills `ctx` incrementally, so a `const { sessions } = ctx` at the
 * top of a factory can capture a member that is not assigned YET and hold
 * `undefined` for the life of the process — and it compiles, because the draft
 * is cast. Checked at the factory body's indent (2 spaces); deeper bindings are
 * inside a callback and run at call time. The four constants main.ts sets
 * before any factory is called are exempt, and `clients.ts` is: it is handed
 * explicit deps (`createClients({ auth, notifyPrefs, push, sessions })`), not
 * `ctx`.
 */
test("server/ factories never bind a ctx member at construction", () => {
  const EXEMPT = new Set(["ROOT", "BOOT_ID", "PORT", "DOCTOR"]);
  const bad = [];
  for (const f of dirFiles("server")) {
    if (f === "server/clients.ts") continue;
    for (const m of code(read(f)).matchAll(/^ {2}(?:const|let)\s+(\{[^}]*\}|\w+)[^=\n]*=\s*ctx\b(?:\.(\w+))?/gm)) {
      const [, lhs, member] = m;
      const names = member ? [member] : lhs.startsWith("{") ? lhs.slice(1, -1).split(",").map((p) => p.trim().split(/\s*:/)[0]).filter(Boolean) : ["(whole ctx)"];
      if (names.every((n) => EXEMPT.has(n))) continue;
      bad.push(`${f}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(
    bad, [],
    `A factory that binds ctx.<x> at construction holds whatever main.ts had assigned by then — read ctx.<x>\n` +
    `inside the function that needs it (ctx.ROOT/BOOT_ID/PORT/DOCTOR are set first and exempt).`,
  );
});

/**
 * The hub literal hands a slice some fields BY REFERENCE (`inflight: this.inflight`,
 * `sessions: this.sessions`): the slice keeps that object, so a facade method that
 * later REASSIGNED the field would leave every slice holding the old one. A
 * `readonly` field makes that reassignment a type error. Arrow members
 * (`rows: () => this.rows`) are read at call time and need nothing.
 */
test("every by-reference member of a facade's core literal names a readonly field", () => {
  const bad = [];
  for (const rel of ["sessions.ts", "intents/manager.ts"]) {
    const c = code(read(rel));
    const lit = /this\.core = \{([\s\S]*?)^ {4}\};/m.exec(c)?.[1];
    if (!lit) { bad.push(`${rel}: no \`this.core = {\` literal found — this check's regex has drifted`); continue; }
    for (const [, key, field] of lit.matchAll(/(\w+):\s*this\.(\w+)\s*(?=[,}\n])/g)) {
      if (!new RegExp(`\\breadonly\\s+${field}\\b`).test(c)) bad.push(`${rel}: core.${key} is this.${field}, which is not readonly`);
    }
  }
  assert.deepEqual(bad, [], `Mark the field (or constructor parameter) \`private readonly\` — the slices share it by reference.`);
});

/**
 * No module writes `process.env` as a statement of its own body. The facades
 * import their knobs (`sessions/knobs.ts`, `intents/contract.ts`) at a fixed
 * place in their import list and read `WATERPLANE_*` there, at import; that is only
 * order-independent because nothing assigns the environment at import. One
 * top-level `process.env.X = …` anywhere would make which knobs see it depend
 * on import order. (Inside a function it is a runtime write, and not this
 * check's business.) The one module that writes the environment at import is
 * `env.ts`, through `loadEnvFiles` (`envfiles.ts`) — a call, not a column-0
 * assignment — and it is `main.ts`'s FIRST import, so it runs before every knob is read.
 */
test("no host module assigns process.env at import", () => {
  const bad = [];
  for (const f of readdirSync(SRC, { recursive: true }).filter((f) => f.endsWith(".ts")).map((f) => f.split("\\").join("/"))) {
    code(read(f)).split("\n").forEach((l, i) => {
      if (/^process\.env(?:\.\w+|\[[^\]]+\])\s*(?:\?\?|\|\||&&)?=(?!=)/.test(l)) bad.push(`${f}:${i + 1}: ${l.slice(0, 80)}`);
    });
  }
  assert.deepEqual(bad, [], `An import-time env write makes import order behaviour — set it inside a function, or in the .env file.`);
});

