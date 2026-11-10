/**
 * The native-tool readings: `metrics/native.mjs` over STUBBED tools, the plot
 * block that carries them and the shared reader that keeps every field.
 *
 * No tool is run here: a stub environment answers `run`, `exists`, `readText`
 * and `mtime`, so the rules are pinned on any machine, installed or not. The
 * rules: an uninstalled tool is ABSENT with "X is not installed" (never 0), a
 * hard timeout and a bad exit code are absences with their reason, nothing is
 * written into the measured repo, and a coverage file older than the last
 * commit is not read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  ANALYZER_KEYS, measureNative, nativeElsewhere, parseCobertura, parseIstanbul, parseJsonc, parseLcov, parseOsv,
} from "./repohealth/metrics/native.mjs";
import { PREREG } from "./repohealth/constants.mjs";
import { buildPlot } from "./repohealth/plot.mjs";
import { readNative } from "../packages/shared/dist/repohealthnative.js";

const ROOT = "/repo";
const COMMIT = 1_700_000_000;

/**
 * A stub environment. `installed`: tool paths that exist; `files`: path -> text;
 * `mtimes`: path -> seconds; `answers`: command basename -> run result or a function.
 */
function stub({ installed = [], files = {}, mtimes = {}, answers = {} } = {}) {
  const calls = [];
  const env = {
    path: ["/bin"],
    exists: (p) => installed.includes(p) || p in files,
    readText: (p) => (p in files ? files[p] : null),
    mtime: (p) => (p in mtimes ? mtimes[p] : null),
    mkTmp: () => "/tmp/wp-native-test",
    rmTmp: () => {},
    run: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const a = answers[cmd.slice(cmd.lastIndexOf("/") + 1)];
      const r = typeof a === "function" ? a(args, opts) : a;
      return { status: 0, stdout: "", stderr: "", ...(r ?? {}) };
    },
  };
  return { env, calls };
}
const lines = (n) => "x\n".repeat(n);
const read = (tracked, s, extra = {}) => measureNative(ROOT, { files: tracked, commitTs: COMMIT, env: s.env, ...extra });

test("nothing installed: every sub-reading is absent with its reason, none is zero", () => {
  const s = stub({ files: { [`${ROOT}/a.py`]: lines(10), [`${ROOT}/s.sh`]: lines(5), [`${ROOT}/tsconfig.json`]: "{}" } });
  const out = read(["a.py", "s.sh", "tsconfig.json", "src/a.ts", "package-lock.json", "eslint.config.js"], s);
  assert.equal(out.vulns.value, null);
  assert.match(out.vulns.reason, /osv-scanner is not installed/);
  assert.match(out.dependencyAge.reason, /registry lookup/);
  assert.deepEqual(Object.keys(out.analyzers), ANALYZER_KEYS);
  assert.match(out.analyzers.ruff.reason, /ruff is not installed/);
  assert.match(out.analyzers.shellcheck.reason, /shellcheck is not installed/);
  assert.match(out.analyzers.eslint.reason, /eslint is not installed/);
  assert.match(out.analyzers.tsc.reason, /tsc is not installed/);
  assert.match(out.analyzers.mypy.reason, /no mypy config/);
  assert.match(out.analyzers.dart.reason, /no Dart files/);
  for (const a of Object.values(out.analyzers)) assert.equal(a.value, null);
  assert.equal(s.calls.length, 0, "no tool is spawned when none is installed");
});

