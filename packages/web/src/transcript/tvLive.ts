import { scrollPanelOpen, shellWords, shellsChipText, shellsSummary, workingLine } from "@waterplane/shared";
import type { TranscriptStatus } from "./tvTypes";
import { since } from "./tvRows";

/**
 * What the status strip, the agent rows and the turn feet say about the session
 * RIGHT NOW, derived from the status the caller passes in. Pure: no state, no
 * clock but the `now` it is handed.
 */
export function liveReading(status: TranscriptStatus | undefined, busy: boolean) {
  const now = Date.now();
  // The day this is read ON. A prompt's "posted" stamp (TvTurn) is drawn only
  // for a prompt from ANOTHER day: the turn head's clock already says the
  // time, and on the day itself "posted Mon 12 Oct, 06:33" under "#1 06:33"
  // said it twice. Past midnight a bare clock no longer says which day — the
  // one case the stamp is for.
  const today = new Date(now).toDateString();
  const work = busy ? workingLine(status?.tail) : null;
  // A clipped screen block is missing rows the CLI never printed, so they are in
  // no record — but while the panel is still open they are one scroll away in
  // the terminal. Both halves of "still reachable" are checked here: the panel
  // is up, and the socket is open, because scrolling the TUI is a REMOTE
  // operation (`screenlog.ts`) and with the link down the gesture does nothing.
  // Failing either one, the notice stands alone — never a dead button.
  const panelOpen = !!status?.running && !status?.linkDown && scrollPanelOpen(status?.tail);
  // The host's turn clock is the one to trust (it starts at UserPromptSubmit);
  // the CLI's own counter is the fallback for a session with no hook pipe,
  // where `turnStartedAt` may never have been set at all.
  const elapsed = busy ? since(status?.turnStartedAt, now) || work?.elapsed || "" : "";
  // Agents are work the turn flag does not describe; `startedAt` is what the
  // clock counts off, so the host broadcasts only when the SET changes.
  const agents = status?.agents ?? [];
  const agentCount = agents.length;
  const agentAge = agentCount ? since(Math.min(...agents.map((a) => a.startedAt)), now) : "";
  // The richer shell reading, when this host has it — `shellList` over the
  // bare `shells` boolean. `shellsChipText` never counts `unknown` as
  // `quiet`, and `shellWords` on the first row is what the reader has room to
  // show — the sheet behind "see shells" carries every one of them.
  const shellList = status?.shellList;
  const shellSum = shellList ? shellsSummary(shellList, now) : null;
  const anyShells = !!shellSum?.total || !!status?.shells;
  // What still keeps the NEWEST turn from being finished, in words — the same
  // facts that make `sessionStatus()` read `coding` (busy, agents, a shell with
  // real workers — a `waiting` poll loop is not work), so the turn foot never says "finished" under a
  // "coding" chip. Null when nothing is running.
  const stillGoing = !status || !status.running ? null
    : status.busy ? "working"
    : agentCount ? `${agentCount} agent${agentCount === 1 ? "" : "s"} still running`
    : (shellSum ? shellSum.working > 0 : !!status.shells) ? "a background shell still running"
    : null;
  // One line, in priority order: dead > blocked > waiting on you > working >
  // agents > shells > idle. Only one of those is ever the thing worth knowing.
  const live = !status ? null
    : !status.running ? { kind: "dead", text: "session ended" }
    : status.blocked ? { kind: "blocked", text: "blocked — usage limit" }
    : status.waiting ? { kind: "waiting", text: "waiting for your answer" }
    : status.awaitingInput ? { kind: "waiting", text: "waiting — a dialog is open in the CLI" }
    // Ranked UNDER `busy` on purpose: the question belongs to the turn that
    // ended, and a session that has since started working is working. The host
    // retires `asking` on that edge anyway; this is the ordering that says so.
    : status.busy ? { kind: "busy", text: elapsed ? `working · ${elapsed}` : "working" }
    : status.asking ? { kind: "waiting", text: "waiting — the turn ended on a question" }
    // Under `asking` (a question is owed an answer, whoever else is working)
    // and under `busy` (the turn is the bigger fact), but ABOVE idle: a session
    // with two background agents in flight is not idle, and saying so was this
    // strip's longest-standing lie.
    : agentCount ? { kind: "agents", text: `${agentCount} agent${agentCount === 1 ? "" : "s"} running${agentAge ? ` · ${agentAge}` : ""}${anyShells ? " · shells too" : ""}` }
    : shellSum?.total ? { kind: "shells", text: shellsChipText(shellSum) }
    : status.shells ? { kind: "shells", text: "background shells running" }
    // Idle repeats the header's "done · 18m ago", and it stays anyway: this
    // strip sits ABOVE the reader's scroll body, so dropping it when a turn
    // ends moved the text 25px at the moment the answer lands — a layout
    // change nobody caused, mid-glance (ux §5). One fact said twice is the
    // smaller cost. Link down, it is also the "last known" marker.
    : { kind: "idle", text: "idle — nothing running" };
  const shellFirstWords = shellList?.length ? shellWords(shellList[0], now) : null;
  const stale = !!status?.linkDown && live?.kind !== "dead";
  const liveTitle = stale
    ? "the connection is down — this is the session's state as of the last update that reached this device, not now"
    : status?.exact
    ? "turn state from the claude hooks (exact)"
    : "turn state guessed from output silence — no hook pipe on this session, so a long quiet tool run can read as idle";
  return {
    now, today, work, panelOpen, elapsed, agents, agentCount, agentAge, shellList, shellSum, anyShells,
    stillGoing, live, shellFirstWords, stale, liveTitle,
  };
}
