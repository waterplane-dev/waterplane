/**
 * The demo desktop's sessions: a PTY that is a string, a turn that is a list
 * of timed steps, and a choice box that is the PARSED `SessionInfo.prompt` the
 * phone answers by tap — the real host's screen heuristics have already run,
 * so the fake emits their result, never just the bytes (plan §Risks).
 *
 * Time: a step list is laid out on `m.timeline` at absolute instants of the
 * injected clock and fired by `fireDue` (from `advance()` and after every
 * message). Nothing here sleeps; nothing here keeps state outside the model,
 * so a reload restores a turn mid-flight. A `clock` step moves the demo's own
 * time forward (`m.clockShift`, added by `Desk.now()` in index.ts) and lays
 * the rest of its list out from there.
 */
import { promptStillCurrent } from "@waterplane/shared";
import type { HistoryEntry, HostMessage, PermissionMode, SessionInfo } from "@waterplane/shared";
import { judgeBudget } from "./budget.ts";
import { autoContinue, parkAtWall } from "./usagewall.ts";
import { base64, mint, utf8 } from "./model.ts";
import type { DemoModel, DemoScreen, DemoStep, DemoTimedStep, Desk } from "./model.ts";
import { CLAUDE_BANNER } from "./banner.ts";
import { eraseFooter, footer, join, render } from "./cli.ts";

/** How much PTY text a session keeps for replay. The snapshot lives in
 *  sessionStorage, so the tail is bounded; `seq` still counts every byte. */
const SCREEN_KEEP = 32_000;

export const NO_REPLY =
  "\r\n● \x1b[2mThis demo has no scripted answer to that prompt. On your own desktop, claude would answer here.\x1b[0m\r\n";

export const SESSION_GONE = "That session is closed — open a new one from the repo list.";

const DEFAULT_BANNER = CLAUDE_BANNER;

export const sessions = (m: DemoModel): SessionInfo[] => (m.sessions ??= []);
export const findSession = (m: DemoModel, id: string): SessionInfo | undefined => sessions(m).find((s) => s.id === id);

const repoName = (cwd: string): string => cwd.split("/").filter(Boolean).pop() ?? cwd;

// ── the PTY ───────────────────────────────────────────────────────────────

/** Append `text` (the scenario's source form, `cli.ts`) to the session's transcript and stream it the
 *  way the CLI draws it: the input box lifted off, the new lines wrapped to the grid, the box again. */
export function write(d: Desk, id: string, text: string, silent = false): void {
  if (!text) return;
  const sc = paintOnce(d, id);
  sc.log = (sc.log ?? "") + text;
  if (sc.log.length > SCREEN_KEEP) sc.log = sc.log.slice(sc.log.length - SCREEN_KEEP);
  const r = render(text, sc.cols ?? 80, sc.endsBlank ?? true);
  sc.endsBlank = r.endsBlank;
  drawFooter(d, id, sc, r.lines.length ? join(r.lines) + "\r\n" : "", silent);
}

/** Redraw the CLI's live region (spinner + input box) in place, after a turn starts or ends. */
export function redrawFooter(d: Desk, id: string): void {
  const sc = d.m.screens?.[id];
  if (sc?.log != null) drawFooter(d, id, sc, "", false);
}

function drawFooter(d: Desk, id: string, sc: DemoScreen, body: string, silent: boolean): void {
  const rows = footer(findSession(d.m, id), sc.cols ?? 80, d.now(), sc.endsBlank ?? true);
  const out = eraseFooter(sc.foot ?? 0) + body + join(rows);
  sc.foot = rows.length;
  emit(d, id, sc, out, silent);
}

function emit(d: Desk, id: string, sc: DemoScreen, text: string, silent: boolean, replace = false): void {
  const bytes = utf8(text);
  sc.data = replace ? text : sc.data + text;
  sc.seq += bytes.length;
  if (sc.data.length > SCREEN_KEEP * 2) sc.data = sc.data.slice(sc.data.length - SCREEN_KEEP * 2);
  if (!silent) d.toSession(id, { t: "pty", id, dataB64: base64(bytes), seq: sc.seq });
}

/** The whole screen again from the transcript, at the grid's width (a resize, or a screen a scenario
 *  seeded as source and nobody has drawn yet). */
