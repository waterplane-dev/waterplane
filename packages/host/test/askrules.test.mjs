/**
 * Ask rules (docs/plans/agent-authority.md §2), host half.
 *
 *  1. The argv: no rules ⇒ the `--settings` blob is byte-identical to before; rules ⇒
 *     `permissions.ask` beside `hooks`; the custom-endpoint `withSettings` merge keeps them.
 *  2. The store: realpath-keyed "off here" (both sides, the phone's spelling kept), corrupt file ⇒
 *     empty, a failed write changes nothing.
 *  3. The box the CLI draws when a rule matches (captured 2026-10-15, CLI 2.1.301) is read as a
 *     `tool` box with the command on it, and the answer gate never lets anything but a person
 *     answer it.
 */
import "../../../scripts/lib-tmuxiso.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, SUGGESTED_ASK_RULES, envName, promptFingerprint } from "@waterplane/shared";

process.env[envName("CONFIG_DIR")] = mkdtempSync(join(tmpdir(), `${BRAND.slug}-askcfg-`));
const { claudeBackend, hookSettingsArg } = await import("../dist/backends/claude.js");
const { withSettings } = await import("../dist/backends/claude-endpoint.js");
const { AskRulesStore, setAskRulesStore, askRulesForCwd } = await import("../dist/askrules.js");
const { detectPrompt } = await import("../dist/prompt.js");
const { hostStateDir } = await import("../dist/branddirs.js");
const { isBlocked, gateRefusal } = await import("../dist/answergate.js");

const PORT = 8770;
const plan = (req) => claudeBackend.launchArgs({ launch: {}, hookPort: PORT, ...req });
const settingsOf = (args) => JSON.parse(args[args.indexOf("--settings") + 1]);

// The blob every claude launch carried BEFORE ask rules existed, written out by hand so a
// change to `hookSettingsArg` itself cannot move both sides of the comparison at once.
const HOOK_CMD = "curl -sS -m 2 -X POST http://127.0.0.1:8770/api/hook -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true";
const HOOK_ENTRY = `[{"hooks":[{"type":"command","command":"${HOOK_CMD}","timeout":5}]}]`;
const LEGACY_BLOB = `{"hooks":{"SessionStart":${HOOK_ENTRY},"UserPromptSubmit":${HOOK_ENTRY},"Stop":${HOOK_ENTRY},"Notification":${HOOK_ENTRY},"SessionEnd":${HOOK_ENTRY}}}`;

test("no rules ⇒ the argv and settings blob are exactly what they were before ask rules", () => {
  for (const askRules of [undefined, []]) {
    const { args, sessionId } = plan({ askRules });
    assert.deepEqual(args.slice(0, 4), ["--session-id", sessionId, "--settings", LEGACY_BLOB]);
    assert.equal(args[4], "--plugin-dir");
    assert.equal(args.length, 6, "nothing else was added to the argv");
  }
  assert.equal(hookSettingsArg(PORT), LEGACY_BLOB);
});

test("rules ⇒ permissions.ask beside the hooks", () => {
  const { args } = plan({ askRules: ["Bash(git push * main)", "Bash(npm publish*)"] });
  const s = settingsOf(args);
  assert.deepEqual(s.permissions, { ask: ["Bash(git push * main)", "Bash(npm publish*)"] });
  assert.ok(s.hooks.Stop && s.hooks.SessionStart, "the hooks stay");
  assert.equal(args.filter((a) => a === "--settings").length, 1, "one settings blob, never two");
});

test("the custom endpoint's settings merge keeps the ask rules", () => {
  const { args } = plan({ askRules: ["Bash(fly deploy*)"] });
  const merged = withSettings(args, { apiKeyHelper: "printf x" });
  const s = settingsOf(merged);
  assert.deepEqual(s.permissions, { ask: ["Bash(fly deploy*)"] });
  assert.equal(s.apiKeyHelper, "printf x");
  assert.ok(s.hooks.Stop);
});

test("the store cuts by realpath, and a repo with the rule off is given none of it", () => {
  const root = mkdtempSync(join(tmpdir(), `${BRAND.slug}-askroot-`));
  const repo = join(root, "repo"); mkdirSync(repo);
  const link = join(root, "link"); symlinkSync(repo, link);
  const store = new AskRulesStore(root);
  try {
    store.set({ rules: [
      { id: "main", rule: "Bash(git push * main)", offIn: [realpathSync(repo)] },
      { id: "pub", rule: "Bash(npm publish*)" },
      { id: "junk", rule: "rm -rf /" },
    ] });
    assert.equal(store.get().rules.length, 2, "the invalid row is dropped");
    setAskRulesStore(store);
    assert.deepEqual(askRulesForCwd(link), ["Bash(npm publish*)"], "reached through a symlink, still the same repo");
    assert.deepEqual(askRulesForCwd(root), ["Bash(git push * main)", "Bash(npm publish*)"]);
    assert.deepEqual(new AskRulesStore(root).get(), store.get(), "a second store reads the same file back");
  } finally {
    setAskRulesStore(null);
  }
  assert.deepEqual(askRulesForCwd(root), [], "no store ⇒ no rules");
});

