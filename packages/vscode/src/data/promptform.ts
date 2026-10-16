/**
 * The two forms a prompt is rendered in, and the scrub that keeps quoted text from typing a control
 * character into a terminal. Its own module so `promptText.ts` and `health/healthprompts.ts` both
 * import it without importing each other (they used to form a cycle).
 */
export type PromptForm = "copy" | "terminal";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g;

/** Text from a log or a file, safe to quote: every C0 control and DEL becomes a space, runs collapse. */
export const scrub = (s: string): string => s.replace(CONTROL, " ").replace(/ {2,}/g, " ").trim();

/** Paragraphs → the form asked for. The terminal form is one line with no control character in it. */
export function formJoin(paras: string[], form: PromptForm): string {
  if (form === "copy") return paras.join("\n\n");
  return scrub(paras.join(" — "));
}
