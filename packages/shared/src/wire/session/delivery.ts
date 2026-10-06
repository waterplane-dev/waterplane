import type { SentSource } from "../sent.js";

/**
 * A delivery whose fate the host could not confirm — and is still asking about.
 *
 * `deliver.ts` answers `unconfirmed` (written, never seen on screen) or
 * `unsubmitted` (in the composer, every Return swallowed) when its four-second
 * echo window fails. Neither may be auto-retried, so both used to be terminal:
 * the phone kept a red row for ever, retired it an hour later, clipped the
 * words to 200 characters and told the user to go and check the session by
 * hand. Sixty-seven of those rows accumulated on one device, several of them
 * prompts that were running at that moment.
 *
 * The ambiguity is a property of a four-second window, not of the world. This
 * is the host writing the question down instead of the answer: the row is
 * re-asked on a sweep (the CLI's own conversation log, the live screen) until
 * one of the terminal verdicts is TRUE, and nothing about that depends on a
 * phone being awake, connected, or remembering to ask.
 *
 * The full text is kept on purpose. It is the copy that makes the row
 * actionable — the host's own re-send of a provably-absent prompt is typed from
 * here — and the whole complaint this answers is words that went missing.
 */
export interface OpenDelivery {
  /** Host-minted row id. */
  id: string;
  /**
   * The client's row key, when the send carried one.
   *
   * Carried so a resolution can name the row it retires. A phone keys its queue
   * by ackId; a verdict that arrived as "some text, in some session" would be a
   * fact the client cannot match against the red row it is showing.
   */
  ackId?: string;
  sessionId: string;
  sessionTitle: string;
  cwd: string;
  repoName: string;
  /** What was sent, in full and un-clipped. */
  text: string;
  /** One-line head of it, for a row label. */
  head: string;
  kind: "prompt" | "command";
  source: SentSource;
  /** What `deliver.ts` said at the time — the reason this row exists at all. */
  reported: "unconfirmed" | "unsubmitted";
  /** When the delivery began. Every log lookup is matched against this, so an
   *  identical prompt fired this morning can never stand in as proof. */
  startedAt: number;
  /**
   * `open` = still being re-asked; the other four are terminal and mean exactly
   * what `input.settled` documents. `unknown` here is a give-up: the sweep ran
   * out of minutes without ever finding a readable conversation log.
   */
  verdict: "open" | "landed" | "composer" | "absent" | "unknown";
  /** Was the session still running when the verdict was reached? An `absent`
   *  prompt in a dead session has nowhere to be re-sent to. */
  alive?: boolean;
  /** How many times the host has re-asked, and when it next will. */
  asks: number;
  nextAskAt: number;
  /** When the sweep stops asking and settles for `unknown`. */
  deadlineAt: number;
  resolvedAt?: number;
  /** One sentence for the row — why it says what it says. */
  reason?: string;
  /**
   * A client asked about this row (`input.settle`), so the client owns what
   * happens next.
   *
   * Both sides can re-send a provably-absent prompt, and both re-sending it is
   * the one outcome neither is allowed to produce. The rule that separates them
   * is ownership, not timing: **the host acts for rows nobody is watching.** A
   * phone that asks has, by asking, proved it is awake and holding the row — so
   * from that moment the host keeps RECORDING the verdict (the row still says
   * what became of the prompt) and stops acting on it.
   */
  clientOwned?: boolean;
  /**
   * When the host last re-delivered it, and how many times it has — only ever
   * out of `absent`: "the log is readable and this never ran" is the one
   * verdict that makes another send provably safe rather than a second copy.
   *
   * That proof is taken again before every attempt, so the count is a budget
   * (`opendeliveries.ts`'s `RESEND_TRIES`) and not the safety argument. It is
   * on the wire because "the host is still trying, for the third time" and "the
   * host tried once and stopped" are the two sentences a red row was conflating
   * — a send that goes fatal-looking inside fifteen seconds is the complaint
   * this count answers. Absent on a row written before it existed; a row with a
   * `resentAt` and no count has been tried once.
   */
  resentAt?: number;
  resends?: number;
  resentResult?: "ok" | "retry" | "unconfirmed" | "unsubmitted";
  /**
   * The audit-log row this delivery already wrote (`SentCommand.id`).
   *
   * Carried so the settled verdict can be written BACK onto it. The sent log is
   * appended from inside the delivery — i.e. at the one moment the answer is
   * not yet known — so without this it states a four-second echo window's
   * opinion for ever, and it is the file "what happened to my deliveries" is
   * read out of.
   */
  sentId?: string;
  /**
   * The conversation-log turn that proved this row `landed` (the CLI's own
   * record uuid).
   *
   * Persisted because it is a CLAIM: one turn is evidence for exactly one
   * delivery, and the ledger enforcing that lives in memory. Two deliveries of
   * the same words — which is what a re-send is — would otherwise both settle
   * `landed` on the one turn after a restart, and the second of them never ran.
   */
  turnId?: string;
}
