// The contract suite (demo-mode plan §6): the protocol behaviour the real
// desktop and the demo's fake desktop must share, every check run against
// BOTH. A check that passes on one and fails on the other is the finding —
// the fake is wrong unless the plan names the difference (tier B), and then
// the check says so per target instead of being loosened.
//
//   npm run test:contract                 # both targets, every check
//   node scripts/run-contract.mjs fake    # one target (fake | real)
//   node scripts/run-contract.mjs --only resume   # checks whose name contains this
//
// The real target drives packages/host/dist (`npm run build` first) on its own
// free port with WATERPLANE_PREFLIGHT=0 and a private tmux socket dir (bootHost). The fake runs in
// this process off the TypeScript sources; both need `npm run build:shared`.
// Not part of `npm test` yet — the plan promotes it once it has proved stable.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS } from "./contract/targets.mjs";
import { CHECKS } from "./contract/checks.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args[onlyAt + 1] : null;
const named = args.filter((a, i) => !a.startsWith("--") && (onlyAt < 0 || i !== onlyAt + 1));
const kinds = named.filter((a) => a in TARGETS);
const targets = kinds.length ? kinds : ["fake", "real"];
const checks = CHECKS.filter((c) => !only || c.name.includes(only));
const PER_CHECK_MS = Number(process.env.CONTRACT_CHECK_MS || 120_000);

if (!existsSync(join(root, "packages/shared/dist/index.js"))) {
  console.error("packages/shared/dist is missing — run `npm run build:shared` first.");
  process.exit(1);
}
if (targets.includes("real") && !existsSync(join(root, "packages/host/dist/main.js"))) {
  console.error("packages/host/dist is missing — run `npm run build` first (the real target drives it).");
  process.exit(1);
}

const results = []; // { target, check, ok, error?, notes[] }

for (const kind of targets) {
  console.log(`\n── target: ${kind} ──`);
  let target;
  try {
    target = await TARGETS[kind]();
  } catch (e) {
    console.log(`FAIL [${kind}] could not boot: ${e.message}`);
    for (const c of checks) results.push({ target: kind, check: c.name, ok: false, error: "target did not boot", notes: [] });
    continue;
  }
  for (const c of checks) {
    const notes = [];
    let timer;
    try {
      await Promise.race([
        c.run(target, { note: (s) => notes.push(s) }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${PER_CHECK_MS} ms`)), PER_CHECK_MS); }),
      ]);
      results.push({ target: kind, check: c.name, ok: true, notes });
      console.log(`PASS [${kind}] ${c.name}`);
    } catch (e) {
      results.push({ target: kind, check: c.name, ok: false, error: e.message, notes });
      console.log(`FAIL [${kind}] ${c.name}\n       ${e.message.split("\n").join("\n       ")}`);
    } finally {
      clearTimeout(timer);
    }
    for (const s of notes) console.log(`       note: ${s}`);
  }
  await target.stop().catch(() => {});
}

// Where the two disagree is the interesting line: same check, different verdict.
const split = checks.filter((c) => {
  const v = targets.map((k) => results.find((r) => r.target === k && r.check === c.name)?.ok);
  return v.length > 1 && v.some((x) => x) && v.some((x) => !x);
});
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed across ${targets.join(" + ")}`);
for (const c of split) {
  console.log(`DISAGREE: ${c.name} — ${targets.map((k) => `${k}: ${results.find((r) => r.target === k && r.check === c.name).ok ? "pass" : "fail"}`).join(", ")}`);
}
process.exit(failed.length ? 1 : 0);
