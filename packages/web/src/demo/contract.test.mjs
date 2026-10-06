/**
 * The demo's wire contract: everything the real host can SAY to the phone,
 * and every `/api` route the phone ASKS, is either answered by the demo or
 * listed in `contract-accept.json` with a one-line reason.
 *
 * The demo ships (Play reviewers open it with no desktop at all), so it has
 * to stay honest as the wire grows. The client→host side is already pinned
 * by type (`HANDLERS satisfies HandlerTable`) and against the host's routing
 * table (`packages/host/test/demoparity.test.mjs`). This is the other two
 * directions, which nothing else checks:
 *
 *   - every `t` of `HostMessage` (read off the TYPE by the compiler, never a
 *     hand list) is a frame the demo builds somewhere — an object literal
 *     under `demo/` (tests excluded) whose type is assignable to
 *     `HostMessage` — or is accepted;
 *   - every `/api/...` literal the web client passes to a call (read off the
 *     AST of `packages/web/src` and `packages/extensions/<x>/web`), keyed
 *     `METHOD /path/:param`, gets something other than the demo's
 *     fall-through 404 from a real `DemoHost` built from each shipped
 *     scenario, or is mapped to bundled media by `demo/media.ts`, or is
 *     accepted.
 *
 * And both ways: an accept entry for a type or route that no longer exists,
 * or that the demo now handles, fails as stale — an accept list that only
 * grows is a list nobody reads.
 *
 * What it does NOT prove: that a handled route answers correctly, or that an
 * emitted frame is reachable from a tap. It proves somebody decided.
 *
 *     node --test packages/web/src/demo/contract.test.mjs
 *     DEMO_CONTRACT_DUMP=1 node --test …   # also prints every derived type/route and its verdict
 *
 * Needs `npm run build:shared` (test:unit does it): the demo host imports
 * `@waterplane/shared`, which resolves to dist. The type analysis maps the
 * same name to `packages/shared/src`, so it reads THIS tree's wire.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createDemoHost, NOT_IN_DEMO } from "./host/index.ts";
import { demoMediaUrl } from "./media.ts";
import { DEMO_SCENARIOS } from "./scenarios/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../..");
const repo = resolve(web, "../..");
const shared = join(repo, "packages/shared/src");
const ACCEPT_PATH = join(here, "contract-accept.json");
const accept = JSON.parse(readFileSync(ACCEPT_PATH, "utf8"));

function walk(dir, keep, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}
const isSource = (p) => /\.tsx?$/.test(p) && !/\.d\.ts$/.test(p) && !/\.test\./.test(p);
const rel = (p) => relative(repo, p);

// ── 1. Host → client: the types, and what the demo builds ──────────────────

const demoFiles = walk(here, isSource);
const messagesTs = join(shared, "wire/messages.ts");
const program = ts.createProgram([messagesTs, ...demoFiles], {
  allowImportingTsExtensions: true,
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  types: [],
  baseUrl: web,
  paths: { "@waterplane/shared": [join(shared, "index.ts")] },
});
const checker = program.getTypeChecker();

function hostMessageType() {
  const sf = program.getSourceFile(messagesTs);
  const decl = sf.statements.find((s) => ts.isTypeAliasDeclaration(s) && s.name.text === "HostMessage");
  assert.ok(decl, "packages/shared/src/wire/messages.ts no longer declares `type HostMessage` — point this test at where it went");
  return checker.getTypeAtLocation(decl.name);
}
const HOST = hostMessageType();

/** Every `t` of the union, off the type — references and intersections resolved by the compiler. */
function hostTypes() {
  const out = new Set();
  for (const member of HOST.isUnion() ? HOST.types : [HOST]) {
    const t = member.getProperty("t");
    const tt = t && checker.getTypeOfSymbol(t);
    const lits = tt ? (tt.isUnion() ? tt.types : [tt]) : [];
    assert.ok(lits.length && lits.every((l) => l.isStringLiteral()), `a HostMessage member has no string-literal \`t\`: ${checker.typeToString(member)}`);
    for (const l of lits) out.add(l.value);
  }
  return out;
}

