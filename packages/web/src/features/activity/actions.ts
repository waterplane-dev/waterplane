/**
 * Every writer of the activity feature's stores, and everything a row can do.
 *
 * The rows come from `activityRows.ts`, which is pure and node-tested; these
 * are the only half that can touch anything. `retarget` is separate from
 * `act` on purpose: a re-aim needs an ANSWER, which the sheet asks inline
 * with the shared `RepoPicker`.
 */
import { intentKind, isTimedWorkRow, repoLabel } from "@waterplane/shared";
import { bulkLines, entryProse, queueRowKey, type ActivityActionId, type ActivityRow } from "../../activityRows";
import { scheduleRemovedToast } from "../../clockCuts";
import { scheduleRuleLabel } from "../../backlogFilter";
import { dismissRows, undismissRows } from "../../activityDismiss";
import { markRowsDone } from "../../activityDone";
import { saveNow, startDownload } from "../../download";
import { baseName } from "../../format";
import type { OutboxEntry } from "../../outbox";
import { pulls } from "../../pull";
import { core, type CoreApi } from "../../sdk";
import { BL_OFFLINE, HELD_OFFLINE, refireSummary, runLane, runNowToast } from "./logic";
import { confirmedDone, filed, focus, pullList, type ActivityFocus } from "./store";
import { SHEET } from "../../sheetNames";

const repoNameOf = (c: CoreApi, cwd: string) => { const r = c.world.repoForCwd(cwd); return r ? repoLabel(r) : baseName(cwd); };

// ── Doors ────────────────────────────────────────────────────────────

/** A cut to open the sheet on: row keys, or the queue entries a strip counted. */
export type ActivityCut = ActivityFocus | { entries: readonly OutboxEntry[]; label: string };

/** The sheet, on exactly these rows or on everything (no cut, or `null`) —
 *  the ONE door, bound straight to `core().nav.openActivity`. */
export function openActivity(cut?: ActivityCut | null): void {
  focus.set(!cut ? null
    : "keys" in cut ? { keys: cut.keys, label: cut.label }
    : { keys: cut.entries.map((e) => queueRowKey(e.ackId)), label: cut.label });
  core().nav.open("activity");
}

/** The sheet, on exactly these queue rows — what a strip's number counted. */
export function openActivityOn(entries: readonly OutboxEntry[], label: string): void {
  openActivity({ entries, label });
}

/** The sheet's own close: the focus was the tap, not a setting. */
export function closeActivity(): void {
  focus.set(null);
  core().nav.close("activity");
}

/** Mirror `pull.ts`'s transfers for the Downloads rows. */
export function bootActivity(): () => void {
  return pulls.subscribe((list) => pullList.set(list));
}

// ── What a row does ──────────────────────────────────────────────────

/** Keep the words, change the destination. */
export function retarget(row: ActivityRow, to: { sessionId: string; cwd: string; mode?: "input" | "backlog" }): void {
  const c = core();
  c.say.track("action:activity.retarget");
  if (row.subject.source === "queue") {
    // Moved onto a backlog: show it there, newest on top.
    if (c.queue.verbs.retargetQueued(row.id, to) && to.mode === "backlog") c.nav.openBacklogCut(to.cwd);
    return;
  }
  // One message for every host-held row, where there used to be one per
  // ledger. `intent.retarget` is the store's own recovery verb.
  if (row.subject.source === "intent") {
    c.conn.liveSend(
      { t: "intent.retarget", id: row.id, cwd: to.cwd,
        target: to.mode === "input" ? { kind: "session", sessionId: to.sessionId } : { kind: "repo" } },
      `aimed at ${repoNameOf(c, to.cwd)}`, BL_OFFLINE,
    );
    if (to.mode !== "input") c.nav.openBacklogCut(to.cwd);
    return;
  }
  c.say.toast("that row cannot be re-aimed");
}

/**
 * Do the thing a row offers. **Every arm says something** — every control on
 * this screen is pressed by someone who has already lost track of a piece of
 * work once, and a tap that produces silence is how they lose it twice.
 */
