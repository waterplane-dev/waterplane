// The pure half of `publish-public.mjs`: no fs, no git, no process. Everything
// here takes strings and returns data, so `public-lib.test.mjs` can pin it.
//
//   - allow-list matching (gitignore-style, LAST MATCH WINS, default = private)
//   - the secret and personal-data scans, line by line
//   - markdown link checking against the included set
//   - CHANGELOG section extraction for the release commit body
import { createHash } from "node:crypto";

// ---------------------------------------------------------------- allow-list

/** One glob (no leading `!`) to a regex source. `**` crosses `/`, `*` and `?` do not. */
function globSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atEnd = i + 2 >= glob.length;
        const slashAfter = glob[i + 2] === "/";
        const slashBefore = i > 0 && glob[i - 1] === "/";
        if (slashAfter) { out += "(?:.*/)?"; i += 2; }          // `**/x`: any depth, including none
        else if (atEnd && slashBefore) { out = out.slice(0, -1) + "/.*"; i += 1; } // `a/**`: everything below
        else { out += ".*"; i += 1; }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** Parse allow-list text into ordered rules. Comments and blanks are dropped. */
export function parseAllowlist(text) {
  const rules = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    let p = raw.trim();
    if (!p || p.startsWith("#")) return;
    let negate = false;
    if (p.startsWith("!")) { negate = true; p = p.slice(1); }
    else if (p.startsWith("\\")) p = p.slice(1); // `\#` / `\!` literal
    const dirOnly = p.endsWith("/");
    if (dirOnly) p = p.slice(0, -1);
    const anchored = p.includes("/");
    if (p.startsWith("/")) p = p.slice(1);
    const src = globSource(p);
    const re = new RegExp(anchored ? `^${src}$` : `^(?:.*/)?${src}$`);
    rules.push({ raw: raw.trim(), line: idx + 1, negate, dirOnly, re });
  });
  return rules;
}

function ruleMatches(rule, path) {
  const parts = path.split("/");
  // A pattern that matches a directory covers everything under it.
  for (let n = 1; n < parts.length; n++) if (rule.re.test(parts.slice(0, n).join("/"))) return true;
  return !rule.dirOnly && rule.re.test(path);
}

/** `{ included, rule }`: the last matching rule decides; no match = private. */
export function classify(path, rules) {
  let decided = null;
  for (const r of rules) if (ruleMatches(r, path)) decided = r;
  return { included: !!decided && !decided.negate, rule: decided };
}

/**
 * The in-repo extensions the allow-list keeps PRIVATE — the folder ids of its whole-folder carve-outs
 * (`!packages/extensions/<id>/**`), in file order. The allow-list is the one record of that decision,
 * so the guards (`tools/publictree.test.mjs`, `scripts/verify-public-tree.mjs`) read it from here and
 * name no extension themselves.
 */
