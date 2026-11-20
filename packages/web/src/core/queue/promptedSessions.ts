/**
 * Sessions the desktop is still typing a first prompt into. A `session.create` that carries `prompt`
 * is acked the moment the PTY exists and leaves the phone's outbox, but the host then waits up to
 * 45 s for the TUI before it types the words (`deliverToNewSession`). In that window the session is
 * running, has no turn, no queue entry and no backlog item: it looks empty, and closing it as empty
 * (`useSendMenu`) would take the first prompt with it, kept nowhere. Remembered here for as long as
 * that wait can last; a session that has taken a turn stops being empty on its own.
 */
const TYPING_MS = 3 * 60_000;
const prompted = new Map<string, number>();

/** A create that carried a first prompt named this session (its ack, or `launch.opened`). */
export function notePromptedSession(sessionId: string, now = Date.now()): void {
  for (const [id, at] of prompted) if (now - at > TYPING_MS) prompted.delete(id);
  prompted.set(sessionId, now);
}

/** True while the first prompt carried inside this session's create may still be on its way. */
export function isPromptedSession(sessionId: string, now = Date.now()): boolean {
  const at = prompted.get(sessionId);
  return at !== undefined && now - at <= TYPING_MS;
}