export function act(id: ActivityActionId, row: ActivityRow): void {
  const c = core();
  const { liveSend } = c.conn;
  const { queueOp } = c.queue;
  const { sessionId } = row;
  c.say.track(`action:activity.${id}`);
  const sub = row.subject;
  const openIt = () => {
    const s = sessionId ? c.world.sessions.find((x) => x.id === sessionId) : null;
    if (s) c.nav.attach(s); else c.say.toast("that session is no longer open");
  };
  // The bulk "file away", offered per row. Not destructive and not confirmed:
  // the words, verdict and buttons stay — it only moves under "dismissed".
  if (id === "dismiss") {
    filed.set(dismissRows([row.key]));
    dismissOnHost([row]);
    c.say.toast("filed away for later — it's under “dismissed”, nothing was deleted");
    return;
  }
  // Only offered on a row whose delivery is `unconfirmed` — a person's own
  // read of the terminal settles it, moving it to "done".
  if (id === "confirmDone") {
    confirmedDone.set(markRowsDone([row.key]));
    c.say.toast("marked done — the desktop's own check never confirmed it, this is your call");
    return;
  }
  // The `from the schedule “x”` chip on a run a rule fired: that rule's card.
  if (id === "openSchedule") {
    if (row.fromSchedule) c.nav.openScheduleCut([row.fromSchedule.id], scheduleRuleLabel(row.fromSchedule.name));
    return;
  }
  switch (sub.source) {
    case "queue": {
      const e = sub.entry;
      const v = c.queue.verbs;
      if (id === "answer") { c.nav.open("questions"); c.say.toast("answer it here — the queued reply is bound to this question"); return; }
      if (id === "sendNow") { v.sendQueuedNow(e.ackId); return; }
      if (id === "hold") { v.toggleHoldQueued(e.ackId); return; }
      if (id === "discard") { v.removeQueued(e.ackId); c.say.toast("discarded"); return; }
      if (id === "open") { openIt(); return; }
      // Both rewrite the words; `fix` additionally checks the files it names.
      c.nav.openSend({
        prompts: [e.op?.t === "session.create" ? ((e.op as { prompt?: string }).prompt || e.text) : e.text],
        target: c.send.targetFor(e.sessionId, e.cwd),
        cwdHint: e.cwd, repoId: c.queue.repoIdOf(e), ackId: e.ackId, repair: id === "fix",
        origin: e.status === "failed" ? "This one never went" : "Queued, not sent yet",
        openAfter: true,
      });
      return;
    }
    /**
     * **Everything the desktop is holding — one arm, where there were five.**
     * One durable row in one store on the host, so one verb: `intent.run`; one
     * `intent.cancel`. Two verbs did NOT collapse: `build.cancel` KILLS A
     * RUNNING PROCESS (which `intent.cancel` refuses) and `schedule.remove`
     * DELETES the row, where cancelling only settles it.
     */
    case "intent": {
      const i = sub.intent;
      const kind = intentKind(i);
      if (id === "open") { openIt(); return; }

      if (id === "runNow" || id === "sendNow") {
        if (kind === "fanout") {
          // A follow-up picks WHICH of the sweep's sessions get it — the fan-out
          // sheet's own per-run composer.
          c.nav.open("fanout");
          c.say.toast("follow up from the run below — it picks which of its sessions get it");
          return;
        }
        // Durable: a "run it now" queued while the tunnel is down is a
        // decision, and the ackId is what stops it running twice.
        const offline = queueOp({ t: "intent.run", id: i.id }, runLane(kind, i),
          i.label || i.title || "run it now", { cwd: i.cwd });
        c.say.toast(runNowToast(kind, offline));
        if (!offline && kind === "work") c.nav.followFire(i.id);
        return;
      }

      if (id === "cancel" || id === "discard") {
        // A live build is a PROCESS, not a queued row: the kill keeps its message.
        if (kind === "build" && (i.state === "running" || i.state === "starting")) {
          liveSend({ t: "build.cancel", runId: i.id }, "cancelling the build…",
            "no connection — the build is running on the desktop and can't be stopped from here");
          return;
        }
        // Same fact about a live capture.
        if (kind === "capture" && (i.state === "running" || i.state === "starting")) {
          liveSend({ t: "capture.cancel", runId: i.id }, "stopping the capture…",
            "no connection — the capture is running on the desktop and can't be stopped from here");
          return;
        }
        // A schedule's "delete" removes the row; cancelling would only settle
        // it, leaving a dead rule in the list for ever.
        if (kind === "schedule") {
          const rows = c.queue.verbs.scheduleQueueRows(i.id);
          const sent = liveSend({ t: "schedule.remove", id: i.id }, scheduleRemovedToast(rows.length),
            "no connection — this one lives on the desktop and can only be deleted there");
          if (sent) c.queue.verbs.dropScheduleQueue(rows);
          return;
        }
        liveSend({ t: "intent.cancel", id: i.id },
          kind === "launch" ? "called off — that session will not open" : "removed",
          HELD_OFFLINE);
        return;
      }

      if (id === "toggle") {
        // Arming a rule is its own host method (`setArmed`): `intent.update`
        // would return the row to `queued` and re-arm `nextAt`.
        if (kind === "schedule") {
          liveSend({ t: "schedule.setEnabled", id: i.id, enabled: i.nextAt == null },
            i.nextAt != null ? "switched off" : "armed",
            "no connection — this one is armed on the desktop and can only be changed there");
          return;
        }
        // A work item's own auto-fire is `Intent.pinned`, which no patch
        // carries — the per-item switch lives in the BACKLOG.
        c.nav.open("backlog");
        c.say.toast("this one is a per-item switch — it is on the row, in the backlog");
        return;
      }

      // "Was this really lost, or is it already implemented?" — the backlog's
      // one-shot headless review, asked from the row that raises the question.
      if (id === "check") {
        liveSend({ t: "backlog.check", id: i.id }, "checking whether this is already done…", BL_OFFLINE);
        return;
      }

      if (id === "download") {
        const arts = i.result?.artifacts ?? [];
        if (!arts.length) { c.say.toast("that run left no files"); return; }
        // One file: `startDownload` words it (fresh, resume, or already here).
        // Several: ONE sentence for the set.
        const withRepo = arts.map((a) => ({ ...a, repoDir: i.cwd, repoName: c.world.repoForCwd(i.cwd)?.repoName }));
        if (withRepo.length === 1) { startDownload(withRepo[0]); return; }
        for (const a of withRepo) startDownload(a, { silent: true });
        c.say.toast(`downloading ${withRepo.length} files — see Downloads`);
        return;
      }

      // `edit` and everything unhandled: the row's own list owns rewriting. A
      // TIMED row's clock is a whole rule, composed only by the Send sheet.
      // A BUILD rule has no prose: its form is the build's own, on its repo's Build sheet.
      if (kind === "schedule" && i.payload.kind === "build") {
        const e = c.world.schedules.find((x) => x.id === i.id);
        const repo = c.world.repoForCwd(i.cwd);
        if (e && repo) { c.nav.openBuild(repo, { schedule: e }); return; }
        // Never fall through to the Send sheet: a prompt saved under this id
        // would REPLACE the build rule.
        c.say.toast(e ? `that rule's repo is not listed on this phone — edit it from its card in ${SHEET.automation}` : "that rule is not in the list yet — try again in a moment");
        return;
      }
      if (kind === "schedule" || isTimedWorkRow(i)) { c.nav.openSend(c.send.seedFromIntent(i)); return; }
      c.nav.open("backlog");
      c.say.toast("rewrite it on its row, in the backlog");
      return;
    }
    case "pull": {
      if (id === "save") { void saveNow(sub.record.item.id); return; }
      if (id === "retry") { pulls.retry(sub.record.item.id); c.say.toast("fetching it now"); return; }
      // A download this device asked for is not in the host's queue at all
      // (`download.ts`): drop it here, and never tell the host about an id it
      // has never heard of.
      if (sub.record.local) {
        void pulls.remove(sub.record.item.id);
        c.say.toast("removed from Downloads");
        return;
      }
      // `sync()` keeps a `done` record whatever the host says, so dismissing
      // the host's entry alone left the row exactly where it was.
      void pulls.remove(sub.record.item.id);
      liveSend({ t: "pull.dismiss", id: sub.record.item.id }, "dropped from Downloads",
        "removed here — the desktop's own queue still lists it until the link is back");
      return;
    }
  }
}

