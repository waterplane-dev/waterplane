#!/usr/bin/env node
// Wire recording -> demo scenario skeleton, with a FAIL-CLOSED scrub.
//
//   node tools/demo-scenario.mjs <wire.jsonl> --id first-look [--out scenario.json]
//
// Input: the JSONL a host writes under `WATERPLANE_WIRE_RECORD=<file>`
// (`packages/host/src/wirerecord.ts`), recorded against the STUB TUI
// (`STUB_MODE=demo`), never a real `claude`. Output: a `DemoScenario`
// (`packages/web/src/demo/host/scenario.ts`) — `meta {id, protocol, stamp}`,
// `clock`, `state`, `script` — as a skeleton: names and summaries (no sidecar
// ran in the recording) are filled in by hand afterwards.
//
// THE SCRUB IS A DENYLIST THAT FAILS CLOSED (docs/analysis/demo-mode-plan.md §3):
// everything it knows to be sensitive is dropped, redacted or rewritten (rules 1
// to 3 below), and then rule 4 looks at EVERYTHING that is left and refuses the
// whole run if a single string still looks like a path, an address or a secret.
// The tool never "fixes" a leak it was not told about — it stops and names it.
// A recording is raw; only a run that exits 0 is fit to be committed.
//
// All rules live in `RULES` just below. Read that object and you have read the
// policy; the code under it only applies it.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { BRAND, PROTOCOL_VERSION } from "../packages/shared/dist/index.js";

/** The instant a scenario's numbers are true at (plan: the clock is pinned). */
export const CLOCK_START = Date.UTC(2026, 9, 1, 9, 0, 0);

