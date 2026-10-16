// The "only git" rule, checked on the SHIPPED text of dist/healthworker.mjs (dev or minified):
// every binding of a node:child_process function, under whatever name the bundler gave it, may
// appear only as a call whose first argument is the literal "git". Anything else — a call with
// another first argument, the function passed around as a value, a namespace member that is not
// such a call, a `require` of the module, a reference the reader does not recognise — is a problem.
// Used by check-vsix.mjs (on the packaged file) and test/health.test.mjs (on the built one).

const MOD = String.raw`["'](?:node:)?child_process["']`;
const SPAWNERS = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]);
const ID = String.raw`[A-Za-z_$][\w$]*`;
const esc = (s) => s.replace(/[$]/g, "\\$");
// A call whose first argument is the literal git: X("git"  X('git'  X(`git`
const GIT_ARG = String.raw`\s*\(\s*(?:"git"|'git'|\`git\`)`;

/** @returns {string[]} problems; empty = every child_process call starts `git`. */
export function gitOnlyProblems(text) {
  const bad = [];
  const fns = []; // [local name, imported name]
  const spaces = []; // namespace / default bindings
  let matched = 0;

  for (const m of text.matchAll(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${MOD}`, "g"))) {
    matched++;
    for (const part of m[1].split(",").map((p) => p.trim()).filter(Boolean)) {
      const [imported, local = imported] = part.split(/\s+as\s+/).map((x) => x.trim());
      if (SPAWNERS.has(imported)) fns.push([local, imported]);
    }
  }
  for (const m of text.matchAll(new RegExp(String.raw`import\s*\*\s*as\s*(${ID})\s*from\s*${MOD}`, "g"))) { matched++; spaces.push(m[1]); }
  for (const m of text.matchAll(new RegExp(String.raw`import\s+(${ID})\s*(?:,\s*\{[^}]*\})?\s*from\s*${MOD}`, "g"))) {
    matched++;
    spaces.push(m[1]);
    const named = /\{([^}]*)\}/.exec(m[0]);
    if (named) {
      for (const part of named[1].split(",").map((p) => p.trim()).filter(Boolean)) {
        const [imported, local = imported] = part.split(/\s+as\s+/).map((x) => x.trim());
        if (SPAWNERS.has(imported)) fns.push([local, imported]);
      }
    }
  }
  const mentions = [...text.matchAll(new RegExp(MOD, "g"))].length;
  if (mentions !== matched) bad.push(`${mentions} mention(s) of child_process, ${matched} recognised import(s): a require() or another form this check cannot follow`);

  // Strip the import statements themselves before looking for uses.
  const body = text.replace(new RegExp(String.raw`import[^;]*?from\s*${MOD}\s*;?`, "g"), "");
  const notMember = String.raw`(?<![\w$.])`;
  // A minified name can collide with a character-class range in a regex or string: `Za` inside
  // [A-Za-z]. The whole shape `x-NAME-y` (a word character each side of the dashes) is not a
  // use; as code it is arithmetic on the function value, which neither calls nor passes it anywhere.
  // Three more shapes a short name meets that are not uses either: an object KEY (`{ts:e}`, `,ts:1` —
  // nothing before the colon can call or pass anything), a string that IS the name (`"ts"`), and a
  // word in a string after `@` (`"@ts-ignore"`), which no code position in a bundle with no
  // decorators takes.
  const uses = (name) => body
    .replace(new RegExp(String.raw`\w-${esc(name)}-\w`, "g"), " ")
    .replace(new RegExp(String.raw`([{,])${esc(name)}:`, "g"), "$1 :")
    .replace(new RegExp(String.raw`(["'])${esc(name)}\1`, "g"), "$1$1")
    .replace(new RegExp(String.raw`@${esc(name)}-`, "g"), "@ -");
  for (const [local, imported] of fns) {
    const all = [...uses(local).matchAll(new RegExp(`${notMember}${esc(local)}(?![\\w$])`, "g"))].length;
    const git = [...body.matchAll(new RegExp(`${notMember}${esc(local)}${GIT_ARG}`, "g"))].length;
    if (all === 0) continue;
    if (git !== all) bad.push(`${imported} (as ${local}): ${all - git} of ${all} use(s) are not a call starting "git"`);
  }
  for (const ns of spaces) {
    const all = [...uses(ns).matchAll(new RegExp(`${notMember}${esc(ns)}(?![\\w$])`, "g"))].length;
    const git = [...body.matchAll(new RegExp(`${notMember}${esc(ns)}\\s*\\.\\s*(${[...SPAWNERS].join("|")})${GIT_ARG}`, "g"))].length;
    if (git !== all) bad.push(`child_process namespace ${ns}: ${all - git} of ${all} use(s) are not a call starting "git"`);
  }
  if (fns.length === 0 && spaces.length === 0 && mentions > 0 && bad.length === 0) bad.push("child_process is imported but no binding was found");
  return bad;
}
