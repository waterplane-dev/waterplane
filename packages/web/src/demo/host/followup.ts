/**
 * `session.followup` in the demo — the host's answer, without the flag store
 * (R-sessions-041). `id` is a live session id or a closed row's conversation
 * id; `on:true` sets the person's flag, `on:false` clears whoever set it.
 * Answered the way the host answers it: `session.updated` for a live session,
 * a fresh `closed.list` for a closed one, and no receipt (fire-and-forget).
 */
import type { Desk } from "./model.ts";

export function setFollowUp(d: Desk, id: string, on: boolean): void {
  const s = (d.m.sessions ?? []).find((x) => x.id === id || x.claudeSessionId === id);
  if (s) {
    if (on) { if (!s.followUp) s.followUp = { by: "hand", at: d.now() }; }
    else delete s.followUp;
    d.broadcast({ t: "session.updated", session: s });
    return;
  }
  const c = (d.m.closed ?? []).find((x) => (x.claudeSessionId ?? x.id) === id || x.id === id);
  if (!c) return;
  if (on) { if (!c.followUp) c.followUp = { by: "hand", at: d.now() }; }
  else delete c.followUp;
  d.broadcast({ t: "closed.list", closed: d.m.closed ?? [] });
}
