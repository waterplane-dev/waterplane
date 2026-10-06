/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/assess-architecture.md (host). */
import { writeTextAtomic } from "../jsonstore.js";

/**
 * Pull the assistant text out of the envelope, in either shape.
 *
 * `--output-format json` prints one object; `stream-json` prints one object per
 * line and the LAST one carrying a `result` is that same envelope. Searched
 * from the end, because that is where it is and because a retained TAIL starts
 * mid-line — the unparseable first line is simply not an event.
 *
 * `found` travels with the text so the caller can tell "the CLI said this" from
 * "here is what was on stdout", which is the difference between clipping the
 * head and clipping the tail.
 */
export function resultText(stdout: string): { text: string; found: boolean } {
  const lines = stdout.split("\n");
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k].trim();
    if (!line || line[0] !== "{") continue;
    try {
      const obj = JSON.parse(line) as { result?: unknown };
      if (typeof obj.result === "string") return { text: obj.result, found: true };
    } catch { /* not an event, or a torn first line */ }
  }
  return { text: stdout, found: false };
}

/**
 * JSON, with the one deviation worth tolerating: a document wrapped in a
 * markdown fence.
 *
 * The prompt asks for JSON only, and asking again after a failed run costs a
 * whole repo read — so a fence, which is the single most common way a model
 * complies-but-not-quite, is unwrapped rather than refused. Anything else is a
 * failed run: `undefined` here means "not readable", which is a verdict, and is
 * distinct from a document that legitimately parses to `null`.
 */
export function parseLoose(raw: string): unknown | undefined {
  const attempts = [raw, raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "")];
  for (const a of attempts) {
    try { return JSON.parse(a); } catch { /* try the next */ }
  }
  return undefined;
}

export function writeAtomic(path: string, body: string): void {
  writeTextAtomic(path, body);
}