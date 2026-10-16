// `.ts` on purpose: `splitHeaderCmds` below is pinned by `headerCmds.test.mjs`
// under `node --test`, which resolves ESM specifiers literally. Type-only
// imports are erased and may stay extensionless; a VALUE import may not.
import { LS, lsDel, lsJson, lsSetJson } from "./storage.ts";
/**
 * Header commands — the user's own one-tap chips in the session header.
 *
 * The header is the one bar that stays in reader view (the reading-room
 * layout), so it is where a command you fire constantly belongs: `/compact`,
 * `/context`, "continue". Everything else needed a sheet — the slash list, or
 * the compose box plus the keyboard — which on a phone is three taps and a
 * viewport resize for a five-character message.
 *
 * Stored in localStorage and SYNCED through the host (see `settings.ts`), like
 * snippets, fan-out presets and the toolbar config: which commands earn a
 * permanent slot is a personal habit, and re-creating it on every client — a
 * phone, a desktop tab, the Android shell — is the part nobody does.
 *
 * Shape mirrors `presets.ts` (`{ list, removed }`, not a bare array) for the
 * same reason: a later build that ships a NEW default must be able to show it
 * without resurrecting the defaults this user deliberately deleted.
 *
 * A chip is `{ id, title, text }` — the same shape `SnippetSheet` edits, so the
 * editor is reused rather than copied.
 */
export interface HeaderCmd { id: string; title: string; text: string }

const KEY = LS.headerCmds;
const MAX_ITEMS = 40;
// A chip sits in a single header row next to the session title — a long label
// scrolls the row instead of the ones behind it, so keep it short.
const MAX_TITLE = 24;
const MAX_TEXT = 8000;

export const DEFAULT_HEADER_CMDS: HeaderCmd[] = [
  { id: "compact", title: "/compact", text: "/compact" },
  { id: "context", title: "/context", text: "/context" },
  { id: "continue", title: "continue", text: "continue" },
];

interface Stored { list: HeaderCmd[]; removed: string[] }

/** First non-empty line, shortened — the fallback chip label. */
export function autoTitle(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line || "untitled";
}

function clean(c: unknown): HeaderCmd | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.slice(0, 64) : "";
  const text = typeof o.text === "string" ? o.text.slice(0, MAX_TEXT) : "";
  const title = typeof o.title === "string" ? o.title.slice(0, MAX_TITLE) : "";
  if (!id || !text.trim()) return null;
  return { id, title: title.trim() || autoTitle(text), text };
}

export function loadHeaderCmds(): HeaderCmd[] {
  // `lsJson` rather than `localStorage.getItem` + `JSON.parse`: storage.ts's
  // readers are where the private-mode and quota throws are swallowed once
  // instead of forty times, and the hand-rolled try/catch here was the only
  // copy left in this file (the write already went through `lsSetJson`).
  //
  // `null` as the fallback because four different nothings have to read the
  // same: no key, an empty string, unparsable JSON and a stored literal `null`
  // all mean "this person has never edited their chips", which is the shipped
  // list — NOT an empty one. An emptied list is a different, stored fact:
  // `{ list: [], removed: [...] }`, which survives the branch below.
  const parsed = lsJson<Partial<Stored> | null>(KEY, null);
  if (!parsed || typeof parsed !== "object") return [...DEFAULT_HEADER_CMDS];
  const stored: Stored = {
    list: Array.isArray(parsed.list) ? parsed.list.map(clean).filter((c): c is HeaderCmd => !!c) : [],
    removed: Array.isArray(parsed.removed) ? parsed.removed.filter((r) => typeof r === "string") : [],
  };
  const have = new Set(stored.list.map((c) => c.id));
  const gone = new Set(stored.removed);
  const fresh = DEFAULT_HEADER_CMDS.filter((d) => !have.has(d.id) && !gone.has(d.id));
  return [...stored.list, ...fresh].slice(0, MAX_ITEMS);
}

export function saveHeaderCmds(list: HeaderCmd[]): void {
  const kept = list.map(clean).filter((c): c is HeaderCmd => !!c).slice(0, MAX_ITEMS);
  const have = new Set(kept.map((c) => c.id));
  // An emptied list must STAY empty across a reload: every missing default is
  // recorded as deliberately removed.
  const removed = DEFAULT_HEADER_CMDS.filter((d) => !have.has(d.id)).map((d) => d.id);
  lsSetJson(KEY, { list: kept, removed } satisfies Stored);
}

/** Back to the shipped list — also forgets which defaults were deleted. */
export function resetHeaderCmds(): HeaderCmd[] {
  lsDel(KEY);
  return [...DEFAULT_HEADER_CMDS];
}

/**
 * Does this chip read as a Claude slash command?
 *
 * The SAME test `runHeaderCmd` applies when it decides between
 * `kind: "command"` and `kind: "prompt"`, so the chip that is withheld is
 * exactly the chip that would have gone down the command path. Two copies of
 * this predicate would be two opinions about what a `/` at the start means, and
 * the wrong half of the pair would still be on screen.
 */
export function isSlashCmd(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/** The chips this session may be offered, and how many were held back. */
export interface HeaderCmdSplit {
  /** What the header renders. */
  shown: HeaderCmd[];
  /** How many chips are slash commands this backend does not take. Feeds the
   *  sentence in the cants strip — one function, one number, one cut. */
  hiddenSlash: number;
}

/**
 * Which header chips a session can actually take.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * A live `opencode` session on the phone showed three absent-capability
 * sentences — no reader, no context graph, **no slash commands** — and, two
 * rows above them, a `/compact` chip. Tapping it typed Claude's vocabulary into
 * a binary whose descriptor says `slash: "none"` and whose `isLocalCommand` is
 * `() => false`, so it landed as a plain prompt: the backend was asked, in
 * English, to compact itself. The screen contradicted itself in the same
 * glance, and the control that lost the argument was the one you could press.
 *
 * ── Why the chips are withheld and not deleted, and never dimmed ────────────
 *
 * These are SYNCED USER DATA (`settings.ts`), shared across every client this
 * person owns. A session that cannot use one is not a reason to edit their
 * configuration, so the manage sheet still lists all of them — it edits global
 * config, not this session. And a withheld chip is not drawn greyed: CLAUDE.md
 * forbids opacity as a verdict, so the fact leaves as a COUNT in the strip that
 * already says what this backend cannot do.
 *
 * ── The compatibility promise ───────────────────────────────────────────────
 *
 * `canSlash: true` returns the list unchanged and `hiddenSlash: 0`. That is
 * claude, and it is every host that never described a backend at all
 * (`hasCap` answers `true` with no descriptor), so a claude header is
 * byte-identical to what it has always been.
 */
export function splitHeaderCmds(cmds: readonly HeaderCmd[], canSlash: boolean): HeaderCmdSplit {
  if (canSlash) return { shown: [...cmds], hiddenSlash: 0 };
  const shown = cmds.filter((c) => !isSlashCmd(c.text));
  return { shown, hiddenSlash: cmds.length - shown.length };
}
