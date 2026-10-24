// Host → client: the updates view. A member list of `HostMessage`.

import type { UpdatesRestart, UpdatesStatus } from "../updates.js";

export type HostUpdatesMsg =
  /** On connect, after any check and after any apply. */
  | { t: "updates.status"; status: UpdatesStatus }
  /** The answer to one `updates.apply`, by its `reqId`. `restart` says whether the daemon is
   *  restarting itself, needs the person to, or nothing changes. */
  | { t: "updates.result"; reqId: string; ok: boolean; message: string; restart: UpdatesRestart };