test("an offIn sent through a symlink (or with a trailing slash) still switches the rule off", () => {
  const root = mkdtempSync(join(tmpdir(), `${BRAND.slug}-askroot-`));
  const repo = join(root, "repo"); mkdirSync(repo);
  const link = join(root, "link"); symlinkSync(repo, link);
  const store = new AskRulesStore(root);
  try {
    // The phone's `worktreePath` for a linked worktree is git's spelling, not always the realpath.
    store.set({ rules: [{ id: "m", rule: "Bash(git push * main)", offIn: [`${link}/`, repo, join(root, "gone")] }] });
    assert.deepEqual(store.get().rules[0].offIn, [link, join(root, "gone")],
      "slash trimmed, the repo's second spelling deduped, the phone's first spelling and a missing path kept as sent");
    setAskRulesStore(store);
    assert.deepEqual(askRulesForCwd(repo), [], "a launch at the real path is off");
    assert.deepEqual(askRulesForCwd(link), [], "and through the symlink");
    assert.deepEqual(askRulesForCwd(root), ["Bash(git push * main)"], "elsewhere it still asks");
  } finally {
    setAskRulesStore(null);
  }
});

test("a corrupt file reads as no rules; a failed write changes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), `${BRAND.slug}-askroot-`));
  const first = new AskRulesStore(root);
  first.set({ rules: [{ id: "a", rule: "Bash(fly deploy*)" }] });
  const dir = hostStateDir(root);
  const file = join(dir, "askrules.json");
  writeFileSync(file, "{not json");
  const broken = new AskRulesStore(root);
  assert.deepEqual(broken.get(), { rules: [] });
  const lost = broken.lost();
  assert.ok(lost, "a list that could not be read is reported lost, never a silent empty list");
  assert.match(lost.movedTo ?? "", /askrules\.json\.corrupt-/, "the bytes are kept aside");
  broken.set({ rules: [{ id: "b", rule: "Bash(npm publish*)" }] });
  assert.equal(broken.lost(), null, "a save that lands clears it");
  writeFileSync(file, JSON.stringify(first.get()));
  const s = new AskRulesStore(root);
  assert.equal(s.lost(), null, "a readable file is not lost");
  assert.equal(s.get().rules.length, 1);
  if (process.getuid?.() === 0) return; // root writes through a read-only dir
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => s.set({ rules: [] }));
    assert.equal(s.get().rules.length, 1, "memory unchanged after a failed write");
  } finally { chmodSync(dir, 0o700); }
});

// Captured off the interactive TUI, 2026-10-15, CLI 2.1.301, with
// `--settings '{"permissions":{"ask":["Bash(echo wpauth * main)"]}}'`.
const ASK_RULE_BOX = [
  " Bash command",
  " Echo the wpauth origin main string",
  "╌╌╌╌╌╌╌╌╌╌",
  " echo wpauth origin main",
  "╌╌╌╌╌╌╌╌╌╌",
  " Permission rule Bash(echo wpauth * main) requires confirmation for this command.",
  " /permissions to update rules",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  " Esc to cancel · Tab to amend",
].join("\n");

test("the ask-rule box is a tool box with the command on it, both stages", () => {
  for (const lenient of [true, false]) {
    const p = detectPrompt(ASK_RULE_BOX, { lenient });
    assert.ok(p, `detected (lenient=${lenient})`);
    assert.equal(p.kind, "tool");
    assert.match(p.question, /echo wpauth origin main/, "the concrete command is on the box");
    assert.deepEqual(p.options.map((o) => [o.index, o.label]), [[1, "Yes"], [2, "No"]]);
  }
});

test("the ask-rule box is person-only: blocked, and the gate refuses a plugin's answer", () => {
  const p = detectPrompt(ASK_RULE_BOX);
  assert.equal(isBlocked(p), true);
  const why = gateRefusal({
    pluginName: "helper", answers: true, sessionLive: true, switchOn: true,
    prompt: p, told: promptFingerprint(p), choice: 1,
  });
  assert.equal(why, "a tool box is always a person's call");
});

