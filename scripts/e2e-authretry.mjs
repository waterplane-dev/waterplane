// The sign-in episode (Phase D of the blocked sessions; host `recover/authgate.ts`,
// `sessions/signinwait.ts`): a sign-out stops two sessions' turns. The host
//   • keeps them as ONE episode (`SessionInfo.signInWait`) and pushes ONCE ("Signed out — 2 sessions");
//   • takes a continue tapped while still signed out: the first goes ALONE, is refused
//     again, and the second is never typed into — the episode stays "signed out";
//   • notices the sign-in (`claude auth status` flipping, read on a poll) and ASKS: one push
//     ("Signed in again — continue …?"), `signInWait.signedInAt` on both, and NOTHING typed;
//   • on the person's `signin.continue`: the first goes alone, the second only after the
//     first got through, and both leave the episode; the push item is resolved.
// The stub (`claude-stub-tui.mjs`) reads `STUB_AUTH_FILE` on every use: `out` = signed out
// (`auth status` false, every turn ends `StopFailure authentication_failed`).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs";
import { bootHost } from "./lib-e2e.mjs";
import { E, SLUG } from "./lib-brand.mjs";

const TMP = mkdtempSync(join(tmpdir(), `${SLUG}-authretry-`));
const AUTH = join(TMP, "auth");
const LOG = join(TMP, "keys.log");
writeFileSync(AUTH, "in");
writeFileSync(LOG, "");
const { port: PORT, stop } = await bootHost({
  tag: "authretry",
  env: {
    [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
    [E.CLAUDE_HOME]: join(TMP, "home"),
    STUB_HOOKS: "1", STUB_AUTH_FILE: AUTH, STUB_LOG: LOG,
    [E.STOP_VERIFY_MS]: "300",
    [E.SIGNIN_POLL_MS]: "1000",
  },
});
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = async (code) => { await stop(); process.exit(code); };
watchdog(async () => { console.error("FAIL: timeout"); await done(1); }, 90_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = `http://127.0.0.1:${PORT}`;
const mkRepo = (name) => fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => r.json());
const repos = [await mkRepo("auth-a"), await mkRepo("auth-b")];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const byCwd = new Map();
const info = new Map();
/** Per session: the timed arc of its sign-in wait (`-` out, `out`, `in`, `queued`, `cont`). */
const arcs = new Map();
const acks = new Map();
const pushes = [];
const keyOf = (w) => !w ? "-" : w.continuing ? "cont" : w.queued ? "queued" : w.signedInAt ? "in" : "out";
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === "welcome") for (const r of repos) ws.send(JSON.stringify({ t: "session.create", cwd: r.path, cols: 100, rows: 30 }));
  if (m.t === "session.created" && repos.some((r) => r.path === m.session.cwd) && !byCwd.has(m.session.cwd)) byCwd.set(m.session.cwd, m.session.id);
  if ((m.t === "session.created" || m.t === "session.updated") && [...byCwd.values()].includes(m.session.id)) {
    const id = m.session.id;
    info.set(id, m.session);
    const key = keyOf(m.session.signInWait);
    const arc = arcs.get(id) ?? [];
    if (arc[arc.length - 1]?.key !== key) arc.push({ key, at: Date.now() });
    arcs.set(id, arc);
  }
  if (m.t === "input.ack" || m.t === "op.ack") acks.set(m.ackId, m);
  if (m.t === "notification" && m.item?.kind === "signin") pushes.push(m.item);
});
ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 2 })));

const show = () => [...arcs.entries()].map(([id, a]) => `${id}: ${a.map((x) => x.key).join(" ")}`).join(" | ");
const until = async (pred, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(50); }
  check(false, `timed out waiting: ${what} (${show()})`);
  await done(1);
};
const continues = () => (readFileSync(LOG, "utf8").match(/continue/g) ?? []).length;
const last = (id) => arcs.get(id)?.at(-1)?.key;

