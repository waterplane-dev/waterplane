/**
 * The two unions on the wire, and the protocol version they are versioned by.
 *
 * Kept apart from the DTOs deliberately: this file changes when a MESSAGE is
 * added, and the DTO files change when a FIELD is. Both used to be the same
 * 1,768-line file, which every feature in the project therefore edited.
 */

import type { ClientSessionMsg } from "./messages/clientsession.js";
import type { ClientBacklogMsg } from "./messages/clientbacklog.js";
import type { ClientHostMsg } from "./messages/clienthost.js";
import type { ClientWorkMsg } from "./messages/clientwork.js";
import type { HostCoreMsg } from "./messages/hostcore.js";
import type { HostToolsMsg } from "./messages/hosttools.js";

/** 2 is a DELIBERATE bump: `plugin.call`/`plugin.reply`/`plugin.push` are the generic extension
 *  channel. An older host ignores `plugin.call`, so calls time out and say so. Today the bump only
 *  triggers the phone's mismatch toast and the host's warning (`routes/system.ts` `onHello`). */
export const PROTOCOL_VERSION = 2;

/** The intent DTOs travel with the messages that carry them, so no import site
 *  has to know they live one file over. */
export type { IntentDraft, IntentPatch } from "./intent.js";

export type { PeerKind, AuthState } from "./messages/hostcore.js";

// ── Client → Host ────────────────────────────────────────────────────
//
// `& SendStamp` on every ackId-carrying durable message: the optional, additive
// `firstSentAt` (first attempt, never changed on a retry) and `sentAt` (this
// attempt). They let a host whose ack ledger was lost refuse a re-send first
// sent BEFORE the loss instead of running it twice (`sendstamp.ts`). Absent =
// an older client = today's behaviour; `PROTOCOL_VERSION` did not move.

export type ClientMessage =
  | ClientSessionMsg
  | ClientBacklogMsg
  | ClientHostMsg
  | ClientWorkMsg;

// ── Host → Client ────────────────────────────────────────────────────

export type HostMessage =
  | HostCoreMsg
  | HostToolsMsg;

export function encode(msg: ClientMessage | HostMessage): string {
  return JSON.stringify(msg);
}

export function decode<T = ClientMessage | HostMessage>(raw: string): T {
  return JSON.parse(raw) as T;
}