// ── The REST shape: GET reads + mints a confirm; PUT needs a browser Origin AND that confirm ──
const { HOST_ROUTES } = await import("../dist/routes/apihost.js");
const { configureOrigins } = await import("../dist/origin.js");
const { createServer } = await import("node:http");
const { ASK_RULES_STALE } = await import("@waterplane/shared");

test("GET/PUT /api/askrules: Origin, then a one-shot confirm bound to the current rev", async (t) => {
  configureOrigins({ port: 8771 });
  const root = mkdtempSync(join(tmpdir(), `${BRAND.slug}-askroot-`));
  const store = new AskRulesStore(root);
  store.set({ rules: [{ id: "pub", rule: "Bash(npm publish*)" }] });
  setAskRulesStore(store);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const entry = HOST_ROUTES.find((e) => e.kind === "route" && e.pattern === url.pathname && e.method === req.method);
    if (!entry) { res.statusCode = 404; res.end(); return; }
    await entry.handler({ req, res, url, path: url.pathname, method: req.method, params: {}, rest: [] }, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); setAskRulesStore(null); });
  const base = `http://127.0.0.1:${server.address().port}/api/askrules`;
  const put = (body, headers = {}) => fetch(base, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const browser = { origin: "http://127.0.0.1:8771" };
  const one = [{ id: "pub", rule: "Bash(npm publish*)" }];

  const got = await (await fetch(base)).json();
  assert.equal(got.ok, true);
  assert.deepEqual(got.doc, { rules: one });
  assert.equal(got.suggested.length, SUGGESTED_ASK_RULES.length);
  assert.ok(got.honouredBy.includes("claude"));
  assert.match(got.rev, /^[0-9a-f]{12}$/);
  assert.equal(typeof got.confirm, "string");

  // fetch() from node sends no Origin unless told to — exactly an agent's curl.
  const anon = await put({ rules: [], rev: got.rev, confirm: got.confirm });
  assert.equal(anon.status, 403);
  assert.equal((await anon.json()).error, "this needs the phone's confirm: a request with no Origin cannot give consent — the ask rules were not changed");
  const evil = await put({ rules: [], rev: got.rev, confirm: got.confirm }, { origin: "https://evil.example" });
  assert.equal(evil.status, 403);

  // A forged Origin alone is no longer enough: no token ⇒ refused.
  const forged = await put({ rules: [], rev: got.rev }, browser);
  assert.equal(forged.status, 403);
  assert.match((await forged.json()).error, /^no confirm token .* — the ask rules were not changed$/);
  const norev = await put({ rules: [], confirm: got.confirm }, browser);
  assert.equal(norev.status, 400);
  const bad = await put({ nope: 1 }, browser);
  assert.equal(bad.status, 400);
  assert.deepEqual(store.get().rules, one, "nothing was changed by any refusal");

  // Good: 200, the cleaned list, and a fresh confirm for the next save.
  const ok = await put({ rules: [{ id: "m", rule: "Bash(git push * main)", offIn: ["/r"] }, { id: "x", rule: "not a rule" }], rev: got.rev, confirm: got.confirm }, browser);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body.doc, { rules: [{ id: "m", rule: "Bash(git push * main)", offIn: ["/r"] }] });
  assert.equal(body.dropped, 1);
  assert.deepEqual(store.get(), body.doc);
  assert.notEqual(body.rev, got.rev);
  assert.ok(body.confirm && body.confirm !== got.confirm, "a fresh confirm rides on the reply");

  // Stale: a second phone still holding the first GET is refused in words, nothing written.
  const stale = await put({ rules: [], rev: got.rev, confirm: got.confirm }, browser);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, ASK_RULES_STALE);
  assert.deepEqual(store.get(), body.doc);

  // Reused: the same token after a save that left the rev where it was.
  const same = await put({ rules: body.doc.rules, rev: body.rev, confirm: body.confirm }, browser);
  assert.equal(same.status, 200);
  const sameBody = await same.json();
  assert.equal(sameBody.rev, body.rev, "an unchanged list keeps its rev");
  const reused = await put({ rules: [], rev: body.rev, confirm: body.confirm }, browser);
  assert.equal(reused.status, 403);
  assert.match((await reused.json()).error, /already used/);
  assert.deepEqual(store.get(), body.doc, "the reused token changed nothing");

  // The fresh one works.
  const again = await put({ rules: [], rev: sameBody.rev, confirm: sameBody.confirm }, browser);
  assert.equal(again.status, 200);
  assert.deepEqual(store.get(), { rules: [] });
});
