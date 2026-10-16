// Repo setup compliance: the checklist (GET) flags a fresh repo, the fix
// endpoint (POST) makes it compliant (gitignore inbox/outbox, CLAUDE.md with the
// outbox convention, optional Gemini setup script), fixes are idempotent, and an
// unknown repo 404s.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootWait } from "./lib-e2e.mjs";
// The one spelling of "this row is a finding", shared with the host's
// `summarize()` and with the phone's filter over the same checklist.
import { isSetupFinding } from "../packages/shared/dist/index.js";
import { CONVENTIONS, E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8799;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-setup-`));
// Isolated config dir so the host doesn't load the real ~/.config/<app>/.env, and
// drop GEMINI_API_KEY so a key on this desktop cannot change what is checked.
const CONFIG = mkdtempSync(join(tmpdir(), `${SLUG}-cfg-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CONFIG_DIR]: CONFIG,
  // The context-weight thresholds are env-overridable, and `process.env` is
  // inherited — a desktop that had tuned them would otherwise silently move this
  // script's goalposts. Stating them pins the override wiring as well.
  [E.CONTEXT_WARN_CHARS]: "16000", [E.CONTEXT_HARD_CHARS]: "40000", [E.CONTEXT_MAX_SKILLS]: "12",
};
delete env.GEMINI_API_KEY;
// The auto-compact row reads this ahead of every settings file.
delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
const j = (p, opts) => fetch(base + p, opts).then((r) => r.json());
const post = (p, body) => j(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
// What the phone's browser sends: an Origin the gate accepts. The consent fixes need it (`confirmgate.ts`).
const postB = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const find = (report, id) => report.checks.find((c) => c.id === id);

bootWait(PORT, 900, async () => {
  try {
    // setup:false → a bare repo, i.e. the non-compliant starting state this
    // script is about (the scaffolded variant already ships a CLAUDE.md).
    const repo = await post("/api/repo", { name: "setupdemo", setup: false });
    const id = (await j("/api/repos")).targets.find((t) => t.repoName === "setupdemo").id;

    // ── Initial check: fresh repo is non-compliant ──────────────────────
    const r0 = await j(`/api/repos/${id}/compliance`);
    check(r0.repoName === "setupdemo" && Array.isArray(r0.checks), "compliance returns a report");
    check(r0.ok === false, "fresh repo is not ok (has failures)");
    const cmd0 = find(r0, "claude-md");
    check(cmd0.status === "fail", "no CLAUDE.md → fail");
    // Missing CLAUDE.md is NOT auto-fixable — recommend /init, no fix button.
    check(cmd0.fix === null, "missing CLAUDE.md offers no fix (recommends /init)");
    check(/\/init/.test(cmd0.detail), "missing CLAUDE.md detail recommends /init");
    check(find(r0, "gitignore-transport").status === "fail", "inbox/outbox not gitignored → fail");
    // The Gemini-key row went with the decision oracle (now a plugin): a key the
    // core no longer needs is not a finding (docs/notes/plugins.md).
    check(find(r0, "gemini") === undefined, "no gemini row — the core needs no Gemini key");
    // Nothing to weigh yet: with no CLAUDE.md the row is omitted rather than
    // reported as 0 chars. The `claude-md` fail above is already the finding,
    // and a second row saying "this repo carries no instructions" is noise.
    check(find(r0, "context-weight") === undefined, "no CLAUDE.md → no context-weight row at all");

    // ── One predicate behind the count and behind the list ──────────────
    // The badge on the repo row is `setup.issues`; the phone's findings filter
    // cuts the same checklist down to the rows that number is about. Two
    // spellings of "a finding is a non-host row that is not a pass" agree on
    // the day they are written and drift the moment either end gains a scope —
    // and the failure is silent: a badge that counts 3 over a list showing 4,
    // with neither screen able to say which is lying. `isSetupFinding` is the
    // one spelling, and this is where the host's count is held to it.
    const listed = (await j("/api/repos")).targets.find((t) => t.repoName === "setupdemo");
    const findings = r0.checks.filter(isSetupFinding);
    check(r0.checks.length > 0 && findings.length > 0,
      `the fresh repo has findings to count (${findings.length} of ${r0.checks.length} checks)`);
    check(listed?.setup?.issues === findings.length,
      `the repo row's badge counts exactly the isSetupFinding rows (badge ${JSON.stringify(listed?.setup?.issues)}, predicate ${findings.length})`);
    // A HOST-scope row would be the reason the two numbers could differ; none
    // exists since the Gemini-key row was retired, so none may count either.
    check(!findings.some((c) => c.scope === "host"), "…and no host-scope row is ever counted");

    // The setup checklist and the repo-health series are two different lists.
    // A metric series is named `family.metric` and is measured per commit; a
    // checklist row is a named piece of wiring with a fix. One leaking into
    // the other would put a rising p95 in a badge that means "this repo is not
    // set up", which is a sentence nobody can act on.
    check(r0.checks.every((c) => !/^[a-z]+\.[a-z]/i.test(c.id)),
      `no compliance check carries a series id (ids: ${r0.checks.map((c) => c.id).join(", ")})`);

    // ── The requirements list is an OFFER, not a finding ────────────────
    // Not set up is no row at all: the offer is the Opt-ins card, and a warn
    // here would sit on every repo on the machine with nobody able to close it.
    // The fix stays registered for that opt-in. Once set up (and never built)
    // it IS a finding, and its detail quotes the command the phone hands to the
    // repo's agent — the host never runs it.
    check(!find(r0, "requirements"), "requirements: not set up → no checklist row (the offer is the Opt-ins card)");
    check(!findings.some((c) => c.id === "requirements"), "requirements: the offer is not counted in the badge");
    const fxr = await post(`/api/repos/${id}/compliance/fix`, { fixes: ["requirements"] });
    const skillP = join(repo.path, ".claude/skills/requirements/SKILL.md");
    check(fxr.ok && fxr.applied.includes("requirements") && existsSync(skillP) &&
      existsSync(join(repo.path, "docs/requirements/README.md")), "requirements fix writes the preset and the index");
    check(/^generated-by:\s*\S/m.test(readFileSync(skillP, "utf8")), "the preset declares it is machine-written");
    const rq1 = find(fxr.report, "requirements");
    check(rq1?.status === "warn" && rq1?.fix === null && /never built/.test(rq1.detail) && /update\.mjs \./.test(rq1.detail),
      `requirements: set up, never built → warn quoting the build command (${rq1?.detail})`);
    const fxr2 = await post(`/api/repos/${id}/compliance/fix`, { fixes: ["requirements"] });
    check(fxr2.ok && !fxr2.applied.includes("requirements"), "requirements fix is idempotent — never rewrites the preset");
    // Back to not set up, so the counts below are about the rows they were written for.
    rmSync(join(repo.path, ".claude/skills/requirements"), { recursive: true, force: true });
    rmSync(join(repo.path, "docs"), { recursive: true, force: true });

    // ── Apply the auto-fixable fix (gitignore) ──────────────────────────
    const fx = await post(`/api/repos/${id}/compliance/fix`, { fixes: ["gitignore"] });
    check(fx.ok && fx.applied.includes("gitignore"), "gitignore fix applied");

    // ── claude-md fix without a CLAUDE.md is a no-op (won't scaffold a stub) ─
    const fxNo = await post(`/api/repos/${id}/compliance/fix`, { fixes: ["claude-md"] });
    check(fxNo.ok && !fxNo.applied.includes("claude-md"), "claude-md fix is a no-op when no CLAUDE.md");
    check(!existsSync(join(repo.path, "CLAUDE.md")), "no stub CLAUDE.md was scaffolded");

    const gi = readFileSync(join(repo.path, ".gitignore"), "utf8");
    check([".claude/inbox", ".claude/outbox", ".outbox"].every((e) => gi.includes(e)), ".gitignore lists transport dirs");
    check(!existsSync(join(repo.path, ".claude/setup-gemini.sh")), "no gemini setup script is written any more");

    // ── Simulate `/init`: a real CLAUDE.md now exists but lacks the outbox note ─
    writeFileSync(join(repo.path, "CLAUDE.md"), "# setupdemo\n\nProject instructions.\n");
    const r1 = await j(`/api/repos/${id}/compliance`);
    check(find(r1, "claude-md").status === "pass", "CLAUDE.md present → pass");
    const ob = find(r1, "claude-md-outbox");
    check(ob.status === "warn" && ob.fix === "claude-md", "outbox not mentioned → warn, offers claude-md fix");
    const cw1 = find(r1, "context-weight");
    check(cw1 && cw1.status === "pass", "a small CLAUDE.md weighs in as a pass");
    check(cw1 && cw1.fix === null, "a passing context-weight row still offers no fix");

    // ── claude-md fix now GRAFTS the outbox section onto the real file ───
    const fxc = await post(`/api/repos/${id}/compliance/fix`, { fixes: ["claude-md"] });
    check(fxc.ok && fxc.applied.includes("claude-md"), "claude-md fix grafts onto existing CLAUDE.md");
    const cm = readFileSync(join(repo.path, "CLAUDE.md"), "utf8");
    check(/outbox/i.test(cm) && cm.includes(CONVENTIONS) && cm.includes("Project instructions."),
      "outbox section appended, original content kept");
    check(find(fxc.report, "claude-md-outbox").status === "pass", "post-fix: outbox-mention passes");
    check(find(fxc.report, "gitignore-transport").status === "pass", "post-fix: transport gitignored passes");

    // ── auto-compact: the write keeps every other key and the row passes ─
    mkdirSync(join(repo.path, ".claude"), { recursive: true });
    writeFileSync(join(repo.path, ".claude/settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, autoCompactWindow: "1M" }, null, 2) + "\n");
    const rep0 = await j(`/api/repos/${id}/compliance`);
    const ac0 = find(rep0, "auto-compact");
    check(ac0 && ac0.status === "warn" && /1M/.test(ac0.detail) && /settings\.json/.test(ac0.detail),
      `auto-compact: 1M in the repo's settings → warn naming value and source (${ac0?.detail})`);
    check(ac0 && ac0.fix === "auto-compact",
      "auto-compact offers the write where the repo file would win");
    // ── the confirm gate: the consent fixes are the phone's, checked on the host ─
    const tok = rep0.confirm?.["auto-compact"];
    check(typeof tok === "string" && tok.length >= 16, "the report carries a confirm token for the gated fix");
    const noOrigin = await fetch(base + `/api/repos/${id}/compliance/fix`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fixes: ["auto-compact"], confirm: tok }) });
    check(noOrigin.status === 403, `an Origin-less consent fix is refused (${noOrigin.status})`);
    const noTok = await postB(`/api/repos/${id}/compliance/fix`, { fixes: ["auto-compact"] });
    check(noTok.status === 403 && noTok.ok === false, "a consent fix with no token is refused");
    const wrongFix = await postB(`/api/repos/${id}/compliance/fix`, { fixes: ["signing-key"], confirm: tok });
    check(wrongFix.status === 403 && /something else/.test(wrongFix.error ?? ""), "a token for another fix is refused");
    const inList = await postB(`/api/repos/${id}/compliance/fix`, { fixes: ["gitignore", "auto-compact"], confirm: tok });
    check(inList.status === 400 && /never part of a list/.test(inList.error ?? ""), "a gated fix inside a Fix-all list is refused");
    check(!existsSync(join(repo.path, ".claude/settings.json")) || !/400k/.test(readFileSync(join(repo.path, ".claude/settings.json"), "utf8")),
      "nothing refused wrote anything");
    const fxa = await postB(`/api/repos/${id}/compliance/fix`, { fixes: ["auto-compact"], confirm: tok });
    const replay = await postB(`/api/repos/${id}/compliance/fix`, { fixes: ["auto-compact"], confirm: tok });
    check(replay.status === 403 && /already used|expired/.test(replay.error ?? ""), "a used token does not work twice");
    const sj = JSON.parse(readFileSync(join(repo.path, ".claude/settings.json"), "utf8"));
    check(fxa.ok && fxa.applied.includes("auto-compact") && sj.autoCompactWindow === "400k" &&
      sj.permissions?.allow?.[0] === "Bash(ls)", "auto-compact fix writes 400k and keeps the other keys");
    rmSync(join(repo.path, ".claude/settings.json"), { force: true });

    // ── auto-compact is a thing to CONSIDER: never counted, ignorable ────
    const acU = find(await j(`/api/repos/${id}/compliance`), "auto-compact");
    check(acU?.status === "warn" && acU.advisory === true && !isSetupFinding(acU),
      "auto-compact unset → advisory warn, not a finding");
    const ign = await post(`/api/repos/${id}/compliance/ignore`, { id: "auto-compact", ignore: true });
    check(ign.ok && find(ign.report, "auto-compact").ignored === true, "ignore stores and the re-run report says so");
    const badIgn = await post(`/api/repos/${id}/compliance/ignore`, { id: "gitignore-transport", ignore: true });
    check(badIgn.ok === false && /not a check that can be ignored/.test(badIgn.error ?? ""),
      "a finding (not advisory) cannot be ignored");
    const unIgn = await post(`/api/repos/${id}/compliance/ignore`, { id: "auto-compact", ignore: false });
    check(unIgn.ok && !find(unIgn.report, "auto-compact").ignored, "stop ignoring brings it back");

    // ── the window the fix writes is a host setting ───────────────────────
    const badPref = await post("/api/host/setupprefs", { autoCompactDefault: "5k" });
    check(badPref.ok === false && /outside/.test(badPref.error ?? ""), "an out-of-range window is refused in words");
    const pref = await post("/api/host/setupprefs", { autoCompactDefault: "700k" });
    check(pref.ok && pref.autoCompactDefault === "700k" && pref.chosen === true, "the chosen window is stored");
    const rP = await j(`/api/repos/${id}/compliance`);
    check(rP.autoCompactDefault === "700k", "the report carries the chosen window");
    writeFileSync(join(repo.path, ".claude/settings.json"), JSON.stringify({ autoCompactWindow: "600k" }) + "\n");
    check(find(await j(`/api/repos/${id}/compliance`), "auto-compact").status === "pass",
      "a window at or under the chosen one passes, even past the shipped 500k line");
    rmSync(join(repo.path, ".claude/settings.json"), { force: true });
    const rP2 = await j(`/api/repos/${id}/compliance`);
    await postB(`/api/repos/${id}/compliance/fix`, { fixes: ["auto-compact"], confirm: rP2.confirm?.["auto-compact"] });
    check(JSON.parse(readFileSync(join(repo.path, ".claude/settings.json"), "utf8")).autoCompactWindow === "700k",
      "the fix writes the chosen window");
    rmSync(join(repo.path, ".claude/settings.json"), { force: true });
    const back = await post("/api/host/setupprefs", { autoCompactDefault: null });
    check(back.ok && back.autoCompactDefault === "400k" && back.chosen === false, "null goes back to the default");

    // ── A tracked .env.example is a template, not a leak ────────────────
    // Templates are named by their LAST segment, so per-environment ones
    // (`.env.production.example`) count too — flagging those produced a warn
    // with no way to close it: the file is meant to be committed and holds
    // placeholders, so every offered remedy was the wrong thing to do.
    writeFileSync(join(repo.path, ".env.example"), "API_TOKEN=changeme\n");
    writeFileSync(join(repo.path, ".env.production.example"), "API_TOKEN=changeme\n");
    execFileSync("git", ["add", ".env.example", ".env.production.example"], { cwd: repo.path });
    execFileSync("git", ["commit", "-m", "example", "--no-gpg-sign"], { cwd: repo.path });
    const r2 = await j(`/api/repos/${id}/compliance`);
    check(find(r2, "env-gitignored").status === "pass", "tracked .env.example / .env.production.example not flagged as a secret leak");

    // …but a real tracked dotenv still is, and it carries NO `fix`: untracking
    // is `git rm --cached` plus a judgement about what is in the file, which is
    // the whole reason the sheet has a second, agent-facing answer.
    writeFileSync(join(repo.path, ".env.nas"), "API_TOKEN=hunter2\n");
    execFileSync("git", ["add", "-f", ".env.nas"], { cwd: repo.path });
    execFileSync("git", ["commit", "-m", "oops", "--no-gpg-sign"], { cwd: repo.path });
    const r2b = await j(`/api/repos/${id}/compliance`);
    const env2 = find(r2b, "env-gitignored");
    check(env2.status === "warn" && /\.env\.nas/.test(env2.detail), "a tracked, un-ignored .env IS flagged, by name");
    check(env2.fix === null, "the secret-leak row offers no auto-fix — untracking is a judgement");
    execFileSync("git", ["rm", "--cached", "-q", ".env.nas"], { cwd: repo.path });
    execFileSync("git", ["commit", "-m", "untrack", "--no-gpg-sign"], { cwd: repo.path });

    // ── Idempotent: re-running applies nothing ──────────────────────────
    const fx2 = await post(`/api/repos/${id}/compliance/fix`, { fixes: ["gitignore", "claude-md"] });
    check(fx2.ok && fx2.applied.length === 0, "second fix run is a no-op (idempotent)");

    // ── Unknown repo 404 ────────────────────────────────────────────────
    const miss = await fetch(`${base}/api/repos/deadbeef/compliance`);
    check(miss.status === 404, "unknown repo → 404");

    // ── What this repo costs to have open ───────────────────────────────
    // The rule is `@waterplane/shared`'s `contextweight.ts` and is unit-tested there;
    // what is pinned here is that the CHECK wires it up and that the row reaches
    // a client. Last, because it rewrites CLAUDE.md out from under the
    // idempotency run above.
    //
    // **`fix: null` is the load-bearing half.** There is no correct size, and
    // which half of a CLAUDE.md is reference is a judgement only its author can
    // make — a `fix` id here would turn that into an auto-patch that deletes the
    // very text it cannot read, offered as a one-tap button beside the others.
    // The remedy is the prompt the detail names, and it stays the only affordance.
    const big = "# setupdemo\n\n" + "Rule: never do the thing. ".repeat(2_400); // ~60k chars
    writeFileSync(join(repo.path, "CLAUDE.md"), big);
    const r3 = await j(`/api/repos/${id}/compliance`);
    const cw3 = find(r3, "context-weight");
    check(!!cw3, "an oversized CLAUDE.md produces a context-weight row");
    check(cw3 && cw3.status === "warn", `oversized CLAUDE.md → warn (got ${cw3 && cw3.status})`);
    check(cw3 && cw3.fix === null, "context-weight carries NO fix — the remedy is a judgement call");
    check(cw3 && /\d/.test(cw3.detail), "the row says what it measured");

    // …and however far past the hard limit it goes, it is still only a warn: a
    // big instruction file is a cost, not a broken repo, and a `fail` here would
    // make `RepoSetupState.ok` — the badge's STYLE — red for a judgement call.
    writeFileSync(join(repo.path, "CLAUDE.md"), big.repeat(6)); // ~360k chars, 9× the hard limit
    const r4 = await j(`/api/repos/${id}/compliance`);
    const cw4 = find(r4, "context-weight");
    check(cw4 && cw4.status === "warn", "still a warn nine times past the hard limit — never a fail");
    check(cw4 && cw4.fix === null, "and still no fix");
    check(r4.checks.filter((c) => c.status === "fail").length === 0,
      "an enormous CLAUDE.md does not make the repo report as failing");

    // ── The line, per repo ──────────────────────────────────────────────
    // The row quotes a threshold, so the threshold has to be arguable. It used
    // to be three env vars: host-wide, invisible from the phone, needing a
    // restart — so a repo whose instructions are genuinely load-bearing sat
    // amber for ever, and an amber that cannot be answered is one that gets
    // ignored. What is pinned here is that the override reaches the CHECK
    // (not just the store), outranks env, and can be given back.
    check(r4.contextLimits && r4.contextLimits.effective.maxChars === 16_000,
      "the report carries the thresholds it measured against");
    check(r4.contextLimits && r4.contextLimits.source.maxChars === "env",
      "…and says they came from this host's env");
    check(r4.contextLimits && r4.contextLimits.repo === null, "…with no repo override on file yet");

    // A CLAUDE.md nine times past the hard limit, declared fine HERE.
    const setBig = await post(`/api/repos/${id}/compliance/limits`, { maxChars: 500_000, hardChars: 900_000 });
    check(setBig.ok, "a per-repo threshold is accepted");
    const cw5 = find(setBig.report, "context-weight");
    check(cw5 && cw5.status === "pass", `the same repo now passes on its own line (got ${cw5 && cw5.status})`);
    check(setBig.report.contextLimits.source.maxChars === "repo", "the repo layer outranks env");
    // The count knob was never set, so it must still be falling through to env
    // — storing all three would freeze the ones nobody touched.
    check(setBig.report.contextLimits.source.maxSkills === "env",
      "a field the repo did not set still inherits");

    // The sentence must credit the right decision-maker. It said "you asked to
    // be warned at" about a shipped default on every desktop that had never
    // exported a knob, which is the bug this whole path is here for.
    writeFileSync(join(repo.path, "CLAUDE.md"), big.repeat(20)); // past even the repo's own line
    const r6 = await j(`/api/repos/${id}/compliance`);
    const cw6 = find(r6, "context-weight");
    check(cw6 && /you set for this repo/.test(cw6.detail),
      "over a repo's OWN line, the sentence says so");

    // Refused, not repaired: a stored fixed-up number would be quoted back at
    // the user in a sentence claiming they chose it.
    const bad = await post(`/api/repos/${id}/compliance/limits`, { maxChars: 0 });
    check(!bad.ok && /maxChars/.test(bad.error || ""), "an out-of-range threshold is refused, in words");
    const r7 = await j(`/api/repos/${id}/compliance`);
    check(r7.contextLimits.effective.maxChars === 500_000, "…and the refused write changed nothing");

    // Back to the host's line has to be one tap, or the first edit is a trap.
    const undone = await post(`/api/repos/${id}/compliance/limits`, { reset: true });
    check(undone.ok && undone.report.contextLimits.repo === null, "reset clears the override");
    check(undone.report.contextLimits.effective.maxChars === 16_000, "…and the host's line is back");
    check(find(undone.report, "context-weight").status === "warn", "…so the row warns again");
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  host.kill();
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
});

setTimeout(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); }, 15000);
