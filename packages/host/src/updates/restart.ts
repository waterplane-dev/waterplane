/**
 * Restart this daemon the one way it is done in-process: SIGTERM after the reply is out, and ONLY
 * when a supervisor (launchd/systemd) will start it again — a false yes leaves the host down.
 * Shared by the code-folder choice (`routes/apihost.ts`) and the updates view.
 */
import { hostSupervisor } from "../rootchoice.js";
import { setRestartNote } from "../restartnote.js";

export type Restarter = (reason: string | null) => "auto" | "manual";

/** Schedules the restart and returns "auto"; unsupervised does nothing and returns "manual". */
export const restartSelf: Restarter = (reason) => {
  const sup = hostSupervisor();
  if (!sup) return "manual";
  if (reason) setRestartNote(reason);
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 800).unref();
  return "auto";
};

/** Whether `restartSelf` would restart (asked before promising the phone "auto"). */
export const canRestartSelf = (): boolean => hostSupervisor() !== null;
