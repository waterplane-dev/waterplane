/**
 * Real captures of the CLI, kept for the heuristics' test fixtures.
 *
 * The tests in `packages/host/test` prove only what somebody believed the CLI
 * drew, and `clihealth.ts` notices drift only after a phone has sat blocked. So
 * the first time a signal is seen to WORK on a CLI version, this keeps that one
 * input — redacted — under the host's state dir, at most one per signal per
 * version: `<state>/clifixtures/<version>/<signal>.txt` (a screen) or `.json`
 * (a record's skeleton). `tools/harvestfixtures.mjs` lists them and, asked to,
 * copies them into the repo for a person to review. Nothing here commits, and
 * nothing here writes to a session.
 *
 * The redaction is `shared`'s `fixtureSample`, applied HERE rather than at the
 * call site for the reason `observe()` applies the health sample's: the call
 * site that leaks is the one written later. What this file adds is the one
 * thing the rule cannot know — which rows of a screen are the CLI's own chrome,
 * kept verbatim, because that is what the readers match. Every other row is
 * masked. The block notice is kept only ROT13'd (`FIXTURE_FORMS`), so its
 * words never sit in plain bytes in a file a session might print.
 *
 * The source is a THUNK: a capture costs a screen read or a log read, and it
 * is paid once per signal per version, never per observation.
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLI_SIGNALS, fixtureExt, fixtureSample } from "@waterplane/shared";
import { writeTextAtomic } from "./jsonstore.js";
import { isDialogFooterRow } from "./prompt.js";
import { contextMeterRow, detectContext } from "./context.js";
import { detectLimitText, parseResetTime } from "./limit.js";

/** Where a capture's input comes from, asked only when one is wanted. Null or
 *  a throw ⇒ nothing is kept, and the next good observation asks again. */
export type FixtureSource = () => string | null | undefined | Promise<string | null | undefined>;

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const KNOWN = new Set<string>(CLI_SIGNALS.map((s) => s.id));

/** The CLI's banner, kept so a fixture says which build drew it. */
const BANNER_RE = /Claude Code v\d+\.\d+\.\d+/;
/** The rows the CLI draws under every question: its own options and the commit row. */
const CONST_OPTION_RE = /^\s*(?:❯\s*)?\d{1,2}\.\s*(?:\[.\]\s*)?(?:Type something\.?|Chat about this)\s*$/;
const COMMIT_ROW_RE = /^\s*\S?\s*(?:Submit|Next)\s*$/;
/** A local command in the composer, and the command name a slash capture leads with. */
const SLASH_ROW_RE = /^(?:\s*❯\s)?\/[a-z][\w-]*\s*$/;

/**
 * A row of key hints and nothing else — `Enter to select · ↑/↓ to navigate ·
 * ctrl+g to edit in Vim · Esc to cancel`. Wider than `isDialogFooterRow` on
 * purpose (that one caps a hint's verb at two words, a prose guard this does
 * not need: every segment must be KEY "to" verb, so no sentence survives).
 */
const KEY = String.raw`(?:Enter|Esc|Tab|Space|Return|[↑↓←→]+(?:/[↑↓←→]+)?|(?:ctrl|shift|alt|meta|cmd)\+\S+)`;
const HINT_RE = new RegExp(`^${KEY} to [a-z][\\w ]{0,30}$`, "i");
/** A footer wrapped at a narrow width: its first row may END on `ctrl+g to`,
 *  the next BEGIN with the verb it cut (`edit in Vim`). */
const HINT_HEAD_RE = new RegExp(`^${KEY}(?: to)?$`, "i");
const HINT_TAIL_RE = /^[a-z][\w ]{0,30}$/i;
function hintRow(r: string): boolean {
  const segs = r.trim().split(/\s+·\s+/);
  if (!segs[0]) return false;
  const full = segs.filter((g) => HINT_RE.test(g)).length;
  return segs.every((g, i) => HINT_RE.test(g)
    || (full > 0 && i === segs.length - 1 && HINT_HEAD_RE.test(g))
    || (full > 0 && i === 0 && HINT_TAIL_RE.test(g)));
}

const boxChrome = (r: string) => isDialogFooterRow(r) || hintRow(r) || CONST_OPTION_RE.test(r) || COMMIT_ROW_RE.test(r) || BANNER_RE.test(r);
/** A row the context reader takes a figure from on its own. */
const meterRow = (r: string) => {
  if (!r.trim()) return false;
  if (contextMeterRow(r) === r.trim()) return true;
  const c = detectContext(r);
  return c.leftPct != null || c.usedTok != null;
};

