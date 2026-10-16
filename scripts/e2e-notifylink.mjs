// The Android background link is sent only the frames it acts on.
//
// `ShellLinkService` holds its own socket so alerts arrive with the app closed,
// and reads exactly `notification`, `authRequired` and `pull.new`. Every other
// frame wakes the phone's radio for nothing, on a link that never sleeps — so
// the host filters it in `send` (`shared/wire/notifylink.ts`).
//
// Asserts:
//   1. an OkHttp User-Agent alone (every APK already installed) makes a socket
//      a notify link: no welcome, no hello snapshots, no broadcasts
//   2. `hello.role: "notify"` does the same with no OkHttp UA (a new APK)
//   3. both still receive a `notification`
//   4. a browser socket beside them still gets everything (the control)
//   5. a JSON ping from a notify link is still answered with `pong`
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootHost } from "./lib-e2e.mjs";
import { E } from "./lib-brand.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(100); }
  return false;
};

const h = await bootHost({ tag: "notifylink", quiet: true, env: { [E.SCHEDULE_TICK_MS]: "500" } });
const open = [];
try {
  async function connect(headers, hello) {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, { headers });
    open.push(ws);
    const frames = [];
    ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    ws.send(JSON.stringify(hello));
    return { ws, frames, send: (m) => ws.send(JSON.stringify(m)), types: () => [...new Set(frames.map((f) => f.t))] };
  }

  const legacy = await connect({ "user-agent": "okhttp/4.12.0" }, { t: "hello", protocol: 1 });
  const declared = await connect({}, { t: "hello", protocol: 1, role: "notify" });
  const browser = await connect({ "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile Safari/537.36" }, { t: "hello", protocol: 1 });

  await waitFor(() => browser.frames.some((f) => f.t === "session.list"));
  await sleep(300);
  check(legacy.frames.length === 0, `an okhttp socket gets no welcome and no snapshots (${legacy.types().join(",") || "none"})`);
  // The declared one connected without the UA, so `welcome`/`backends` went out
  // before its hello said what it was; nothing after the hello may.
  const afterHello = declared.frames.filter((f) => f.t !== "welcome" && f.t !== "backends");
  check(afterHello.length === 0, `hello.role notify gets no snapshots (${afterHello.map((f) => f.t).join(",") || "none"})`);
  check(browser.frames.some((f) => f.t === "welcome") && browser.frames.some((f) => f.t === "usage.status"), "a browser socket still gets welcome and the snapshots (control)");

  // A broadcast (the schedule list) and a notification: the one-shot schedule
  // aims at a directory that is not a repo, fails, and says so in the feed.
  legacy.frames.length = 0; declared.frames.length = 0; browser.frames.length = 0;
  browser.send({
    t: "schedule.save",
    entry: {
      id: "sched-notifylink", name: "probe", enabled: true, graceMin: 120,
      rule: { kind: "once", at: Date.now() + 1500 },
      action: { kind: "fanout", dirs: [join(h.root, "no-such-repo")], text: "never runs" },
    },
  });
  const notified = await waitFor(() => legacy.frames.some((f) => f.t === "notification") && declared.frames.some((f) => f.t === "notification"));
  await sleep(300);
  check(browser.frames.some((f) => f.t !== "notification"), `the browser saw the broadcasts (${browser.types().join(",")})`);
  check(notified, "both notify links received the notification");
  check(legacy.frames.every((f) => f.t === "notification"), `the okhttp link received only notifications (${legacy.types().join(",")})`);
  check(declared.frames.every((f) => f.t === "notification"), `the declared link received only notifications (${declared.types().join(",")})`);

  legacy.frames.length = 0;
  legacy.send({ t: "ping" });
  check(await waitFor(() => legacy.frames.some((f) => f.t === "pong"), 3000), "a notify link's ping is still answered");
} finally {
  for (const ws of open) { try { ws.close(); } catch { /* closing */ } }
  await h.stop();
}
process.exit(failed ? 1 : 0);
