/**
 * Native tools: what the repo's OWN analyzers, scanners and coverage files
 * already say, read at the newest commit and never anywhere else.
 *
 * ── Why HEAD-only, and from the working directory ──────────────────────────
 *
 * Like `workspace.mjs`, this is a list a person acts on (upgrade this
 * package, fix these findings), and a tool run per commit would mean checking
 * out 150 trees. Every earlier row carries `read at the newest commit only`.
 * Unlike `workspace.mjs` it needs the FILES: a linter cannot run on a git
 * object. So it runs in the checkout it was pointed at (`--root=`), and the
 * caller passes the newest commit's timestamp: a coverage file older than the
 * last commit describes some other code and is not read.
 *
 * ── The rules every sub-reading holds ──────────────────────────────────────
 *
 * - Each is `{value}` or `{value: null, reason}`. A tool that is not on the
 *   PATH (or, for eslint and tsc, not in the repo's own `node_modules/.bin`)
 *   is ABSENT with "X is not installed". It is never 0: zero findings from a
 *   tool that did not run is the exact lie this family exists to avoid.
 * - Nothing is installed, nothing is fetched except by the scanner that
 *   needs a network (`osv-scanner`), and every child has a hard timeout. A
 *   timeout is an absence with its reason, not a partial count.
 * - Nothing is written into the measured repo: mypy gets a temp cache dir,
 *   ruff runs with `--no-cache`, detekt's report goes to a temp dir. Tests
 *   are never run; coverage files are only read.
 * - Counts per 1,000 lines divide by the tracked lines of THAT tool's
 *   language, so a Dart analyzer is not diluted by the repo's TypeScript.
 *
 * ── What is deliberately not here ──────────────────────────────────────────
 *
 * Dependency age needs a registry lookup per package, which is a network
 * call per dependency on every refresh. It is reported absent with that
 * reason until a cheap source exists (a lockfile has no publish date).
 * `tsc` is taken at the repo ROOT tsconfig only: a root that is only project
 * references reads as zero errors, and the reading says which config it ran.
 * Strictness follows no `extends`: it reports what each file itself says.
 *
 * The metric is pure over an injected environment (`run`, `fs`), so the test
 * stubs every tool; `defaultEnv()` is the one place that spawns or reads.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const NATIVE_NOT_HEAD = "read at the newest commit only";
const SECONDS = 1000;
export const NATIVE_TIMEOUT_MS = 180 * SECONDS;
const LIST_MAX = 20;
const MAX_BUFFER = 256 * 1024 * 1024;

export const ANALYZER_KEYS = ["eslint", "tsc", "ruff", "mypy", "dart", "shellcheck", "detekt", "ktlint"];

const none = (reason) => ({ value: null, reason });
const ok = (value) => ({ value });

/** The row field for a commit that is not the newest one. */
export function nativeElsewhere() {
  return {
    vulns: none(NATIVE_NOT_HEAD),
    dependencyAge: none(NATIVE_NOT_HEAD),
    analyzers: Object.fromEntries(ANALYZER_KEYS.map((k) => [k, none(NATIVE_NOT_HEAD)])),
    strictness: none(NATIVE_NOT_HEAD),
    coverage: none(NATIVE_NOT_HEAD),
  };
}

// ── languages ───────────────────────────────────────────────────────────────

const LANG_EXTS = {
  js: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  python: [".py"],
  dart: [".dart"],
  shell: [".sh", ".bash"],
  kotlin: [".kt", ".kts"],
};
const LANG_NAMES = { js: "TypeScript or JavaScript", python: "Python", dart: "Dart", shell: "shell", kotlin: "Kotlin" };
const SKIP_DIRS =new Set(["node_modules", "dist", "build", ".dart_tool", "vendor", "third_party", "__pycache__"]);
const skipPath = (p) =>
  p.split("/").some((s) => SKIP_DIRS.has(s)) || p.endsWith(".d.ts") || p.endsWith(".g.dart") || p.endsWith(".freezed.dart");
const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);

/** @returns {Record<string,string[]>} language -> tracked source paths. */
function filesByLang(files) {
  const out = Object.fromEntries(Object.keys(LANG_EXTS).map((l) => [l, []]));
  for (const p of files) {
    if (skipPath(p)) continue;
    const dot = baseName(p).lastIndexOf(".");
    const ext = dot < 0 ? "" : baseName(p).slice(dot).toLowerCase();
    for (const [lang, exts] of Object.entries(LANG_EXTS)) if (exts.includes(ext)) out[lang].push(p);
  }
  return out;
}

