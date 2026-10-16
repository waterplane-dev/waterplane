import type { DetectedPrompt } from "@waterplane/shared";

/**
 * Which boxes the TERMINAL view answers by tap — the one exception to "a terminal is driven the
 * terminal's way" (`PromptAnswer.tsx`). Only the workspace-trust box: it is the first thing a new
 * person meets, before they know the key bar exists, and claude 2.1.293 draws it UNNUMBERED with
 * the cursor on "No, exit", so the obvious keystroke (a digit) does nothing and Return leaves.
 * Every other box stays the terminal's (press the digit) or the reader's (tap).
 */
export function termAnswersBox(p: DetectedPrompt | undefined | null, running: boolean): p is DetectedPrompt {
  return !!p && running && p.kind === "trust" && p.options.length > 0;
}