export function privateExtensions(text) {
  const out = [];
  for (const r of parseAllowlist(text)) {
    const m = /^packages\/extensions\/([a-z0-9][a-z0-9-]*)\/\*\*$/.exec(r.raw.replace(/^!/, ""));
    if (r.negate && m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// ----------------------------------------------------------------- redaction

export const lineHash = (rule, text) => createHash("sha1").update(`${rule}\n${text.trim()}`).digest("hex").slice(0, 10);
/** What an `--accept` file lists: `path:line:hash`. */
export const hitToken = (path, line, rule, text) => `${path}:${line}:${lineHash(rule, text)}`;

export function parseAccept(text) {
  return new Set(text.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, "").trim()).filter((l) => l && !l.startsWith("#")));
}

/** A secret is never printed whole, because the report lands in a phone gallery. */
export const mask = (s) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…(${s.length})`);
const excerpt = (line, at, len) => {
  const start = Math.max(0, at - 30);
  const s = line.slice(start, start + len).trim();
  return (start > 0 ? "…" : "") + s + (line.length > start + len ? "…" : "");
};

// -------------------------------------------------------------------- secrets

export const SECRET_RULES = [
  { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "gcp-service-account", re: /"type"\s*:\s*"service_account"/ },
  { id: "gcp-private-key-field", re: /"private_key"\s*:\s*"-----BEGIN/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: "openai-key", re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

/** Config-style files, where `password = value` is a credential and not code. */
export const CONFIG_FILE_RE = /(?:\.(?:properties|ini|cfg|conf|toml|gradle|ya?ml|env)$|(?:^|\/)\.env(?:\.[^/]*)?$)/i;
const PASSWORD_RE = /\b\w*password\w*\s*=\s*["']?([^\s"']+)/i;
const PASSWORD_PLACEHOLDER_RE = /^(?:\$|<|\{|%|changeme|example|xxx|\*+$|null$|undefined$|process\.|System\.)/i;

/** Files that are credentials by their name alone. */
export const SECRET_FILE_RE = /\.(?:p8|p12|jks|keystore|pfx)$/i;

// ------------------------------------------------------------------- personal

const PLACEHOLDER_TS_LABEL_RE = /^(?:\*|<.*>|\{.*\}|\$.*|example|tailnet|tailnet-name|your-?tailnet|my-?tailnet|yourname|name|host|hostname|machine|device|desktop|laptop|foo|bar|baz|xxx+|x+|placeholder|something|mydesktop|my-?desktop|my-?machine|your-?host|your-?machine|\.\.\.?|tail(?:1234|5678|abcd|0000|x+)|tailnet\d*)$/i;
const TS_NET_RE = /([A-Za-z0-9<>{}$*_-][A-Za-z0-9<>{}$*_.-]*)\.ts\.net\b/g;
const CGNAT_RE = /(?<![\d.])100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(\d{1,3})\.(\d{1,3})(?![\d])/g;
const LAN_RE = /(?<![\d.])(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d])/g;
/** The resolver every tailnet exposes, and the documentation-style obvious fakes. */
const DOC_CGNAT_RE = /^100\.64\.0\.\d{1,3}$/; // the documentation-style range
const OBVIOUS_CGNAT = new Set(["100.100.100.100", "100.64.0.0", "100.64.0.1", "100.101.102.103", "100.127.255.255", "100.100.0.0", "100.64.1.1", "100.100.1.1", "100.64.0.2"]);
const IGNORED_EMAILS = new Set(["noreply@github.com", "noreply@anthropic.com"]);
/** A Claude session id as this repo's docs cite one: 8+ letters and digits, at least one digit. */
const SID = String.raw`(?=[0-9A-Za-z]*\d)[0-9A-Za-z]{8,}`;
/** `session 9c2215c5`, `session \`5630c7fb\``, `session_014Xmz…`: provenance only the owner can follow.
 *  Markdown only; `stripSessionIds` removes the forms the docs use, so a hit is a new phrasing. */
const SESSION_ID_RE = new RegExp(String.raw`\bsession[ _:]\`?${SID}\b`, "gi");
/** A link to a Claude Code session, in any file. */
const SESSION_URL_RE = /claude\.ai\/code\/session_[0-9A-Za-z]{10,}/g;

/** Build the machine's own identifiers once; `scanText` reuses them for every file. */
export function buildContext({ emails = [], home = "", hostnames = [], extraNeedles = [] } = {}) {
  const needles = [];
  for (const e of new Set(emails.map((x) => x.trim().toLowerCase()).filter(Boolean))) {
    if (!IGNORED_EMAILS.has(e) && e.includes("@")) needles.push({ rule: "personal-email", needle: e });
  }
  const homes = new Set();
  if (home && home !== "/") {
    homes.add(home);
    const name = home.split("/").filter(Boolean).pop();
    if (name && !/^(?:user|runner|me|root|ubuntu|node|home|app)$/i.test(name)) {
      homes.add(`/Users/${name}`);
      homes.add(`/home/${name}`);
      // Claude Code encodes a project path as a dir name: /Users/x/dev -> -Users-x-dev.
      homes.add(`-Users-${name}-`);
      homes.add(`-home-${name}-`);
    }
  }
  for (const h of homes) needles.push({ rule: "home-path", needle: h.toLowerCase() });
  for (const h of new Set(hostnames.map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 4 && x !== "localhost"))) {
    needles.push({ rule: "hostname", needle: h });
  }
  for (const n of extraNeedles) needles.push(n);
  return { needles };
}

const isDocsPath = (path) => /^docs\//.test(path) || /\.md$/i.test(path);

/**
 * Scan one text file. Returns `hits` (gate the release) and `warnings` (reported,
 * never gate). Every entry carries `token` for the `--accept` file.
 */