function countLines(env, root, paths) {
  let n = 0;
  for (const p of paths) {
    const t = env.readText(join(root, p));
    if (t === null) continue;
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) n++;
    if (t.length && t.charCodeAt(t.length - 1) !== 10) n++;
  }
  return n;
}

// ── running a tool ──────────────────────────────────────────────────────────

/** A finished run, or a sentence for why there is none. */
function runTool(env, tool, cmd, args, opts) {
  const res = env.run(cmd, args, { timeout: NATIVE_TIMEOUT_MS, ...opts });
  if (res.error) {
    if (res.error.code === "ETIMEDOUT" || res.timedOut) return { reason: `${tool} did not finish in ${Math.round(NATIVE_TIMEOUT_MS / SECONDS)} s` };
    if (res.error.code === "ENOENT") return { reason: `${tool} is not installed` };
    return { reason: `${tool} could not be run (${String(res.error.message ?? res.error.code).slice(0, 120)})` };
  }
  if (res.signal) return { reason: `${tool} did not finish in ${Math.round(NATIVE_TIMEOUT_MS / SECONDS)} s` };
  return { res };
}

const tail = (s) => String(s ?? "").trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? "";

/** Resolve a tool: the repo's own `node_modules/.bin` for `local`, else the PATH. */
function findTool(env, root, name, local) {
  if (local) {
    const p = join(root, "node_modules", ".bin", name);
    return env.exists(p) ? p : null;
  }
  for (const dir of env.path) {
    const p = join(dir, name);
    if (env.exists(p)) return p;
  }
  return null;
}

function perThousand(findings, lines) {
  return lines > 0 ? Math.round((findings / lines) * 10000) / 10 : null;
}

/** One analyzer's value. `parse` turns a finished run into a finding count or `{reason}`. */
function analyzer(env, ctx, spec) {
  const { key, tool, lang, need, local, args, parse, okCodes = [0, 1], configReason, config, cwd } = spec;
  const paths = ctx.byLang[lang];
  if (!paths.length) return none(`no ${LANG_NAMES[lang]} files`);
  if (config && !config()) return none(configReason);
  const bin = findTool(env, ctx.root, need ?? tool, local);
  if (!bin) return none(`${tool} is not installed`);
  const ran = runTool(env, tool, bin, args({ paths, tmp: ctx.tmp() }), { cwd: cwd ?? ctx.root });
  if (ran.reason) return none(ran.reason);
  const { res } = ran;
  if (!okCodes.includes(res.status)) return none(`${tool} stopped with code ${res.status}${tail(res.stderr) ? `: ${tail(res.stderr)}` : ""}`);
  const found = parse(res, ctx);
  if (found.reason) return none(found.reason);
  const lines = found.lines ?? countLines(env, ctx.root, paths);
  return ok({ tool, findings: found.findings, lines, per1000: perThousand(found.findings, lines), ...(found.note ? { note: found.note } : {}) });
}

const tryJson = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

