// `POST /api/relay` — the background relay's one HTTP route (plan:
// .claude/outbox/bg-link-send/PLAN.md). NOT a socket message and not in either
// union: a sender with no page (the APK's `ShellLinkService`, the PWA's service
// worker) hands the host ONE frame the phone's send queue built (`entryFrame`)
// and gets back the verdict the queue's own receipt handler will apply later.
// The relay never mints an ackId and never edits a row; which frames it may
// carry is `relayRefusal` (`queue/queuerelay.ts`), asked by both ends.

import type { ClientMessage } from "../messages.js";
import type { HostCoreMsg } from "./hostcore.js";

/** The three receipts a relayed frame can earn — verbatim the frame the host
 *  sends a page's socket, so the page replays it through `core/queue/wire.ts`. */
export type RelayAckFrame = Extract<HostCoreMsg, { t: "input.ack" | "backlog.ack" | "op.ack" }>;

/** The longest a relay request may ask the host to wait for the verdict. */
export const RELAY_WAIT_MAX_MS = 100_000;

/** `POST /api/relay` body. `waitMs` is capped at `RELAY_WAIT_MAX_MS` host-side. */
export interface RelayRequest {
  frame: ClientMessage;
  waitMs?: number;
  /** The page never attempted this row, so its `firstSentAt` is the relay's own stamp: the host
   *  skips the "first sent past the ledger's life" check (an unknown ackId then never arrived). */
  firstByRelay?: boolean;
}

/**
 * `POST /api/relay` answer — exactly one of:
 *   ack     — the verdict, verbatim (`ok`, `rescued`, `retryable`, …);
 *   pending — still running after `waitMs`; the host's ledger and
 *             `inputsInFlight` keep it, so a re-send of the same ackId joins
 *             or is re-acked, never re-run;
 *   refused — the frame is not one a relay may carry, in words. Nothing ran.
 * An older host answers 404: the relay is unsupported on that link.
 */
export type RelayResponse =
  | { ack: RelayAckFrame }
  | { pending: true }
  | { refused: string };