test("eslint and tsc run only from the repo's own node_modules, and only with a config", () => {
  const bin = (n) => `${ROOT}/node_modules/.bin/${n}`;
  const eslintJson = JSON.stringify([{ errorCount: 3, warningCount: 2 }, { errorCount: 0, warningCount: 1 }]);
  const s = stub({
    installed: [bin("eslint"), bin("tsc"), "/bin/eslint"],
    files: { [`${ROOT}/src/a.ts`]: lines(2000), [`${ROOT}/tsconfig.json`]: "{}" },
    answers: {
      eslint: { status: 1, stdout: eslintJson },
      tsc: { status: 2, stdout: "src/a.ts(1,1): error TS2322: bad\nsrc/a.ts(2,1): error TS2304: worse\nFound 2 errors\n" },
    },
  });
  const out = read(["src/a.ts", "tsconfig.json", "eslint.config.js"], s);
  assert.deepEqual(out.analyzers.eslint.value, { tool: "eslint", findings: 6, lines: 2000, per1000: 3 });
  assert.equal(out.analyzers.tsc.value.findings, 2);
  assert.equal(out.analyzers.tsc.value.per1000, 1);
  assert.equal(out.analyzers.tsc.value.note, "root tsconfig.json only");
  assert.ok(s.calls.every((c) => c.cmd.startsWith(`${ROOT}/node_modules/.bin/`)), "never the PATH copy");

  const refsOnly = stub({ installed: [bin("tsc")], files: { [`${ROOT}/src/a.ts`]: lines(5), [`${ROOT}/tsconfig.json`]: '{ "files": [], "references": [{ "path": "./a" }] }' } });
  assert.match(read(["src/a.ts", "tsconfig.json"], refsOnly).analyzers.tsc.reason, /only references other projects/);
  assert.equal(refsOnly.calls.length, 0, "a zero from a config that compiles nothing is never taken");

  const noConfig = read(["src/a.ts", "tsconfig.json"], stub({ installed: [bin("eslint")], files: { [`${ROOT}/src/a.ts`]: lines(5) } }));
  assert.match(noConfig.analyzers.eslint.reason, /no eslint config/);
});

test("ruff, mypy and shellcheck: counts per 1,000 lines of their own language, no cache in the repo", () => {
  const s = stub({
    installed: ["/bin/ruff", "/bin/mypy", "/bin/shellcheck"],
    files: {
      [`${ROOT}/a.py`]: lines(500), [`${ROOT}/b.py`]: lines(500), [`${ROOT}/run.sh`]: lines(100),
      [`${ROOT}/mypy.ini`]: "[mypy]\nstrict = True\n",
    },
    answers: {
      ruff: { status: 1, stdout: JSON.stringify([{}, {}, {}]) },
      mypy: { status: 1, stdout: "a.py:1: error: x\nb.py:2: error: y\nFound 2 errors in 2 files\n" },
      shellcheck: { status: 1, stdout: JSON.stringify({ comments: [{}, {}] }) },
    },
  });
  const out = read(["a.py", "b.py", "run.sh", "mypy.ini"], s);
  assert.deepEqual(out.analyzers.ruff.value, { tool: "ruff", findings: 3, lines: 1000, per1000: 3 });
  assert.equal(out.analyzers.mypy.value.findings, 2);
  assert.equal(out.analyzers.shellcheck.value.per1000, 20);
  const ruff = s.calls.find((c) => c.cmd.endsWith("ruff"));
  assert.ok(ruff.args.includes("--no-cache"));
  const mypy = s.calls.find((c) => c.cmd.endsWith("mypy"));
  assert.equal(mypy.args[mypy.args.indexOf("--cache-dir") + 1], "/tmp/wp-native-test/mypy");
});

test("a tool that times out, crashes or prints nonsense is an absence with the reason", () => {
  const files = { [`${ROOT}/a.py`]: lines(10), [`${ROOT}/run.sh`]: lines(10), [`${ROOT}/mypy.ini`]: "[mypy]\n" };
  const slow = stub({ installed: ["/bin/ruff"], files, answers: { ruff: { status: null, error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) } } });
  assert.match(read(["a.py"], slow).analyzers.ruff.reason, /ruff did not finish in 180 s/);
  const killed = stub({ installed: ["/bin/ruff"], files, answers: { ruff: { status: null, signal: "SIGKILL" } } });
  assert.match(read(["a.py"], killed).analyzers.ruff.reason, /did not finish/);
  const crash = stub({ installed: ["/bin/ruff"], files, answers: { ruff: { status: 2, stderr: "boom\n" } } });
  assert.match(read(["a.py"], crash).analyzers.ruff.reason, /code 2: boom/);
  const junk = stub({ installed: ["/bin/ruff"], files, answers: { ruff: { status: 0, stdout: "not json" } } });
  assert.match(read(["a.py"], junk).analyzers.ruff.reason, /no JSON report/);
});