export function repaint(d: Desk, id: string, silent = false): void {
  const sc = d.m.screens?.[id];
  if (!sc) return;
  const r = render(sc.log ?? "", sc.cols ?? 80, true);
  sc.endsBlank = r.endsBlank;
  const rows = footer(findSession(d.m, id), sc.cols ?? 80, d.now(), r.endsBlank);
  sc.foot = rows.length;
  emit(d, id, sc, `\x1b[?25l\x1b[2J\x1b[3J\x1b[H${join([...r.lines, ...rows])}`, silent, true);
}

/** A seeded screen's `data` is source text (`log` unset): draw it once before anything is added. */
function paintOnce(d: Desk, id: string): DemoScreen {
  const screens = (d.m.screens ??= {});
  const sc = (screens[id] ??= { data: "", seq: 0 });
  if (sc.log == null) { sc.log = sc.data; sc.data = ""; repaint(d, id, true); }
  return sc;
}

/** The attach replay: the delta since `resumeSeq` when it is from this boot
 *  and still retained, the whole retained screen (`full`) otherwise, nothing
 *  when the client is already current. */
export function replay(d: Desk, id: string, resumeSeq?: number, resumeBoot?: string): { dataB64: string; seq: number; full?: boolean } | null {
  if (!d.m.screens?.[id]) return null;
  const sc = paintOnce(d, id);
  const bytes = utf8(sc.data);
  const base = sc.seq - bytes.length;
  const usable = resumeSeq != null && (!resumeBoot || resumeBoot === d.bootId) && resumeSeq >= base && resumeSeq <= sc.seq;
  if (usable) {
    if (resumeSeq === sc.seq) return null;
    return { dataB64: base64(bytes.slice(resumeSeq - base)), seq: sc.seq };
  }
  return { dataB64: base64(bytes), seq: sc.seq, full: true };
}

/** The retained screen as plain lines, for `/api/scrollback`. */
export function screenLines(m: DemoModel, id: string): string[] {
  const sc = m.screens?.[id];
  const src = sc ? (sc.log ?? sc.data) : "";
  return render(src, Infinity, true).lines.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
}

// ── sessions ──────────────────────────────────────────────────────────────

export function updateSession(d: Desk, id: string, patch: Partial<SessionInfo>, unset: (keyof SessionInfo)[] = []): void {
  const s = findSession(d.m, id);
  if (!s) return;
  Object.assign(s, patch);
  for (const k of unset) delete s[k];
  // The spend moved (or the session stopped): the host re-judges a budget at
  // the end of every spark refresh, and so does the demo.
  if ("contextSpark" in patch || "running" in patch) judgeBudget(d, s);
  d.broadcast({ t: "session.updated", session: s });
  if ("turnActive" in patch || "awaitingInput" in patch || unset.includes("turnActive")) redrawFooter(d, id);
}

export function createSession(d: Desk, o: { cwd: string; title?: string; cols?: number; rows?: number }): SessionInfo {
  const now = d.now();
  const info: SessionInfo = {
    id: mint(d.m, "demo"), cwd: o.cwd, title: o.title || repoName(o.cwd),
    remoteControl: false, running: true, createdAt: now, idle: true, idleSince: now,
    // A fresh claude's footer carries no mode label, which the host reads as Manual.
    liveMode: "default",
  };
  sessions(d.m).push(info);
  (d.m.screens ??= {})[info.id] = { data: "", seq: 0, cols: o.cols, rows: o.rows, log: (d.m.banner ?? DEFAULT_BANNER).replaceAll("{repo}", repoName(o.cwd)).replaceAll("{cwd}", o.cwd) };
  repaint(d, info.id, true);
  d.broadcast({ t: "session.created", session: info });
  return info;
}

export function killSession(d: Desk, id: string): boolean {
  const s = findSession(d.m, id);
  if (!s) return false;
  if (s.running) {
    s.running = false;
    delete s.prompt;
    delete s.turnActive;
    if (d.m.boxes) delete d.m.boxes[id];
    d.m.timeline = (d.m.timeline ?? []).filter((e) => e.sessionId !== id);
    d.broadcast({ t: "session.exit", id, code: null });
    d.broadcast({ t: "session.updated", session: s });
  }
  return true;
}