await until(() => byCwd.size === 2 && [...byCwd.values()].every((id) => info.get(id)?.hooked && !info.get(id)?.turnActive), 30_000, "two hooked sessions");
await sleep(500);
const ids = [...byCwd.values()];

// ── The sign-out: both turns refused ────────────────────────────────────────
writeFileSync(AUTH, "out");
let n = 0;
const sent = ids.map((id) => { const ackId = `au-${++n}`; ws.send(JSON.stringify({ t: "session.input", id, data: "do the thing", submit: true, ackId })); return ackId; });
await until(() => sent.every((a) => acks.has(a)), 20_000, "both prompts acked");
await until(() => ids.every((id) => last(id) === "out"), 15_000, "both sessions in the sign-in episode");
check(ids.every((id) => info.get(id).signedOut), "both read signed out");
await until(() => pushes.length >= 1, 10_000, "the signed-out push");
await sleep(1500);
check(pushes.length === 1 && /^Signed out — 2 sessions stopped/.test(pushes[0].title), `ONE signed-out push for both (${pushes.map((p) => p.title).join(" / ")})`);
check(pushes[0].open?.to === "blocked" && pushes[0].key === "signin", "it opens the blocked sheet, keyed signin");

// ── A tap while still signed out: the first goes alone and is refused ───────
const before = continues();
ws.send(JSON.stringify({ t: "signin.continue", ids: [...ids, "nope"], ackId: "au-c1" }));
await until(() => acks.has("au-c1"), 5000, "the early tap acked");
check(acks.get("au-c1").ok && /not waiting for a sign-in: nope/.test(acks.get("au-c1").reason ?? ""), `early tap taken, the stranger named (${acks.get("au-c1").reason})`);
await until(() => ids.some((id) => arcs.get(id).some((x) => x.key === "cont")), 10_000, "the first continue typed");
const [firstId, secondId] = [...ids].sort((a, b) => (arcs.get(a).findIndex((x) => x.key === "cont") >= 0 ? 0 : 1) - (arcs.get(b).findIndex((x) => x.key === "cont") >= 0 ? 0 : 1));
await until(() => last(firstId) === "out" && arcs.get(firstId).some((x) => x.key === "cont"), 10_000, "the first refused again, back to signed out");
await sleep(2000);
check(!arcs.get(secondId).some((x) => x.key === "cont"), `the second was never typed into while signed out (${show()})`);
check(continues() - before === 1, `exactly one continue typed (${continues() - before})`);
check(pushes.length === 1, "no new push for the refusal");

// ── The sign-in: noticed, ASKED, nothing typed ──────────────────────────────
writeFileSync(AUTH, "in");
const typedBefore = continues();
await until(() => ids.every((id) => last(id) === "in"), 10_000, "both read signed in again");
await until(() => pushes.length >= 2, 5000, "the signed-in push");
check(/^Signed in again — continue the 2 sessions that stopped\?/.test(pushes[1].title), `one signed-in push (${pushes[1].title})`);
await sleep(1500);
check(continues() === typedBefore, "nothing typed until the tap");

// ── The tap: first alone, then the second ───────────────────────────────────
ws.send(JSON.stringify({ t: "signin.continue", ids, ackId: "au-c2" }));
await until(() => acks.has("au-c2") && acks.get("au-c2").ok, 5000, "the tap acked");
await until(() => ids.every((id) => last(id) === "-"), 20_000, "both continued and out of the episode");
const contAt = (id) => arcs.get(id).filter((x) => x.key === "cont").at(-1).at;
const leftAt = (id) => arcs.get(id).at(-1).at;
const [lead, follow] = [...ids].sort((a, b) => contAt(a) - contAt(b));
check(contAt(follow) >= leftAt(lead), `the second typed only after the first got through (${show()})`);
check(continues() - typedBefore === 2, `two continues typed (${continues() - typedBefore})`);

await done(failed ? 1 : 0);