export const RULES = {
  // 1. DROP: records removed whole. They carry root paths, tokens, real
  //    numbers or machine facts; DemoHost answers them itself (its welcome says
  //    root "demo"). HTTP is matched on the request path, frames on `t`.
  dropHttp: [
    /^\/api\/(auth|pair|redeem|settings|install|usage|secret|health|plugin|push|host)\b/,
  ],
  // A prefix list, so a frame type added to a family later (auth.*, settings.*,
  // plugin.* — the ones a person types a password, a key or a plugin config
  // into) is dropped without anyone remembering to list it.
  dropFrames: /^(?:authRequired|auth\.|pair|settings\.|install\.|usage\.|meter\.|budget\.|update\.status|backends|plugin\.|clihealth)/,

  // 2. REDACT: fields of a frame we KEEP, overwritten with a fixed fictional
  //    value (`undefined` = delete the key). Only `welcome` today.
  redactFields: {
    welcome: {
      tailscaleIp: null, tailscaleBin: null, tailscaleDns: null, httpsUrl: null,
      lanIps: [], port: 0, root: "demo", hostId: "demo", hostName: "Demo",
      deviceId: undefined,
      auth: { enabled: false, gateTailscale: false, canManage: false },
    },
  },

  // 3. REWRITE: what a kept string is allowed to become.
  //    - the recording's own root (and its /private realpath twin) -> ROOT_ALIAS
  //    - every random id seen as `session.id`, pty `id`, repo-target `id`,
  //      `bootId`, `claudeSessionId` -> a stable `s1`/`r1`/`c1`/`boot` name
  //    - epoch-ms within a day of the recording -> CLOCK_START + offset
  //    - pty `seq` / `resumeSeq` recomputed from the scrubbed bytes
  rootAlias: "~/dev",

  // 4. FORBID: after 1 to 3, a surviving match in ANY string (pty bytes are
  //    decoded first) fails the run. This is the fail-closed part.
  //    Every string is also checked in its UNESCAPED view (`\/`, `\uXXXX`,
  //    `%XX` decoded), base64-looking strings outside pty in their decoded
  //    view, and each session's pty bytes JOINED and ANSI-stripped — so a path
  //    split across two chunks or broken by a colour code is still one path.
  forbid: [
    ["user path",        /[/\\](?:Users|home)[/\\]/i],
    ["windows path",     /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\/i],
    ["private path",     /\/private\//],
    ["temp path",        new RegExp(`/var/folders|/tmp/|/T/${BRAND.slug}-`)],
    ["tailscale ip",     /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
    ["lan ip",           /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
    ["ipv6 address",     /\b(?:f[cd][0-9a-f]{2}|fe80):[0-9a-f]{0,4}:[0-9a-f:]*|\b2[0-9a-f]{3}:[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f:]+/i],
    ["tailnet name",     /\.ts\.net\b|\btailscale\.net\b/],
    ["email address",    /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
    ["url credentials",  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
    ["secret in query",  /[?&;](?:token|access_token|auth|key|apikey|api_key|sig|signature|password|pw|secret|code)=[^&\s]/i],
    ["secret assignment", /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[:=]\s*["']?[^\s"']{4,}/],
    ["cookie",           /\b(?:set-)?cookie\s*:/i],
    ["secret key in text", /"(?:token|password|secret|cookie|authorization|api_?key|access_?token|refresh_?token)"\s*:\s*"[^"]/i],
    ["uuid",             /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
    ["api key prefix",   /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bxox[abprs]-[A-Za-z0-9-]{8,}/],
    ["bearer / jwt",     /\bBearer\s+\S{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
    ["tok subprotocol",  /-tok\.[A-Za-z0-9_-]{8,}/],
    ["long hex",         /\b[0-9a-f]{32,}\b/i],
    ["long opaque run",  /[A-Za-z0-9+/_=-]{40,}/],
  ],
  // Keys whose value must be empty/absent, wherever they sit.
  forbidKeys: /^(token|password|passwd|passphrase|secret|clientSecret|cookie|authorization|apikey|api_key|accessToken|refreshToken|idToken|privateKey|credentials?)$/i,
};

// ── reading ────────────────────────────────────────────────────────────────

export function parseRecording(text) {
  return text.split("\n").filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`recording line ${i + 1} is not JSON`); }
  });
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Visit every string in `v`, replacing it with `fn(str, key)`. */
function mapStrings(v, fn, key = "") {
  if (typeof v === "string") return fn(v, key);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn, key));
  if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = mapStrings(x, fn, k); return o; }
  return v;
}
function mapNumbers(v, fn) {
  if (typeof v === "number") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapNumbers(x, fn));
  if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = mapNumbers(x, fn); return o; }
  return v;
}

// ── 1. drop, 2. redact ─────────────────────────────────────────────────────

function dropAndRedact(records, report) {
  const kept = [];
  for (const r of records) {
    if (r.dir === "http") {
      if (RULES.dropHttp.some((re) => re.test(r.path))) { report.dropped.push(`http ${r.path}`); continue; }
    } else if (typeof r.msg?.t === "string" && RULES.dropFrames.test(r.msg.t)) {
      report.dropped.push(`frame ${r.msg.t}`); continue;
    }
    const c = clone(r);
    const red = c.dir !== "http" && RULES.redactFields[c.msg?.t];
    if (red) for (const [k, v] of Object.entries(red)) { if (v === undefined) delete c.msg[k]; else c.msg[k] = v; }
    kept.push(c);
  }
  return kept;
}

/** A recording is made against bootHost's mkdtemp root; a root anywhere else is
 *  a real tree whose repo names, branches and files no scrub rule can know. */
function underTemp(p) {
  const bases = new Set(["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"]);
  try { bases.add(tmpdir().replace(/\/?$/, "/")); bases.add(realpathSync(tmpdir()).replace(/\/?$/, "/")); } catch { /* none */ }
  return [...bases].some((b) => p.startsWith(b) && p.length > b.length);
}

// ── 3. rewrite ─────────────────────────────────────────────────────────────

/** Roots the recording knew about, read from the RAW records (before any drop). */
function findRoots(raw) {
  const roots = new Set();
  for (const r of raw) {
    if (r.dir === "http" && typeof r.body?.root === "string") roots.add(r.body.root);
    if (r.dir === "out" && r.msg?.t === "welcome" && typeof r.msg.root === "string") roots.add(r.msg.root);
  }
  const all = new Set();
  for (const root of roots) { all.add(root); all.add("/private" + root); if (root.startsWith("/private/")) all.add(root.slice(8)); }
  return [...all].sort((a, b) => b.length - a.length);
}

/** Random ids -> stable names, assigned in order of first appearance. */
function collectIds(records) {
  const map = new Map();
  const give = (id, prefix) => { if (typeof id === "string" && id && !map.has(id)) map.set(id, `${prefix}${[...map.values()].filter((v) => v.startsWith(prefix)).length + 1}`); };
  for (const r of records) {
    if (r.dir === "http") { for (const t of r.body?.targets ?? []) give(t.id, "r"); continue; }
    const m = r.msg;
    if (m.t === "welcome") map.set(m.bootId, "boot");
    if (m.session) { give(m.session.id, "s"); give(m.session.claudeSessionId, "c"); }
    if (m.t === "pty" || m.t === "session.history") give(m.id, "s");
    for (const x of m.recent ?? []) give(x.claudeSessionId, "c");
    if (m.item?.id) give(m.item.id, "n");
  }
  return map;
}

function rewrite(records, roots, ids) {
  const idList = [...ids.entries()].sort((a, b) => b[0].length - a[0].length);
  const text = (s) => {
    for (const root of roots) s = s.split(root).join(RULES.rootAlias);
    for (const [from, to] of idList) s = s.split(from).join(to);
    return s;
  };
  const start = records[0]?.at ?? 0;
  const day = 24 * 3600_000;
  const num = (n) => (Math.abs(n - start) < day && n > 1e12 ? CLOCK_START + (n - start) : n);

  const seqTotal = new Map(); // session -> scrubbed bytes so far
  const seqMap = new Map();   // `${session}:${old}` -> new
  return records.map((r) => {
    let out = r;
    if (r.dir !== "http" && r.msg?.t === "pty" && typeof r.msg.dataB64 === "string") {
      const sid = r.msg.id;
      const bytes = Buffer.from(text(Buffer.from(r.msg.dataB64, "base64").toString("utf8")), "utf8");
      let total = seqTotal.get(sid) ?? 0;
      // a `full` repaint replaces the screen: it carries the position, it does not advance it
      if (r.msg.full !== true) total += bytes.length;
      seqTotal.set(sid, total);
      seqMap.set(`${sid}:${r.msg.seq}`, total);
      out = { ...r, msg: { ...r.msg, dataB64: bytes.toString("base64"), seq: total } };
    }
    if (r.dir === "in" && r.msg?.t === "session.attach" && "resumeSeq" in r.msg) {
      const to = seqMap.get(`${r.msg.id}:${r.msg.resumeSeq}`);
      const m = { ...r.msg }; delete m.resumeBoot;
      if (to === undefined) delete m.resumeSeq; else m.resumeSeq = to;
      out = { ...r, msg: m };
    }
    const keepB64 = (s, k) => (k === "dataB64" ? s : text(s));
    out = mapStrings(out, keepB64);
    return mapNumbers(out, (n, ) => num(n));
  }).map((r, i) => ({ ...r, at: records[i].at - start }));
}

// ── 4. forbid ──────────────────────────────────────────────────────────────

/** Every string a record holds, pty bytes decoded. [where, string]. */
function* allStrings(v, where = "$", streams = null) {
  if (typeof v === "string") { yield [where, v]; return; }
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) yield* allStrings(v[i], `${where}[${i}]`, streams); return; }
  if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === "dataB64" && typeof x === "string") {
        const text = Buffer.from(x, "base64").toString("utf8");
        if (streams) { const id = String(v.id ?? ""); streams.set(id, (streams.get(id) ?? "") + text); }
        yield [`${where}.${k}(decoded)`, text];
        continue;
      }
      yield* allStrings(x, `${where}.${k}`, streams);
    }
  }
}