/** The `t`s of every object literal under demo/ that is a HostMessage by type. */
function demoEmits(types) {
  const out = new Map();
  for (const f of demoFiles) {
    const sf = program.getSourceFile(f);
    const visit = (n) => {
      if (ts.isObjectLiteralExpression(n)) {
        const p = n.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText(sf) === "t");
        const lit = p && ts.isStringLiteralLike(p.initializer) ? p.initializer.text : null;
        if (lit && types.has(lit) && checker.isTypeAssignableTo(checker.getTypeAtLocation(n), HOST)) {
          if (!out.has(lit)) out.set(lit, `${rel(f)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

// ── 2. Client → host HTTP: the routes the phone calls ──────────────────────

const HOLE = "\u0000";
const CLASSIFIERS = new Set(["includes", "startsWith", "endsWith", "indexOf", "test", "match"]);
const METHODS = ["GET", "POST", "PUT", "DELETE"];

/** A literal's text with each `${}` as HOLE. */
function textOf(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => HOLE + s.literal.text).join("");
  return null;
}

/**
 * `/api/repos/${id}/git/diff?${q}` → `/api/repos/:param/git/diff`; null when not a route.
 * A query pair spelled out whole (`&stat=1`, `&download=1`) stays in the key: it is
 * a different question on the same path, and the demo may answer one and not the other.
 */
function normalize(text) {
  const at = text.indexOf("/api/");
  if (at < 0 || text.slice(0, at).replaceAll(HOLE, "") !== "") return null;
  const [path, query = ""] = text.slice(at).split("?");
  const flags = query.split("&").filter((kv) => /^[\w-]+=[\w-]+$/.test(kv)).sort();
  const segs = path.split("/").map((s, i) => {
    if (i === 0) return s;
    if (s.replaceAll(HOLE, "") === "") return ":param";
    // A segment ending in a hole is a conditional suffix (`tokenstats${fresh ? "?fresh=1" : ""}`).
    return s.replace(new RegExp(`${HOLE}+$`), "");
  });
  if (segs.slice(1).some((s) => s.includes(HOLE) || s === "")) return null;
  return segs.join("/") + (flags.length ? `?${flags.join("&")}` : "");
}

const stringArg = (a) => (a && ts.isStringLiteralLike(a) ? a.text.toUpperCase() : null);
const calleeName = (c) =>
  ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : ts.isIdentifier(c.expression) ? c.expression.text : "";

/** The HTTP method a URL literal travels with, read off the call it is an argument of. */
function methodOf(call, idx) {
  const name = calleeName(call);
  const prev = stringArg(call.arguments[idx - 1]);
  if (prev && METHODS.includes(prev)) return prev; // xhr.open("POST", url), api.peers.on(.., "GET", url)
  if (/^jpost/.test(name) || name === "sendBeacon") return "POST";
  if (name === "jdel") return "DELETE";
  const opts = call.arguments[idx + 1];
  if (opts && ts.isObjectLiteralExpression(opts)) {
    const m = opts.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === "method");
    if (m) return stringArg(m.initializer) ?? "*";
  }
  return "GET";
}

function clientRoutes() {
  const files = [
    ...walk(join(web, "src"), (p) => isSource(p) && !p.startsWith(here + "/")),
    ...readdirSync(join(repo, "packages/extensions"))
      .map((x) => join(repo, "packages/extensions", x, "web"))
      .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
      .flatMap((d) => walk(d, isSource)),
  ];
  const out = new Map();
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (n) => {
      const text = textOf(n);
      const path = text != null && normalize(text);
      if (path) {
        const call = n.parent;
        const idx = call && ts.isCallExpression(call) ? call.arguments.indexOf(n) : -1;
        if (idx >= 0 && !CLASSIFIERS.has(calleeName(call))) {
          const key = `${methodOf(call, idx)} ${path}`;
          if (!out.has(key)) out.set(key, `${rel(f)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const isFallThrough = (res, method, path) =>
  res.status === 404 && res.contentType === "text/plain" && res.body === `${NOT_IN_DEMO} (${method} ${path})`;

/** Does any shipped scenario's desktop answer this route (or bundled media stand in for it)? */
function demoAnswers(key) {
  const [method, target] = key.split(" ");
  const [pattern, flags = ""] = target.split("?");
  const query = Object.fromEntries(new URLSearchParams(flags));
  for (const sc of Object.values(DEMO_SCENARIOS)) {
    const repoId = sc.state?.model?.repos?.find((r) => typeof r?.id === "string")?.id ?? "demo";
    const path = pattern.replace(/^\/api\/repos\/:param/, `/api/repos/${encodeURIComponent(repoId)}`).replaceAll(":param", "x");
    const url = `${path}?${new URLSearchParams({ path: "a.png", ...query })}`;
    if (method === "GET" && demoMediaUrl(url) !== url) return true;
    for (const m of method === "*" ? METHODS : [method]) {
      const host = createDemoHost(sc, { now: () => sc.clock?.start ?? Date.now() });
      if (!isFallThrough(host.request({ method: m, path, query }), m, path)) return true;
    }
  }
  return false;
}

// ── the tests ──────────────────────────────────────────────────────────────

const TYPES = hostTypes();
const EMITS = demoEmits(TYPES);
const ROUTES = clientRoutes();
const ANSWERED = new Set([...ROUTES.keys()].filter(demoAnswers));

const reasons = (o) => Object.entries(o ?? {}).filter(([k]) => !k.startsWith("//"));
const list = (xs) => xs.map((x) => `  ${x}`).join("\n");

test("the derivations found what they should — a broken scan is not a clean contract", () => {
  assert.ok(TYPES.size >= 60, `only ${TYPES.size} HostMessage types read — the type walk is broken`);
  for (const t of ["welcome", "pty", "input.ack", "op.ack", "session.list"]) assert.ok(TYPES.has(t), `HostMessage type walk lost "${t}"`);
  assert.ok(EMITS.has("welcome") && EMITS.has("pty"), "the demo's frames were not found — the emission scan is broken");
  assert.ok(ROUTES.size >= 60, `only ${ROUTES.size} client routes read — the route scan is broken`);
  for (const k of ["GET /api/repos", "GET /api/health", "POST /api/repos/:param/inbox", "PUT /api/repos/:param/tree/file"]) {
    assert.ok(ROUTES.has(k), `route scan lost "${k}"`);
  }
  assert.ok(ANSWERED.has("GET /api/repos") && ANSWERED.has("GET /api/health"), "the demo answers nothing — the probe is broken");
});

/** The three verdicts for one side of the contract, as separate tests so a run names every problem at once. */
function side({ name, section, all, handled, where, undecided, fix, gone, now }) {
  const acc = new Map(reasons(accept[section]));
  test(`${name}: every one is handled by the demo or accepted with a reason`, () => {
    const missing = [...all.keys()].filter((k) => !handled.has(k) && !acc.has(k)).sort().map(where);
    assert.deepEqual(missing, [], `${undecided}:\n${list(missing)}\n${fix} or add it to ${rel(ACCEPT_PATH)} "${section}" with a one-line reason.`);
    for (const [k, why] of acc) assert.ok(typeof why === "string" && why.trim().length >= 10, `accept entry "${k}" needs a one-line reason`);
  });
  test(`${name}: no accept entry names one that no longer exists`, () => {
    const stale = [...acc.keys()].filter((k) => !all.has(k)).sort();
    assert.deepEqual(stale, [], `stale accept entries — ${gone}, remove them from ${rel(ACCEPT_PATH)} "${section}":\n${list(stale)}`);
  });
  test(`${name}: no accept entry names one the demo now handles`, () => {
    const stale = [...acc.keys()].filter((k) => handled.has(k)).sort();
    assert.deepEqual(stale, [], `stale accept entries — ${now}, remove them from ${rel(ACCEPT_PATH)} "${section}":\n${list(stale)}`);
  });
}

side({
  name: "host→client message types",
  section: "messages",
  all: new Map([...TYPES].map((t) => [t, t])),
  handled: EMITS,
  where: (t) => t,
  undecided: "HostMessage type(s) the demo never sends and nobody decided about",
  fix: "Either build the frame under packages/web/src/demo/",
  gone: "no longer a HostMessage type",
  now: "the demo builds these frames now",
});

side({
  name: "/api routes the phone calls",
  section: "routes",
  all: ROUTES,
  handled: ANSWERED,
  where: (k) => `${k}  (called at ${ROUTES.get(k)})`,
  undecided: "route(s) the phone calls that the demo answers with its fall-through 404, undecided",
  fix: "Either answer it in packages/web/src/demo/host/demohttp.ts",
  gone: "the phone no longer calls these",
  now: "the demo answers these now",
});

if (process.env.DEMO_CONTRACT_DUMP) {
  console.log(JSON.stringify({
    types: TYPES.size, emitted: EMITS.size, routes: ROUTES.size, answered: ANSWERED.size,
    notEmitted: [...TYPES].filter((t) => !EMITS.has(t)).sort(),
    unanswered: [...ROUTES.keys()].filter((k) => !ANSWERED.has(k)).sort().map((k) => [k, ROUTES.get(k)]),
    answered: [...ANSWERED].sort(),
  }, null, 1));
}
