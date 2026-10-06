/**
 * Every writer of the context feature's store, and the one thing it sends.
 */
import type { RepoTarget, SessionInfo } from "@waterplane/shared";
import { core } from "../../sdk";
import { compactToast } from "./logic";
import { explainCostPrompt } from "../../explainCost";
import { ctxSid } from "./store";

/**
 * Open the context sheet for ONE session — the launcher row's cost tile.
 *
 * Deliberately no `attach`: the sheet reads its series by id over HTTP, so
 * the numbers on a row open without spawning or switching to anything, and
 * the list is still there behind the sheet when it closes. Tapping the rest
 * of the row is how you enter the conversation, and that is the larger half.
 */
export function openContextFor(s: SessionInfo): void {
  const c = core();
  c.say.track("action:session.context");
  ctxSid.set(s.id);
  c.nav.open("context");
}

/** Open the context sheet on the ATTACHED session — the header chip. */
export function openContext(): void {
  ctxSid.set(null);
  core().nav.open("context");
}

export function closeContext(): void {
  ctxSid.set(null);
  core().nav.close("context");
}

/** The sheet's fresh-session door: close it (dropping whose sheet it was) and
 *  open a new session in the subject's repo. */
export function freshFromContext(repo: RepoTarget): void {
  closeContext();
  core().nav.openRepo(repo);
}

/**
 * The other door out of an expensive conversation, and the one the panel's own
 * ledger can put a figure on. Same durable path as the header chip
 * (`runHeaderCmd`) — the outbox and an ackId, never a bare socket write — but
 * aimed at SUBJECT, which is not necessarily the attached session: a launcher
 * row's cost tile opens this graph without attaching, and `/compact` typed
 * into the conversation behind the list is the one failure this button could
 * have. The sheet stays open: the effect lands in a session that may not even
 * be on screen, so the toast is the receipt.
 */
export function compactSubject(subject: SessionInfo): void {
  const c = core();
  c.say.track("action:ctx.compact");
  c.queue.submitInput(subject.id, subject.cwd, "/compact", "command");
  c.compose.pushHistory("/compact");
  c.say.toast(compactToast(c.conn.status === "open", c.world.sessionRowTitle(subject)));
}

/**
 * The third door: a NEW session in the subject's directory, started with a
 * prompt that explains what made the subject expensive and proposes fixes —
 * and implements none of them until asked. Through the launch core's
 * `startSessionWithPrompt`, so the create and its prompt are one durable op.
 * Returns false when there is no conversation id to point the prompt at (the
 * sheet shows that as a sentence, never a button that would guess).
 */
export function explainCostOf(subject: SessionInfo, title: string): boolean {
  const prompt = explainCostPrompt({ title, cwd: subject.cwd, claudeSessionId: subject.claudeSessionId, model: subject.model });
  if (!prompt) return false;
  const c = core();
  c.say.track("action:ctx.explainCost");
  closeContext();
  c.nav.startSessionWithPrompt(subject.cwd, `cost of ${title}`, [prompt]);
  return true;
}
