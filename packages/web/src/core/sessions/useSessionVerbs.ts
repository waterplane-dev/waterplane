/**
 * What a person does TO a session from either screen: star it, close it, clear
 * the ones that ended — plus the host's answer to a close (`session.closecheck`)
 * and the star presses held for a link that is down (`localState.ts`).
 *
 * One hook for both screens and the session-tab strip, so a close from the
 * launcher row, the session header and a tab's × is one verb with one receipt.
 * The BULK close is the launcher's alone (`core/launcher/CloseAllPicker.tsx`).
 *
 * Called in App right where `sessions` is derived: the pending stars ARE part
 * of that list (`applyPendingStars`), so this hook runs before it.
 */
import { useEffect, useRef, useState } from "react";
import type { HostMessage, SessionInfo } from "@waterplane/shared";
import { shellCloseWords, shellsSummary } from "@waterplane/shared";
import type { Connection } from "../conn/useConnection";
import { type PendingStars, loadPendingStars, reconcileStars, savePendingStars } from "../../localState";
import { askConfirm } from "../../Confirm";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { noteSessionClosing } from "../../features/shells";

type CloseCheck = Extract<HostMessage, { t: "session.closecheck" }>;

/** The one sentence every archiving path ends in — where the words went. */
export function archivedToast(title: string, n = 1): string {
  const what = n > 1 ? `archived ${n} sessions` : `archived ${title}`;
  return `${what} — the conversation is kept: reopen it under “Recently closed”, or in Archive`;
}

/**
 * @param conn        the one connection (`useConnection`)
 * @param getSessions the merged session list as of NOW — read at tap time,
 *                    never closed over (a host answer lands renders later)
 */
