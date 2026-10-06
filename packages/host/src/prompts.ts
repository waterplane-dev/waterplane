/**
 * **A fork's own words for the unattended model calls.**
 *
 * `promptText(name, fallback)` answers `<config dir>/prompts/<name>.md` when that
 * file holds anything, else `fallback` — the pinned default, byte for byte the
 * text that shipped. The config dir is `branddirs.ts`' `configDir()`, the same one
 * `secrets.ts` and the `.env` load use.
 *
 * Read PER CALL, not cached: the callers are unattended passes and a tapped
 * button, minutes apart, and one `readFileSync` of a few hundred bytes costs
 * nothing against a model call. A cache would need an mtime check to notice an
 * edit anyway — and then hot-reload (the point of a file a person edits while
 * the daemon runs) would be exactly what the read already is.
 *
 * Never throws and never returns an empty string: a missing, unreadable, empty
 * or whitespace-only file is the default (the unreadable and the empty ones are
 * logged once per name — an absent file is the normal case and says nothing). A
 * name outside `[a-z0-9-]+` is refused so a caller bug cannot read outside the
 * `prompts/` dir. Only the INSTRUCTION wording is overridable: the JSON contracts
 * the parsers read stay in code. Why / the names: docs/notes/host.md.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./branddirs.js";

const NAME_RE = /^[a-z0-9-]+$/;
const said = new Set<string>();

function sayOnce(key: string, msg: string): void {
  if (said.has(key)) return;
  said.add(key);
  console.warn(`[prompts] ${msg}`);
}

function promptsDir(): string {
  return join(configDir(), "prompts");
}

/** The override for `name`, or `fallback`. Never throws. */
export function promptText(name: string, fallback: string): string {
  try {
    if (!NAME_RE.test(name)) {
      sayOnce(`name:${name}`, `refusing prompt name ${JSON.stringify(name)} (must match ${NAME_RE})`);
      return fallback;
    }
    const file = join(promptsDir(), `${name}.md`);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") sayOnce(`read:${name}`, `cannot read ${file}: ${(e as Error)?.message}; using the default`);
      return fallback;
    }
    // Trailing newline off: an editor adds one and the default has none.
    const text = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    if (!text.trim()) {
      sayOnce(`empty:${name}`, `${file} is empty; using the default`);
      return fallback;
    }
    return text;
  } catch {
    return fallback;
  }
}

/** Names with a non-empty override file present right now (for a doctor row). */
export function overriddenPrompts(): string[] {
  try {
    return readdirSync(promptsDir())
      .filter((f) => f.endsWith(".md") && NAME_RE.test(f.slice(0, -3)))
      .map((f) => f.slice(0, -3))
      .filter((n) => promptText(n, "") !== "")
      .sort();
  } catch {
    return [];
  }
}
