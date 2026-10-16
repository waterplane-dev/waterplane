#!/usr/bin/env node
// Is <pkg>@<version> on npm, and is it the package it should be? Read-only: `npm view` (and, with
// --repo, `gh run list`) — it never publishes, tags or uploads anything.
//
//   node scripts/release/npm-verify.mjs <pkg> <version> [--wait <seconds>] [--check] [--repo <org/slug>]
//
//   --wait <s>    poll until the version appears, up to <s> seconds (default 0: ask once)
//   --check       once it is there: `_hasShrinkwrap` must be true AND a SLSA provenance
//                 attestation must be on it (`dist.attestations`); both re-read for up to 2 minutes,
//                 since the registry's metadata can lag the publish
//   --repo <r>    while waiting, also read the newest npm-publish run for tag v<version> on
//                 github.com/<r> (gh run list) and print it; a run that finished without success
//                 stops the wait at once, with its URL
//
// Exit: 0 = there (and, with --check, both checks pass) · 3 = not on npm after the wait ·
// 1 = a check failed, the workflow run failed, or npm could not be asked.
// Callers: `release:publish`'s npm-wait step (publish-lib.mjs planSteps) and the public repo's
// .github/workflows/npm-publish.yml. Pure parts: publish-lib.mjs. Why: docs/notes/distribution.md.
import { spawnSync } from "node:child_process";
import { NPM_WORKFLOW, npmWaitDecision, readHasShrinkwrap, readNpmHasVersion, readProvenance, readWorkflowRun, tagOf } from "./publish-lib.mjs";

const argv = process.argv.slice(2);
const pos = [];
const opts = { wait: 0, check: false, repo: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--wait") opts.wait = Number(argv[++i]);
  else if (a === "--check") opts.check = true;
  else if (a === "--repo") opts.repo = argv[++i];
  else if (a.startsWith("--")) die(`unknown argument ${a}`, 2);
  else pos.push(a);
}
const [PKG, VERSION] = pos;
if (!PKG || !VERSION || pos.length > 2 || !Number.isFinite(opts.wait) || opts.wait < 0 || (argv.includes("--repo") && !opts.repo)) {
  die("usage: npm-verify.mjs <pkg> <version> [--wait <seconds>] [--check] [--repo <org/slug>]", 2);
}
const SPEC = `${PKG}@${VERSION}`;
const TAG = tagOf(VERSION);
const POLL_MS = 20_000;

function die(msg, code = 1) { console.error(`npm-verify: ${msg}`); process.exit(code); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 24 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() + (r.error ? String(r.error.message) : "") };
}

/** true = on npm, false = not (E404, or the package exists without this version), null = could not tell. */
function onNpm() {
  const r = run("npm", ["view", SPEC, "version"]);
  if (r.ok) return readNpmHasVersion(r.out, VERSION);
  return /E404|404/.test(r.err) ? false : null;
}

const started = Date.now();
const mmss = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
const elapsed = () => mmss(Math.round((Date.now() - started) / 1000));
let there = onNpm();
let streak = 0;
while (true) {
  const d = npmWaitDecision({ answer: there, streak, expired: Date.now() - started >= opts.wait * 1000, wait: opts.wait, elapsed: elapsed(), spec: SPEC });
  streak = d.streak;
  if (d.stop?.code === 0) break;
  if (d.stop?.code === 1) die(d.stop.text);
  if (d.stop) { console.log(`npm-verify: ${d.stop.text}`); process.exit(d.stop.code); }
  let line = `npm-verify: ${SPEC} not on npm yet (${elapsed()} of ${mmss(opts.wait)})`;
  if (opts.repo) {
    const r = run("gh", ["run", "list", "--repo", opts.repo, "--workflow", NPM_WORKFLOW, "--limit", "10", "--json", "headBranch,status,conclusion,url"]);
    const wf = r.ok ? readWorkflowRun(r.out, TAG) : null;
    if (!wf) line += ` — no ${NPM_WORKFLOW} run for ${TAG} on github.com/${opts.repo} yet`;
    else if (wf.status !== "completed") line += ` — ${NPM_WORKFLOW} for ${TAG}: ${wf.status} ${wf.url}`;
    else if (wf.conclusion !== "success") {
      die(`the ${NPM_WORKFLOW} run for ${TAG} finished "${wf.conclusion}" — check \`npm view ${SPEC}\` before re-running (a re-run skips a version already on npm): ${wf.url}\n` +
        `  A run can fail AFTER publishing (a registry lag past its own wait); it did not necessarily fail to publish.\n` +
        `  If the version is not on npm, read the run's log, fix the cause, then run it again ON the tag (provenance records the commit a run starts on):\n` +
        `    gh workflow run ${NPM_WORKFLOW} --repo ${opts.repo} --ref ${TAG} -f tag=${TAG}\n` +
        `  and re-run release:publish to wait for it (done steps are skipped).`);
    } else line += ` — ${NPM_WORKFLOW} for ${TAG} succeeded, waiting for the registry: ${wf.url}`;
  }
  console.log(line);
  await sleep(POLL_MS);
  there = onNpm();
}
console.log(`npm-verify: ${SPEC} is on npm (${elapsed()}).`);
if (!opts.check) process.exit(0);

// The registry can serve the version before its metadata settles: re-read each field a few times
// before calling it missing.
async function settle(read) {
  let v = read();
  for (let i = 0; i < 6 && v !== true; i++) { await sleep(POLL_MS); v = read(); }
  return v;
}
const sw = await settle(() => readHasShrinkwrap(run("npm", ["view", SPEC, "_hasShrinkwrap"]).out));
const prov = await settle(() => readProvenance(run("npm", ["view", SPEC, "dist.attestations", "--json"]).out));
let failed = 0;
if (sw === true) console.log(`  ok   ${SPEC} carries npm-shrinkwrap.json`);
else { failed++; console.log(`  FAIL ${SPEC}: _hasShrinkwrap is ${sw === null ? "unreadable" : "not true"} — \`npm i -g\` would re-resolve every transitive dependency`); }
if (prov === true) console.log(`  ok   ${SPEC} has a SLSA provenance attestation (npm view ${SPEC} dist.attestations)`);
else { failed++; console.log(`  FAIL ${SPEC}: ${prov === null ? "dist.attestations is unreadable" : "no provenance attestation"} — it was not published by the npm-publish workflow with --provenance`); }
process.exit(failed ? 1 : 0);
