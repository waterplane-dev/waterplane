/**
 * **A live session running an older `claude` than the one installed.**
 *
 * The CLI updates itself on disk (npm global, native installer, or our own
 * `update.apply`) while every live PTY keeps the binary it was spawned with —
 * the kernel holds the old inode. The CLI then says "Update installed · Restart
 * to apply" in its own footer, and the only way to apply it is a new process.
 *
 * A new process does not have to mean a new conversation: `--resume <id>`
 * reopens exactly the one this session was in. So "restart" here is the
 * relaunch op (`replaceSessionId`, kill + create as ONE at-most-once op)
 * resuming that id — the process dies, the conversation does not.
 *
 * Two versions, both READ, never guessed:
 *   - `running` — `SessionInfo.cliVersion`: what the session's process said it
 *     was at spawn, or what its own conversation log recorded since then.
 *   - `installed` — `UpdateInfo.current`: `claude --version` on the desktop,
 *     re-read whenever the binary on disk changes.
 * Either absent ⇒ no verdict (degrade to absent, never to a wrong nag).
 *
 * Pure, and it produces sentences, never an action: a restart kills whatever
 * is in flight (a turn, a background agent), so the person decides.
 */

/** `a` vs `b` as dotted numbers: 1 when a is newer, -1 when older, 0 when equal
 *  or when either is missing. */
export function cmpCliVersion(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Pull `2.1.283` out of `2.1.283 (Claude Code)` or a log record's field. */
export function parseCliVersion(s: string | undefined | null): string | undefined {
  return (s && /(\d+\.\d+\.\d+)/.exec(s)?.[1]) || undefined;
}

export interface CliRestartDue {
  running: string;
  installed: string;
}

/** Non-null only when BOTH versions are known and the installed one is newer. */
export function cliRestartDue(running: string | undefined, installed: string | undefined): CliRestartDue | null {
  if (!running || !installed) return null;
  return cmpCliVersion(installed, running) > 0 ? { running, installed } : null;
}

export interface CliRestartState {
  /** A turn is running right now. */
  turnActive?: boolean;
  /** Background agents still running under the session. */
  agents?: number;
  /** Background shells still running under the session. */
  shells?: boolean;
  /** The conversation id a relaunch would resume — absent ⇒ it cannot. */
  resumeId?: string;
}

export interface CliRestartView {
  /** The bar's sentence. */
  text: string;
  /** Why the restart can't keep the conversation — the button is not drawn. */
  cant?: string;
  /** What a restart right now would stop — non-empty ⇒ ask first. */
  loses?: string;
}

export function cliRestartView(due: CliRestartDue, st: CliRestartState): CliRestartView {
  const text = `This session runs Claude ${due.running}; ${due.installed} is installed.`;
  if (!st.resumeId) {
    return { text, cant: "its conversation id is not known yet, so a restart could not reopen the same conversation" };
  }
  const parts: string[] = [];
  if (st.turnActive) parts.push("the turn that is running");
  const n = st.agents ?? 0;
  if (n > 0) parts.push(n === 1 ? "1 background agent" : `${n} background agents`);
  if (st.shells) parts.push("the background shells");
  return parts.length ? { text, loses: parts.join(" and ") } : { text };
}

/**
 * **Send on a session the restart is due on: ask first.** The moment before a
 * prompt is the cheapest restart there is — nothing is running, and once the
 * turn starts on the old binary the next chance is when it ends. Yes relaunches
 * the same conversation with the words as its first prompt (one op); the
 * other answer sends on the old version and is not asked again for it.
 */
export function cliRestartSendAsk(due: CliRestartDue): { title: string; lines: string[]; confirmLabel: string; cancelLabel: string } {
  return {
    title: `Restart on Claude ${due.installed} first?`,
    lines: [
      `This session still runs Claude ${due.running}; ${due.installed} is installed.`,
      `Restart, then send: the same conversation reopens on ${due.installed} and this message is its first prompt.`,
      `Send on ${due.running}: the message goes now and the bar above stays — this is not asked again for this version.`,
    ],
    confirmLabel: "Restart, then send",
    cancelLabel: `Send on ${due.running}`,
  };
}
