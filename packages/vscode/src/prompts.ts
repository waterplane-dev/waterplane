/**
 * The optimisation prompts: text a person can copy or type into a terminal. Nothing here runs
 * `claude` and nothing applies itself — a prompt is a sentence the person sends, or does not.
 * The text itself is built in `data/promptText.ts` (pure, tested); this file only delivers it.
 */
import * as vscode from "vscode";
import { scrub } from "./data/promptText.js";

export { PROMPTS, render } from "./data/promptText.js";
export type { PromptCtx, PromptForm, Rendered } from "./data/promptText.js";

export type Delivery = { ok: true; message: string } | { ok: false; message: string };

/** `copy` → clipboard. `terminal` → typed into the active terminal WITHOUT a newline: typed, not sent. */
export async function deliver(text: string, how: "copy" | "terminal"): Promise<Delivery> {
  if (how === "copy") {
    await vscode.env.clipboard.writeText(text);
    return { ok: true, message: "Prompt copied. Paste it into your Claude Code session." };
  }
  const term = vscode.window.activeTerminal;
  if (!term) return { ok: false, message: "There is no active terminal to type into. Open one, or copy the prompt instead." };
  // `render(…, "terminal")` already made it one line; scrub again so no path here can type a newline.
  term.sendText(scrub(text), false);
  term.show(true);
  return { ok: true, message: `Typed into ${term.name}, not sent. Press Enter there to send it.` };
}