function analyzers(env, ctx) {
  const has = (re) => ctx.files.some((p) => re.test(p));
  const hasRoot = (names) => names.some((n) => ctx.fileSet.has(n));
  const specs = [
    {
      key: "eslint", tool: "eslint", lang: "js", local: true,
      config: () => has(/(^|\/)(eslint\.config\.(js|mjs|cjs|ts|mts|cts)|\.eslintrc(\.[a-z]+)?)$/) || ctx.pkgJsonHas("eslintConfig"),
      configReason: "the repo has no eslint config",
      args: () => ["-f", "json", "--no-warn-ignored", "."],
      parse: (res) => {
        const j = tryJson(res.stdout);
        if (!Array.isArray(j)) return { reason: "eslint printed no JSON report" };
        return { findings: j.reduce((n, f) => n + (f.errorCount ?? 0) + (f.warningCount ?? 0), 0) };
      },
    },
    {
      key: "tsc", tool: "tsc", lang: "js", local: true, okCodes: [0, 1, 2],
      // A root that only references other projects (`files: []`) compiles nothing: its "0 errors" would be a lie.
      config: () => {
        if (!ctx.fileSet.has("tsconfig.json")) return false;
        const j = parseJsonc(env.readText(join(ctx.root, "tsconfig.json")) ?? "");
        if (!j) return false;
        const empty = (Array.isArray(j.files) && j.files.length === 0 && !j.include) || (Array.isArray(j.references) && j.references.length > 0 && j.files === undefined && j.include === undefined);
        return !empty;
      },
      configReason: "the root tsconfig.json is missing or only references other projects, so it compiles nothing",
      args: () => ["--noEmit", "--incremental", "false", "-p", "tsconfig.json", "--pretty", "false"],
      parse: (res) => ({
        findings: String(res.stdout).split("\n").filter((l) => /\berror TS\d+:/.test(l)).length,
        note: "root tsconfig.json only",
      }),
    },
    {
      key: "ruff", tool: "ruff", lang: "python",
      args: () => ["check", "--output-format", "json", "--no-cache", "."],
      parse: (res) => {
        const j = tryJson(res.stdout);
        return Array.isArray(j) ? { findings: j.length } : { reason: "ruff printed no JSON report" };
      },
    },
    {
      key: "mypy", tool: "mypy", lang: "python",
      config: () => hasRoot(["mypy.ini", ".mypy.ini"]) || ctx.textHas("pyproject.toml", /^\[tool\.mypy\]/m) || ctx.textHas("setup.cfg", /^\[mypy\]/m),
      configReason: "the repo has no mypy config",
      args: ({ tmp }) => ["--cache-dir", join(tmp, "mypy"), "--no-error-summary", "--no-color-output", "."],
      parse: (res) => ({ findings: String(res.stdout).split("\n").filter((l) => /: error:/.test(l)).length }),
    },
    {
      key: "dart", tool: ctx.flutterApp ? "flutter" : "dart", need: ctx.flutterApp ? "flutter" : "dart", lang: "dart",
      config: () => ctx.fileSet.has("pubspec.yaml") && env.exists(join(ctx.root, ".dart_tool", "package_config.json")),
      configReason: ctx.fileSet.has("pubspec.yaml")
        ? "the Dart packages are not fetched here (no .dart_tool/package_config.json), so the analyzer cannot resolve imports"
        : "the repo has no pubspec.yaml at its root",
      args: () => (ctx.flutterApp ? ["analyze", "--no-pub", "--no-fatal-infos", "--no-fatal-warnings"] : ["analyze", "--format=machine"]),
      okCodes: [0, 1, 2, 3],
      parse: (res) => {
        const out = `${res.stdout}\n${res.stderr}`.split("\n");
        // flutter: "   info • message • path:1:2 • code"; dart machine: SEVERITY|TYPE|CODE|FILE|...
        const n = out.filter((l) => /^\s*(error|warning|info|hint) • /i.test(l) || /^(ERROR|WARNING|INFO)\|/.test(l)).length;
        return { findings: n };
      },
    },
    {
      key: "shellcheck", tool: "shellcheck", lang: "shell",
      // Chunked below: a long file list would overflow one command line.
      args: ({ paths }) => ["-f", "json1", ...paths],
      parse: (res) => {
        const j = tryJson(res.stdout);
        return Array.isArray(j?.comments) ? { findings: j.comments.length } : { reason: "shellcheck printed no JSON report" };
      },
    },
    {
      key: "detekt", tool: "detekt", need: "detekt-cli", lang: "kotlin",
      config: () => has(/(^|\/)detekt(\.ya?ml|-config\.ya?ml)$/) || ctx.textHas("build.gradle.kts", /detekt/) || ctx.textHas("build.gradle", /detekt/),
      configReason: "the repo has no detekt config",
      args: ({ tmp }) => ["--input", ".", "--report", `txt:${join(tmp, "detekt.txt")}`],
      okCodes: [0, 1, 2],
      parse: (res, c) => {
        const f = c.tmpText("detekt.txt");
        if (f === null) return { reason: "detekt wrote no report" };
        return { findings: f.split("\n").filter((l) => /\.kt(s)?:\d+:\d+/.test(l) || /^\S+ - \[/.test(l)).length };
      },
    },
    {
      key: "ktlint", tool: "ktlint", lang: "kotlin",
      args: () => ["--reporter=plain", "**/*.kt", "**/*.kts"],
      parse: (res) => ({ findings: String(res.stdout).split("\n").filter((l) => /\.kts?:\d+:\d+/.test(l)).length }),
    },
  ];
  const out = {};
  for (const spec of specs) {
    out[spec.key] = spec.key === "shellcheck" ? shellcheckChunked(env, ctx, spec) : analyzer(env, ctx, spec);
  }
  return out;
}

function shellcheckChunked(env, ctx, spec) {
  const paths = ctx.byLang.shell;
  if (!paths.length) return none("no shell files");
  const bin = findTool(env, ctx.root, "shellcheck", false);
  if (!bin) return none("shellcheck is not installed");
  let findings = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const ran = runTool(env, "shellcheck", bin, ["-f", "json1", ...paths.slice(i, i + 100)], { cwd: ctx.root });
    if (ran.reason) return none(ran.reason);
    if (![0, 1].includes(ran.res.status)) return none(`shellcheck stopped with code ${ran.res.status}`);
    const got = spec.parse(ran.res);
    if (got.reason) return none(got.reason);
    findings += got.findings;
  }
  const lines = countLines(env, ctx.root, paths);
  return ok({ tool: "shellcheck", findings, lines, per1000: perThousand(findings, lines) });
}

