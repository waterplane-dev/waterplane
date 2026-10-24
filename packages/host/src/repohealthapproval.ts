/**
 * The approval of code that arrived with a checkout, split out of `repohealth.ts`
 * (900-line lint cap): the engine key, the approvals store, the gates that decide
 * whether an engine or a repo's own readings may run, and the consent token.
 * Moved verbatim — behaviour unchanged.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { BRAND, REPOHEALTH_TOOL } from "@waterplane/shared";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";
import { hostStateDir } from "./branddirs.js";
import { ROOT, env } from "./env.js";
import { containedReal } from "./paths.js";
import { confirmGate, gateRefusal, type ConfirmGate } from "./confirmgate.js";

/* A worktree's own `tools/repohealth.mjs` is code that arrived with a checkout
   (clone, autopull). Spawning it when the Repo readings sheet merely OPENS is
   code execution without a tap. The person's one approval is remembered in the
   host's own state as sha256(realpath(worktree)) + sha256(engine bytes) — an
   edited engine is a different key and asks again (`builds.ts` optionsTrusted
   is the precedent). The bundled engine is this desktop's and needs none. */
const approvalsPath = (root: string): string => join(hostStateDir(root), "repohealth-approvals.json");

export const HEALTH_JSON = `${BRAND.sharedDirName}/health.json`;
const TREE_MAX_FILES = 2000;
/** The most bytes one hashed module or sibling may hold; past it the key is incomplete. */
const FILE_MAX_BYTES = 4 * 1024 * 1024;
/** The most bytes the entry or health.json may hold to be read whole on the event loop. */
const TEXT_MAX_BYTES = 1024 * 1024;

/** Does a parsed health.json carry a `run` argv anywhere (a reading or a central override)? */
function declaresRun(v: unknown, depth = 0): boolean {
  if (depth > 6 || !v || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some((x) => declaresRun(x, depth + 1));
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.run)) return true;
  return Object.values(o).some((x) => declaresRun(x, depth + 1));
}

type Readable = "ok" | "absent" | "a link out of the repo" | "not a regular file" | "over 1 MB";

/**
 * May `rel` be read whole, on the event loop? Present, inside the worktree by
 * realpath, a regular file, under the cap. A committed `tools/repohealth.mjs ->
 * /dev/zero` would otherwise be a `readFileSync` that never returns — on every
 * sheet open and every sweep.
 */
function readable(wt: string, rel: string): Readable {
  const full = join(wt, rel);
  try { lstatSync(full); } catch { return "absent"; }
  if (containedReal(wt, rel) === null) return "a link out of the repo";
  let st;
  try { st = statSync(full); } catch { return "not a regular file"; }
  if (!st.isFile()) return "not a regular file";
  if (st.size > TEXT_MAX_BYTES) return "over 1 MB";
  return "ok";
}

/** The committed health.json's bytes, only when it declares commands of its own. A file the
 *  host must not read whole stands in for its bytes and counts as declaring (fails closed). */
function ownCommandsBody(wt: string): Buffer | null {
  const r = readable(wt, HEALTH_JSON);
  if (r === "absent") return null;
  if (r !== "ok") return Buffer.from(`unreadable: ${r}`);
  let body: Buffer;
  try { body = readFileSync(join(wt, HEALTH_JSON)); } catch { return null; }
  try { return declaresRun(JSON.parse(body.toString("utf8"))) ? body : null; } catch { return null; }
}

/**
 * Every file under `dir` (sorted relative paths + bytes), skipping symlinks that
 * leave the tree. False when the walk was CUT (too deep, too many files, a file
 * too big): a truncated hash would approve the files it never read, so the
 * caller treats a cut as "cannot pin".
 */
function hashTree(dir: string, h: ReturnType<typeof createHash>): boolean {
  let top: string;
  try { top = realpathSync.native(dir); } catch { return true; }
  const files: string[] = [];
  let cut = false;
  const walk = (d: string, depth: number) => {
    if (depth > 8 || files.length > TREE_MAX_FILES) { cut = true; return; }
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const full = join(d, n);
      let real: string;
      try { real = realpathSync.native(full); } catch { continue; }
      if (real !== top && !real.startsWith(top + sep)) continue; // a link out of the tree
      let st;
      try { st = statSync(real); } catch { continue; }
      if (st.isDirectory()) walk(real, depth + 1);
      else if (st.isFile()) { if (st.size > FILE_MAX_BYTES) cut = true; else files.push(real); }
    }
  };
  walk(top, 0);
  for (const f of files.sort()) {
    h.update("F\0").update(f.slice(top.length)).update("\0");
    try { h.update(readFileSync(f)); } catch { h.update("?"); }
    h.update("\0");
  }
  return !cut;
}