export function removeSession(d: Desk, id: string): void {
  const s = findSession(d.m, id);
  killSession(d, id);
  d.m.sessions = sessions(d.m).filter((x) => x.id !== id);
  if (d.m.screens) delete d.m.screens[id];
  if (d.m.composer) delete d.m.composer[id];
  if (s) {
    (d.m.closed ??= []).unshift({ id, cwd: s.cwd, title: s.title, closedAt: d.now(), closedBy: "you", firstPrompt: s.firstPrompt, lastPrompt: s.lastPrompt,
      // The flag outlives the session (kept per conversation on the host).
      ...(s.followUp ? { followUp: s.followUp } : {}) });
    d.broadcast({ t: "session.closed", id, shellsStopped: 0, shellsLeft: 0 });
    d.broadcast({ t: "closed.list", closed: d.m.closed });
  }
  d.broadcast({ t: "session.list", sessions: sessions(d.m) });
}

export function recordHistory(d: Desk, id: string, text: string, kind: HistoryEntry["kind"]): void {
  const rows = ((d.m.history ??= {})[id] ??= []);
  // A scenario seeds its past rows with ids of the same shape (`h-1`); a minted one that matched
  // would share that row's turn facts, and the reader would price two turns as one.
  let rowId = mint(d.m, "h");
  while (rows.some((r) => r.id === rowId)) rowId = mint(d.m, "h");
  rows.push({ id: rowId, kind, text, sentAt: d.now() });
}

// ── turns ─────────────────────────────────────────────────────────────────

/** A submitted prompt: echo it, start the turn, lay out the scripted reply. */
export function submit(d: Desk, id: string, raw: string, echo = true): void {
  const s = findSession(d.m, id);
  if (!s) return;
  const text = raw.replace(/\r+$/, "");
  if (echo) write(d, id, `\x1b[1m>\x1b[0m ${text}\r\n`);
  recordHistory(d, id, text, "prompt");
  const now = d.now();
  if (effortCommand(d, id, text)) return;
  updateSession(d, id, { lastPrompt: text, firstPrompt: s.firstPrompt ?? text, turnActive: true, turnStartedAt: now, idle: false, lastTurnAt: now }, ["idleSince"]);
  const q = text.toLowerCase();
  const rule = (d.m.replies ?? []).find((r) =>
    (!r.match || q.includes(r.match.toLowerCase())) && (!r.cwd || s.cwd === r.cwd || s.cwd.startsWith(`${r.cwd}/`)));
  const steps: DemoTimedStep[] = rule ? [...rule.steps] : [{ kind: "output", text: NO_REPLY, afterMs: 400 }];
  steps.push({ kind: "turnEnd" });
  schedule(d, id, steps);
}

/** `/effort <level>` and `/effort ultracode on|off`, answered the way the CLI
 *  does — a line on screen, no turn — and recorded on the session so the
 *  phone's wheel and ultracode row read them back. False for anything else. */
function effortCommand(d: Desk, id: string, text: string): boolean {
  const m = /^\/effort\s+(?:ultracode\s+(on|off)|(low|medium|high|xhigh|max))\s*$/i.exec(text.trim());
  if (!m) return false;
  if (m[1]) {
    const on = m[1].toLowerCase() === "on";
    write(d, id, on ? "Ultracode on for this session\r\n" : "Ultracode off\r\n");
    updateSession(d, id, { ultracode: on });
  } else {
    const effort = m[2].toLowerCase() as NonNullable<SessionInfo["effort"]>;
    write(d, id, `Set effort level to ${effort}\r\n`);
    updateSession(d, id, { effort });
  }
  return true;
}

/** `session.mode`: what the host does with shift+tab, minus the keys. The
 *  cycle is the CLI's four, plus `bypassPermissions` only for a session
 *  launched with it; anything else is refused in the host's shape — the
 *  footer's mode (unchanged) and the sentence why. */
export function switchMode(d: Desk, id: string, mode: PermissionMode): { ok: boolean; mode?: PermissionMode; reason?: string } {
  const s = findSession(d.m, id);
  if (!s || !s.running) return { ok: false, reason: SESSION_GONE };
  const cur = s.liveMode ?? s.permissionMode ?? "default";
  const cycle: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];
  if (s.permissionMode === "bypassPermissions") cycle.push("bypassPermissions");
  if (!cycle.includes(mode)) {
    return { ok: false, mode: cur, reason: `${mode} is not in this session’s shift+tab cycle — it exists only in a session launched with it.` };
  }
  updateSession(d, id, { liveMode: mode });
  return { ok: true, mode };
}

