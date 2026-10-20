// The redaction a harvested test fixture is kept under: one sample per signal
// per CLI version, taken on a GOOD observation (`host/clifixtures.ts`) and
// copied into the repo's fixtures by `tools/harvestfixtures.mjs`.
// The one door stays `./clihealth.js`; this slice imports its siblings directly, never the barrel.

import { signalSpec } from "./healthcatalog.js";
import { redactRow } from "./healthrecord.js";

/**
 * How a harvested sample is kept. By default the form its `SampleMode` names:
 * a `line` signal as a masked GRID (the readers work by row and column, so a
 * one-line sample is no fixture), a `shape` signal as a SKELETON of the record
 * it read (keys and event names, never a value) — `deliver.submit`'s is the
 * `UserPromptSubmit` hook that proved the turn, its prompt gone with every
 * other value. Two signals need a form of their own:
 *
 *   • `echo` — `deliver.echo`'s evidence is the composer holding the person's
 *     prompt. Kept as the prompt and the grid masked BY THE SAME RULE
 *     (`maskRow` is character for character), so the echo reader can still
 *     find one in the other and neither holds a word: the masked prompt, the
 *     `ECHO_SPLIT` row, the masked grid.
 *   • `notice` — `limit.reset`'s evidence is the block notice itself, and that
 *     text must never sit in plain bytes in a file a session might print (it
 *     would false-positive the detector on a live screen). Kept as a grid with
 *     the notice rows verbatim, then ROT13'd whole; `decodeFixture` undoes it.
 *
 * The fixture lands in a PUBLIC repo, so the bar is higher than for the
 * health record's own sample, which never leaves this desktop.
 */
export const FIXTURE_FORMS: Readonly<Record<string, "echo" | "notice">> = {
  "deliver.echo": "echo",
  "limit.reset": "notice",
};
/** The row between an `echo` fixture's prompt and its grid. */
export const ECHO_SPLIT = "⁂ screen ⁂";

/** A capture's file extension: a grid is text, a skeleton JSON. */
export function fixtureExt(id: string): "txt" | "json" {
  return FIXTURE_FORMS[id] || signalSpec(id).capture === "line" ? "txt" : "json";
}

const rot13 = (s: string) => s.replace(/[A-Za-z]/g, (c) => {
  const base = c <= "Z" ? 65 : 97;
  return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
});

/** A fixture's text as its reader reads it (a `notice` is stored ROT13'd). */
export function decodeFixture(id: string, text: string): string {
  return FIXTURE_FORMS[id] === "notice" ? rot13(text) : text;
}

/** At most this many rows of a grid are kept — the newest, where the CLI draws. */
export const FIXTURE_ROWS = 60;
/** …and this much of each row. */
const ROW_CAP = 300;

/**
 * A row's words, masked with its layout kept: every letter becomes `x`/`X`,
 * every digit `0`, so widths, wrapping, punctuation and box glyphs survive and
 * no word does. An option's leading index (`❯ 2.`) is kept: it is drawn by the
 * CLI, and the box readers count by it.
 */
export function maskRow(row: string, protect?: RegExp): string {
  const lead = /^(\s*(?:[❯›>]\s*)?\d{1,2}[.)])/.exec(row)?.[1] ?? "";
  const mask = (s: string) => s
    .replace(/\p{L}/gu, (c) => (c !== c.toLowerCase() ? "X" : "x"))
    .replace(/\p{N}/gu, "0");
  const rest = row.slice(lead.length);
  if (!protect) return lead + mask(rest);
  // Spans the CLI drew INSIDE a row of words (a paste chit) stay as drawn.
  let out = "", at = 0;
  for (const m of rest.matchAll(new RegExp(protect.source, protect.flags.includes("g") ? protect.flags : protect.flags + "g"))) {
    if (!m[0]) continue;
    out += mask(rest.slice(at, m.index)) + m[0];
    at = m.index! + m[0].length;
  }
  return lead + out + mask(rest.slice(at));
}

/**
 * A screen kept for a fixture: the CLI's CHROME verbatim (redacted as the
 * health sample is), every other row masked (`maskRow`). Which rows are chrome
 * is the host's knowledge — the footer and the meter row are what its readers
 * already recognise — so it is handed in.
 */