test("Dart: needs fetched packages, uses flutter for a Flutter app, counts analyzer lines", () => {
  const files = { [`${ROOT}/lib/a.dart`]: lines(1000), [`${ROOT}/pubspec.yaml`]: "dependencies:\n  flutter:\n    sdk: flutter\n" };
  const unfetched = read(["lib/a.dart", "pubspec.yaml"], stub({ installed: ["/bin/flutter"], files }));
  assert.match(unfetched.analyzers.dart.reason, /packages are not fetched/);

  const s = stub({
    installed: ["/bin/flutter", `${ROOT}/.dart_tool/package_config.json`],
    files,
    answers: { flutter: { status: 1, stdout: "Analyzing...\n   info • Use x • lib/a.dart:1:1 • a\n  error • Bad • lib/a.dart:2:1 • b\n2 issues found.\n" } },
  });
  const out = read(["lib/a.dart", "pubspec.yaml"], s);
  assert.deepEqual(out.analyzers.dart.value, { tool: "flutter", findings: 2, lines: 1000, per1000: 2 });
  assert.ok(s.calls[0].args.includes("--no-pub"), "analyzing must not run pub get inside the repo");
});

test("osv-scanner: severity counts, package@version list, exit 1 is a finding and 127 is not", () => {
  const doc = {
    results: [{
      packages: [
        { package: { name: "lodash", version: "4.17.0" }, vulnerabilities: [{ id: "GHSA-1", database_specific: { severity: "HIGH" } }, { id: "GHSA-2", database_specific: { severity: "MODERATE" } }] },
        { package: { name: "left-pad", version: "1.0.0" }, vulnerabilities: [{ id: "GHSA-3", database_specific: { severity: "CRITICAL" } }] },
        { package: { name: "fine", version: "1.0.0" }, vulnerabilities: [] },
      ],
    }],
  };
  const parsed = parseOsv(doc);
  assert.equal(parsed.total, 3);
  assert.equal(parsed.packages, 2);
  assert.deepEqual(parsed.bySeverity, { critical: 1, high: 1, moderate: 1, low: 0, unknown: 0 });
  assert.deepEqual(parsed.items.map((i) => `${i.package}@${i.version}:${i.severity}`), ["left-pad@1.0.0:critical", "lodash@4.17.0:high"]);

  const s = stub({ installed: ["/bin/osv-scanner"], answers: { "osv-scanner": { status: 1, stdout: JSON.stringify(doc) } } });
  const out = read(["package-lock.json", "app/pubspec.lock", "node_modules/x/package-lock.json"], s);
  assert.equal(out.vulns.value.lockfiles, 2, "only tracked lockfiles outside vendored dirs");
  assert.equal(out.vulns.value.total, 3);
  assert.ok(s.calls[0].args.includes(`${ROOT}/package-lock.json`));

  const offline = stub({ installed: ["/bin/osv-scanner"], answers: { "osv-scanner": { status: 127, stderr: "no network\n" } } });
  assert.match(read(["package-lock.json"], offline).vulns.reason, /code 127: no network/);
  assert.match(read(["README.md"], stub({ installed: ["/bin/osv-scanner"] })).vulns.reason, /no lockfile/);
  const clean = stub({ installed: ["/bin/osv-scanner"], answers: { "osv-scanner": { status: 0, stdout: '{"results":[]}' } } });
  assert.equal(read(["package-lock.json"], clean).vulns.value.total, 0, "a scan that ran and found nothing is a real zero");
});

