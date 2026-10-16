// The setup checklist run WITHOUT being asked: the host sweeps discovered repos
// on its own, stamps the verdict on /api/repos so a repo row can badge it, keeps
// it across a restart, and re-stamps it the moment a fix lands. Host-scope rows
// (the Gemini key) must never count — one unset env var would flag every repo.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVENTIONS, E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8804;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-setupwatch-`));
const CONFIG = mkdtempSync(join(tmpdir(), `${SLUG}-cfg-`));
const env = {
  ...process.env,
  // e2e must never touch the shared tmux server, and the boot doctor must not
  // print into output we assert on.
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CONFIG_DIR]: CONFIG,
  // Sweep hard so the test doesn't wait ten minutes, and re-check aggressively
  // so the staleness path is exercised too.
  [E.SETUP_SWEEP_MS]: "300", [E.SETUP_RECHECK_MS]: "60000",
  // Pin the auto-compact row to a PASS (env beats every settings file) so the
  // counts below are about the rows they were written for, and not about
  // whatever ~/.claude/settings.json on this desktop happens to say.
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400k",
};
// A key on this desktop must not change what is checked.
delete env.GEMINI_API_KEY;

const base = `http://127.0.0.1:${PORT}`;
const j = (p, opts) => fetch(base + p, opts).then((r) => r.json());
const post = (p, body) => j(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const find = (report, id) => report.checks.find((c) => c.id === id) || {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A plain git repo with a real CLAUDE.md that never mentions the outbox and no
 *  .gitignore: one fail + one warn, both fixable — the state a desktop clone is
 *  in the first time you drive it from the phone. */
function makeRepo(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "CLAUDE.md"), `# ${name}\n\nProject instructions.\n`);
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  return dir;
}

/** The same repo with its transport dirs already gitignored: nothing FAILS, one
 *  thing warns (CLAUDE.md never mentions the outbox). This is the shape most
 *  repos are actually in, and the one that separates the badge's gate from the
 *  badge's style — `issues > 0` renders it, `ok` decides whether it is amber or
 *  red. Both readings have to survive a restart, since `npm run restart` is
 *  routine and the watcher rebuilds every entry from `<state>/setup.json` on boot. */
function makeWarnOnlyRepo(name) {
  const dir = makeRepo(name);
  writeFileSync(join(dir, ".gitignore"), ".claude/inbox\n.claude/outbox\n.outbox\n");
  return dir;
}

async function reposList() { return (await j("/api/repos")).targets; }
async function repoNamed(name) { return (await reposList()).find((t) => t.repoName === name); }

/** Poll until `pick` returns something truthy, or give up. */
async function until(pick, ms = 6000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await pick();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(150);
  }
}

let host = null;
function boot() {
  host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  host.stdout.on("data", () => {});
}

const t0 = makeRepo("watched");
const tWarn = makeWarnOnlyRepo("warn-only");