const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** The other spellings of one string a leak can hide behind: JSON/JS escapes,
 *  percent-encoding, colour codes, and (for a base64-shaped string) its
 *  decoded bytes. */
function views(s) {
  const out = [];
  const un = s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([/\\"])/g, "$1")
    .replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  if (un !== s) out.push(["unescaped", un]);
  const noAnsi = s.replace(ANSI, "");
  if (noAnsi !== s) out.push(["ansi-stripped", noAnsi]);
  const compact = s.trim();
  if (compact.length >= 8 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
    const dec = Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    // only a decoding that is mostly text is worth reading; random bytes are not a leak
    const printable = dec.replace(/[^\x20-\x7e\t\r\n]/g, "").length;
    if (dec.length && printable / dec.length > 0.9) out.push(["base64-decoded", dec]);
  }
  return out;
}

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let machineCache = null;
/** Who and where THIS machine is: username, home, host and computer names, and
 *  the VCS identity its commits carry. Read once; each probe may fail. */
function machinePatterns() {
  if (machineCache) return machineCache;
  const m = [];
  const word = (name, v, min = 3) => { if (v && v.length >= min && v.toLowerCase() !== "localhost") m.push([name, new RegExp(`\\b${esc(v)}\\b`, "i")]); };
  try { word("this machine's username", userInfo().username); } catch { /* no username */ }
  try { const h = homedir(); if (h && h.length > 1) m.push(["this machine's home directory", new RegExp(esc(h))]); } catch { /* none */ }
  word("this machine's hostname", hostname().split(".")[0], 4);
  const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
  if (process.platform === "darwin") {
    word("this machine's computer name", run("scutil", ["--get", "ComputerName"]), 4);
    word("this machine's local host name", run("scutil", ["--get", "LocalHostName"]), 4);
  }
  word("this machine's commit author name", run("git", ["config", "--get", "user.name"]));
  word("this machine's commit author email", run("git", ["config", "--get", "user.email"]));
  return (machineCache = m);
}

function* keyHits(v, where = "$") {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) yield* keyHits(v[i], `${where}[${i}]`); return; }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (RULES.forbidKeys.test(k) && x !== null && x !== "" && x !== false && x !== undefined) yield [`${where}.${k}`, "forbidden key holds a value"];
    yield* keyHits(x, `${where}.${k}`);
  }
}

