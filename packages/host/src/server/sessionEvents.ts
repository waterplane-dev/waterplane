/**
 * Every `sessions.on(…)` main.ts registers, the plugin events they fire
 * (`plugins.firePrompt`/`fireQuestion`), and the usage-limit event log
 * (`logLimitEvent`, `fmtClock`, `fmtDur`).
 *
 * Moved verbatim out of `main.ts` (M5 of the host split, see
 * docs/notes/host-architecture.md). Every main-scope name is read as
 * `ctx.<name>` at CALL time: several listeners reach names (`updates`,
 * `plugins`, `decisionLog`, `usage`, the scan maps) that main defines AFTER the
 * position this is wired at, and are correct only because no session event is
 * emitted before `main()` runs.
 *
 * **Listener order is behaviour.** The registrations below are main's, in
 * main's order: the `turnEnded`/`exit` → intents pair FIRST, and the three
 * `exit` listeners (intents, the `session.exit` broadcast, the scan-baseline
 * cleanup) fire in that order. Nothing else in the host subscribes to
 * `sessions`, and everything main ran between today's registrations is
 * synchronous and emits nothing on it, so wiring all fifteen at once, at the
 * position of today's first one, keeps every session listener's relative order.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { keepLastLines } from "../jsonstore.js";
import { basename, join } from "node:path";
import type { DetectedPrompt, FollowUp, HistoryEntry, HostMessage, SessionInfo, TurnEndNet } from "@waterplane/shared";
import { AGENT_WINDOW_WARN_KEY, followUpPushText } from "@waterplane/shared";
import { createAgentWatch } from "../agentwatch.js";
import { isMarkdownPath, readsInline } from "../files.js";
import { stripFresh } from "./scan.js";
import { forgetRules } from "../answergate.js";
import { targetId } from "../repos.js";
import { detectPrompt, dialogEvidence, dialogStillUp, stripAnsi } from "../prompt.js";
import { looksLikeQuestion, questionText } from "../question.js";
import type { WebSocket } from "ws";
import type { ServerCtx } from "./ctx.js";
import { ptyFrameAction, ptyHoldsStreams } from "./liveness.js";
import { WS_PTY_BACKLOG_BYTES } from "./wsops.js";
import { env } from "../env.js";
import { logTag, envName, sessionBudgetHoldText, sessionBudgetText, workingLine } from "@waterplane/shared";
import { openDeliveries } from "../opendeliveries.js";
import { peerJobOriginAt } from "../peers/serve.js";
import { createBudgetCalibrator } from "../sessionbudget.js";
import { backendInfos, onBackendsChanged, primeNewBackendModels } from "../backends/index.js";
import { hostStateDir } from "../branddirs.js";
import { noteOptInSends } from "../optins.js";

export function wireSessionEvents(ctx: ServerCtx) {
  // A closed row says how its item SETTLED (`roster.ts`'s `closedRowOf`) —
  // read at close time, through the store, never a copy of it.
  ctx.sessions.setItemLookup((itemId) => ctx.intents.get(itemId));
  // The ONE completion watcher. There used to be two of these — the backlog's and
  // the fan-out's — subscribing to the same two events and keeping the same two
  // maps; this is the commit that deletes one.
  // …and a HARD session budget re-owes its Esc for the next turn while over
  // (`sessions/budgetwatch.ts`; sent by the judge that sees it working).
  // A turn the CLI gave up on a transient API error carries `net`
  // (`sessions/apiretry.ts`): the intents do not complete off it. The budget
  // still counts it — the retry's `continue` is a turn that spends, and a HARD
  // budget over owes it its Esc exactly as any other.
  ctx.sessions.on("turnEnded", (id: string, stopCount: number, net?: TurnEndNet) => { ctx.intents.onTurnEnded(id, stopCount, net); ctx.sessions.budgetTurnEnded(id); });
  // The late answer to a `checking` turn end (or the halt stopping a retry):
  // the intents only — the budget already counted that turn.
  ctx.sessions.on("netTurnSettled", (id: string, stopCount: number, net: TurnEndNet | null) => ctx.intents.onTurnEnded(id, stopCount, net ?? undefined));
  ctx.sessions.on("exit", (id: string) => ctx.intents.onSessionExit(id));

  // The CLI's own on-screen "Update available!" nag → surface the update button
  // immediately, even while the Homebrew cask still lags the npm release.
  ctx.sessions.on("updateBanner", (latest?: string) => ctx.updates.noteBanner(latest));

  // PTY output goes only to sockets attached to that session — and not into a
  // socket whose send buffer is already past `WS_PTY_BACKLOG_BYTES`
  // (`liveness.ts`): its deltas are dropped, the session marked starved for
  // that socket, and the first frame after it drains is ONE full replay
  // (`routes/session.ts`'s attach shape) in place of the delta. `seq` already
  // counts this chunk when `data` fires, so the replay's `seq` is this frame's.
  // Only here: every other frame type is sent as before, whatever the buffer.
  const starved = new WeakMap<WebSocket, Set<string>>();
  ctx.sessions.on("data", (id: string, chunk: string, seq: number) => {
    let frame: HostMessage | null = null;
    for (const ws of ctx.clients) {
      if (!ctx.attached.get(ws)?.has(id)) continue;
      const mine = starved.get(ws);
      const action = ptyFrameAction(ws.bufferedAmount, WS_PTY_BACKLOG_BYTES, !!mine?.has(id));
      if (action === "skip") {
        if (mine) mine.add(id); else starved.set(ws, new Set([id]));
      } else if (action === "resync") {
        mine?.delete(id);
        const rep = ctx.sessions.attachReplay(id, undefined);
        if (rep) ctx.send(ws, { t: "pty", id, dataB64: Buffer.from(rep.data, "utf8").toString("base64"), seq: rep.seq, full: rep.full });
      } else {
        frame ??= { t: "pty", id, dataB64: Buffer.from(chunk, "utf8").toString("base64"), seq };
        ctx.send(ws, frame);
      }
    }
  });
  ctx.sessions.on("exit", (id: string, code: number | null) => {
    ctx.broadcast({ t: "session.exit", id, code });
    // A standing rule a person made lives exactly as long as its session (`answergate.ts`).
    forgetRules({ sessionId: id });
    ctx.resolveAttention(`prompt:${id}`, "session closed");
  });
  ctx.sessions.on("closed", (closed) => ctx.broadcast({ t: "closed.list", closed }));
  ctx.sessions.on("updated", (info: SessionInfo) => {
    ctx.broadcast({ t: "session.updated", session: info });
    // An attention item resolves by its cause: the box is gone (answered, or the turn moved on)
    // / the follow-up flag was cleared. A silent no-op when nothing matches.
    if (!info.prompt && !info.awaitingInput && !info.asking) ctx.resolveAttention(`prompt:${info.id}`, "answered");
    if (!info.followUp) ctx.resolveAttention(`followup:${info.id}`, "flag cleared");
  });
  ctx.sessions.on("followUpCleared", (ids: string[]) => {
    for (const k of ids) ctx.resolveAttention(`followup:${k}`, "flag cleared");
  });
  // A follow-up flag nobody tapped (a launch option on finishing, or the session's
  // agent): one push saying who and why. A hand flag never gets here (`roster.ts`).
  ctx.sessions.on("followUp", (info: SessionInfo, f: FollowUp) => {
    const p = followUpPushText(f, info.tabTitle || info.title);
    // The launch option ("flag when done") is a receipt, so info; the session's own agent asking is attention.
    if (p) ctx.notify("followup", { ...p, sessionId: info.id, tag: `followup-${info.id}`, key: `followup:${info.id}`, ...(f.by === "launch" ? { level: "info" as const } : {}) });
  });
  // History updates stream only to sockets viewing that session (like PTY frames).
  ctx.sessions.on("history", (id: string, entries: HistoryEntry[]) => {
    const frame: HostMessage = { t: "session.history", id, entries };
    for (const ws of ctx.clients) if (ctx.attached.get(ws)?.has(id)) ctx.send(ws, frame);
    // An opt-in's words sent here are remembered past the session (`optins.ts`).
    const cwd = ctx.sessions.get(id)?.cwd;
    if (cwd) noteOptInSends(cwd, entries);
  });

  // Fires for every session, including ones the backlog creates internally.
  ctx.sessions.on("created", (info: SessionInfo) => {
    // A delegated job's worktree says why a session in it exists ("job from mac · …") —
    // set before the first broadcast, so the row is never drawn without it.
    const origin = peerJobOriginAt(info.cwd);
    if (origin) info.peerJob = origin;
    ctx.broadcast({ t: "session.created", session: info });
    ctx.broadcast({ t: "recent.list", recent: ctx.sessions.listRecent() });
    // Snapshot pre-existing images/outbox files so they aren't reported as "new".
    // The two repo-wide walks run in the background (a sync walk froze the host on WSL), so each
    // lands only if nothing seeded that baseline meanwhile (a turn end re-seeds a missing pull
    // snapshot itself) and the session is still there to own it.
    const live = () => ctx.sessions.list().some((s) => s.id === info.id);
    void ctx.scanImages(info.cwd).then((imgs) => {
      if (live() && !ctx.imgSeen.has(info.id)) ctx.imgSeen.set(info.id, new Map(imgs.map((i) => [i.relPath, i.mtime])));
    }, () => {});
    // Only when the repo has no baseline yet. A second session opening in a
    // checkout must not RE-seed it: that would mark anything produced since the
    // first session opened as already seen, and swallow the notification for a
    // file nobody has been told about.
    if (!ctx.outSeen.has(info.cwd)) ctx.outSeen.set(info.cwd, new Set(ctx.scanOutboxDocs(info.cwd).map((f) => f.relPath)));
    const pullCfg = ctx.autopull.config(info.cwd);
    void ctx.scanPullCandidates(info.cwd, pullCfg.scope).then((found) => {
      if (live() && !ctx.pullSeen.has(info.id)) ctx.pullSeen.set(info.id, { scope: pullCfg.scope, paths: new Set(found.map((f) => f.relPath)) });
    }, () => {});
    // Opening a session is the moment a repo starts being driven from the phone —
    // and the moment its wiring starts to matter. Re-check it here as well as on
    // the sweep, so a repo created between two sweeps is never driven unchecked.
    // Deferred: this shells out to git, and a session create must not wait for it.
    setImmediate(() => { try { ctx.setupWatch.check(info.cwd, basename(info.cwd)); } catch { /* never break a create */ } });
  });
  ctx.sessions.on("exit", (id: string) => {
    ctx.imgSeen.delete(id);
    ctx.pullSeen.delete(id);
    // `outSeen` is keyed by REPO, so one session ending is not a reason to forget
    // that repo's baseline — its siblings are still running against it. Drop only
    // the checkouts nothing is open in any more; re-opening one re-seeds it, which
    // is the same "don't report what was already there" rule as on create.
    const live = new Set(ctx.sessions.list().filter((s) => s.running).map((s) => s.cwd));
    for (const cwd of [...ctx.outSeen.keys()]) if (!live.has(cwd)) ctx.outSeen.delete(cwd);
    // The last percent-budget session ending is the poll losing its reason to
    // run (`wantsBudgetUsage` counts RUNNING sessions) — each poll spawns claude.
    ctx.syncUsagePolling();
  });

  // A dialog we could not parse into options (prompt.ts fell short, or the TUI
  // changed shape). No one-tap buttons to offer — just say where it is.
  ctx.sessions.on("awaiting", (id: string) => {
    const s = ctx.sessions.get(id);
    ctx.notify("prompt", {
      title: `${s?.title ?? "Session"} needs you`,
      body: "A dialog is open in the CLI — open the session to answer.",
      sessionId: id, tag: `prompt-${id}`, key: `prompt:${id}`,
    });
  });

  // Notifications: prompt waiting + turn finished.
  ctx.sessions.on("prompt", (id: string, prompt: DetectedPrompt) => {
    const s = ctx.sessions.get(id);
    const opts = prompt.options.map((o) => `${o.index}. ${o.label}`).join("  ");
    ctx.notify("prompt", { title: `${s?.title ?? "Session"} needs you`, body: `${prompt.question}\n${opts}`, sessionId: id, tag: `prompt-${id}`, key: `prompt:${id}` });

    // Plugins hear about every box (docs/notes/plugins.md). `blocked` is the
    // core's gate verdict, precomputed; answering goes through that gate.
    ctx.plugins.firePrompt(id, prompt);
  });

  // ── Usage-limit lifecycle → console log + persisted event log + notifications ──
  // Every phase is logged (console + <STATE_DIR>/limit-events.jsonl) so an
  // unattended night of blocks/attempts is auditable; blocked/attempt/resumed/
  // gaveup also notify the phone AND land in the decision log (`source: "limit"`)
  // so the in-app log shows the whole story next to the plugins' decisions
  // ("scheduled" is log-only).
  const LIMIT_LOG = join(hostStateDir(ctx.ROOT), "limit-events.jsonl");
  function logLimitEvent(e: Record<string, unknown>): void {
    try {
      mkdirSync(hostStateDir(ctx.ROOT), { recursive: true });
      appendFileSync(LIMIT_LOG, JSON.stringify(e) + "\n");
      // Rotate: keep the newest ~500 events once the file grows past 256 KB.
      if (statSync(LIMIT_LOG).size > 256 * 1024) {
        keepLastLines(LIMIT_LOG, 500);
      }
    } catch { /* logging must never break the host */ }
  }
  const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fmtDur = (ms: number) => {
    const m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };

  // The resume queue's host-wide half (who is resuming, the hold-off after a
  // failed resume) is not a property of any one session, so it rides on
  // limit.config rather than SessionInfo.
  ctx.sessions.on("limitQueue", () => {
    ctx.broadcast({ t: "limit.config", enabled: ctx.sessions.getAutoContinue(), ...ctx.sessions.resumeState() });
  });

  ctx.sessions.on("limit", (id: string, info: SessionInfo, phase: "blocked" | "scheduled" | "attempt" | "resumed" | "gaveup") => {
    const lim = info.limit;
    const when = lim?.resetAt ? fmtClock(lim.resetAt) : null;
    const next = lim?.nextAttemptAt ? fmtClock(lim.nextAttemptAt) : null;
    console.log(
      `${logTag} limit ${phase} · ${info.title} (${id})` +
      (lim ? ` · attempts=${lim.attempts}${when ? ` reset~${when}` : ""}${next ? ` next=${next}` : ""}` : ""),
    );
    logLimitEvent({ ts: Date.now(), phase, sessionId: id, title: info.title, cwd: info.cwd, attempts: lim?.attempts ?? 0, resetAt: lim?.resetAt ?? null, nextAttemptAt: lim?.nextAttemptAt ?? null, autoContinue: lim?.autoContinue ?? null });

    // Auto-continue plan, phrased once for the notification, log entry and card.
    // (Wording deliberately dodges the detection regexes in limit.ts — this file
    // printed inside a session must not trip them.)
    const retryMin = Math.max(1, Math.round(Number(env("LIMIT_RETRY_MS") || 600000) / 60000));
    // A source wall nobody can date (`SessionLimit.needsYou`) schedules nothing: say so, in the
    // backend's own words, never "will retry".
    const plan = lim?.needsYou
      ? `nothing is retried by itself — it needs you: ${lim.needsYou}`
      : lim?.autoContinue
      ? (when ? `auto-continue after the reset (~${when})` : `auto-continue will retry every ${retryMin} min`)
      : "auto-continue is off — resume manually";
    const dur = lim?.blockedSince ? fmtDur(Date.now() - lim.blockedSince) : "";
    const att = lim?.attempts ?? 0;

    // Activity-log entry ("scheduled" ticks stay out — they'd drown the log).
    if (phase !== "scheduled") {
      const question =
        phase === "blocked" ? (lim?.needsYou ? "Session stopped: its CLI reports a wall with no time it lifts." : "Session stopped at the Claude usage limit.")
        : phase === "attempt" ? `Auto-continue attempt ${att} — typing "continue" into the session.`
        : phase === "resumed" ? "Usage limit lifted — session resumed."
        : `Auto-continue gave up after ${att} attempt${att === 1 ? "" : "s"}.`;
      const rationale =
        phase === "blocked" ? plan.charAt(0).toUpperCase() + plan.slice(1) + "."
        : phase === "attempt" ? (next ? `If still blocked, next retry ~${next}.` : "")
        : phase === "resumed" ? `${att} attempt${att === 1 ? "" : "s"}${dur ? ` · blocked ${dur}` : ""}`
        : "Still blocked — resume manually.";
      ctx.decisionLog.add({
        id: randomUUID().slice(0, 8), ts: Date.now(), sessionId: id, sessionTitle: info.title,
        source: "limit", phase, question, options: [], choice: null, rationale, outcome: "limit",
      });
    }

    if (phase === "blocked") {
      ctx.notify("limit", { title: `${lim?.needsYou ? "Needs you" : "Usage limit"} · ${info.title}`, body: plan, sessionId: id, tag: `limit-${id}` });
    } else if (phase === "attempt") {
      ctx.notify("limit", {
        title: `Auto-continue sent · ${info.title}`,
        body: `attempt ${lim?.attempts ?? "?"} — "continue" typed; still blocked → retry${next ? ` ~${next}` : " later"}`,
        sessionId: id, tag: `limit-${id}`, // replaces the "blocked" push (state update, not a new thread)
      });
    } else if (phase === "resumed") {
      ctx.notify("limit", { title: `Session resumed · ${info.title}`, body: `usage limit lifted after ${att} attempt${att === 1 ? "" : "s"}${dur ? ` · blocked ${dur}` : ""} — work continues`, sessionId: id, tag: `limit-${id}-done`, outcome: "ok" });
      ctx.resolveAttention(`limit:${id}`, "session resumed");
    } else if (phase === "gaveup") {
      ctx.notify("limit", { title: `Auto-continue gave up · ${info.title}`, body: `still limit-blocked after ${att} attempts — resume manually`, sessionId: id, tag: `limit-${id}-done`, outcome: "failed", key: `limit:${id}` });
    }
  });

  ctx.sessions.on("idle", (id: string, info: SessionInfo) => {
    // Turn finished ⇒ give the tab its name, once, off the first prompt
    // (a no-op once named, asked, or with no prompt yet).
    void ctx.sessions.nameTab(id);

    // A limit-blocked session isn't a finished turn — the limit notification
    // already covers it; a "Turn finished" ping on top would mislead.
    if (info.limit?.blocked) return;

    // Free-text question at turn end (no numbered prompt): plugins hear it
    // (one may draft a reply — suggest-only), and the phone is told WHAT is
    // being asked rather than "Turn finished". `sessions.checkAsking` has
    // already published the question on the session; that ping is the one
    // that used to bury a decision under the same three words every completed
    // turn sends.
    const tail = ctx.sessions.scrollback(id).slice(-4000);
    if (!info.prompt && (info.asking || looksLikeQuestion(tail))) {
      ctx.plugins.fireQuestion({ sessionId: id, question: info.asking?.text ?? questionText(tail), tail: stripAnsi(tail) });
    }
    if (info.asking) {
      ctx.notify("prompt", {
        title: `Needs your decision · ${info.title}`,
        body: info.asking.text,
        sessionId: id, tag: `prompt-${id}`, key: `prompt:${id}`,
      });
    } else {
      // "Turn finished" is the main loop's fact and not always the whole one: a
      // turn that ended by launching background agents left them working, and a
      // push claiming the work is done is the same lie the reader's idle badge
      // used to tell (host `agents.ts`). Say what is still running instead — the
      // list is already on the session by this point (`checkAgents` runs inside
      // `markIdle`, before this event).
      const n = info.agents?.length ?? 0;
      const still = [n ? `${n} agent${n === 1 ? "" : "s"}` : "", info.shells ? "shells" : ""].filter(Boolean).join(" + ");
      ctx.notify("idle", {
        title: still ? `Turn finished · ${still} still running` : "Turn finished",
        body: info.title, sessionId: id, tag: `idle-${id}`,
      });
    }

    // Auto-download: whatever this turn produced inside the repo's pull scope gets
    // queued for the phone to fetch on its own. Runs before the notification scans
    // below and off its own baseline, so it is never limited by their caps or by
    // which of them happens to cover a given file type.
    void ctx.pullNewFiles(id, info.cwd).catch(() => {});

    // Detect new outbox deliverables (non-image: APK, zip, pdf …) → one
    // notification per file whose tap downloads it.
    const oSeen = ctx.outSeen.get(info.cwd);
    if (oSeen) {
      const freshDocs = ctx.scanOutboxDocs(info.cwd).filter((f) => !oSeen.has(f.relPath));
      const repoIdDocs = targetId(info.cwd);
      for (const f of freshDocs.slice(0, 5)) {
        oSeen.add(f.relPath);
        console.log(`${logTag} outbox artifact · ${info.title} (${id}) · ${f.relPath} (${ctx.fmtSize(f.size)})`);
        ctx.notify("artifact", {
          title: `Outbox: ${f.name}`,
          // The verb has to match what the tap DOES: a report opens in the
          // phone's viewer, an APK is a transfer (web `openNotif`).
          body: `${ctx.fmtSize(f.size)} · ${info.title} — ${readsInline(f.relPath) ? "tap to read" : "tap to download"}`,
          sessionId: id,
          // Keyed on the FILE, not the session that happened to notice it. A tag
          // is what makes a re-show replace rather than stack, and with the
          // session id in it two sessions in one repo could only ever stack. The
          // baseline above already stops the second one being sent; this makes a
          // duplicate unrepresentable on the phone even if one ever is.
          tag: `artifact-${repoIdDocs}-${f.relPath}`,
          file: { repoId: repoIdDocs, relPath: f.relPath, name: f.name, size: f.size, mtime: f.mtime },
        });
      }
      freshDocs.slice(5).forEach((f) => oSeen.add(f.relPath)); // count them seen, no spam
    }

    // Detect images the agent produced this turn, and markdown it wrote or rewrote → the
    // session's strip; images also notify. A repo-wide walk, so in the background; the baseline
    // is read when it lands, so two overlapping turn ends never both claim a file.
    if (!ctx.imgSeen.has(id)) return;
    void ctx.scanImages(info.cwd).then((imgs) => {
      const seen = ctx.imgSeen.get(id);
      if (!seen) return;
      const fresh = stripFresh(seen, imgs);
      if (!fresh.length) return;
      const repoId = targetId(info.cwd);
      ctx.broadcast({ t: "session.images", id, repoId, images: fresh });
      const pics = fresh.filter((f) => !isMarkdownPath(f.relPath));
      if (!pics.length) return;
      const names = pics.slice(0, 3).map((f) => f.name).join(", ");
      ctx.notify("image", {
        title: `New image${pics.length > 1 ? `s (${pics.length})` : ""} · ${info.title}`,
        body: names + (pics.length > 3 ? "…" : ""),
        sessionId: id,
        tag: `image-${id}`,
        image: { repoId, relPath: pics[0].relPath },
      });
    }, () => {});
  });

  // A session's own budget was crossed (`sessions/budgetwatch.ts` emits this
  // once per crossing). Sends to it are held by the shared predicate on both
  // ends; this says so, and — when every gate below agrees — writes ONE Esc
  // into the running turn. Never through `deliver.ts`: an Esc is not a prompt,
  // there is nothing to echo or confirm, and the gates ARE the safety.
  //
  // The Esc is OWED until it goes out: a crossing with no turn to interrupt
  // right then (between turns, after a limit resume, across a restart) is
  // retried on every judge while still over (`budgetEscDue`), quietly — the
  // person was told at the crossing — and said once when it lands.
  const tryBudgetEsc = (id: string, info: SessionInfo): { sent: boolean; why: string } => {
    const b = info.budget;
    const blocker = budgetEscBlocker({
      interrupt: !!b?.cfg.interrupt,
      envOff: env("SESSION_BUDGET_INTERRUPT") === "0",
      running: info.running,
      prompt: !!info.prompt,
      awaitingInput: !!info.awaitingInput,
      openDelivery: (openDeliveries()?.open() ?? []).some((d) => d.sessionId === id),
    });
    if (blocker) return { sent: false, why: blocker };
    // `prompt`/`awaitingInput` are the detector's LAST reading, and a box
    // painted inside its debounce window is on screen and not yet in them — so
    // the live grid is read in the same tick as the write, and must show the
    // CLI working NOW with no box anywhere on it.
    const screen = budgetEscScreenBlocker(ctx.sessions.liveGrid(id));
    if (screen) return { sent: false, why: screen };
    if (!ctx.sessions.write(id, "\x1b")) return { sent: false, why: "No Esc was sent: the session would not take input." };
    ctx.sessions.settleBudgetEsc(id);
    return { sent: true, why: "The running turn was interrupted (one Esc)." };
  };
  ctx.sessions.on("budgetTripped", (id: string, info: SessionInfo) => {
    const b = info.budget;
    if (!b) return;
    const esc = tryBudgetEsc(id, info);
    const owed = !esc.sent && b.cfg.interrupt && env("SESSION_BUDGET_INTERRUPT") !== "0" && info.running;
    const tail = owed ? " It will be interrupted once a running turn shows on its screen." : "";
    console.log(`${logTag} session budget hit · ${id} · ${esc.why}${owed ? " (owed — retried while over)" : ""}`);
    ctx.notify("limit", {
      title: `Session budget hit · ${info.title}`,
      body: `${sessionBudgetText(b.verdict)}. ${sessionBudgetHoldText(b.cfg)} ${esc.why}${tail}`,
      sessionId: id, tag: `session-budget:${id}`, level: "attention", key: `budget:${id}`,
    });
  });
  ctx.sessions.on("budgetEscDue", (id: string, info: SessionInfo) => {
    const b = info.budget;
    if (!b) return;
    const esc = tryBudgetEsc(id, info);
    if (!esc.sent) return;
    console.log(`${logTag} session budget hit · ${id} · ${esc.why} (owed Esc, sent late)`);
    ctx.notify("limit", {
      title: `Session budget · ${info.title} interrupted`,
      body: `${sessionBudgetText(b.verdict)}. ${esc.why} ${sessionBudgetHoldText(b.cfg)}`,
      sessionId: id, tag: `session-budget:${id}`, level: "attention", key: `budget:${id}`,
    });
  });
  // A running subagent over the person's line: one `agent` push per agent
  // (`agentwatch.ts`). Registered last so it changes no listener's relative order.
  const agentWatch = createAgentWatch({
    notify: (kind, p) => ctx.notify(kind, p),
    setting: () => ctx.settings.get(AGENT_WINDOW_WARN_KEY)?.value,
  });
  ctx.sessions.on("updated", (info: SessionInfo) => agentWatch.onUpdated(info));
  ctx.sessions.on("exit", (id: string) => agentWatch.forget(id));
  // A budget in window percent needs a fresh reading to be judged at all, so a
  // session born with one is a reason for the usage poll to run.
  ctx.sessions.on("created", (info: SessionInfo) => { if (info.budget) ctx.syncUsagePolling(); });
  // …and its dollars per window point come off whatever reading the usage
  // cache holds (`sessionbudget.ts`), asked once a minute: the calibrator folds
  // a reading once per `checkedAt`, so an unchanged cache costs a comparison,
  // and it never scrapes. Not in a doctor run — a fold reads the token ledger.
  if (!ctx.DOCTOR) {
    const calibrate = createBudgetCalibrator({
      windowSeries: (specs, maxAgeMs) => ctx.tokenStats.windowSeries(specs, maxAgeMs),
      apply: (cal) => ctx.sessions.setBudgetCal(cal),
    });
    setInterval(() => { void calibrate(ctx.usage.get()).catch(() => false); }, BUDGET_CAL_EVERY_MS).unref();
  }
  // A backend arriving or leaving (a plugin's `api.backend`, or its switch-off):
  // re-send the list, adopt any pane `rediscover()` parked for it
  // (`sessions/tmux.ts`), and ask a NEW backend for its catalogue — boot's
  // priming never saw it.
  onBackendsChanged(() => {
    ctx.broadcast({ t: "backends", list: backendInfos() });
    ctx.sessions.parked();
    void primeNewBackendModels().then((asked) => { if (asked) ctx.broadcast({ t: "backends", list: backendInfos() }); });
  });
  // PTY first (`liveness.ts`'s `ptyHoldsStreams`): what the plugin streams ask before every frame.
  return {
    ptyHeld: (ws: WebSocket): boolean => ptyHoldsStreams(ws.bufferedAmount, WS_PTY_BACKLOG_BYTES, (starved.get(ws)?.size ?? 0) > 0),
  };
}

