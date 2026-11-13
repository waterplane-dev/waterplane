/** What one skill costs: its listing line (always carried) and its body (on demand). Pure. */
import { frontmatterLines, skillDescChars } from "@waterplane/shared";

/** The `name:` frontmatter value, or null. */
export function frontmatterName(text: string): string | null {
  for (const l of frontmatterLines(text) ?? []) {
    const m = /^["']?name["']?[ \t]*:(.*)$/.exec(l);
    if (m) return m[1]!.trim().replace(/^["']|["']$/g, "") || null;
  }
  return null;
}

/** `disable-model-invocation: true` in the frontmatter: the CLI keeps such a skill out of the model's listing, whatever `skillOverrides` says. */
export function disablesModelInvocation(text: string): boolean {
  for (const l of frontmatterLines(text) ?? []) {
    const m = /^["']?disable-model-invocation["']?[ \t]*:(.*)$/.exec(l);
    if (m) return m[1]!.split("#")[0]!.trim().replace(/^["']|["']$/g, "").toLowerCase() === "true";
  }
  return false;
}

/** The CLI's own cap on one listing entry's text (`skillListingMaxDescChars` default). */
export const DEFAULT_MAX_DESC = 1536;

/** The `when_to_use:` frontmatter value's length (the CLI appends it to the description), 0 when absent. */
function whenToUseChars(text: string): number {
  const lines = frontmatterLines(text);
  const start = lines ? lines.findIndex((l) => /^["']?when_to_use["']?[ \t]*:/.test(l)) : -1;
  if (!lines || start < 0) return 0;
  const first = lines[start]!.replace(/^["']?when_to_use["']?[ \t]*:/, "").trim();
  const parts = /^[>|][+-]?\d*$/.test(first) ? [] : [first];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_-]+:/.test(lines[i]!)) break;
    parts.push(lines[i]!.trim());
  }
  return parts.join(" ").trim().length;
}

/**
 * With no `description:` the CLI lists the first non-blank body line, leading `#` heading marks
 * dropped (read back from a headless listing 2026-11-12: `# Heading` listed as `Heading`).
 */
function bodyFallbackChars(text: string): number {
  const fm = /^(?:[ \t]*\r?\n)*---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ""));
  const body = fm ? text.replace(/^\uFEFF/, "").slice(fm[0].length) : text;
  for (const l of body.split(/\r?\n/)) {
    const t = l.trim().replace(/^#+\s*/, "").trim();
    if (t) return t.length;
  }
  return 0;
}

export interface Weight { listingChars: number; bodyChars: number; capped: boolean }

/**
 * `- <name>: <description> - <when_to_use>` is the listing line; the text past `maxDesc`
 * (skillListingMaxDescChars, else the CLI's own default of 1536) is cut by the CLI, so it counts
 * capped. This is the line BEFORE the CLI's overall listing budget: past it the CLI shrinks entries
 * to bare names, so a figure built from these lines is an upper bound, never an exact carry.
 */
export function weightOf(name: string, text: string, maxDesc: number = DEFAULT_MAX_DESC): Weight {
  const hasDesc = (frontmatterLines(text) ?? []).some((l) => /^["']?description["']?[ \t]*:/.test(l));
  const d = hasDesc ? skillDescChars(text) : bodyFallbackChars(text), w = whenToUseChars(text);
  const raw = d > 0 || w > 0 ? d + (d > 0 && w > 0 ? 3 : 0) + w : 0;
  const capped = raw > maxDesc;
  const desc = capped ? maxDesc : raw;
  const fm = /^(?:[ \t]*\r?\n)*---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^﻿/, ""));
  const bodyChars = Math.max(0, text.length - (fm ? fm[0].length : 0));
  // "- " + name + ": " + description; no description is just "- name".
  return { listingChars: desc > 0 ? name.length + desc + 4 : name.length + 2, bodyChars, capped };
}
