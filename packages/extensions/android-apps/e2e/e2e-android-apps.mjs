// The android-apps extension end to end (docs/notes/android-apps-architecture.md sections 4 and 6, P3a):
//
//   A. a desktop with NO Android repo: the extension is LISTED, off, with the auto sentence, and
//      `plugin.call` into it is refused in words — the default rule keeps it off.
//   B. a desktop whose root holds an Android app (a git repo with a gradle file naming the android plugin)
//      and today's installs.json: the extension switches itself ON, `readiness` answers the repo's facts
//      through api.repoApps(), `log` answers today's file's rows, and a `report` chunk is MERGED and
//      persisted with one `changed` ping (WRITE = true: the extension is the file's one writer), while
//      core's old `install.report` route writes nothing any more.
//
// A real booted host, a fake phone on the one WebSocket (plugin.call / plugin.reply).
import "../../../../scripts/lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootHost } from "../../../../scripts/lib-e2e.mjs";
import { SLUG, STATE, rootEnv } from "../../../../scripts/lib-brand.mjs";
import { watchdog } from "../../../../scripts/lib-watchdog.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dog = watchdog(() => { console.error("FAIL: watchdog — the script hung"); process.exit(2); });
dog.unref();

/** A fake phone: hello, then the latest plugin.list, and plugin.call -> plugin.reply by ackId. */
async function phone(base) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  const st = { plugins: null, replies: new Map(), pushes: [] };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "plugin.list") st.plugins = m.plugins;
    if (m.t === "plugin.reply") st.replies.set(m.ackId, m);
    if (m.t === "plugin.push" && m.plugin === "android-apps") st.pushes.push(m);
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 2 }));
  const until = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); } return false; };
  let n = 0;
  const call = async (method, args) => {
    const ackId = `aa-${++n}`;
    ws.send(JSON.stringify({ t: "plugin.call", plugin: "android-apps", method, args, ackId }));
    await until(() => st.replies.has(ackId), 8000);
    return st.replies.get(ackId);
  };
  const entry = () => st.plugins?.find((p) => p.manifest.id === "android-apps");
  return { st, until, call, entry, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

const T0 = 1_700_000_000_000;
const K1 = '["aa11bb22","l_1",1700000000000]';
const FIXTURE = { entries: [
  { key: K1, deviceId: "aa11bb22", pullId: "l_1", pkg: "de.hoh.tiptoi", outcome: "installed", reportedAt: T0 + 5_000,
    deviceName: "kitchen phone", label: "Tiptoi", version: "0.1.98", code: 98, auto: true, at: T0 },
  { key: '["cc33dd44","l_9",1700000100000]', deviceId: "cc33dd44", pullId: "l_9", pkg: "de.hoh.game", outcome: "failed",
    reportedAt: T0 + 200_000, error: "INSTALL_FAILED_VERSION_DOWNGRADE", at: T0 + 100_000 },
] };

// ── A. no Android repo anywhere under the root ──
{
  const h = await bootHost({ tag: "aa-off" });
  try {
    const p = await phone(h.base);
    await p.until(() => p.entry());
    const e = p.entry();
    check(!!e, "android-apps is in the registry (plugin.list)");
    check(e?.manifest.optional === true && e?.manifest.autoOn === "androidRepo", "its manifest says optional + autoOn androidRepo");
    // the boot probe has run once its answer replaces the "until this desktop's repos are checked" sentence
    check(await p.until(() => /^off automatically/.test(p.entry()?.auto?.why ?? "")), `the boot probe ran (why: ${p.entry()?.auto?.why})`);
    check(p.entry()?.state === "off", `with no Android repo it stays OFF (got ${p.entry()?.state})`);
    check(p.entry()?.auto?.state === "off", `…and says so (auto: ${JSON.stringify(p.entry()?.auto)})`);
    const r = await p.call("readiness");
    check(r && r.ok === false, `a call into the switched-off extension is refused (got ${JSON.stringify(r)})`);
    p.close();
  } finally { await h.stop(); }
}

// ── B. a root with an Android app and today's installs.json ──
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${SLUG}-aa-on-`)));
  const repo = join(root, "droid");
  mkdirSync(join(repo, "app"), { recursive: true });
  writeFileSync(join(repo, "app", "build.gradle"), "plugins { id 'com.android.application' }\nandroid { defaultConfig { applicationId 'dev.example.droid' ; targetSdk 34 } }\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-qm", "init"], { cwd: repo });
  const state = join(root, STATE);
  mkdirSync(state, { recursive: true });
  const file = join(state, "installs.json");
  writeFileSync(file, JSON.stringify(FIXTURE));

  // bootHost keeps the host's logs on screen (a failing run shows why); its env overrides the scratch root.
  const h = await bootHost({ tag: "aa-on", env: rootEnv(root) });
  try {
    const p = await phone(h.base);
    await p.until(() => p.entry());
    check(await p.until(() => p.entry()?.state === "active"), `with an Android repo it switches ITSELF on (state ${p.entry()?.state})`);
    check(p.entry()?.auto?.state === "on", `…and says so (auto: ${JSON.stringify(p.entry()?.auto)})`);

    const r = await p.call("readiness");
    const app = r?.result?.apps?.find((a) => a.pkg === "dev.example.droid");
    check(r?.ok === true && typeof r.result.at === "number", `readiness answers {at, apps} (got ${JSON.stringify(r)?.slice(0, 200)})`);
    check(!!app && app.repoName === "droid" && app.targetSdk === 34, `…with the repo's facts through api.repoApps() (got ${JSON.stringify(app)?.slice(0, 200)})`);

    const log = await p.call("log");
    check(log?.ok === true && log.result.total === 2 && log.result.entries.length === 2, `log answers today's installs.json rows (got ${log?.result?.total})`);
    check(log?.result?.entries?.some((e) => e.key === K1 && e.label === "Tiptoi") && log.result.devices.length === 2, "…same keys, same fields, devices derived");

    const rep = await p.call("report", { device: { id: "ee55ff66", name: "tablet" }, entries: [{ pullId: "new1", pkg: "de.hoh.new", outcome: "installed", at: Date.now() - 1000 }] });
    check(rep?.ok === true && rep.result.n === 3 && typeof rep.result.at === "number" && rep.result.kept === true, `report merges and answers {n, at, kept:true} (got ${JSON.stringify(rep)})`);
    check(await p.until(() => p.st.pushes.length > 0), "…and pings every phone `changed`");
    const again = await p.call("log");
    check(again?.result?.total === 3 && again.result.entries.some((e) => e.pkg === "de.hoh.new"), "…and the log grew by the reported row");
    let saved = false;
    const t1 = Date.now();
    while (Date.now() - t1 < 10000) {
      try { if (JSON.parse(readFileSync(file, "utf8")).entries.some((e) => e.pkg === "de.hoh.new")) { saved = true; break; } } catch { /* mid-rename */ }
      await sleep(250);
    }
    check(saved, "…and installs.json holds it (the extension is the writer)");

    // Core's old route is neutered: an old bundle's install.report is dropped, never a second writer.
    const bytes = readFileSync(file, "utf8");
    p.send({ t: "install.report", device: { id: "99aa88bb", name: "core phone" }, entries: [{ pullId: "core1", pkg: "de.hoh.core", outcome: "installed", at: Date.now() - 2000 }] });
    await sleep(1500);
    const after = await p.call("log");
    check(after?.result?.total === 3 && !after.result.entries.some((e) => e.pkg === "de.hoh.core"), "core's install.report adds nothing (its store no longer writes)");
    check(readFileSync(file, "utf8") === bytes, "…and installs.json is untouched by core");
    p.close();
  } finally { await h.stop(); rmSync(root, { recursive: true, force: true }); }
}

if (failed) { console.error("android-apps e2e FAILED"); process.exit(1); }
console.log("android-apps e2e OK");
process.exit(0);