/** The findings that make a run fail. Empty array = clean. Never throws. */
export function findLeaks(value) {
  const finds = [];
  const rules = [...RULES.forbid, ...machinePatterns()];
  const scan = (where, s) => {
    for (const [name, re] of rules) {
      const m = re.exec(s);
      if (m) finds.push({ rule: name, where, sample: m[0].length > 24 ? m[0].slice(0, 6) + "…" : m[0] });
    }
  };
  const streams = new Map();
  for (const [where, s] of allStrings(value, "$", streams)) {
    scan(where, s);
    for (const [how, v] of views(s)) scan(`${where}(${how})`, v);
  }
  // a session's pty bytes as ONE stream, colour codes out: a path cut across
  // two chunks, or painted in two colours, is still one path
  for (const [id, joined] of streams) scan(`pty stream ${JSON.stringify(id)} (joined)`, joined.replace(ANSI, ""));
  for (const [where, why] of keyHits(value)) finds.push({ rule: why, where, sample: "" });
  return finds;
}

// ── build ──────────────────────────────────────────────────────────────────

/**
 * Recording -> `{ scenario, report }`. Throws `ScrubError` (with `.finds`) if
 * anything forbidden survives; the scenario is never returned in that case.
 */
export function buildScenario(raw, { id, stubHash = "" }) {
  if (!id) throw new Error("a scenario needs an --id");
  const report = { dropped: [], records: raw.length };
  const welcome = raw.find((r) => r.dir === "out" && r.msg?.t === "welcome")?.msg;
  if (!welcome) throw new Error("recording has no welcome frame — was it recorded with the host's WIRE_RECORD?");
  if (welcome.protocol !== PROTOCOL_VERSION) throw new Error(`recording is protocol ${welcome.protocol}, this tree is ${PROTOCOL_VERSION} — re-record`);

  const roots = findRoots(raw);
  const outside = roots.filter((r) => !underTemp(r));
  if (outside.length) throw new Error(`recording root ${outside[0]} is not under a temp dir — record the stub against a scratch root (scripts/lib-demorecord.mjs), never a real tree: its repo names and files would ship`);
  const kept = dropAndRedact(raw, report);
  const ids = collectIds(kept);
  const rec = rewrite(kept, roots, ids);

  const http = rec.filter((r) => r.dir === "http").map(({ method, path, status, body }) => ({ method, path, status, body }));
  const frames = rec.filter((r) => r.dir !== "http");
  const boundary = frames.findIndex((r) => r.dir === "in" && r.msg.t !== "hello" && r.msg.t !== "ping");
  const split = boundary < 0 ? frames.length : boundary;
  const t0 = frames[split]?.at ?? 0;
  const outs = (list) => list.filter((r) => r.dir === "out").map((r) => r.msg);
  const handshake = outs(frames.slice(0, split));
  const script = frames.slice(split).filter((r) => r.dir === "out").map((r) => ({ at: Math.max(0, r.at - t0), event: { kind: "frame", msg: r.msg } }));
  const inputs = frames.filter((r) => r.dir === "in").map((r) => ({ at: Math.max(0, r.at - t0), msg: r.msg }));

  const body = {
    clock: { start: CLOCK_START },
    state: { bootId: "boot", model: { recording: { http, handshake, inputs } } },
    script,
  };
  const finds = findLeaks(body);
  if (finds.length) throw new ScrubError(finds);
  const stamp = createHash("sha256").update(stubHash).update(JSON.stringify(body)).digest("hex").slice(0, 12);
  return { scenario: { meta: { id, protocol: PROTOCOL_VERSION, stamp }, ...body }, report };
}

export class ScrubError extends Error {
  constructor(finds) {
    super(`scrub failed closed: ${finds.length} finding(s)\n` + finds.slice(0, 20).map((f) => `  ${f.rule} at ${f.where}  ${JSON.stringify(f.sample)}`).join("\n"));
    this.finds = finds;
  }
}

// ── cli ────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
  const input = args.find((a) => !a.startsWith("--") && a !== flag("--id") && a !== flag("--out"));
  if (!input || !flag("--id")) { console.error("usage: demo-scenario.mjs <wire.jsonl> --id <name> [--out file.json]"); process.exit(2); }
  let stubHash = "";
  try { stubHash = createHash("sha256").update(readFileSync(new URL("../scripts/claude-stub-tui.mjs", import.meta.url))).digest("hex"); } catch { /* no stub */ }
  try {
    const { scenario, report } = buildScenario(parseRecording(readFileSync(input, "utf8")), { id: flag("--id"), stubHash });
    const json = JSON.stringify(scenario, null, 2) + "\n";
    if (flag("--out")) writeFileSync(flag("--out"), json); else process.stdout.write(json);
    console.error(`ok: ${scenario.script.length} script events, ${report.dropped.length} records dropped, stamp ${scenario.meta.stamp}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