test("strictness is read from configs only, as facts", () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "x//y", /* b */ "b": [1,], }'), { a: "x//y", b: [1] });
  const files = {
    [`${ROOT}/tsconfig.json`]: '{ "compilerOptions": { "strict": true, // yes\n "noUncheckedIndexedAccess": false, }, }',
    [`${ROOT}/web/tsconfig.json`]: '{ "extends": "../tsconfig.json", "compilerOptions": {} }',
    [`${ROOT}/pyproject.toml`]: "[tool.black]\nx=1\n[tool.mypy]\nstrict = true\n",
    [`${ROOT}/app/analysis_options.yaml`]: "analyzer:\n  language:\n    strict-casts: true\n    strict-inference: false\n",
  };
  const out = read(["tsconfig.json", "web/tsconfig.json", "pyproject.toml", "app/analysis_options.yaml", "node_modules/x/tsconfig.json"], stub({ files }));
  const byPath = Object.fromEntries(out.strictness.value.facts.map((f) => [f.path, f]));
  assert.equal(out.strictness.value.total, 4);
  assert.deepEqual(byPath["tsconfig.json"].settings, { strict: true, noUncheckedIndexedAccess: false });
  assert.deepEqual(byPath["web/tsconfig.json"].settings, { strict: null, noUncheckedIndexedAccess: null, extends: true });
  assert.equal(byPath["pyproject.toml"].settings.strict, true);
  assert.deepEqual(byPath["app/analysis_options.yaml"].settings, { "strict-casts": true, "strict-inference": false, "strict-raw-types": null });
  assert.match(read(["a.txt"], stub()).strictness.reason, /no tsconfig, mypy or analysis_options/);
});

test("coverage: a file older than the last commit is not read; each format parses; tests never run", () => {
  assert.deepEqual(parseLcov("SF:a\nLF:10\nLH:7\nend_of_record\nSF:b\nLF:10\nLH:3\nend_of_record\n"), { covered: 10, total: 20 });
  assert.equal(parseLcov("nothing"), null);
  assert.deepEqual(parseCobertura('<coverage lines-valid="40" lines-covered="30" line-rate="0.75">'), { covered: 30, total: 40 });
  assert.deepEqual(parseIstanbul(JSON.stringify({ "a.js": { s: { 0: 1, 1: 0, 2: 5 } } })), { covered: 2, total: 3 });

  const files = {
    [`${ROOT}/coverage/lcov.info`]: "LF:100\nLH:80\n",
    [`${ROOT}/coverage.xml`]: '<coverage lines-valid="10" lines-covered="1">',
    [`${ROOT}/packages/a/coverage/coverage-final.json`]: JSON.stringify({ x: { s: { 0: 1 } } }),
  };
  const mtimes = {
    [`${ROOT}/coverage/lcov.info`]: COMMIT + 60,
    [`${ROOT}/coverage.xml`]: COMMIT - 60,
    [`${ROOT}/packages/a/coverage/coverage-final.json`]: COMMIT + 1,
  };
  const s = stub({ files, mtimes });
  const out = read(["packages/a/src/x.js"], s);
  assert.deepEqual(out.coverage.value.files.map((f) => [f.path, f.percent]), [["coverage/lcov.info", 80], ["packages/a/coverage/coverage-final.json", 100]]);
  assert.equal(s.calls.length, 0);

  const stale = read(["a.js"], stub({ files: { [`${ROOT}/coverage/lcov.info`]: "LF:1\nLH:1\n" }, mtimes: { [`${ROOT}/coverage/lcov.info`]: COMMIT - 5 } }));
  assert.match(stale.coverage.reason, /older than the last commit/);
  assert.match(read(["a.js"], stub()).coverage.reason, /no coverage file/);
});