/**
 * Put ONE row's words back on the wire, as a work item in the repo they were
 * written for: the row's OWN text and `cwd`, the ordinary durable backlog
 * path, and then the dead row leaves the queue so nothing can send it twice.
 * Everything else is refused upstream by `refireBlocker`.
 */
function refire(c: CoreApi, row: ActivityRow, landed: Set<string>): "sent" | "queued" | "norepo" | "nothing" {
  if (row.subject.source !== "queue") return "nothing";
  const e = row.subject.entry;
  const repo = e.cwd ? c.world.repoForCwd(e.cwd) : null;
  if (!repo) return "norepo";
  const text = entryProse(e).trim();
  if (!text) return "nothing";
  const q = c.queue.queueBacklog({ text, repoDir: repo.worktreePath, label: text.slice(0, 40) });
  if (q === null) return "nothing"; // refused — it names an image that never arrived
  c.queue.drop(e.ackId);
  landed.add(repo.worktreePath);
  return q ? "queued" : "sent";
}

/**
 * Tell the host about a filing, for the rows it actually holds:
 * `Intent.dismissedAt` is the gate a terminal row passes before it may be
 * compacted out of `.waterplane/intents.json`. Safe to fire and forget — the host's
 * `dismiss()` refuses anything not terminal or already dismissed — and sent
 * only over a live socket; the local mark applies either way. Not undone by
 * `restore` (there is no un-dismiss message; compaction archives, never deletes).
 */
