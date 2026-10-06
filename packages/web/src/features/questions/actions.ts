/**
 * What the questions sheet sends that is not an answer. An ANSWER is the
 * queue's `answerPrompt` (durable, fingerprinted) — the same path the reader's
 * card uses, so there is deliberately no second way to answer a question here.
 */
import type { SessionInfo } from "@waterplane/shared";
import { core } from "../../sdk";

/**
 * "I dealt with that elsewhere": retire a prose question without typing
 * anything. Live-only and never queued (`session.ackAsking`), so it goes
 * through the helper that refuses in words rather than through the durable
 * queue: an acknowledgement is about a screen being read NOW.
 */
export function ackAsking(s: SessionInfo): void {
  core().conn.liveSend({ t: "session.ackAsking", id: s.id, text: s.asking?.text },
    "marked as handled — nothing was typed into the session");
}