/** Lay `steps` out from `from` (default now). A `prompt` step holds the rest of
 *  the list until it is answered, so its answer's steps run first and the rest
 *  after; a `clock` or `autoContinue` holds it until it fires, so what follows
 *  is paced from the instant it fired at; a `wall` hands it to the
 *  `autoContinue` it lays out at the reset. */
export function schedule(d: Desk, sessionId: string | undefined, steps: readonly DemoTimedStep[], from = d.now()): void {
  const tl = (d.m.timeline ??= []);
  let at = from;
  for (let i = 0; i < steps.length; i++) {
    const { afterMs, ...step } = steps[i];
    at += Math.max(0, afterMs ?? 0);
    const n = (d.m.minted = (d.m.minted ?? 0) + 1);
    if (step.kind === "prompt" || step.kind === "clock" || step.kind === "autoContinue" || step.kind === "wall") {
      tl.push({ at, n, sessionId, step, rest: steps.slice(i + 1) });
      return;
    }
    tl.push({ at, n, sessionId, step });
  }
}

/** Fire every timeline entry due by now, in time order. True when any did. */
export function fireDue(d: Desk): boolean {
  let fired = false;
  for (;;) {
    const tl = d.m.timeline ?? [];
    const now = d.now();
    let best = -1;
    tl.forEach((e, i) => {
      if (e.at <= now && (best < 0 || e.at < tl[best].at || (e.at === tl[best].at && e.n < tl[best].n))) best = i;
    });
    if (best < 0) return fired;
    const [e] = tl.splice(best, 1);
    runStep(d, e.step, e.sessionId, e.rest);
    fired = true;
  }
}

/** Move the demo's time forward to `to`; never backwards. */
export function jumpClock(d: Desk, to: number): void {
  const by = to - d.now();
  if (by > 0) d.m.clockShift = (d.m.clockShift ?? 0) + by;
}

/**
 * A broadcast frame written into the model too, so the READ that asks for the
 * same thing later (`usage.get`, `decisions.get`, …) answers what was pushed —
 * the real host has one copy of each, never a pushed one and a stored one.
 * Only frames with a home in the model; any other is broadcast and forgotten.
 */
export function keepFrame(m: DemoModel, msg: HostMessage): void {
  switch (msg.t) {
    case "usage.status": (m.numbers ??= {}).usage = msg.usage; return;
    case "decisions.log": m.decisions = msg.entries; return;
    case "notification.list": m.notifications = msg.items; return;
    case "limit.config": m.limitConfig = { enabled: msg.enabled, ...(msg.mode ? { mode: msg.mode } : {}) }; return;
    case "netretry.config": m.netRetry = { enabled: msg.enabled, ...(msg.envOff ? { envOff: true } : {}) }; return;
    case "intent.list": m.intents = msg.intents; return;
    default: return;
  }
}

export const nextDue = (m: DemoModel): number | null =>
  (m.timeline ?? []).reduce<number | null>((min, e) => (min == null || e.at < min ? e.at : min), null);