/**
 * A paste chit (`[Pasted text #2 +4 lines]`) — the CLI's drawing, and what the
 * echo reader counts newlines off — kept as drawn wherever it sits, including
 * the two halves of one the composer wrapped (`…[Pasted text #3 +2` / `lines]…`).
 */
const CHIT_RE = /\[Pasted text #\d+(?: \+\d+(?: lines?\]?)?)?\]?|^\s*lines?\]/g;
/** A row the limit reader takes the block or its reset from on its own. */
const noticeRow = (r: string) => {
  if (!r.trim()) return false;
  const now = Date.now();
  return detectLimitText(r, now).blocked || parseResetTime(r, now) != null;
};

/** Per grid signal: which rows are chrome. A signal not named keeps none. */
const CHROME: Record<string, (row: string) => boolean> = {
  "prompt.box": boxChrome,
  "prompt.submit": boxChrome,
  "context.meter": (r) => BANNER_RE.test(r) || meterRow(r),
  "slash.local": (r) => SLASH_ROW_RE.test(r) || BANNER_RE.test(r),
  "deliver.echo": (r) => BANNER_RE.test(r),
  "limit.reset": (r) => noticeRow(r) || BANNER_RE.test(r),
};

export function chromeRow(id: string): (row: string) => boolean {
  return CHROME[id] ?? (() => false);
}

/** Per grid signal: the chrome SPANS inside a masked row. */
export function chromeSpans(id: string): RegExp | undefined {
  return id === "deliver.echo" ? CHIT_RE : undefined;
}

export class FixtureShelf {
  /** Asked but not yet written — so two good observations a tick apart run one source. */
  private pending = new Set<string>();

  constructor(private dir: string) {}

  /** The file a capture of this signal on this version lives at; null when
   *  either is not something a path may be built from. */
  fileFor(id: string, version: string | null | undefined): string | null {
    if (!version || !VERSION_RE.test(version) || !KNOWN.has(id)) return null;
    return join(this.dir, version, `${id}.${fixtureExt(id)}`);
  }

  /** Would a capture of `id` on `version` be kept? For a call site whose input
   *  must be read NOW (the composer, before the Return clears it). */
  wants(id: string, version: string | null | undefined): boolean {
    const file = this.fileFor(id, version);
    return !!file && !this.pending.has(file) && !existsSync(file);
  }

  /** Keep one capture of `id` on `version`, unless one is kept already. */
  offer(id: string, version: string | null | undefined, source: FixtureSource): void {
    const file = this.fileFor(id, version);
    if (!file || this.pending.has(file) || existsSync(file)) return;
    this.pending.add(file);
    Promise.resolve()
      .then(source)
      .then((raw) => {
        const kept = raw ? fixtureSample(id, raw, chromeRow(id), chromeSpans(id)) : null;
        if (!kept) return;
        mkdirSync(dirname(file), { recursive: true });
        writeTextAtomic(file, kept);
      })
      .catch(() => { /* best-effort: a capture is never the reason anything else fails */ })
      .finally(() => this.pending.delete(file));
  }
}

/** How much of a conversation log's tail a `transcript.jsonl` capture reads. */
const LOG_TAIL_BYTES = 512 * 1024;

/** At most this many records, one per kind, go into a `transcript.jsonl` capture. */
const LOG_KINDS = 24;
/** The record types the transcript reader reads; the CLI's request/telemetry
 *  records are neither its subject nor anything a public fixture needs. */
const LOG_TYPES = new Set(["user", "assistant", "system", "summary"]);

/**
 * A conversation log's tail as one JSON array of records, the NEWEST of each
 * kind (record type, subtype, content block types) — the input to
 * `transcript.jsonl`'s skeleton, which keeps keys and names and no value. One
 * per kind, because every tool call is a distinct shape and the reader asks
 * about the turn records, not the tool catalogue. Null when unreadable.
 */
export function logRecords(path: string): string | null {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buf = Buffer.allocUnsafe(size - start);
    const fd = openSync(path, "r");
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // half a record
    const byKind = new Map<string, unknown>();
    for (const l of lines) {
      let r: any;
      try { r = l ? JSON.parse(l) : null; } catch { continue; } // a torn last line
      if (!r || typeof r !== "object" || !LOG_TYPES.has(r.type)) continue;
      const content = r.message?.content;
      const blocks = Array.isArray(content) ? content.map((b: any) => b?.type).join(",") : typeof content;
      const kind = `${r.type}/${r.subtype ?? ""}/${blocks}`;
      byKind.delete(kind);
      byKind.set(kind, r);
      if (byKind.size > LOG_KINDS) byKind.delete(byKind.keys().next().value!);
    }
    return byKind.size ? JSON.stringify([...byKind.values()]) : null;
  } catch { return null; }
}
