// Client → host: the updates view (waterplane itself + plugins). A member list of `ClientMessage`.
// `updates.get`/`updates.check` are reads. `updates.apply` changes the desktop, so it is durable:
// ackId + SendStamp, at-most-once per the protocol skill; a confirm precedes it on the phone.

import type { SendStamp } from "../../sendstamp.js";
import type { UpdatesTarget } from "../updates.js";

export type ClientUpdatesMsg =
  /** Ask for the cached status; answered with `updates.status`. */
  | { t: "updates.get" }
  /** Check now (the host keeps a 10-minute floor); answered with `updates.status`. */
  | { t: "updates.check" }
  /** Apply one target; answered by `updates.result` matched on `reqId`. */
  | ({ t: "updates.apply"; target: UpdatesTarget; reqId: string; ackId?: string } & SendStamp);