function dismissOnHost(rows: readonly ActivityRow[]): void {
  const c = core();
  if (c.conn.status !== "open") return;
  for (const r of rows) {
    if (r.source === "queue" || r.source === "pull") continue; // this phone's own ledgers
    c.conn.send({ t: "intent.dismiss", id: r.id });
  }
}

/**
 * A decision over many rows at once — the most dangerous button in this app.
 * **Confirmed with a COUNT and a SAMPLE** (`bulkLines`), **filing is not
 * deleting** (undoable under `dismissed`), and **one sentence at the end**,
 * with the failures in it. A successful re-fire also FILES the row it came from.
 */
export function bulk(kind: "refire" | "dismiss" | "restore", rows: ActivityRow[]): void {
  const c = core();
  c.say.track(`action:activity.bulk.${kind}`);
  if (!rows.length) { c.say.toast("nothing selected"); return; }
  const name = (cwd: string) => repoNameOf(c, cwd);
  void (async () => {
    if (kind === "restore") {
      filed.set(undismissRows(rows.map((r) => r.key)));
      c.say.toast(`${rows.length} back in the list`);
      return;
    }
    const ok = await c.say.confirm({
      title: kind === "dismiss" ? `File ${rows.length} away?` : `Send ${rows.length} again?`,
      lines: bulkLines(rows, { verb: kind, repoName: name }),
      confirmLabel: kind === "dismiss" ? "File them away" : "Send them again",
    });
    if (!ok) { c.say.toast("left alone"); return; }
    if (kind === "dismiss") {
      filed.set(dismissRows(rows.map((r) => r.key)));
      dismissOnHost(rows);
      c.say.toast(`${rows.length} filed away — nothing was deleted, they are under “dismissed”`);
      return;
    }
    let sent = 0;
    let offline = false;
    const done: string[] = [];
    const landed = new Set<string>();
    for (const r of rows) {
      const v = refire(c, r, landed);
      if (v === "sent" || v === "queued") { sent++; done.push(r.key); if (v === "queued") offline = true; }
    }
    if (!sent) { c.say.toast("nothing left to send from those rows"); return; }
    filed.set(dismissRows(done));
    dismissOnHost(rows.filter((r) => done.includes(r.key)));
    c.say.toast(refireSummary(sent, rows.length, offline));
    // One repo's backlog holds them all: open it, the new rows on top. Several
    // repos have no one backlog to show, so the toast stands alone.
    if (landed.size === 1) c.nav.openBacklogCut([...landed][0]);
  })();
}