export function scanText(path, text, ctx) {
  const hits = [];
  const warnings = [];
  const config = CONFIG_FILE_RE.test(path);
  const lines = text.split(/\r?\n/);
  const push = (list, rule, category, i, line, at, shown) => {
    list.push({ path, line: i + 1, rule, category, excerpt: shown ?? excerpt(line, at, 120), token: hitToken(path, i + 1, rule, line) });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const r of SECRET_RULES) {
      const m = r.re.exec(line);
      if (m && !/EXAMPLE/.test(m[0])) push(hits, r.id, "secret", i, line, m.index, `${r.id}: ${mask(m[0])}`);
    }
    if (config) {
      const m = PASSWORD_RE.exec(line);
      if (m && !PASSWORD_PLACEHOLDER_RE.test(m[1]) && !/^\s*[#/;]/.test(line)) push(hits, "password-assignment", "secret", i, line, m.index, `password assignment: ${mask(m[1])}`);
    }
    const lower = line.toLowerCase();
    for (const n of ctx.needles) {
      const at = lower.indexOf(n.needle);
      if (at >= 0) push(hits, n.rule, "personal", i, line, at);
    }
    for (const m of line.matchAll(CGNAT_RE)) {
      if (!OBVIOUS_CGNAT.has(m[0]) && !DOC_CGNAT_RE.test(m[0])) push(hits, "tailscale-ip", "personal", i, line, m.index);
    }
    for (const m of line.matchAll(TS_NET_RE)) {
      const label = m[1].split(".").pop();
      if (!PLACEHOLDER_TS_LABEL_RE.test(m[1]) && !PLACEHOLDER_TS_LABEL_RE.test(label)) push(hits, "ts-net-name", "personal", i, line, m.index);
    }
    if (/\.md$/i.test(path)) for (const m of line.matchAll(SESSION_ID_RE)) push(hits, "session-id", "personal", i, line, m.index);
    for (const m of line.matchAll(SESSION_URL_RE)) push(hits, "session-url", "personal", i, line, m.index);
    for (const m of line.matchAll(LAN_RE)) {
      push(warnings, isDocsPath(path) ? "lan-ip-docs" : "lan-ip", "lan", i, line, m.index);
    }
  }
  return { hits, warnings };
}

/** Name-only checks (no content): a key store present at all is a hit. */
export function scanPath(path) {
  if (!SECRET_FILE_RE.test(path)) return [];
  return [{ path, line: 0, rule: "key-file", category: "secret", excerpt: "credential file present", token: hitToken(path, 0, "key-file", "") }];
}

// ------------------------------------------------------------------ changelog

/** The body of `## <version> ...` up to the next `## `, or null. */
export function extractChangelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const v = version.replace(/^v/, "");
  const head = new RegExp(`^##\\s+\\[?v?${v.replace(/[.+^${}()|[\]\\]/g, "\\$&")}\\]?(?:\\s|$|[—–-])`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body || null;
}

// ---------------------------------------------------------------------- links

const posixDirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
/** Resolve `target` against `dir` without touching a filesystem; null if it escapes the root. */
export function resolveRel(dir, target) {
  const out = target.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return out.join("/");
}

/** An `<a …>` or `<img …>` tag, and the `href="…"`/`src="…"` targets inside one. */
const HTML_LINK_TAG_RE = /<(?:a|img)\s[^>]*>/gi;
const HTML_TARGET_RE = /(\b(?:href|src)=")([^"]+)"/gi;

const stripFences = (md) => md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, " "));

/**
 * Links and path mentions in one markdown file that point at something that is
 * not in the snapshot. `kind: "excluded"` = exists in the private tree but is
 * not published; `"missing"` = exists nowhere (broken already).
 */