/** One step, now. `fallbackId` is the session a scripted reply belongs to. */
export function runStep(d: Desk, step: DemoStep, fallbackId?: string, rest: DemoTimedStep[] = []): void {
  if (step.kind === "frame") {
    if (step.keep) keepFrame(d.m, step.msg);
    d.broadcast(step.msg);
    return;
  }
  if (step.kind === "clock") {
    jumpClock(d, step.to);
    schedule(d, fallbackId, rest);
    return;
  }
  if (step.kind === "usage") {
    const usage = { ...step.usage, checkedAt: d.now() };
    (d.m.numbers ??= {}).usage = usage;
    d.broadcast({ t: "usage.status", usage });
    return;
  }
  const id = step.sessionId ?? fallbackId;
  if (!id || !findSession(d.m, id)?.running) return;
  switch (step.kind) {
    case "output": write(d, id, step.text); return;
    case "session": updateSession(d, id, step.patch, step.unset); return;
    case "prompt":
      (d.m.boxes ??= {})[id] = { answers: step.answers ?? {}, rest };
      updateSession(d, id, { prompt: step.prompt, awaitingInput: true });
      return;
    case "turnEnd": endTurn(d, id); return;
    case "facts": {
      const row = (d.m.history?.[id] ?? []).filter((h) => h.kind === "prompt").at(-1);
      if (!row) return;
      ((d.m.turnFacts ??= {})[id] ??= {})[row.id] = step.facts;
      row.outputAt ??= d.now(); // the log's last record of the turn: when it ended
      // The same log feeds the context series: its newest reading is this turn's last request.
      const doc = d.m.numbers?.context?.[id] as { updatedAt: number; samples?: { t: number; tok: number }[]; turns?: number } | undefined;
      if (doc && Array.isArray(doc.samples) && step.facts.ctxTok) {
        doc.samples.push({ t: d.now(), tok: step.facts.ctxTok });
        if (typeof doc.turns === "number") doc.turns += 1;
        doc.updatedAt = d.now();
      }
      return;
    }
    case "artifact": landArtifact(d, id, step.repoId, step.relPath, step.size); return;
    case "deliverable": landDeliverable(d, id, step.repoId, step.relPath, step.size); return;
    case "wall": {
      const s = findSession(d.m, id);
      if (!s) return;
      const auto = parkAtWall(d, s, step.resetAt);
      if (auto) schedule(d, id, [{ kind: "autoContinue" }, ...(step.resumed ?? []), ...rest], Math.max(d.now(), step.resetAt));
      schedule(d, id, step.meanwhile ?? []);
      return;
    }
    case "autoContinue": {
      const s = findSession(d.m, id);
      if (!s || autoContinue(d, s) !== "continued") return;
      // What the host types, echoed the way the CLI echoes a prompt, and the
      // history row its `recordPrompt` writes.
      write(d, id, `\x1b[1m>\x1b[0m continue\r\n`);
      recordHistory(d, id, "continue (auto, usage limit reset)", "backlog");
      schedule(d, id, rest);
      return;
    }
  }
}

/** A file this session's turn wrote into the outbox (`artifact` step): what the
 *  real host's turn-end scan reports — the gallery entry and its badge, the
 *  session's new-images strip, and one `image` notification. */
function landArtifact(d: Desk, id: string, repoId: string, relPath: string, size: number): void {
  const now = d.now();
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const files = ((d.m.gallery ??= {})[repoId] ??= []) as unknown[];
  if (!files.some((f) => (f as { relPath?: unknown })?.relPath === relPath)) files.unshift({ name, relPath, size, mtime: now, ctime: now });
  const repo = (d.m.repos ?? []).find((r) => !!r && typeof r === "object" && (r as { id?: unknown }).id === repoId) as { outboxCount?: number; repoName?: string } | undefined;
  if (repo) repo.outboxCount = (repo.outboxCount ?? 0) + 1;
  d.broadcast({ t: "session.images", id, repoId, images: [{ name, relPath, mtime: now }] });
  const item = {
    id: mint(d.m, "n"), ts: now, kind: "image" as const, title: `New screenshot in ${repo?.repoName ?? "the repo"}`, body: name,
    sessionId: id, image: { repoId, relPath },
  };
  (d.m.notifications ??= []).unshift(item);
  d.broadcast({ t: "notification", item });
}

/** A non-picture deliverable this session's turn wrote into the outbox (`deliverable` step): the
 *  gallery entry and its badge, and the one notification the real host's turn-end scan sends for
 *  it (`server/sessionEvents.ts`: "Outbox: <name>", its size, the session, "tap to download"). */
function landDeliverable(d: Desk, id: string, repoId: string, relPath: string, size: number): void {
  const now = d.now();
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const files = ((d.m.gallery ??= {})[repoId] ??= []) as unknown[];
  if (!files.some((f) => (f as { relPath?: unknown })?.relPath === relPath)) files.unshift({ name, relPath, size, mtime: now, ctime: now });
  const repo = (d.m.repos ?? []).find((r) => !!r && typeof r === "object" && (r as { id?: unknown }).id === repoId) as { outboxCount?: number } | undefined;
  if (repo) repo.outboxCount = (repo.outboxCount ?? 0) + 1;
  const mb = `${(size / (1024 * 1024)).toFixed(1)} MB`;
  const item = {
    id: mint(d.m, "n"), ts: now, kind: "artifact" as const, title: `Outbox: ${name}`,
    body: `${mb} · ${findSession(d.m, id)?.title ?? "this session"} — tap to download`,
    sessionId: id, file: { repoId, relPath, name, size, mtime: now },
  };
  (d.m.notifications ??= []).unshift(item);
  d.broadcast({ t: "notification", item });
}

