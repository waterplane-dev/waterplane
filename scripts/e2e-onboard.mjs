// First app, web path, end to end (first-app plan WP6): plan → consent refusal → start →
// `onboard.progress` frames over the one socket → the page lands in the new repo's outbox →
// a session is open there. The web template builds in a second, so this runs on every desktop;
// the Android path is covered on fakes (`packages/host/test/onboard.test.mjs`) because it would
// download a toolchain and run a five-minute gradle build.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootHost } from "./lib-e2e.mjs";

const h = await bootHost({ tag: "onboard", quiet: true });
const fail = async (m) => { console.error("FAIL:", m); await h.stop(); process.exit(1); };
// Every POST here is the phone's: a browser always sends an Origin the gate accepts.
const api = async (path, init = {}) => {
  const origin = init.method === "POST" && !init.noOrigin ? { origin: h.base } : {};
  const r = await fetch(h.base + path, { ...init, headers: { "content-type": "application/json", ...origin, ...(init.headers ?? {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  // ── The plan is read-only and says what applies ─────────────────────────────
  const plan = await api("/api/onboard/plan?name=First-Page&path=web");
  if (!plan.body?.ok) await fail("plan refused: " + JSON.stringify(plan.body));
  if (plan.body.name !== "first-page") await fail("name not cleaned: " + plan.body.name);
  if (JSON.stringify(plan.body.steps.map((s) => s.id)) !== JSON.stringify(["scaffold", "setup", "build", "session"])) await fail("web steps: " + JSON.stringify(plan.body.steps));
  if (plan.body.consent.some((l) => l.id === "toolchain" || l.id === "signingKey")) await fail("the web path must not ask for a toolchain or a key");
  if (existsSync(join(h.root, "first-page"))) await fail("the plan wrote something");

  // ── Start without the repo tick: refused, nothing made ───────────────────────
  const tok = plan.body.confirm;
  if (typeof tok !== "string" || tok.length < 16) await fail("the plan carries no confirm token");
  const refused = await api("/api/onboard", { method: "POST", body: JSON.stringify({ answers: { name: "first-page", path: "web" }, consent: { session: true }, confirm: tok }) });
  if (refused.status !== 400 || !refused.body?.missing?.includes("repo")) await fail("start without consent was not refused: " + JSON.stringify(refused));
  if (existsSync(join(h.root, "first-page"))) await fail("a refused start created the folder");

  // ── Consent is the phone's: Origin-less, token-less, wrong-path, unlisted-tick starts are refused ──
  const body = (extra) => JSON.stringify({ answers: { name: "first-page", path: "web" }, consent: { repo: true, session: true }, ...extra });
  const noOrigin = await api("/api/onboard", { method: "POST", noOrigin: true, body: body({ confirm: tok }) });
  if (noOrigin.status !== 403) await fail("an Origin-less start was not refused: " + JSON.stringify(noOrigin));
  const noTok = await api("/api/onboard", { method: "POST", body: body({}) });
  if (noTok.status !== 403) await fail("a start with no token was not refused: " + JSON.stringify(noTok));
  const wrongPath = await api("/api/onboard", { method: "POST", body: JSON.stringify({ answers: { name: "first-page", path: "android" }, consent: { repo: true }, confirm: tok }) });
  if (wrongPath.status !== 403) await fail("a token for the web plan started an android job: " + JSON.stringify(wrongPath));
  const unlisted = await api("/api/onboard", { method: "POST", body: body({ consent: { repo: true, session: true, toolchain: true }, confirm: tok }) });
  if (unlisted.status !== 403 || !/toolchain/.test(unlisted.body?.error ?? "")) await fail("a tick the plan never listed was accepted: " + JSON.stringify(unlisted));
  if (existsSync(join(h.root, "first-page"))) await fail("a refused start created the folder");

  // ── A cross-origin POST never reaches the job (the /api gate) ───────────────
  const evil = await fetch(h.base + "/api/onboard", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ answers: { name: "evil", path: "web" }, consent: { repo: true } }) });
  if (evil.status !== 403) await fail("cross-origin POST /api/onboard answered " + evil.status);

  // ── Start for real, and follow it over the socket ───────────────────────────
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
  const frames = [];
  const done = new Promise((resolve) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t !== "onboard.progress") return;
      frames.push(m.job);
      if (m.job.state !== "running") resolve(m.job);
    });
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  await new Promise((r) => setTimeout(r, 200));

  const started = await api("/api/onboard", { method: "POST", body: JSON.stringify({
    answers: { name: "first-page", path: "web" }, consent: { repo: true, session: true }, confirm: tok,
  }) });
  if (!started.body?.ok) await fail("start refused: " + JSON.stringify(started.body));
  const replay = await api("/api/onboard", { method: "POST", body: body({ confirm: tok }) });
  if (replay.status !== 403) await fail("a used token started again: " + JSON.stringify(replay));
  const plan2 = await api("/api/onboard/plan?name=other&path=web");
  const again = await api("/api/onboard", { method: "POST", body: JSON.stringify({ answers: { name: "other", path: "web" }, consent: { repo: true }, confirm: plan2.body?.confirm }) });
  if (again.status !== 409 && again.body?.job?.state !== "done") await fail("a second start while one runs must be refused: " + JSON.stringify(again));

  const job = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 30_000))]);
  if (!job) await fail("no terminal onboard.progress frame within 30 s; frames: " + JSON.stringify(frames.map((f) => f.summary)));
  if (job.state !== "done") await fail("job stopped: " + job.summary + " " + JSON.stringify(job.steps));
  const seen = new Set(frames.flatMap((f) => f.steps.filter((s) => s.status === "running").map((s) => s.id)));
  for (const id of ["scaffold", "build", "session"]) if (!seen.has(id)) await fail(`no frame showed ${id} running`);

  // ── The page is in the outbox, and the job says so ──────────────────────────
  const repo = join(h.root, "first-page");
  const page = join(repo, ".claude", "outbox", "first-page.html");
  if (!existsSync(page)) await fail("the page did not land in the outbox: " + page);
  if (!/<button/.test(readFileSync(page, "utf8"))) await fail("the outbox page is not the template's");
  if (job.artifact !== ".claude/outbox/first-page.html") await fail("artifact: " + job.artifact);
  if (!job.sessionId) await fail("no session id on the finished job");

  // ── A reconnecting phone reads the same job back ────────────────────────────
  const back = await api("/api/onboard");
  if (back.body?.job?.id !== job.id || back.body.job.state !== "done") await fail("GET /api/onboard: " + JSON.stringify(back.body));

  // ── POST /api/repo takes a template too ─────────────────────────────────────
  const tpl = await api("/api/repo", { method: "POST", body: JSON.stringify({ name: "second-page", template: "web-hello" }) });
  if (tpl.status !== 200 || !existsSync(join(h.root, "second-page", "index.html"))) await fail("POST /api/repo with a template: " + JSON.stringify(tpl));
  const bad = await api("/api/repo", { method: "POST", body: JSON.stringify({ name: "third", template: "../x" }) });
  if (bad.status !== 400) await fail("an unknown template must be refused: " + JSON.stringify(bad));

  ws.close();
  console.log(`PASS onboard (web): ${frames.length} progress frames, page in the outbox, session ${job.sessionId}`);
  await h.stop();
} catch (e) {
  await fail(e?.stack ?? String(e));
}