export function checkLinks(path, md, { included, tracked, includedDirs }) {
  const found = [];
  const body = stripFences(md);
  const dir = posixDirname(path);
  const lines = body.split("\n");
  const consider = (target, via, i) => {
    let t = target.trim().replace(/^<|>$/g, "");
    if (!t || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(t)) return;
    t = t.replace(/[?#].*$/, "");
    if (!t) return;
    // A markdown link is relative to its file, but skills and CLAUDE.md also write
    // repo-root paths in link position: accept either reading before calling it broken.
    const cands = [resolveRel(via === "link" ? dir : "", t), via === "link" ? resolveRel("", t) : null]
      .filter((c) => c !== null && c !== "").map((c) => c.replace(/\/$/, ""));
    if (!cands.length) return;
    if (cands.some((c) => included.has(c) || includedDirs.has(c))) return;
    const bare = cands.find((c) => tracked.has(c) || [...tracked].some((p) => p.startsWith(`${c}/`))) ?? cands[0];
    const existsPrivately = tracked.has(bare) || [...tracked].some((p) => p.startsWith(`${bare}/`));
    if (via === "mention" && !existsPrivately) return; // prose that merely looks like a path
    found.push({ path, line: i + 1, target: t, resolved: bare, kind: existsPrivately ? "excluded" : "missing", via });
  };
  lines.forEach((line, i) => {
    // A link written inside a code span is an example of the syntax, not a link.
    const prose = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    // Every `](target)`: `[![alt](a.gif)](b.mp4)` carries two, and `[text](t)` only sees the first.
    for (const m of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) consider(m[1], "link", i);
    // …and the sized HTML spelling of a docs gif, `<a href="b.mp4"><img src="a.gif" width=…></a>`.
    for (const tag of prose.matchAll(HTML_LINK_TAG_RE)) for (const m of tag[0].matchAll(HTML_TARGET_RE)) consider(m[2], "link", i);
    const ref = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(prose);
    if (ref) consider(ref[1], "link", i);
    for (const m of line.matchAll(/`([\w@.-]+(?:\/[\w@.-]+)+\.md)`/g)) consider(m[1], "mention", i);
  });
  return found;
}

/** Every directory that holds at least one of the given files. */
export function dirsOf(paths) {
  const out = new Set();
  for (const p of paths) {
    const parts = p.split("/");
    for (let n = 1; n < parts.length; n++) out.add(parts.slice(0, n).join("/"));
  }
  return out;
}

// ----------------------------------------------------------------- rewriting
// What publishing CHANGES on the way out, so the private tree keeps what only its owner needs and
// the public one never carries it. Each returns the new text and a count; the report says both.

const SID_LIST = String.raw`${SID}(?:, ${SID})*`;
const SID_PAREN_RE = new RegExp(String.raw`[ \t]*\(session ${SID_LIST}\)`, "g");
const SID_PAREN_LEAD_RE = new RegExp(String.raw`\(session ${SID_LIST};\s*`, "g");
const SID_ON_RE = new RegExp(String.raw` on session \`?${SID}\`?`, "g");
const ASKED_RE = /^(\s*- asked: )(.*)$/;
/** An `asked:` entry that is a prompt-log ref (`ec4932bb`): a key into the private prompt log. */
const PROMPT_REF_RE = /(^|, )[0-9a-f]{8}(?=, |$)/g;

/**
 * Drop the Claude session ids, and the prompt-log refs of an `asked:` line, from a markdown file.
 * The requirements record `asked: <ref>, <date> (session <id>)` so the owner can find the prompt
 * and the conversation behind an item; nobody else can open either, so publicly they are noise
 * that also leaks how the owner works. An `asked:` line left with nothing is dropped. Markdown
 * only; an id in a new phrasing is a `session-id` scan hit.
 */
export function stripSessionIds(path, text) {
  if (!/\.md$/i.test(path)) return { text, n: 0 };
  let n = 0;
  const count = (r) => () => { n++; return r; };
  const out = [];
  for (const line of text.split("\n")) {
    let l = line.replace(SID_PAREN_LEAD_RE, count("(")).replace(SID_PAREN_RE, count("")).replace(SID_ON_RE, count(""));
    const asked = ASKED_RE.exec(l);
    if (asked) {
      const rest = asked[2].replace(PROMPT_REF_RE, () => { n++; return ""; }).replace(/^, /, "");
      if (!rest.trim()) continue;
      l = asked[1] + rest;
    }
    out.push(l);
  }
  return { text: out.join("\n"), n };
}

/**
 * Re-point links at files published somewhere else (the videos: too big to carry in the
 * public repo's history). `host(repoPath)` answers the URL for a path that is hosted, else null.
 * Every `](target)` and `[ref]: target` outside fences and code spans is considered, resolved
 * like `checkLinks` (relative to the file, then from the repo root). Returns the new text, the
 * number of links changed and the set of repo paths they point at.
 */
export function rewriteHostedLinks(path, md, host) {
  const dir = posixDirname(path);
  const used = new Set();
  let n = 0;
  const fenced = stripFences(md).split("\n");
  const target = (t) => {
    const bare = t.replace(/[?#].*$/, "");
    if (!bare || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(bare)) return null;
    for (const c of [resolveRel(dir, bare), resolveRel("", bare)]) {
      const url = c ? host(c) : null;
      if (url) { used.add(c); n++; return url + t.slice(bare.length); }
    }
    return null;
  };
  const out = md.split("\n").map((line, i) => {
    if (fenced[i] !== line) return line; // inside a fence
    const ref = /^(\s{0,3}\[[^\]]+\]:\s*)(\S+)(.*)$/.exec(line);
    if (ref) { const u = target(ref[2]); return u ? ref[1] + u + ref[3] : line; }
    return line.replace(/(`[^`]*`)|\]\(([^)\s]+)|<(?:a|img)\s[^>]*>/gi, (m, code, t) => {
      if (code) return code;
      if (t === undefined) return m.replace(HTML_TARGET_RE, (a, pre, h) => { const u = target(h); return u ? `${pre}${u}"` : a; });
      const u = target(t);
      return u ? `](${u}` : m;
    });
  }).join("\n");
  return { text: out, n, used };
}

/** The hosted name of a file: its stem plus the first 10 hex of its sha256, so a re-recording is a
 *  new URL and every older release's links keep pointing at the bytes they were written against. */
export function hostedName(path, sha256hex) {
  const base = path.split("/").pop();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? `${base.slice(0, dot)}-${sha256hex.slice(0, 10)}${base.slice(dot)}` : `${base}-${sha256hex.slice(0, 10)}`;
}

// --------------------------------------------------------------------- target

// The target's own git metadata, which a write never deletes or walks into. `.git` at the root is
// a directory in a clone but a FILE in a linked worktree (`gitdir: …`); both are the repo, so it
// is matched by name, never by type. A nested `.git` (`a/.git`) is snapshot content like any other.
export const isTargetGit = (rel) => rel === ".git" || rel.startsWith(".git/");

// ------------------------------------------------------------------- grouping

/** Group a path list for a report: one row per two-level prefix. */
export function groupPaths(paths) {
  const groups = new Map();
  for (const p of paths) {
    const parts = p.split("/");
    const key = parts.length === 1 ? "(root)" : parts.length === 2 ? parts[0] : `${parts[0]}/${parts[1]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export const topDir = (p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : "(root)");

/**
 * What CI's "The tarball is this version, with its shrinkwrap" step (`.github/workflows/npm-publish.yml`)
 * asserts of `dist-release/<slug>-<version>.tgz`, as a list of sentences (empty = it would pass):
 * `listing` is the tarball's member names (`tar -tzf`), `pkgJson` the text of `package/package.json`
 * (null = unreadable). Pure; `scripts/release/check-npm-tarball.mjs` gathers the facts.
 */
export function npmTarballProblems({ slug, version, listing, pkgJson }) {
  const tgz = `dist-release/${slug}-${version}.tgz`;
  const out = [];
  let got = null;
  try { const p = JSON.parse(pkgJson ?? ""); got = `${p.name}@${p.version}`; } catch { /* reported below */ }
  if (got === null) out.push(`${tgz}: package/package.json is missing or unreadable`);
  else if (got !== `${slug}@${version}`) out.push(`${tgz} is ${got}, not ${slug}@${version}`);
  if (!listing.includes("package/npm-shrinkwrap.json")) {
    out.push(`${tgz} has no package/npm-shrinkwrap.json: npm i -g would re-resolve every transitive dependency`);
  }
  return out;
}

/**
 * What `scripts/verify-public-tree.mjs` runs inside the copied public tree, in order. `stop`: a
 * failure there ends the run (nothing after an install or a build means anything); the others all
 * run so one report lists every failure. `npm ci` is the copy's OWN install (its package.json,
 * package-lock.json and .npmrc) — never a link to this checkout's node_modules, which proved only
 * that the tree runs on dependencies it may not declare. `e2e`: comma-separated run-e2e filters.
 */
export function verifySteps({ e2e = null } = {}) {
  const steps = [
    { cmd: "npm", args: ["ci"], stop: true },
    { cmd: "npm", args: ["run", "build"], stop: true },
    // The step npm-publish.yml runs on the release tag, here BEFORE the release is undrafted and that
    // workflow starts: on the clean copy, right after the build, as CI has it (build.mjs refuses a
    // dirty tree). Then the same two assertions CI makes of the .tgz it would publish.
    { cmd: "npm", args: ["run", "release:build", "--", "--unsigned"], stop: true },
    { cmd: "node", args: ["scripts/release/check-npm-tarball.mjs"], stop: false },
    { cmd: "npm", args: ["run", "lint"], stop: false },
    { cmd: "npm", args: ["run", "test:unit"], stop: false },
    { cmd: "npm", args: ["run", "test:host"], stop: false },
  ];
  if (e2e) steps.push({ cmd: "node", args: ["scripts/run-e2e.mjs", ...String(e2e).split(",").filter(Boolean)], stop: false });
  return steps;
}