function endTurn(d: Desk, id: string): void {
  const now = d.now();
  updateSession(d, id, { turnActive: false, idle: true, idleSince: now, awaitingInput: false }, ["turnStartedAt"]);
  const items = d.m.backlog?.items ?? [];
  let changed = false;
  for (const it of items) {
    if (it.status === "running" && it.sessionId === id) { it.status = "done"; it.finishedAt = now; changed = true; }
  }
  if (changed) d.broadcast(backlogFrame(d.m));
}

export function backlogFrame(m: DemoModel): Extract<HostMessage, { t: "backlog.list" }> {
  return { t: "backlog.list", items: m.backlog?.items ?? [], auto: m.backlog?.auto ?? false, idleMs: m.backlog?.idleMs ?? 60_000 };
}

/** Answer the open box with `key` ("1", "submit", "esc", …). */
export function answer(d: Desk, id: string, key: string): void {
  const s = findSession(d.m, id);
  const box = d.m.boxes?.[id] ?? { answers: {}, rest: [] };
  const label = s?.prompt?.options.find((o) => String(o.index) === key)?.label;
  if (d.m.boxes) delete d.m.boxes[id];
  updateSession(d, id, { awaitingInput: false }, ["prompt"]);
  if (label) write(d, id, `\x1b[2m  ⎿ ${label}\x1b[0m\r\n`);
  const chosen = box.answers[key] ?? box.answers["*"] ?? [];
  schedule(d, id, [...chosen, ...box.rest]);
}

/** Put a box on a session outside any script (the `prompt` fault). */
export function openBox(d: Desk, id: string): void {
  runStep(d, {
    kind: "prompt", sessionId: id,
    prompt: { kind: "tool", question: "Do you want to make this edit to src/todo.ts?", options: [{ index: 1, label: "Yes" }, { index: 2, label: "No, and tell Claude what to do differently" }] },
  });
}

// ── input ─────────────────────────────────────────────────────────────────

export interface InputVerdict {
  ok: boolean;
  reason?: string;
  state?: "ok" | "stale";
}

/** `session.input` as the real route reads it: answer, submit, or keys. */
export function input(d: Desk, msg: { id: string; data: string; submit?: boolean; expectPrompt?: string; promptSubmit?: boolean; promptChoice?: number }): InputVerdict {
  const s = findSession(d.m, msg.id);
  if (!s || !s.running) return { ok: false, reason: SESSION_GONE };
  if (msg.expectPrompt) {
    if (!promptStillCurrent(s.prompt, msg.expectPrompt)) {
      return { ok: false, state: "stale", reason: s.prompt ? "that question was replaced by a different one" : "that question is no longer open" };
    }
    const digit = /^(\d{1,2})\r?$/.exec(msg.data ?? "");
    const key = msg.promptSubmit ? "submit"
      : msg.promptChoice != null ? String(msg.promptChoice)
      : digit ? digit[1]
      : msg.data === "\x1b" ? "esc" : "*";
    answer(d, msg.id, key);
    return { ok: true };
  }
  if (msg.submit) {
    submit(d, msg.id, msg.data);
    return { ok: true, state: "ok" };
  }
  keys(d, msg.id, msg.data ?? "");
  return { ok: true };
}

/** Raw keystrokes into the composer: echo, Backspace, Return submits; a
 *  digit or Esc at an open box answers it, as the TUI would. */
function keys(d: Desk, id: string, data: string): void {
  const comp = (d.m.composer ??= {});
  const s = findSession(d.m, id);
  if (s?.prompt) {
    const digit = /^(\d{1,2})\r?$/.exec(data);
    if (digit && !s.prompt.multi) { answer(d, id, digit[1]); return; }
    if (data === "\x1b") { answer(d, id, "esc"); return; }
  }
  for (const tok of data.match(/\x1b\[[0-9;?]*[A-Za-z~]|\x1b.?|[\s\S]/g) ?? []) {
    if (tok === "\r" || tok === "\n") {
      const line = comp[id] ?? "";
      comp[id] = "";
      if (line.trim()) { write(d, id, "\r\n"); submit(d, id, line, false); }
    } else if (tok === "\x7f" || tok === "\b") {
      if (comp[id]) { comp[id] = comp[id].slice(0, -1); write(d, id, "\b \b"); }
    } else if (tok >= " " && !tok.startsWith("\x1b")) {
      comp[id] = (comp[id] ?? "") + tok;
      write(d, id, tok);
    }
  }
}