// ── vulnerable dependencies ─────────────────────────────────────────────────

const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "bun.lock",
  "poetry.lock", "Pipfile.lock", "uv.lock", "pdm.lock", "pubspec.lock", "Cargo.lock", "go.mod",
  "composer.lock", "Gemfile.lock", "gradle.lockfile", "packages.lock.json", "Podfile.lock",
]);
const SEVERITIES = ["critical", "high", "moderate", "low", "unknown"];

/** Pure: an osv-scanner JSON document to the reading. */
export function parseOsv(doc) {
  const seen = new Map();
  const results = Array.isArray(doc?.results) ? doc.results : [];
  let packages = 0;
  for (const r of results) {
    for (const p of Array.isArray(r?.packages) ? r.packages : []) {
      const vulns = Array.isArray(p?.vulnerabilities) ? p.vulnerabilities : [];
      if (!vulns.length) continue;
      packages++;
      const key = `${p.package?.name}@${p.package?.version}`;
      const e = seen.get(key) ?? { package: String(p.package?.name ?? "?"), version: String(p.package?.version ?? "?"), ids: new Set(), rank: 4 };
      for (const v of vulns) {
        e.ids.add(String(v.id ?? "?"));
        const sev = String(v.database_specific?.severity ?? "").toLowerCase();
        const idx = SEVERITIES.indexOf(sev === "medium" ? "moderate" : sev);
        // OSV groups by advisory; the worst severity wins per package.
        e.rank = Math.min(e.rank, idx < 0 ? 4 : idx);
      }
      seen.set(key, e);
    }
  }
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const advisories = new Map();
  for (const r of results) {
    for (const p of Array.isArray(r?.packages) ? r.packages : []) {
      for (const v of Array.isArray(p?.vulnerabilities) ? p.vulnerabilities : []) {
        const sev = String(v.database_specific?.severity ?? "").toLowerCase();
        const idx = SEVERITIES.indexOf(sev === "medium" ? "moderate" : sev);
        advisories.set(String(v.id ?? "?"), SEVERITIES[idx < 0 ? 4 : idx]);
      }
    }
  }
  for (const s of advisories.values()) bySeverity[s]++;
  const items = [...seen.values()]
    .sort((a, b) => a.rank - b.rank || a.package.localeCompare(b.package))
    .map((e) => ({ package: e.package, version: e.version, severity: SEVERITIES[e.rank], ids: [...e.ids].sort() }));
  return { total: advisories.size, packages, bySeverity, items: items.slice(0, LIST_MAX), itemsTotal: items.length };
}

function vulns(env, ctx) {
  const locks = ctx.files.filter((p) => LOCKFILES.has(baseName(p)) && !p.split("/").some((s) => SKIP_DIRS.has(s)));
  if (!locks.length) return none("the repo has no lockfile osv-scanner reads");
  const bin = findTool(env, ctx.root, "osv-scanner", false);
  if (!bin) return none("osv-scanner is not installed");
  const args = ["scan", "source", "--format", "json", ...locks.flatMap((p) => ["-L", join(ctx.root, p)])];
  const ran = runTool(env, "osv-scanner", bin, args, { cwd: ctx.root });
  if (ran.reason) return none(ran.reason);
  const { res } = ran;
  // 0 clean, 1 vulnerabilities found; anything else is an error (no network, bad lockfile).
  if (![0, 1].includes(res.status)) return none(`osv-scanner stopped with code ${res.status}${tail(res.stderr) ? `: ${tail(res.stderr)}` : ""}`);
  const doc = tryJson(res.stdout);
  if (!doc || typeof doc !== "object") return none("osv-scanner printed no JSON report");
  return ok({ ...parseOsv(doc), lockfiles: locks.length });
}