/** Files read as code; anything else an engine imports (JSON) is only hashed. */
const CODE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** A `/` after one of these words opens a regex literal, not a division. */
const REGEX_AFTER_WORD = /(^|[^\w$])(?:return|typeof|case|in|of|do|else|throw|delete|void|await|yield|instanceof|new)\s*$/;

/**
 * The source as code, twice. `code`: the comments removed, every string, template
 * and regex literal kept whole — the specifier regexes read it. `blank`: the
 * comments removed and the string and template TEXT blanked to its quotes, a
 * template's `${…}` expressions and regex literals kept — `UNPINNABLE` reads it.
 * So prose anywhere ("the dynamic `import()`", Python's `from a.b import (\n X)`,
 * a string saying `import(x)`) is never read as a call, a `//` inside a string
 * is never read as a comment, and an `import()` inside a template expression is
 * still seen. One tokenizer, recursive through `${…}`.
 *
 * A `/` after a value (an identifier, `)`, `]`, `}`, a string, a postfix `++`/`--`)
 * is a division; after a keyword or an operator it opens a regex literal. Doubt
 * is a division, and regex bodies are not blanked: a misread division then
 * EXPOSES code to the check, where a misread regex would hide it. Null when the
 * text does not scan (an unterminated string, template, regex or comment): the
 * caller treats that as "cannot pin". Honest scope: a heuristic over text, not a
 * parser; it closes the plain shapes, not every trick an author could hide one in.
 */
export function stripComments(src: string): { code: string; blank: string } | null {
  // A shebang is a comment to Node; to a slash-reader it is two regex literals and a hang.
  if (src.startsWith("#!")) { const e = src.indexOf("\n"); src = e < 0 ? "" : src.slice(e); }
  const n = src.length;
  let code = "";
  let blank = "";
  let last = "";   // the last significant character of `code`
  let prev = "";   // the one before it: a postfix `++`/`--` ends in an operator and is still a value
  const sig = (c: string) => { if (!/\s/.test(c)) { prev = last; last = c; } };
  const emit = (c: string, b: string = c) => { code += c; blank += b; for (const ch of c) sig(ch); };
  const emitRun = (raw: string, b: string, lastChar: string) => { code += raw; blank += b; prev = last; last = lastChar; };
  const blanked = (from: number, to: number, q: string): string => q + " ".repeat(Math.max(0, to - from - 2)) + q;

  /** Index after the closing quote, or -1 (unterminated). */
  const skipString = (from: number, q: string): number => {
    for (let j = from + 1; j < n; j++) {
      const c = src[j]!;
      if (c === "\\") { j++; continue; }
      if (c === q) return j + 1;
      if (c === "\n") return -1;
    }
    return -1;
  };
  /** Index after a regex literal and its flags, or -1 (unterminated). */
  const skipRegex = (from: number): number => {
    let j = from + 1;
    let inClass = false;
    for (; j < n; j++) {
      const k = src[j]!;
      if (k === "\\") { j++; continue; }
      if (k === "\n") return -1;
      if (inClass) { if (k === "]") inClass = false; continue; }
      if (k === "[") inClass = true; else if (k === "/") break;
    }
    if (j >= n) return -1;
    j++;
    while (j < n && /[a-z]/i.test(src[j]!)) j++;
    return j;
  };
  /** Does a `/` here open a regex literal? */
  const regexHere = (): boolean => {
    if (last === "") return true;
    if (/[\w$]/.test(last)) {
      const m = REGEX_AFTER_WORD.exec(code.slice(-40));
      return !!m && (m[1] !== "" || code.length <= 40);
    }
    if (/[)\]}'"`]/.test(last)) return false;
    if ((last === "+" && prev === "+") || (last === "-" && prev === "-")) return false;
    return true;
  };
  /** Code from `start`: to the end, or — inside a template's `${…}` — through the `}` that closes it. */
  const scan = (start: number, inExpr: boolean): number => {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = src[i]!;
      const d = src[i + 1];
      if (c === "/" && d === "/") { const e = src.indexOf("\n", i); i = e < 0 ? n : e; continue; }
      if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) return -1; code += " "; blank += " "; i = e + 2; continue; }
      if (c === "'" || c === '"') { const e = skipString(i, c); if (e < 0) return -1; emitRun(src.slice(i, e), blanked(i, e, c), c); i = e; continue; }
      if (c === "`") { const e = scanTemplate(i); if (e < 0) return -1; i = e; continue; }
      if (c === "/" && regexHere()) { const e = skipRegex(i); if (e < 0) return -1; const lit = src.slice(i, e); emitRun(lit, lit, "/"); i = e; continue; }
      if (inExpr) {
        if (c === "{") depth++;
        else if (c === "}") { if (depth === 0) { emit(c); return i + 1; } depth--; }
      }
      emit(c);
      i++;
    }
    return inExpr ? -1 : n;
  };
  /** A template literal from its opening backtick: text blanked, each `${…}` scanned as code. */
  const scanTemplate = (start: number): number => {
    emit("`");
    let i = start + 1;
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") { code += src.slice(i, i + 2); blank += "  "; i += 2; continue; }
      if (c === "`") { emit("`"); return i + 1; }
      if (c === "$" && src[i + 1] === "{") { emit("${"); const e = scan(i + 2, true); if (e < 0) return -1; i = e; continue; }
      code += c; blank += c === "\n" ? "\n" : " "; i++;
    }
    return -1;
  };
  return scan(0, false) < 0 ? null : { code, blank };
}

