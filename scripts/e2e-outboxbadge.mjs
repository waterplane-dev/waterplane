// The repo "things to look at" badge. Two rules it exists to keep:
//   1. it counts the OUTBOX (what an agent left for you), never the inbox (what
//      this phone uploaded — the phone already knows about those);
//   2. the number is unread-since-you-last-looked, cleared by opening the
//      outbox, and it counts exactly the files the outbox tab would list.
// The bug that motivated it: a badge saying 42 that opened on an empty grid.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8807;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-outboxbadge-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
const j = (p, opts) => fetch(base + p, opts).then((r) => r.json());
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

const countOf = async (id) => (await j("/api/repos")).targets.find((t) => t.id === id).outboxCount;

bootWait(PORT, 1500, async () => {
  try {
    const repo = await j("/api/repo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "drops" }) });
    const id = (await j("/api/repos")).targets[0].id;
    const out = join(repo.path, ".claude", "outbox");
    mkdirSync(out, { recursive: true });

    check(await countOf(id) === 0, "empty outbox → no badge");

    writeFileSync(join(out, "report.md"), "# hi\n");
    writeFileSync(join(out, "shot.png"), Buffer.alloc(64, 1));
    check(await countOf(id) === 2, "two drops, never opened → 2");

    // An inbox upload must not move the badge — that is the phone's own file.
    await fetch(`${base}/api/repos/${id}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "phone.jpg" },
      body: Buffer.alloc(32, 2),
    });
    check((await j(`/api/repos/${id}/inbox`)).files.length === 1, "the inbox upload landed");
    check(await countOf(id) === 2, "an inbox upload does NOT raise the outbox badge");

    // Whatever the badge counts, the outbox tab must list — the whole point.
    const listed = await j(`/api/repos/${id}/artifacts?scope=outbox`);
    check(listed.files.length === 2, "the outbox listing shows exactly what was counted");

    // Opening the outbox clears it. GET must not — only the POST marks read.
    await j(`/api/repos/${id}/artifacts?scope=outbox`);
    check(await countOf(id) === 2, "listing the outbox (GET) does not clear the badge");
    const seen = await fetch(`${base}/api/repos/${id}/artifacts/seen`, { method: "POST" });
    check(seen.status === 200 && await countOf(id) === 0, "opening the outbox clears the badge");

    // The marker itself is not an artifact, and a later drop counts again.
    const after = await j(`/api/repos/${id}/artifacts?scope=outbox`);
    check(after.files.length === 2, "the .seen marker is not listed as an artifact");
    await new Promise((r) => setTimeout(r, 1100)); // mtime granularity
    writeFileSync(join(out, "later.txt"), "new\n");
    check(await countOf(id) === 1, "a drop after the last look counts again");

    // The second outbox location is counted too.
    const alt = join(repo.path, ".outbox");
    mkdirSync(alt, { recursive: true });
    writeFileSync(join(alt, "alt.md"), "alt\n");
    check(await countOf(id) === 2, ".outbox is counted alongside .claude/outbox");
  } catch (e) {
    check(false, `threw: ${e?.message || e}`);
  }
  done();
});