setTimeout(async () => {
  try {
    boot();
    await waitForHost(PORT);

    // ── The sweep finds a repo nobody opened ────────────────────────────
    const flagged = await until(async () => {
      const t = await repoNamed("watched");
      return t && t.setup ? t : null;
    });
    check(!!flagged, "sweep stamps a setup verdict on the repo listing");
    check(flagged && flagged.setup.ok === false, "un-wired repo is flagged not-ok without anyone asking");
    // gitignore-transport fails, claude-md-outbox warns.
    check(flagged && flagged.setup.issues === 2, `two repo-scope issues counted (got ${flagged?.setup?.issues})`);
    check(flagged && flagged.setup.fixable === 2, "both are one-tap fixable");
    check(flagged && flagged.setup.firstSeenAt > 0 && flagged.setup.checkedAt >= flagged.setup.firstSeenAt,
      "verdict carries when the repo was first seen and last checked");

    // ── The checklist agrees with the count (no host-scope row since the Gemini one went) ─
    const rep = await j(`/api/repos/${flagged.id}/compliance`);
    check(!rep.checks.some((c) => c.id === "gemini"), "no gemini row — the core needs no Gemini key");
    check(rep.checks.filter((c) => c.status !== "pass").length === 2, "checklist itself shows both non-passing rows");

    // ── Persisted, so a restart doesn't start from ignorance ────────────
    const store = JSON.parse(readFileSync(join(ROOT, STATE, "setup.json"), "utf8"));
    // Keyed by realpath — a mkdtemp root is /var/… while git reports /private/var/….
    check(!!store.repos[realpathSync(t0)], "verdict persisted under <state>/setup.json");

    // ── Warn-only: amber badge, nothing failing ─────────────────────────
    // `ok` and `issues` answer two different questions and both have to be
    // right. A repo with warns and no fails is the common case, and it is the
    // one where collapsing them loses information: `issues > 0` is what makes
    // the chip appear at all (most of these checks can only ever warn), `ok`
    // is only what makes it amber rather than red.
    const amber = await until(async () => {
      const t = await repoNamed("warn-only");
      return t && t.setup ? t : null;
    });
    check(!!amber && amber.setup.ok === true, "warn-only repo is ok — nothing is failing");
    check(!!amber && amber.setup.issues > 0, `warn-only repo still badges (got ${amber?.setup?.issues} issues)`);
    check(!!amber && amber.setup.fixable === 1, "the one warn is one-tap fixable");
    const amberRep = await j(`/api/repos/${amber.id}/compliance`);
    check(amberRep.checks.filter((c) => c.scope !== "host" && c.status === "fail").length === 0,
      "no repo-scope row is a fail");
    check(find(amberRep, "claude-md-outbox").status === "warn", "the issue counted is the outbox warn");

    // ── A repo added later is picked up by a later sweep ────────────────
    const t1 = makeRepo("appeared-later");
    const late = await until(async () => {
      const t = await repoNamed("appeared-later");
      return t && t.setup ? t : null;
    });
    check(!!late && late.setup.ok === false, "a repo that appears after boot is swept too");

    // ── Applying the fixes clears the badge immediately ─────────────────
    const fx = await post(`/api/repos/${late.id}/compliance/fix`, { fixes: ["gitignore", "claude-md"] });
    check(fx.ok, "fixes applied");
    const cleared = await repoNamed("appeared-later");
    check(cleared.setup.ok === true && cleared.setup.issues === 0,
      "the row badge clears on the next listing, not on the next sweep");

    // ── Restart: the verdict survives (and is not re-derived from nothing) ─
    host.kill();
    await sleep(400);
    boot();
    await waitForHost(PORT);
    const after = await until(async () => {
      const t = await repoNamed("appeared-later");
      return t && t.setup ? t : null;
    });
    check(!!after && after.setup.ok === true, "fixed repo stays clean across a host restart");
    const stillFlagged = await repoNamed("watched");
    check(stillFlagged.setup && stillFlagged.setup.ok === false, "un-fixed repo is still flagged after a restart");
    // The rebuild in `SetupWatcher`'s constructor reads each field back by hand,
    // so a restart is where a rollup silently loses one. Both readings, both
    // repos: a fail must still read as a fail (above) and a warn must still read
    // as a warn, for the whole RECHECK_MS window before anything re-inspects.
    const amberAfter = await until(async () => {
      const t = await repoNamed("warn-only");
      return t && t.setup ? t : null;
    });
    check(!!amberAfter && amberAfter.setup.ok === true && amberAfter.setup.issues > 0,
      "warn-only repo is still ok-with-issues after a restart (amber, not red)");
    check(!existsSync(join(tWarn, ".claude")), "the sweep never wrote into the warn-only repo either");
    check(existsSync(join(t1, ".gitignore")), "the fix wrote a real .gitignore");
    // The watcher itself must never write into a repo — only the fix route did,
    // and `watched` was never fixed.
    check(!existsSync(join(t0, ".gitignore")), "the sweep never writes into a repo it merely inspected");
    const cm = readFileSync(join(t0, "CLAUDE.md"), "utf8");
    check(!cm.includes(CONVENTIONS), "the sweep never edits CLAUDE.md on its own");
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  if (host) host.kill();
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
}, 300);

// Two boots inside: a host answers in under a second on a Mac and in 3-5 s under WSL.
setTimeout(() => { console.log("FAIL: timeout"); if (host) host.kill(); process.exit(1); }, 60000);
