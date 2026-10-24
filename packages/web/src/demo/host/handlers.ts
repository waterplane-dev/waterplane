/**
 * What the demo does with each client message — EXHAUSTIVE BY TYPE.
 *
 * `HANDLERS satisfies HandlerTable`, a mapped type over `ClientMessage["t"]`:
 * a new client message fails `tsc` here until someone decides what the demo
 * says to it, and a misspelt or removed one fails as an excess key. That is
 * the drift guard on this side; `packages/host/test/demoparity.test.mjs` is
 * the one on the host's (every key here is a key of the host's `HANDLED`).
 *
 * Two tiers, both DECLARED, so the dispatcher (index.ts) applies the
 * verdict-shape rule and the ack ledger and no entry can forget either:
 *   - `A`  answers from the model (`run`). Its return is the verdict the
 *          receipt carries; returning nothing means `{ ok: true }`.
 *   - `B`  refused with `refuse()` — the receipt with `ok:false` and a
 *          sentence saying what would make it work.
 * (`pending`, WP2a's placeholder for "tier A not written yet", is gone; the
 * type keeps it so a future half-built entry still refuses instead of hanging.)
 *
 * Reads that a sheet sends on OPEN (`build.list`, `capture.list`,
 * `fanout.list`, `launch.list`, `assess.state`) are tier A with empty
 * answers: a refusal there would be a toast on every sheet open, and an empty
 * list is the truth about the demo's desktop.
 */
import { cleanIntentRow, DEFAULT_ARTIFACT_POLICY, nextFireAt } from "@waterplane/shared";
import type { ClientMessage, HostMessage, Intent } from "@waterplane/shared";
import {
  backlogFrame, createSession, findSession, input, killSession, recordHistory, removeSession, repaint,
  replay, sessions, submit, switchMode,
} from "./desk.ts";
import { setBudget } from "./budget.ts";
import { setFollowUp } from "./followup.ts";
import { addWaiting } from "./waiting.ts";
import { inRepos, mint, NOT_A_DEMO_REPO } from "./model.ts";
import type { DemoModel, Desk, Frame } from "./model.ts";
import type { DemoState } from "./snapshot.ts";
import type { DemoVerdict, Msg } from "./verdict.ts";

export interface HandlerCtx<K extends ClientMessage["t"]> {
  msg: Msg<K>;
  now: number;
  /** Mutable. Mutating it and returning is enough: the dispatcher fires
   *  `onChange` after every tier-A handler. */
  state: DemoState;
  /** The typed model plus the ways out (broadcast, to a session's sockets). */
  desk: Desk;
  /** To the asking socket only. */
  reply(m: HostMessage): void;
  /** To every open socket. */
  broadcast(m: HostMessage): void;
  /** This socket now streams session `id`'s PTY (and stops, on detach). */
  attach(id: string): void;
  detach(id: string): void;
}

export type Handler<K extends ClientMessage["t"]> =
  | { tier: "A"; run(c: HandlerCtx<K>): DemoVerdict | void }
  | { tier: "B"; reason?: string }
  | { tier: "pending" };

export type HandlerTable = { [K in ClientMessage["t"]]: Handler<K> };

const B = { tier: "B" } as const;
const because = (reason: string) => ({ tier: "B", reason }) as const;

// ── the sentences tier B answers with — each says what would make it work ──
const BUILDS = because("Builds run commands on your desktop — the demo has no desktop to run them on. Connect your own to build.");
const CAPTURE = because("Screenshots are taken on your desktop's screen — connect your own desktop to capture one.");
const ASSESS = because("An assessment spends model calls on your desktop — connect your own to run one.");
const FANOUT = because("Fanning out opens sessions in several repos on your desktop — connect your own to try it.");
const AUTH = because("The password gate guards a real desktop — the demo has nothing to lock.");
const PLUGINS = because("Plugins run on your desktop, and the demo has none installed.");
const LOCALRT = because("Local models run on your desktop — the demo has none loaded.");
const UPDATE = because("Updating claude happens on your desktop — the demo's claude is not a real install.");
const LIMITS = because("Usage-limit resumes need a real claude session — the demo never hits a limit of its own.");
const CONVO = because("This reads the real conversation log on your desktop — the demo keeps no logs.");
const RUNS = because("The demo keeps your waiting work but does not start it — on your own desktop it would run here.");
const DESKTOP = because("A live desktop streams your own screen, and the demo has no desktop to show.");
const STORE = because("The demo keeps no records on disk to change — this needs your own desktop.");

