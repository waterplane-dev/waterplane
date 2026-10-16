/**
 * What a LIVE session is running on, for its one-line label: the newest turn's
 * model and effort (`turnModel`/`turnEffort`, off the conversation log) over
 * the launch flags.
 *
 * Reported from a phone: `/model fable` and `/effort high` had both landed and
 * the next turn ran on `claude-fable-5-1` at `high` — and the header still read
 * `opus · medium`, because `launchLabel` was only ever handed the flags the
 * session was STARTED with, which a slash command never moves.
 *
 * The log names a full id and the label speaks aliases, so a turn model of the
 * same family as the launch alias keeps the launch spelling (that is what keeps
 * `opus[1m]`, a window the log does not record); another family is named by
 * its family word. An id this cannot read a family off is shown as it is,
 * minus `claude-`. No turn yet ⇒ the launch flags, unchanged.
 */
export function liveLaunch<T extends { model?: string; effort?: string; turnModel?: string; turnEffort?: string }>(s: T): T {
  if (!s.turnModel && !s.turnEffort) return s;
  const effort = s.turnEffort ?? s.effort;
  if (!s.turnModel) return { ...s, effort };
  const family = /^claude-([a-z]+)-/.exec(s.turnModel)?.[1];
  const launchFamily = s.model?.replace(/\[1m\]$/i, "").replace(/^claude-/, "").split("-")[0];
  const model = family && family === launchFamily ? s.model : family ?? s.turnModel.replace(/^claude-/, "");
  return { ...s, model, effort };
}