export function maskGrid(text: string, keep: (row: string) => boolean, protect?: RegExp): string {
  const rows = text.replace(/\r/g, "").split("\n").map((r) => r.replace(/\s+$/, ""));
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return rows.slice(-FIXTURE_ROWS)
    .map((r) => (r.length > ROW_CAP ? r.slice(0, ROW_CAP) : r))
    .map((r) => (keep(r) ? redactRow(r) : maskRow(r, protect)))
    .join("\n");
}

/** Keys whose string VALUE is a name the CLI chose, not content: record kinds,
 *  roles, hook events, tool names. Kept only while it looks like an identifier. */
const NAME_KEYS = new Set(["type", "subtype", "role", "name", "hook_event_name", "stop_reason", "permission_mode", "permissionMode"]);
const NAME_RE = /^[A-Za-z][\w.:-]{0,47}$/;
const KEY_RE = /^[A-Za-z_$][\w$-]{0,63}$/;
/** An identifier-shaped key that is really an ID (`toolu_014eSw…` keying a map):
 *  digits beside both cases, or a long run of digits. */
const ID_KEY_RE = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{12,}$|\d{6,}/;
const MAX_DEPTH = 16;
const MAX_ITEMS = 40;
/** What a leaf becomes — and stays, when a skeleton is put through again. */
const LEAVES = new Set(["<string>", "<number>", "<boolean>", "<deeper>", "<other>", "<mcp>"]);

/**
 * The structure of a record with its content gone: object keys (an
 * identifier-shaped key only — a map keyed by file path is content), the kind
 * of every leaf, the names in `NAME_KEYS`, and an array as its DISTINCT
 * element shapes. Idempotent, so a skeleton put through again is unchanged.
 */
export function skeletonOf(v: unknown, key = "", depth = 0): unknown {
  if (v === null) return null;
  if (typeof v === "string") {
    // An MCP tool's name says which servers this account connected: config, not schema.
    if (NAME_KEYS.has(key) && NAME_RE.test(v)) return v.startsWith("mcp__") ? "<mcp>" : v;
    return LEAVES.has(v) ? v : "<string>";
  }
  if (typeof v === "number") return "<number>";
  if (typeof v === "boolean") return "<boolean>";
  if (depth >= MAX_DEPTH) return "<deeper>";
  if (Array.isArray(v)) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const x of v) {
      const s = skeletonOf(x, key, depth + 1);
      const k = JSON.stringify(s);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const name = KEY_RE.test(k) && !ID_KEY_RE.test(k) ? k : "<key>";
      if (name in out) continue;
      out[name] = skeletonOf(x, name, depth + 1);
    }
    return out;
  }
  return "<other>";
}

/**
 * What a harvested sample of this signal keeps, or null when nothing may be
 * kept (a shape that is not JSON, an empty screen, an echo with no prompt).
 * `keep` names the chrome rows of a grid, `protect` the chrome spans inside
 * any other row.
 */
export function fixtureSample(id: string, raw: string, keep: (row: string) => boolean = () => false, protect?: RegExp): string | null {
  if (!raw) return null;
  const form = FIXTURE_FORMS[id];
  if (form === "echo") {
    let v: { prompt?: unknown; grid?: unknown };
    try { v = JSON.parse(raw); } catch { return null; }
    if (typeof v?.prompt !== "string" || typeof v?.grid !== "string" || !v.prompt.trim()) return null;
    const grid = maskGrid(v.grid, keep, protect);
    return grid.trim() ? `${v.prompt.replace(/\r/g, "").split("\n").map((r) => maskRow(r)).join("\n")}\n${ECHO_SPLIT}\n${grid}\n` : null;
  }
  if (form === "notice") {
    const grid = maskGrid(raw, keep);
    return grid.trim() ? rot13(grid) + "\n" : null;
  }
  if (signalSpec(id).capture === "line") {
    const grid = maskGrid(raw, keep);
    return grid.trim() ? grid + "\n" : null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return JSON.stringify(skeletonOf(parsed), null, 2) + "\n";
}