const m = (c: { desk: Desk }): DemoModel => c.desk.m;
const bl = (md: DemoModel) => (md.backlog ??= {}).items ??= [];
const intents = (md: DemoModel): Intent[] => (md.intents ??= []);

/** Start a backlog item: in its target session when that is open, else in a
 *  fresh session of its repo. The turn's end marks it done (desk.ts). */
function fireItem(c: { desk: Desk; attach(id: string): void }, id: string): void {
  const d = c.desk;
  const it = bl(d.m).find((x) => x.id === id);
  if (!it || it.status !== "queued") return;
  const target = it.targetSessionId ? findSession(d.m, it.targetSessionId) : undefined;
  const sid = target?.running ? target.id : createSession(d, { cwd: it.repoDir, title: `backlog · ${it.label ?? it.text.slice(0, 40)}` }).id;
  Object.assign(it, { status: "running", sessionId: sid, startedAt: d.now() });
  d.broadcast(backlogFrame(d.m));
  submit(d, sid, it.text);
}

/** What the demo host says it can launch: ONE backend (so no picker), with a
 *  small FIXTURE catalogue. The app carries no model table of its own, so
 *  without this frame demo mode's model picker would be a typed field. */
export const DEMO_BACKENDS: Frame<"backends">["list"] = [{
  id: "claude", label: "Claude Code",
  caps: {
    contextMeter: true, usageLimits: true, transcript: true, slash: true, promptBoxes: true,
    hooks: true, effort: true, remoteControl: true,
    permissionModes: ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"],
  },
  models: { aliases: ["opus", "sonnet", "haiku"], ids: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"] },
}];

/**
 * The usage reading a demo desktop holds when its scenario carries none of its own: the 5-hour
 * window at 42% resetting in a little over two hours, the week at 61% — the figures the first-look
 * scenario ships, so every film's header meter and every Token usage sheet say one consistent thing.
 * Seeded once, at `at` (index.ts `build`), so `usage.status`, `usage.get` and `usage.refresh` all answer
 * the same reading: an app that finds none shows "? / ? wk" in its header and asks again on every
 * screen change, which the demo used to answer with a toast about itself.
 */
export const demoUsage = (at: number): Frame<"usage.status">["usage"] => ({
  ok: true, sessionPct: 42, weeklyPct: 61, checkedAt: at - 2 * 60_000,
  sessionResetAt: at + 130 * 60_000, weeklyResetAt: at + (3 * 24 + 5) * 3_600_000,
});

/** The frames the real host sends unasked on `hello` (routes/system.ts),
 *  minus the ones whose number the scenario does not carry. */
export function helloFrames(md: DemoModel): HostMessage[] {
  const n = md.numbers ?? {};
  const out: (HostMessage | null)[] = [
    { t: "backends", list: DEMO_BACKENDS },
    { t: "session.list", sessions: sessions(md) },
    { t: "recent.list", recent: md.recent ?? [] },
    { t: "closed.list", closed: md.closed ?? [] },
    backlogFrame(md),
    n.update ? { t: "update.status", info: n.update } : null,
    { t: "plugin.list", plugins: md.plugins ?? [] },
    { t: "decisions.log", entries: (md.decisions ?? []).slice(0, 100) },
    n.usage ? { t: "usage.status", usage: n.usage } : null,
    n.meter ? { t: "meter.status", summary: n.meter } : null,
    { t: "notification.list", items: md.notifications ?? [] },
    n.notifyPrefs ? { t: "notify.prefs", prefs: n.notifyPrefs } : null,
    n.budget ? { t: "budget.state", budget: n.budget.budget, verdict: n.budget.verdict } : null,
    {
      t: "limit.config", enabled: md.limitConfig?.enabled ?? false, resumingId: null, holdUntil: null,
      ...(md.limitConfig?.mode ? { mode: md.limitConfig.mode } : {}),
    },
    { t: "fanout.list", runs: [] },
    { t: "pull.list", items: md.pulls ?? [] },
    { t: "schedule.list", entries: md.schedules ?? [] },
    { t: "launch.list", launches: md.launches ?? [] },
    { t: "intent.list", intents: md.intents ?? [] },
    { t: "delivery.list", items: md.deliveries ?? [] },
    { t: "settings.all", doc: md.settings ?? {} },
    md.install ? { t: "install.log", doc: md.install } : null,
    n.clihealth ? { t: "clihealth", health: n.clihealth.health, rollup: n.clihealth.rollup } : null,
  ];
  return out.filter((f): f is HostMessage => !!f);
}

export const HANDLERS = {
  "ping": { tier: "A", run: (c) => { c.reply({ t: "pong" }); } },
  // `hello` → `welcome` + `helloFrames` is the dispatcher's (index.ts): it
  // needs the protocol fault and the connection, which no handler sees.
  "hello": { tier: "A", run: () => {} },

  // ── sessions ──────────────────────────────────────────────────────────
  "session.list": { tier: "A", run: (c) => { c.reply({ t: "session.list", sessions: sessions(m(c)) }); } },
  "session.create": {
    tier: "A",
    run: (c) => {
      const { msg, desk } = c;
      if (!inRepos(desk.m, msg.cwd)) return { ok: false, reason: NOT_A_DEMO_REPO };
      if (msg.forkAtTurn) return { ok: false, reason: "Forking cuts the real conversation log on your desktop — the demo keeps none." };
      if (msg.replaceSessionId) killSession(desk, msg.replaceSessionId);
      // `needs` would park the create until files land; the demo's files
      // never land, so it opens now — a parked create the phone could never
      // see open is the worse demo.
      const info = createSession(desk, { cwd: msg.cwd, title: msg.title, cols: msg.cols, rows: msg.rows });
      c.attach(info.id);
      // Born with a cap, as the host's create does (garbage is dropped there too).
      if (msg.budget) setBudget(desk, info.id, msg.budget);
      const first = msg.prompt?.trim();
      if (first) submit(desk, info.id, first);
      return { ok: true, sessionId: info.id };
    },
  },
  "session.attach": {
    tier: "A",
    run: (c) => {
      c.attach(c.msg.id);
      const rep = replay(c.desk, c.msg.id, c.msg.resumeSeq, c.msg.resumeBoot);
      if (rep) c.reply({ t: "pty", id: c.msg.id, ...rep });
      c.reply({ t: "session.history", id: c.msg.id, entries: m(c).history?.[c.msg.id] ?? [] });
    },
  },
  "session.detach": { tier: "A", run: (c) => { c.detach(c.msg.id); } },
  "session.resize": {
    tier: "A",
    run: (c) => {
      const sc = m(c).screens?.[c.msg.id];
      if (!sc) return;
      const wider = sc.cols !== c.msg.cols;
      sc.cols = c.msg.cols; sc.rows = c.msg.rows;
      // The CLI lays its transcript out to the PTY's width: a new width is a new picture.
      if (wider && sc.log != null) repaint(c.desk, c.msg.id);
    },
  },
  "session.kill": { tier: "A", run: (c) => { killSession(c.desk, c.msg.id); } },
  "session.remove": { tier: "A", run: (c) => { removeSession(c.desk, c.msg.id); } },
  "session.input": { tier: "A", run: (c) => input(c.desk, c.msg) },
  "session.history": { tier: "A", run: (c) => { c.reply({ t: "session.history", id: c.msg.id, entries: m(c).history?.[c.msg.id] ?? [] }); } },
  "session.record": {
    tier: "A",
    run: (c) => { if (findSession(m(c), c.msg.id)) recordHistory(c.desk, c.msg.id, c.msg.text, c.msg.kind); },
  },
  "recent.list": { tier: "A", run: (c) => { c.reply({ t: "recent.list", recent: m(c).recent ?? [] }); } },
  "delivery.list": { tier: "A", run: (c) => { c.reply({ t: "delivery.list", items: m(c).deliveries ?? [] }); } },

  // ── backlog ───────────────────────────────────────────────────────────
  "backlog.list": { tier: "A", run: (c) => { c.reply(backlogFrame(m(c))); } },
  "backlog.add": {
    tier: "A",
    run: (c) => {
      const { msg, desk } = c;
      if (!inRepos(desk.m, msg.repoDir)) return { ok: false, reason: NOT_A_DEMO_REPO };
      if (!msg.text?.trim()) return { ok: false, reason: "There is nothing to queue — the text is empty." };
      const items = bl(desk.m);
      const id = mint(desk.m, "b");
      items.push({
        id, text: msg.text, status: "queued", repoDir: msg.repoDir, createdAt: desk.now(),
        order: items.reduce((mx, x) => Math.max(mx, x.order), 0) + 1,
        ...(msg.label ? { label: msg.label } : {}),
        ...(msg.targetSessionId ? { targetSessionId: msg.targetSessionId } : {}),
        ...(msg.autoFire != null ? { autoFire: msg.autoFire } : {}),
        ...(msg.resume != null ? { resume: msg.resume } : {}),
        ...(msg.closeWhenDone != null ? { closeWhenDone: msg.closeWhenDone } : {}),
      });
      desk.broadcast(backlogFrame(desk.m));
      if (msg.fire) fireItem(c, id);
      // *When it's free* to one session: judged and run the way the host's
      // ladder runs it (waiting.ts) — held by a spent budget, a turn, a limit.
      else if (msg.targetSessionId && msg.autoFire) { const it = items.find((x) => x.id === id); if (it) addWaiting(desk, it); }
      return { ok: true, itemId: id };
    },
  },
  "backlog.remove": {
    tier: "A",
    run: (c) => {
      const md = m(c);
      md.backlog = { ...md.backlog, items: bl(md).filter((x) => x.id !== c.msg.id) };
      c.broadcast(backlogFrame(md));
    },
  },
  "backlog.fire": { tier: "A", run: (c) => { fireItem(c, c.msg.id); } },
  "backlog.update": {
    tier: "A",
    run: (c) => {
      const { msg } = c;
      const it = bl(m(c)).find((x) => x.id === msg.id);
      if (!it) { c.reply({ t: "toast", text: "backlog: that item is gone" }); return; }
      if (msg.repoDir !== undefined && !inRepos(m(c), msg.repoDir)) { c.reply({ t: "toast", text: NOT_A_DEMO_REPO }); return; }
      const patch = {
        text: msg.text, label: msg.label, repoDir: msg.repoDir, targetSessionId: msg.targetSessionId,
        autoFire: msg.autoFire, resume: msg.resume, headline: msg.headline, category: msg.category,
      };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (it as unknown as Record<string, unknown>)[k] = v;
      if (msg.closeWhenDone === null) delete it.closeWhenDone;
      else if (typeof msg.closeWhenDone === "boolean") it.closeWhenDone = msg.closeWhenDone;
      c.broadcast(backlogFrame(m(c)));
    },
  },

  // ── schedules (armed, never fired: the demo's clock only moves on a script) ─
  "schedule.list": { tier: "A", run: (c) => { c.reply({ t: "schedule.list", entries: m(c).schedules ?? [] }); } },
  "schedule.save": {
    tier: "A",
    run: (c) => {
      const e = c.msg.entry;
      if (!e || typeof e.id !== "string" || !e.id) return { ok: false, reason: "nothing to run (pick repos and write a prompt)" };
      let nextAt: number | null = null;
      try { nextAt = e.enabled ? nextFireAt(e.rule, c.now) : null; } catch { nextAt = null; }
      const md = m(c);
      const list = (md.schedules ??= []);
      const row = { ...e, nextAt };
      const at = list.findIndex((x) => x.id === e.id);
      if (at >= 0) list[at] = row; else list.push(row);
      c.broadcast({ t: "schedule.list", entries: list });
      return { ok: true, intentId: e.id };
    },
  },
  "schedule.remove": {
    tier: "A",
    run: (c) => {
      const md = m(c);
      md.schedules = (md.schedules ?? []).filter((x) => x.id !== c.msg.id);
      c.broadcast({ t: "schedule.list", entries: md.schedules });
    },
  },

  // ── intents ───────────────────────────────────────────────────────────
  "intent.list": { tier: "A", run: (c) => { c.reply({ t: "intent.list", intents: m(c).intents ?? [] }); } },
  "intent.post": {
    tier: "A",
    run: (c) => {
      const d = c.msg.intent;
      if (!inRepos(m(c), d?.cwd)) return { ok: false, reason: NOT_A_DEMO_REPO };
      const list = intents(m(c));
      const existing = list.find((x) => x.id === d.id);
      const row = existing ?? cleanIntentRow({ ...d, state: "queued", createdAt: c.now }, c.now);
      if (!row) return { ok: false, reason: "That request could not be read, so nothing was written down." };
      if (!existing) list.push(row);
      c.broadcast({ t: "intent.changed", intent: row });
      return { ok: true, intentId: row.id, launchId: row.trigger.kind === "files" ? row.id : undefined };
    },
  },
  "intent.dismiss": {
    tier: "A",
    run: (c) => {
      const row = intents(m(c)).find((x) => x.id === c.msg.id);
      if (!row || row.dismissedAt != null || !["done", "failed", "canceled"].includes(row.state)) return;
      row.dismissedAt = c.now;
      c.broadcast({ t: "intent.changed", intent: row });
    },
  },

  // ── settings and numbers ──────────────────────────────────────────────
  "settings.get": { tier: "A", run: (c) => { c.reply({ t: "settings.all", doc: m(c).settings ?? {} }); } },
  "settings.set": {
    tier: "A",
    run: (c) => {
      const { key, value, ts, device } = c.msg;
      const doc = (m(c).settings ??= {});
      const cur = doc[key];
      if (cur && cur.ts > ts) { c.reply({ t: "settings.update", key, value: cur.value, ts: cur.ts, ...(cur.device ? { device: cur.device } : {}) }); return; }
      doc[key] = { value, ts, ...(device ? { device } : {}) };
      c.broadcast({ t: "settings.update", key, value, ts, ...(device ? { device } : {}) });
    },
  },
  "usage.get": { tier: "A", run: (c) => { const u = m(c).numbers?.usage; if (u) c.reply({ t: "usage.status", usage: u }); } },
  "update.status": { tier: "A", run: (c) => { const u = m(c).numbers?.update; if (u) c.reply({ t: "update.status", info: u }); } },
  "notification.get": { tier: "A", run: (c) => { c.reply({ t: "notification.list", items: m(c).notifications ?? [] }); } },
  "budget.get": {
    tier: "A",
    run: (c) => { const b = m(c).numbers?.budget; if (b) c.reply({ t: "budget.state", budget: b.budget, verdict: b.verdict }); },
  },
  // Demo hosts have no billing profile: nothing to answer, the phone reads that as `unknown`.
  "billing.get": { tier: "A", run: () => {} },
  "clihealth.get": {
    tier: "A",
    run: (c) => { const h = m(c).numbers?.clihealth; if (h) c.reply({ t: "clihealth", health: h.health, rollup: h.rollup }); },
  },
  // The demo board is a fixture: a clear is acknowledged with the board as it
  // is, so the tap ends in its receipt and the rows read as staged.
  "clihealth.clear": {
    tier: "A",
    run: (c) => { const h = m(c).numbers?.clihealth; if (h) c.reply({ t: "clihealth", health: h.health, rollup: h.rollup }); },
  },
  "meter.get": { tier: "A", run: (c) => { const s = m(c).numbers?.meter; if (s) c.reply({ t: "meter.status", summary: s }); } },
  "artifacts.get": {
    tier: "A",
    run: (c) => {
      if (!inRepos(m(c), c.msg.repoDir)) return;
      c.reply({ t: "artifacts.config", repoDir: c.msg.repoDir, policy: m(c).artifactPolicies?.[c.msg.repoDir] ?? DEFAULT_ARTIFACT_POLICY });
    },
  },
  "pull.list": { tier: "A", run: (c) => { c.reply({ t: "pull.list", items: m(c).pulls ?? [] }); } },
  "plugin.list": { tier: "A", run: (c) => { c.reply({ t: "plugin.list", plugins: m(c).plugins ?? [] }); } },
  "auth.get": { tier: "A", run: (c) => { c.reply({ t: "auth.state", auth: { enabled: false, gateTailscale: false, canManage: false } }); } },
  "install.get": { tier: "A", run: (c) => { const doc = m(c).install; if (doc) c.reply({ t: "install.log", doc }); } },
  "decisions.get": {
    tier: "A",
    run: (c) => {
      const sid = c.msg.sessionId;
      const entries = (m(c).decisions ?? []).filter((e) => !sid || e.sessionId === sid).slice(0, 200);
      c.reply({ t: "decisions.log", entries, sessionId: sid });
    },
  },
  "sent.get": {
    tier: "A",
    run: (c) => {
      const sid = c.msg.sessionId;
      c.reply({ t: "sent.log", entries: (m(c).sent ?? []).filter((e) => !sid || e.sessionId === sid), sessionId: sid });
    },
  },

  // ── reads a sheet sends on open: answered empty, never a toast ────────
  "build.list": { tier: "A", run: (c) => { c.reply({ t: "build.list", repoDir: c.msg.repoDir, builds: [], runs: [] }); } },
  "capture.list": { tier: "A", run: (c) => { c.reply({ t: "capture.list", repoDir: c.msg.repoDir, targets: [], runs: [], backends: [] }); } },
  "fanout.list": { tier: "A", run: (c) => { c.reply({ t: "fanout.list", runs: [] }); } },
  "launch.list": { tier: "A", run: (c) => { c.reply({ t: "launch.list", launches: m(c).launches ?? [] }); } },
  "assess.state": { tier: "A", run: (c) => { c.reply({ t: "assess.state", repoDir: c.msg.repoDir ?? "", run: null }); } },

  // ── tier B: needs a real desktop ─────────────────────────────────────
  "session.name": CONVO,
  "session.fork": CONVO,
  "session.reopen": because("Reopening resumes a conversation from your desktop's log — open a new session in the demo instead."),
  // The cap is judged against the scenario's fictional spend, the way the host
  // judges the real one; garbage and a closed session are refused in the host's
  // own words (a toast: the message has no receipt there either).
  // Live only on the real host too (never queued): flips `liveMode` on the
  // session list and answers `session.moded` through its receipt.
  "session.mode": { tier: "A", run: (c) => switchMode(c.desk, c.msg.id, c.msg.mode) },
  "session.budget.set": {
    tier: "A",
    run: (c) => { const no = setBudget(c.desk, c.msg.id, c.msg.budget); if (no) c.reply({ t: "toast", text: no }); },
  },
  "session.rename": STORE,
  "session.star": STORE,
  // Toggled for real, so the docs can show a flag set, coloured and cleared.
  "session.followup": { tier: "A", run: (c) => setFollowUp(c.desk, c.msg.id, c.msg.on) },
  "session.pin": STORE,
  "session.background": B,
  "session.closecheck": because("The close check reads git on your desktop — the demo has no working tree."),
  "session.search": CONVO,
  "session.remoteControl": B,
  "session.ackAsking": B,
  "input.settle": B,
  "shell.kill": because("The demo runs no background shells to stop."),
  "backlog.archive": STORE,
  "backlog.check": ASSESS,
  "backlog.continue": RUNS,
  "backlog.done": STORE,
  "backlog.name": ASSESS,
  "backlog.nextStep": RUNS,
  "backlog.openRepoSession": RUNS,
  "backlog.reorder": STORE,
  "backlog.setAuto": RUNS,
  "backlog.swap": STORE,
  "backlog.validate": ASSESS,
  "build.cancel": BUILDS,
  "build.options": BUILDS,
  "build.run": BUILDS,
  "build.save": BUILDS,
  // The editor waits on this frame to stop saying "reading the repo..." (a toast
  // alone left that spinner up for good); the real host answers a scan it cannot
  // do with an EMPTY list, and so does the demo: the repo describes nothing.
  "build.scan": { tier: "A", run: (c) => { c.reply({ t: "build.candidates", repoDir: c.msg.repoDir, candidates: [], total: 0 }); } },
  "capture.cancel": CAPTURE,
  "capture.run": CAPTURE,
  "capture.save": CAPTURE,
  "assess.apply": ASSESS,
  "assess.discard": ASSESS,
  "assess.run": ASSESS,
  "fanout.followup": FANOUT,
  "fanout.run": FANOUT,
  "artifacts.save": STORE,
  "auth.clear": AUTH,
  "auth.gateTailscale": AUTH,
  "auth.set": AUTH,
  "budget.set": STORE,
  "billing.set": STORE,
  "closed.clear": STORE,
  "decisions.archive": STORE,
  "decisions.archiveAll": STORE,
  "decisions.delete": STORE,
  // A device's own install log, reported at boot: nothing to keep in a demo, and
  // a toast for it would greet every first look.
  "install.report": { tier: "A", run: () => {} },
  // The HTTP stall record: nothing to keep in a demo.
  "net.stalls": { tier: "A", run: () => {} },
  "intent.cancel": RUNS,
  "intent.requeue": RUNS,
  "intent.retarget": RUNS,
  "intent.run": RUNS,
  "intent.update": RUNS,
  "intent.waive": RUNS,
  "launch.cancel": RUNS,
  "launch.run": RUNS,
  "limit.first": LIMITS,
  "limit.resume": LIMITS,
  "limit.session": LIMITS,
  "host.halt": because("The demo has no AI processes to stop — on a real desktop this halts every agent session and holds automatic work until lifted."),
  "limit.setAuto": LIMITS,
  "limit.setMode": LIMITS,
  "backends.recheck": B,
  "localrt.evict": LOCALRT,
  // The strip renews this watch every 25 s; a refusal would toast each time over every demo screen.
  // Answered at once, as the real host always does (host/localrt.ts `localRtWatch`): silence is what
  // the phone words as "this desktop didn't answer" — an amber strip over every film. The demo
  // desktop measures nothing, which is exactly what a host with `WATERPLANE_LOCAL_RUNTIME=0` says:
  // one `disabled` frame, drawn as a muted "not polled here". The zeros are the wire's required
  // fields; the phone reads none of them while `disabled` is set, so no figure is made up.
  "localrt.watch": {
    tier: "A",
    run: (c) => { c.reply({ t: "localrt.sample", disabled: true, sample: { at: c.now, models: [], reachable: false, cpuPct: 0, memTotal: 0, memFree: 0 } }); },
  },
  "notification.clear": STORE,
  "notify.prefs.set": STORE,
  "plugin.action": PLUGINS,
  "plugin.call": PLUGINS,
  "plugin.enable": PLUGINS,
  "plugin.sessionAnswer": PLUGINS,
  "plugin.sessionToggle": PLUGINS,
  "plugin.set": PLUGINS,
  "pull.add": STORE,
  "pull.dismiss": STORE,
  "pull.get": STORE,
  "pull.save": STORE,
  "recent.clear": STORE,
  "schedule.run": RUNS,
  "schedule.setEnabled": STORE,
  "schedule.skipNext": STORE,
  "sent.clear": STORE,
  "stream.ack": DESKTOP,
  "stream.close": DESKTOP,
  "stream.input": DESKTOP,
  "stream.keyframe": DESKTOP,
  "stream.open": DESKTOP,
  "stream.params": DESKTOP,
  "update.apply": UPDATE,
  "updates.apply": UPDATE,
  "updates.check": UPDATE,
  "updates.get": UPDATE,
  "update.check": UPDATE,
  // A re-read answers the reading the demo holds (a scenario's turns move it). The app asks on
  // every screen change, so this is answered quietly like `usage.get`: a toast about the demo's own
  // numbers sat over six to sixteen seconds of every film. A reading is always held (`demoUsage`).
  "usage.refresh": {
    tier: "A",
    run: (c) => { const u = m(c).numbers?.usage; if (u) c.reply({ t: "usage.status", usage: u }); },
  },
} satisfies HandlerTable;