export function useSessionVerbs(conn: Connection, getSessions: () => SessionInfo[]) {
  const { connRef, status, send, liveSend, liveAsk } = conn;
  // Stars pressed before the host could be told. Held here (and in localStorage)
  // so the button paints instantly with no link, survives the watchdog's reload,
  // and is re-sent on reconnect — see localState.ts. Cleared per session the
  // moment a live row shows the host holding the same value.
  const [pendingStars, setPendingStars] = useState<PendingStars>(loadPendingStars);
  const pendingStarsRef = useRef(pendingStars);
  pendingStarsRef.current = pendingStars;

  // Stars pressed while the link was down. Re-sent on every reconnect because
  // the socket's in-memory queue does not survive a reload, and the frame is
  // idempotent set-state — sending one the host already has costs nothing. The
  // `session.list` that follows the handshake is what retires them.
  useEffect(() => {
    if (status !== "open") return;
    for (const [id, starred] of Object.entries(pendingStarsRef.current)) {
      connRef.current.send({ t: "session.star", id, starred });
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Archive one session: end the CLI process AND take the row off the list, in
   * one tap.
   *
   * `session.kill` alone does only the first half — the PTY dies, the session
   * stays in `sessions.list()` as `exited`, and the row sits there looking like
   * the button did nothing. Worse, that leftover row is what `conversationOpen()`
   * reads as "this conversation is already open", which SUPPRESSES its
   * "Recently closed" entry: one tap removed nothing from the list and hid the
   * route back at the same time. `session.remove` kills first when the session
   * is still running, so both states take the same verb and the conversation
   * lands where it belongs — the recently-closed shortlist, and the Archive
   * sheet behind it (the jsonl on disk survives either way; this is not a
   * delete).
   *
   * A running session still goes through `session.closecheck` first, whose
   * answer fires the removal — hence `liveAsk` and NO toast here: saying
   * "archiving…" before asking is a receipt for something that may never happen
   * on a dead tunnel, which is the other half of what made this button look
   * unreliable.
   */
  function closeSession(s: SessionInfo) {
    track("action:session.close");
    if (s.running) { liveAsk({ t: "session.closecheck", id: s.id }, "no connection — the desktop didn't get that, the session is still open"); return; }
    // Mark it THIS phone's close before it ships — `session.closed` is a
    // broadcast, and this is what keeps its shells-stopped toast off every
    // OTHER open phone (`features/shells/store.ts`).
    noteSessionClosing(s.id);
    liveSend({ t: "session.remove", id: s.id }, archivedToast(s.title), "no connection — the desktop didn't get that, the session is still listed");
  }
  function clearExited() {
    const gone = getSessions().filter((s) => !s.running);
    if (!gone.length) return;
    if (connRef.current.status !== "open") { showToast("no connection — the desktop didn't get that, the sessions are still listed"); return; }
    for (const s of gone) send({ t: "session.remove", id: s.id });
    showToast(archivedToast(gone[0].title, gone.length));
  }
  /** The host's answer to `closeSession`'s ask: close, or say what would be lost first. */
  function onCloseCheck(msg: CloseCheck) {
    const warn: string[] = [];
    if (msg.isRepo) {
      if (msg.dirty) warn.push("• uncommitted changes (no commit done)");
      if (!msg.isMain && msg.unmerged > 0)
        warn.push(`• ${msg.unmerged} commit(s) not merged to ${msg.mainBranch || "main"}`);
    }
    // CLAUDE.md's decision: closing a session stops every background shell
    // under it, fully — no "leave running" option. Said here, on the confirm,
    // not only enforced silently at close time (`sessions/drive.ts`).
    if (msg.shells?.length) {
      const words = shellCloseWords(shellsSummary(msg.shells, Date.now()), msg.shells);
      if (words) warn.push(`• ${words}`);
    }
    // `session.remove`, not `session.kill`: killing stops the process but
    // leaves the row on the list as `exited` — see `closeSession`.
    const sess = getSessions().find((s) => s.id === msg.id);
    const name = sess?.title ?? msg.branch ?? "session";
    if (warn.length === 0) { noteSessionClosing(msg.id); send({ t: "session.remove", id: msg.id }); showToast(archivedToast(name)); return; }
    const label = msg.branch || "this session";
    // The one confirm in this app that genuinely needs a dialog: the
    // question is composed from a HOST FRAME that arrives long after the
    // tap, so there is no button left to arm. `askConfirm` rather than
    // `window.confirm` — the native modal blocks the WebView's event loop
    // while it is up, which on this link means the socket's own keepalive
    // stalls behind a question about a branch.
    void (async () => {
      if (!await askConfirm({ title: `Close ${label}?`, lines: warn.map((w) => w.replace(/^• /, "")), confirmLabel: "Close anyway" })) return;
      noteSessionClosing(msg.id);
      send({ t: "session.remove", id: msg.id });
      showToast(archivedToast(name));
    })();
  }

  /**
   * Star a session — the one write in the UI that must work with no link.
   *
   * The frame itself is idempotent set-state, so it needs no ackId and no queue
   * entry: it is recorded as an intent (`pendingStars`), painted immediately,
   * and re-sent on every reconnect until a live row proves the host holds it.
   * A press used to go straight onto the socket, where offline it queued in
   * memory, painted nothing and died with the next reload.
   */
  function toggleStar(id: string, starred: boolean) {
    track("action:session.star");
    const next = { ...pendingStarsRef.current, [id]: starred };
    pendingStarsRef.current = next;
    setPendingStars(next);
    savePendingStars(next);
    send({ t: "session.star", id, starred });
  }
  /** Drop the presses the host has confirmed. `authoritative` = a full
   *  `session.list`, the only kind that can also retire a press for a session
   *  that no longer exists. */
  function settleStars(live: SessionInfo[], authoritative: boolean) {
    const next = reconcileStars(pendingStarsRef.current, live, authoritative);
    if (!next) return;
    pendingStarsRef.current = next;
    setPendingStars(next);
    savePendingStars(next);
  }

  return { pendingStars, toggleStar, settleStars, closeSession, archivedToast, clearExited, onCloseCheck };
}

export type SessionVerbs = ReturnType<typeof useSessionVerbs>;
