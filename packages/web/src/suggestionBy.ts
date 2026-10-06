/**
 * Who a suggested answer is from, in words — the plugin's display name, and the
 * model when the plugin said which. A suggestion used to be the oracle's and
 * said "gemini-2.5-flash suggests"; any plugin may suggest now, so the name
 * comes first and the model is optional. No imports, so `node --test` runs it.
 */
export function suggestionBy(s: { by?: string; byName?: string; model?: string }): string {
  const who = s.byName?.trim() || s.by?.trim() || "a plugin";
  const model = s.model?.trim();
  return model ? `${who} (${model})` : who;
}

/**
 * What tapping an option that makes a standing rule (`PromptOption.remembers`) does, in
 * words, on the option itself — before the tap. The label is the HOST's (what it will keep
 * the rule under), never the plugin's option text alone, and the scope is always said:
 * the rule dies with the session, the plugin's switch-off or a restart.
 */
export function remembersText(r: { label: string }): string {
  const label = r.label.trim() || "this request";
  return `won't ask again for: ${label} — this session only`;
}