/** Every literal specifier a module names — `import … from "x"`, `import "x"`, `export … from "x"`, `import("x")`, `require("x")`. Group 2 is the specifier. */
const ANY_SPEC_RE = /(?:(?:^|[\n;])\s*(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?|\b(?:import|require_*)\s*\(\s*)(["'])([^"'`\n]+)\1/g;
/** Every `import(` / `require(` call opener (`require_`: a `createRequire` alias by that name). */
const CALL_RE = /\b(?:import|require_*)\s*\(/g;
/** The one call shape the key can pin: one plain string, nothing else between the parentheses. */
const PLAIN_CALL_RE = /\b(?:import|require_*)\s*\(\s*(["'])[^"'`\n]*\1\s*\)/g;
/**
 * Code the key cannot pin, read off the `blank` view. `eval` in any form (a
 * reference is enough: `(0, eval)(x)`), `Function(…)` with or without `new`, a
 * worker thread, a native addon, `createRequire` called straight away or bound
 * to a name the call regexes do not know. A later pull could change what such
 * an engine LOADS without changing a byte of what was approved.
 */
const UNPINNABLE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\beval\b/, "eval"],
  [/\bFunction\s*\(/, "Function()"],
  [/\bnew\s+Worker\s*\(|\bprocess\.dlopen\b/, "a worker thread or a native addon"],
  [/\bcreateRequire\s*\([^)]*\)\s*\(/, "createRequire called straight away"],
  [/\b(?:const|let|var)\s+(?!require_*\b)[\w$]+\s*=\s*createRequire\s*\(/, "createRequire bound to a name other than require"],
];
/** `import { register } from "node:module"` installs loader hooks: code the key never sees. Read off `code`. */
const MODULE_REGISTER_RE = /\bimport\s*\{[^}]*\bregister\b[^}]*\}\s*from\s*(["'])node:module\1/;
/** Builtins that run code from a string or a file the key never saw. */
const UNPINNABLE_MODULES = new Set(["vm", "node:vm", "worker_threads", "node:worker_threads"]);
const BUILTINS = new Set(builtinModules);

type SpecKind = "relative" | "builtin" | "map" | "bare" | "foreign";
/** What a specifier resolves through. `foreign` = a URL (`data:`, `file:`, `http:`) or an absolute path. */
function classifySpec(spec: string): SpecKind {
  if (spec.startsWith("./") || spec.startsWith("../")) return "relative";
  if (spec.startsWith("node:") || BUILTINS.has(spec)) return "builtin";
  if (spec.startsWith("#")) return "map";
  if (/^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*$/.test(spec)) return "bare";
  return "foreign";
}

/** The package a bare specifier names: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

const count = (s: string, re: RegExp): number => { let k = 0; for (const _ of s.matchAll(re)) k++; return k; };

/** What `scanModules` found: every module hashed, or why the engine cannot be pinned, and the bare packages it imports. */
interface Scan { complete: boolean; why: string | null; bare: Set<string> }

/**
 * The entry's relative imports, transitively — static, and dynamic or `require`d
 * with ONE PLAIN STRING (a pull editing `tools/lib/x.mjs` is new code the entry
 * runs) — hashed after the entry. Contained to the worktree by realpath; an
 * import that resolves outside it is not followed and makes the engine
 * unpinnable (a sibling checkout under ROOT is pull-controlled too). Bounded:
 * past the bound the scan is incomplete and the engine is not approvable. Along
 * the way every module is read for the shapes the key cannot pin, and its bare
 * specifiers are collected for `committedDependency`.
 */
function scanModules(entry: string, wtReal: string, h: ReturnType<typeof createHash>): Scan {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue: string[] = [];
  let why: string | null = null;
  const note = (w: string) => { why ??= w; };
  try { queue.push(realpathSync.native(entry)); } catch { return { complete: false, why: "the engine file cannot be read", bare }; }
  while (queue.length && seen.size < TREE_MAX_FILES) {
    const f = queue.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    const rel = f.slice(wtReal.length + 1);
    let raw: string;
    try {
      const st = statSync(f);
      if (!st.isFile()) continue;
      if (st.size > FILE_MAX_BYTES) { note(`${rel} is over 4 MB`); continue; }
      raw = readFileSync(f, "utf8");
    } catch { continue; }
    const isCode = CODE_EXT.test(f);
    const scanned = isCode ? stripComments(raw) : { code: raw, blank: raw };
    if (scanned === null) { note(`${rel} does not scan as JavaScript`); continue; }
    const { code, blank } = scanned;
    if (isCode) {
      if (count(blank, CALL_RE) !== count(blank, PLAIN_CALL_RE)) note(`an import() or require() whose argument is not one plain string, in ${rel}`);
      for (const [re, what] of UNPINNABLE) if (re.test(blank)) { note(`${what} in ${rel}`); break; }
      if (MODULE_REGISTER_RE.test(code)) note(`module.register() loader hooks in ${rel}`);
    }
    for (const m of code.matchAll(ANY_SPEC_RE)) {
      const spec = m[2]!;
      if (UNPINNABLE_MODULES.has(spec)) { note(`the ${spec.replace(/^node:/, "")} module in ${rel}`); continue; }
      switch (classifySpec(spec)) {
        case "relative": {
          let real: string;
          try { real = realpathSync.native(resolve(dirname(f), spec)); } catch { continue; } // absent: nothing to pin, node fails at run time
          if (real !== wtReal && !real.startsWith(wtReal + sep)) { note(`an import outside the repo (${spec}) in ${rel}`); continue; }
          queue.push(real);
          break;
        }
        case "map": note(`a package import map entry (${spec}) in ${rel}`); break;
        case "bare": bare.add(packageOf(spec)); break;
        case "foreign": note(`a module loaded from a URL or an absolute path (${spec}) in ${rel}`); break;
        case "builtin": break;
      }
    }
  }
  for (const f of [...seen].sort()) {
    h.update("I\0").update(f.slice(wtReal.length)).update("\0");
    try { h.update(readFileSync(f)); } catch { h.update("?"); }
    h.update("\0");
  }
  return { complete: queue.length === 0, why, bare };
}

/**
 * A bare specifier (`import x from "left-pad"`) resolves through `node_modules`
 * — any `node_modules` on the way up from the importing file, or a symlink by
 * that name — or, when it is the `name` of a `package.json` on that way up, to
 * the repo's own files (Node's self-reference). Installed by the person, a
 * dependency is not the clone's content; COMMITTED in the repo it is — code a
 * pull can change behind an approval. Git tells the two apart, and where it
 * cannot (not a repository) the engine is not approvable.
 */
function committedDependency(wt: string, entry: string, bare: Set<string>): string | null {
  if (!bare.size) return null;
  for (let d = dirname(entry); ; d = dirname(d)) {
    try {
      const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as { name?: unknown };
      if (typeof pkg?.name === "string" && bare.has(pkg.name)) return `the repo's own package name imported (${pkg.name})`;
    } catch { /* no package.json here */ }
    if (d === wt || dirname(d) === d) break;
  }
  try {
    const out = execFileSync("git", ["-C", wt, "ls-files", "-z", "--", "node_modules", "node_modules/*", "*/node_modules", "*/node_modules/*"], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024,
    });
    const hit = out.split("\0").find((l) => l);
    return hit ? `a dependency committed in the repo (${hit})` : null;
  } catch { return "a dependency whose origin git cannot tell"; }
}

/**
 * What an approval covers. A repo's own engine: the entry file AND every module
 * it imports from `tools/repohealth/` (a pull changing a sibling is new code),
 * plus its committed health.json when that declares commands. The bundled
 * engine: only that health.json, and only when it declares commands. No key =
 * nothing to approve (or an engine that cannot be read), or — with `why` — an
 * engine the key cannot pin, which is never approvable.
 */
function engineKeyOrWhy(wt: string, kind: "repo" | "bundled" = "repo"): { key: string | null; why: string | null } {
  let repo: string;
  try { repo = realpathSync.native(wt); } catch { repo = resolve(wt); }
  const h = createHash("sha256").update(kind).update("\0").update(repo).update("\0");
  const own = ownCommandsBody(wt);
  if (kind === "bundled") {
    if (!own) return { key: null, why: null };
    return { key: h.update("health\0").update(own).digest("hex"), why: null };
  }
  const r = readable(wt, REPOHEALTH_TOOL);
  if (r === "absent") return { key: null, why: null };
  if (r !== "ok") return { key: null, why: `${REPOHEALTH_TOOL} is ${r}` };
  const entry = join(wt, REPOHEALTH_TOOL);
  try { h.update(readFileSync(entry)); } catch { return { key: null, why: null }; }
  h.update("\0tree\0");
  let treeComplete = true;
  try { treeComplete = hashTree(join(dirname(realpathSync.native(entry)), "repohealth"), h); } catch { /* no siblings */ }
  const scan = scanModules(entry, repo, h);
  const why = scan.why
    ?? committedDependency(wt, entry, scan.bare)
    ?? (treeComplete && scan.complete ? null : "too many files, too deep or too big to read whole");
  if (why) return { key: null, why };
  if (own) h.update("\0health\0").update(own);
  return { key: h.digest("hex"), why: null };
}

function engineKey(wt: string, kind: "repo" | "bundled" = "repo"): string | null {
  return engineKeyOrWhy(wt, kind).key;
}

/** Why this worktree's own engine can never be approved — or null: approvable, or no engine of its own. */
export function engineUnapprovable(wt: string): string | null {
  if (!existsSync(join(wt, REPOHEALTH_TOOL)) && readable(wt, REPOHEALTH_TOOL) === "absent") return null;
  return engineKeyOrWhy(wt, "repo").why;
}

function readApprovals(root: string): string[] {
  const v = readJsonGuarded<unknown>(approvalsPath(root), []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function rememberApproval(root: string, key: string): void {
  const cur = readApprovals(root);
  if (cur.includes(key)) return;
  try {
    mkdirSync(hostStateDir(root), { recursive: true });
    writeJsonAtomic(approvalsPath(root), [...cur, key].slice(-2000), { space: 2 });
  } catch { /* not remembered: asks again */ }
}

/** Has what runs for this worktree, AS IT READS NOW, been approved? Fails closed. */
export function engineApproved(wt: string, root: string = ROOT, kind: "repo" | "bundled" = "repo"): boolean {
  const key = engineKey(wt, kind);
  return key !== null && readApprovals(root).includes(key);
}

/** Does the bundled engine have the repo's own commands (health.json `run`) to wait on? */
export function ownCommandsDeclared(wt: string): boolean {
  return ownCommandsBody(wt) !== null;
}

/** Remember the approval of what runs for this worktree as it reads now. */
export function approveEngine(wt: string, root: string = ROOT): void {
  const kind = resolveRepoHealthEngine(wt)?.kind ?? "bundled";
  const key = engineKey(wt, kind);
  if (key) rememberApproval(root, key);
}

/** The sentence for an unapproved repo engine; with `why` (`engineUnapprovable`), one the key cannot pin is told why it never runs. */
export const needsApprovalText = (why: string | null = null): string =>
  why
    ? `this repo ships its own ${REPOHEALTH_TOOL}, and it loads code an approval cannot pin (${why}) — it does not run on this desktop`
    : `this repo ships its own ${REPOHEALTH_TOOL} — it runs on this desktop only after you approve it once`;

export const ownApprovalText = (): string =>
  `this repo's ${HEALTH_JSON} declares commands of its own — they run on this desktop only after you approve them once`;

/** Is there anything for a person to approve here, right now? (The route's check.) */
export function approvalPending(wt: string, root: string = ROOT): boolean {
  const e = resolveRepoHealthEngine(wt);
  return !!e && (e.kind === "repo" || ownCommandsDeclared(wt)) && !engineApproved(wt, root, e.kind);
}

// ── The consent: a token the read minted, bound to the worktree (`confirmgate.ts`) ──
export const REPOHEALTH_APPROVE_SCOPE = "repohealth.approve";

/** A view the phone will draw: when it waits on an approval, it carries the token that approval needs. */
export function withApproveToken<V extends { engine?: { needsApproval?: boolean; approveToken?: string } | null }>(
  wt: string, view: V, gate: ConfirmGate = confirmGate,
): V {
  if (!view.engine?.needsApproval) return view;
  return { ...view, engine: { ...view.engine, approveToken: gate.mint(REPOHEALTH_APPROVE_SCOPE, wt) } };
}

/**
 * The approving tap: null when it was accepted (and remembered), else the refusal
 * sentence — nothing approved. Nothing pending is a no-op, not a refusal. The key
 * is computed once here (it hashes the engine's whole import graph).
 */
export function approveWithConsent(
  req: Pick<IncomingMessage, "headers">, wt: string, token: unknown,
  root: string = ROOT, gate: ConfirmGate = confirmGate,
): string | null {
  const e = resolveRepoHealthEngine(wt);
  if (!e) return null;
  const r = engineKeyOrWhy(wt, e.kind);
  const approved = r.key !== null && readApprovals(root).includes(r.key);
  if (!((e.kind === "repo" || r.key !== null) && !approved)) return null;
  if (e.kind === "repo" && r.why) return `${needsApprovalText(r.why)} — nothing was approved`;
  const why = gateRefusal(req, token, REPOHEALTH_APPROVE_SCOPE, wt, undefined, gate);
  if (why) return `${why} — nothing was approved`;
  if (r.key) rememberApproval(root, r.key);
  gate.consume(token);
  return null;
}

// ── Which engine reads a worktree (here so the approval key and the runner agree on it) ──

/** Which engine will read a worktree, and whose it is. */
export interface RepoHealthEngine {
  /** Absolute path to the script that gets spawned. */
  path: string;
  /** `repo` = the worktree's own copy, which decides its own root; `bundled` =
   *  this desktop's, pointed at the worktree with `--root=`. */
  kind: "repo" | "bundled";
}

/**
 * This desktop's own engine: the env override, else this checkout's copy.
 *
 * Read on every call rather than frozen at import. Since `env.ts` (`main.ts`'s
 * first import) loads the `.env` files, a constant would now see them too — but
 * a call-time read also serves a caller that never went through `main.ts`.
 *
 * The three hops are `env.ts`'s rule for `.env` and `webbundle.ts`'s for
 * `packages/web/dist`: `import.meta.dirname` is `packages/host/src` under tsx
 * and `packages/host/dist` after a build, and both are one level under
 * `packages/host`, so the same path reaches the repo root from either.
 *
 * `WATERPLANE_REPOHEALTH_ENGINE` is taken as an ABSOLUTE path and is not repaired: a
 * relative one would resolve against whatever `cwd` the daemon was started in,
 * which on a launchd service is `/`. A value that is not absolute, or names
 * nothing, is no engine — never a quiet fallback to the bundled one, because a
 * desktop that named an engine and typo'd it must not be told its reading came
 * from the engine it asked for.
 */
export function bundledEngine(): string | null {
  const named = env("REPOHEALTH_ENGINE");
  if (named) return isAbsolute(named) && existsSync(named) ? named : null;
  const own = resolve(import.meta.dirname, "../../..", REPOHEALTH_TOOL);
  return existsSync(own) ? own : null;
}

/**
 * Which engine reads this worktree — its own copy first, then the desktop's.
 *
 * The order is the header's: a repo carrying the tool is the authority on its
 * own root, and it is also how waterplane keeps reading itself with the engine it
 * ships rather than with a copy of the same file reached by a different path.
 */
export function resolveRepoHealthEngine(wt: string): RepoHealthEngine | null {
  const own = join(wt, REPOHEALTH_TOOL);
  if (existsSync(own)) return { path: own, kind: "repo" };
  const bundled = bundledEngine();
  return bundled ? { path: bundled, kind: "bundled" } : null;
}