/** How often the session-budget calibrator looks at the usage cache. */
const BUDGET_CAL_EVERY_MS = 60_000;

/** The facts the budget's one Esc is gated on (`budgetTripped` above). */
export interface BudgetEscFacts {
  interrupt: boolean; envOff: boolean; running: boolean;
  prompt: boolean; awaitingInput: boolean; openDelivery: boolean;
}

/**
 * Why NOT to write the Esc, as the sentence the notification carries — or
 * null, which lets `budgetEscScreenBlocker` have the last word. An Esc is only
 * ever safe into a turn that is running, with nothing on screen it would answer
 * instead (a choice box or a dialog: Esc there DECLINES, which is a decision
 * nobody made), and no delivery still unconfirmed in it (an Esc at a composer
 * holding those words could clear them, the loss `deliver.ts`'s miss sweep is
 * forbidden too).
 *
 * The running turn is proven on the LIVE grid (the CLI's own working line), not
 * by the hooks. It used to need a hook-announced turn, and that never came for
 * the turns that overspend most: one driven by background agents' task
 * notifications (no `UserPromptSubmit`), and one already running when the
 * daemon restarted — a session at $178 of a $150 cap kept working because of it.
 */
export function budgetEscBlocker(f: BudgetEscFacts): string | null {
  if (!f.interrupt) return "No Esc was sent: this budget is set not to interrupt.";
  if (f.envOff) return `No Esc was sent: interrupting is turned off on this desktop (${envName("SESSION_BUDGET_INTERRUPT")}=0).`;
  if (!f.running) return "No Esc was sent: the session is not running.";
  if (f.prompt || f.awaitingInput) return "No Esc was sent: a question is on screen, and Esc would answer it.";
  if (f.openDelivery) return "No Esc was sent: a prompt sent to it is still unconfirmed, and Esc could clear it from the composer.";
  return null;
}

/**
 * The second half of the gate, asked of the LIVE grid (`sessions.liveGrid`)
 * immediately before the write: the facts above are readings taken earlier,
 * and a permission box painted since — inside the prompt check's debounce —
 * would take the Esc as its answer and DECLINE. So the screen must show the
 * CLI's own working line (`workingLine`, the one matcher) right now, and no
 * choice box or dialog by any of the detector's rules. An unreadable grid is
 * a refusal, never a pass.
 */
export function budgetEscScreenBlocker(grid: string): string | null {
  if (!grid.trim()) return "No Esc was sent: the live screen could not be read, so a running turn could not be confirmed on it.";
  if (detectPrompt(grid) || dialogEvidence(grid).box || dialogStillUp(grid)) {
    return "No Esc was sent: a question is on screen right now, and Esc would answer it.";
  }
  if (!workingLine(grid)) return "No Esc was sent: the screen does not show the CLI working right now, so there was no turn to interrupt.";
  return null;
}