// ── type strictness (configs only) ──────────────────────────────────────────

/** Strip comments and trailing commas from a tsconfig, then parse; null when it will not. */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      i = j < 0 ? text.length : j + 2;
    } else {
      out += c;
      i++;
    }
  }
  return tryJson(out.replace(/,(\s*[}\]])/g, "$1"));
}

const bool = (v) => (v === true || v === false ? v : null);

function iniSection(text, header) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === header);
  if (at < 0) return null;
  const body = [];
  for (let i = at + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) body.push(lines[i]);
  return body;
}
const iniBool = (body, key) => {
  const m = body.map((l) => l.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*(#.*)?$`, "i"))).find(Boolean);
  return m ? m[1].toLowerCase() === "true" : null;
};

function strictness(env, ctx) {
  const facts = [];
  for (const p of ctx.files) {
    const name = baseName(p);
    if (SKIP_DIRS.has(p.split("/")[0]) || p.split("/").some((s) => SKIP_DIRS.has(s))) continue;
    if (/^tsconfig(\.[\w-]+)?\.json$/.test(name)) {
      const j = parseJsonc(env.readText(join(ctx.root, p)) ?? "");
      const o = j?.compilerOptions;
      if (!o) continue;
      facts.push({
        kind: "typescript", path: p,
        settings: { strict: bool(o.strict), noUncheckedIndexedAccess: bool(o.noUncheckedIndexedAccess), ...(typeof j.extends === "string" ? { extends: true } : {}) },
      });
    } else if (name === "mypy.ini" || name === ".mypy.ini" || name === "setup.cfg" || name === "pyproject.toml") {
      const text = env.readText(join(ctx.root, p)) ?? "";
      const body = iniSection(text, name === "pyproject.toml" ? "[tool.mypy]" : "[mypy]");
      if (!body) continue;
      facts.push({
        kind: "mypy", path: p,
        settings: { strict: iniBool(body, "strict"), disallow_untyped_defs: iniBool(body, "disallow_untyped_defs"), check_untyped_defs: iniBool(body, "check_untyped_defs") },
      });
    } else if (name === "analysis_options.yaml") {
      const text = env.readText(join(ctx.root, p)) ?? "";
      const get = (k) => {
        const m = text.match(new RegExp(`^\\s*${k}\\s*:\\s*(true|false)\\b`, "m"));
        return m ? m[1] === "true" : null;
      };
      facts.push({
        kind: "dart", path: p,
        settings: { "strict-casts": get("strict-casts"), "strict-inference": get("strict-inference"), "strict-raw-types": get("strict-raw-types") },
      });
    }
  }
  if (!facts.length) return none("the repo has no tsconfig, mypy or analysis_options config to read");
  return ok({ facts: facts.slice(0, LIST_MAX), total: facts.length });
}

// ── existing coverage files ─────────────────────────────────────────────────

const COVERAGE_NAMES = [
  ["coverage/lcov.info", "lcov"], ["lcov.info", "lcov"], ["coverage.lcov", "lcov"],
  ["coverage.xml", "cobertura"], ["coverage/cobertura-coverage.xml", "cobertura"], ["coverage/coverage.xml", "cobertura"],
  ["coverage/coverage-final.json", "istanbul"], ["coverage-final.json", "istanbul"],
];

/** Pure parsers: file text to `{covered, total}` or null. */
export function parseLcov(t) {
  let lf = 0, lh = 0, seen = false;
  for (const l of t.split("\n")) {
    if (l.startsWith("LF:")) { lf += Number(l.slice(3)) || 0; seen = true; }
    else if (l.startsWith("LH:")) lh += Number(l.slice(3)) || 0;
  }
  return seen && lf > 0 ? { covered: lh, total: lf } : null;
}
export function parseCobertura(t) {
  const head = t.slice(0, 4000);
  const valid = head.match(/\blines-valid="(\d+)"/);
  const cov = head.match(/\blines-covered="(\d+)"/);
  if (valid && cov && Number(valid[1]) > 0) return { covered: Number(cov[1]), total: Number(valid[1]) };
  return null;
}
export function parseIstanbul(t) {
  const j = tryJson(t);
  if (!j || typeof j !== "object") return null;
  let covered = 0, total = 0;
  for (const f of Object.values(j)) {
    const s = f?.s;
    if (!s || typeof s !== "object") continue;
    for (const n of Object.values(s)) { total++; if (n > 0) covered++; }
  }
  return total > 0 ? { covered, total } : null;
}
const COVERAGE_PARSERS = { lcov: parseLcov, cobertura: parseCobertura, istanbul: parseIstanbul };

function coverage(env, ctx) {
  const dirs = [""];
  for (const p of ctx.files) {
    const m = p.match(/^((?:packages|apps)\/[^/]+)\//);
    if (m && !dirs.includes(`${m[1]}/`)) dirs.push(`${m[1]}/`);
  }
  const files = [];
  let stale = 0;
  for (const dir of dirs) {
    for (const [name, kind] of COVERAGE_NAMES) {
      const rel = dir + name;
      const abs = join(ctx.root, rel);
      const mtime = env.mtime(abs);
      if (mtime === null) continue;
      if (ctx.commitTs !== null && mtime < ctx.commitTs) { stale++; continue; }
      const text = env.readText(abs);
      const got = text === null ? null : COVERAGE_PARSERS[kind](text);
      if (!got) continue;
      files.push({ path: rel, kind, covered: got.covered, total: got.total, percent: Math.round((got.covered / got.total) * 1000) / 10 });
    }
  }
  if (!files.length) {
    return none(stale ? `${stale} coverage file${stale === 1 ? " is" : "s are"} older than the last commit, so describe other code` : "no coverage file in the working directory");
  }
  return ok({ files: files.slice(0, LIST_MAX), total: files.length });
}

// ── entry ───────────────────────────────────────────────────────────────────

/**
 * The newest commit's native readings.
 *
 * @param {string} root
 * @param {{files: string[], commitTs?: number|null, env?: object}} input
 *   `files`: tracked paths at HEAD. `commitTs`: the commit's time in seconds.
 */
export function measureNative(root, { files, commitTs = null, env = defaultEnv() }) {
  let tmpDir = null;
  const ctx = {
    root,
    files,
    fileSet: new Set(files),
    commitTs,
    byLang: filesByLang(files),
    tmp: () => (tmpDir ??= env.mkTmp()),
    tmpText: (name) => (tmpDir ? env.readText(join(tmpDir, name)) : null),
    textHas: (rel, re) => ctx.fileSet.has(rel) && re.test(env.readText(join(root, rel)) ?? ""),
    pkgJsonHas: (key) => ctx.fileSet.has("package.json") && key in (tryJson(env.readText(join(root, "package.json")) ?? "") ?? {}),
    flutterApp: false,
  };
  ctx.flutterApp = ctx.textHas("pubspec.yaml", /^[ \t]*sdk:[ \t]*flutter\b/m);
  try {
    return {
      vulns: vulns(env, ctx),
      dependencyAge: none("not read: a lockfile has no publish dates, and a registry lookup per package is a network call on every refresh"),
      analyzers: analyzers(env, ctx),
      strictness: strictness(env, ctx),
      coverage: coverage(env, ctx),
    };
  } finally {
    if (tmpDir) env.rmTmp(tmpDir);
  }
}

/** The one place that spawns or touches the disk. */
export function defaultEnv() {
  return {
    path: String(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    exists: (p) => existsSync(p),
    readText: (p) => {
      try { return readFileSync(p, "utf8"); } catch { return null; }
    },
    mtime: (p) => {
      try { return statSync(p).mtimeMs / 1000; } catch { return null; }
    },
    mkTmp: () => mkdtempSync(join(tmpdir(), "wp-native-")),
    rmTmp: (d) => rmSync(d, { recursive: true, force: true }),
    run: (cmd, args, opts) => {
      const r = spawnSync(cmd, args, {
        cwd: opts.cwd, encoding: "utf8", timeout: opts.timeout, killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: "1", NO_COLOR: "1", NODE_OPTIONS: "" },
      });
      return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error, timedOut: r.error?.code === "ETIMEDOUT" };
    },
  };
}
