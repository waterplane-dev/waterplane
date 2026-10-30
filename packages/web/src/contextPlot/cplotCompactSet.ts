/**
 * The auto-compact SETTING on the context chart: its line label and its caption.
 * A setting as it reads now, beside the measured "compacts ~" line — the two are
 * never worded alike (docs/notes/charts-architecture.md).
 */

import { formatTokenWindow, wordOf, type AutoCompactSource } from "@waterplane/shared";

const SET_WHERE: Record<AutoCompactSource, string> = {
  env: "the daemon's CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  local: ".claude/settings.local.json",
  project: ".claude/settings.json",
  user: "~/.claude/settings.json",
  unset: "",
};

/** The chart's label for the SETTING line: the value as it is written, never a %. */
export function autoCompactSetLabel(tokens: number): string {
  return `auto-compact set ${formatTokenWindow(tokens)}`;
}

/**
 * The caption for the auto-compact SETTING as it reads now. A size is a line on
 * the chart and is named with where it is set; auto, unset or unreadable draw no
 * line and say why — auto compacts near the model's own window, and a guessed
 * number for it would be a wrong one.
 */
export function autoCompactSetText(s: { tokens: number | null; source: AutoCompactSource; raw?: string }): string {
  if (s.source === "unset") return "No autoCompactWindow is set for this repo, so the CLI compacts near the model's own window — no setting line is drawn.";
  const where = wordOf(SET_WHERE, s.source, "a place this app version cannot name");
  if (s.tokens == null) {
    return /^auto$/i.test(s.raw?.trim() ?? "")
      ? `autoCompactWindow is "auto" in ${where}, so the CLI compacts near the model's own window — no setting line is drawn.`
      : `autoCompactWindow in ${where} reads ${JSON.stringify(s.raw ?? "")}, which is not a size — no setting line is drawn.`;
  }
  return `The dotted line is autoCompactWindow as ${where} sets it now (${formatTokenWindow(s.tokens)}) — the setting today, not necessarily what this conversation ran under.`;
}