test("the row field for an older commit is absent everywhere, and the plot and shared reader carry the newest", () => {
  const els = nativeElsewhere();
  assert.deepEqual(Object.keys(els.analyzers), ANALYZER_KEYS);
  assert.equal(els.vulns.reason, "read at the newest commit only");

  const s = stub({
    installed: ["/bin/osv-scanner", "/bin/ruff"],
    files: {
      [`${ROOT}/a.py`]: lines(200), [`${ROOT}/pyproject.toml`]: "[tool.mypy]\nstrict = true\n",
      [`${ROOT}/coverage/lcov.info`]: "LF:10\nLH:5\n",
    },
    mtimes: { [`${ROOT}/coverage/lcov.info`]: COMMIT + 1 },
    answers: {
      "osv-scanner": { status: 1, stdout: JSON.stringify({ results: [{ packages: [{ package: { name: "p", version: "1" }, vulnerabilities: [{ id: "X", database_specific: { severity: "LOW" } }] }] }] }) },
      ruff: { status: 1, stdout: "[{}]" },
    },
  });
  const value = read(["a.py", "pyproject.toml", "poetry.lock"], s);
  const row = (i, v) => ({ sha: "s" + i, day: `2026-01-0${i + 1}`, ts: COMMIT + i * 86400, batch: false, prereg: "v", native: { value: v } });
  const doc = buildPlot({ rows: [row(0, nativeElsewhere()), row(1, value)], prereg: PREREG, preregVersion: "v" });
  const n = doc.native;
  assert.equal(n.vulns.total, 1);
  assert.equal(n.vulns.bySeverity.low, 1);
  assert.match(n.dependencyAge.absent, /registry lookup/);
  assert.deepEqual(n.analyzers.map((a) => a.key), ANALYZER_KEYS);
  const ruff = n.analyzers.find((a) => a.key === "ruff");
  assert.equal(ruff.per1000, 5);
  const eslint = n.analyzers.find((a) => a.key === "eslint");
  assert.equal(eslint.findings, null);
  assert.match(eslint.absent, /no TypeScript or JavaScript files/);
  assert.equal(n.coverage.files[0].percent, 50);

  const wire = JSON.parse(JSON.stringify(n));
  assert.deepEqual(readNative(wire), wire, "every field survives the shared reader");

  const old = buildPlot({ rows: [row(0, nativeElsewhere())], prereg: PREREG, preregVersion: "v" }).native;
  assert.equal(old.vulns.absent, "read at the newest commit only");
  assert.deepEqual(readNative(JSON.parse(JSON.stringify(old))), JSON.parse(JSON.stringify(old)));
  const bare = buildPlot({ rows: [{ sha: "s", day: "2026-01-01", ts: COMMIT, batch: false, prereg: "v" }], prereg: PREREG, preregVersion: "v" }).native;
  assert.equal(bare.absent, "no reading");
  assert.ok(readNative(JSON.parse(JSON.stringify(bare))));
});

test("a malformed native block is dropped whole by the shared reader", () => {
  assert.equal(readNative({ vulns: { total: 1 } }), null);
  assert.equal(readNative(null), null);
  const ok = { vulns: { absent: "x" }, dependencyAge: { absent: "y" }, analyzers: [], strictness: { absent: "z" }, coverage: { absent: "w" } };
  assert.ok(readNative(ok));
  assert.equal(readNative({ ...ok, analyzers: [{ key: "k" }] }), null);
  assert.equal(readNative({ ...ok, dependencyAge: {} }), null);
});

test("the module never names a path inside the measured repo to write", () => {
  // The only writes are to the temp dir the environment hands out.
  const s = stub({ installed: ["/bin/mypy"], files: { [`${ROOT}/a.py`]: lines(3), [`${ROOT}/mypy.ini`]: "[mypy]\n" }, answers: { mypy: { status: 0 } } });
  read(["a.py", "mypy.ini"], s);
  for (const c of s.calls) for (const a of c.args) assert.ok(!String(a).startsWith(join(ROOT, ".")) || String(a) === ".", String(a));
});
