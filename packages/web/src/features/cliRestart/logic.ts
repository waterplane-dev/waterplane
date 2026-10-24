/**
 * When an armed "restart when idle" fires. Pure: the session as the host last
 * said it, the version the arm was for, the version installed now, and how
 * many of this session's messages are still in the send queue.
 *
 * Idle means a restart would stop nothing — the same test the banner's
 * confirm uses (`cliRestartView(...).loses`), so "idle" is never worded two
 * ways — and nothing of the person's is still on its way into it: a held
 * prompt typed the moment the turn ends would otherwise race the kill.
 */
import { cliRestartDue, cliRestartView, type SessionInfo } from "@waterplane/shared";

export type ArmVerdict = "fire" | "wait" | "drop";

export function armVerdict(
  s: SessionInfo,
  armedFor: string,
  installed: string | undefined,
  resumeId: string | undefined,
  queued: number,
): ArmVerdict {
  const due = cliRestartDue(s.cliVersion, installed);
  // Already on the new version (restarted some other way), or the install it
  // was armed for is no longer the one on disk: the tap was about that one.
  if (!due || due.installed !== armedFor) return "drop";
  const v = cliRestartView(due, { turnActive: s.turnActive, agents: s.agents?.length, shells: s.shells, resumeId });
  if (v.cant) return "drop";
  return v.loses || queued > 0 ? "wait" : "fire";
}
