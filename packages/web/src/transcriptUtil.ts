import type { TranscriptBlock, TranscriptTurn } from "@waterplane/shared";
import { LS, lsGet, lsSet, trSeenKey } from "./storage";

/**
 * Shared transcript helpers. They live here rather than inside
 * `TranscriptView.tsx` because the OUTLINE is now reachable from the terminal
 * too (`OutlineSheet.tsx`) — and an outline built on a second copy of "which
 * turn is new" would drift from the reader's unread marks within one edit.
 */

export const clock = (ts?: number): string =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

/** "New since you left" watermark — per session, per device (see TranscriptView). */
/** Re-exported from the key registry, which owns the prefix so a boot-time
 *  sweep can recognise it (`BootGuard`). */
export const seenKey = trSeenKey;
export const turnTs = (t: TranscriptTurn): number => t.endedAt ?? t.sentAt ?? 0;
export const newestTs = (turns: TranscriptTurn[]): number =>
  turns.reduce((m, t) => Math.max(m, turnTs(t)), 0);

export function readSeen(sid: string): number {
  const v = Number(lsGet(seenKey(sid)));
  return Number.isFinite(v) && v > 0 ? v : 0;
}
export function writeSeen(sid: string, ts: number) {
  if (ts > 0) lsSet(seenKey(sid), String(ts));
}

export const blockText = (b: TranscriptBlock): string =>
  b.kind === "tool" ? `${b.name} ${b.label} ${b.input ?? ""} ${b.result ?? ""}` : b.text;

export const turnText = (t: TranscriptTurn): string =>
  `${t.prompt}\n${t.blocks.map(blockText).join("\n")}`;

export const matches = (text: string, q: string): boolean =>
  !!q && text.toLowerCase().includes(q.toLowerCase());

/**
 * How much of a tool call the reader shows — and, for `full`, how much of one
 * even leaves the host.
 *
 * A turn that read six files and ran four commands spends a whole phone screen
 * on `> Bash …` rows, so the prose either side gets pushed off both ends; and
 * the inputs/results behind those rows are the overwhelming majority of a
 * transcript's bytes, which is what made a big conversation slow to fetch and
 * unreliable to keep offline. Hence the default. The other two exist because
 * "what did it actually run" is sometimes exactly what you opened the reader
 * for, and a desktop tab on the LAN has no reason to pay the phone's tax.
 *
 *  - `fold` (default) — runs of 2+ tool calls collapse into one placeholder;
 *    inputs/results stay on the host and load when you open one.
 *  - `list` — every tool call gets its row back; details still load on demand.
 *  - `full` — rows, and the details come down WITH the transcript, so they are
 *    there offline without having opened anything. The old behaviour.
 */
export type ReaderToolsMode = "fold" | "list" | "full";
export const READER_TOOLS_KEY = LS.readerTools;

export function readerToolsMode(): ReaderToolsMode {
  const v = lsGet(READER_TOOLS_KEY);
  return v === "list" || v === "full" ? v : "fold";
}

export function setReaderToolsMode(mode: ReaderToolsMode): void {
  // `lsSet` goes through the global `setItem` that settings.ts patches, so this
  // syncs to the other devices without a call site remembering to.
  lsSet(READER_TOOLS_KEY, mode);
}

/** What to ask the host for. `full` is the only mode that pays for the details
 *  up front; the two lite modes differ only in how the rows are drawn. */
export const wantedDetail = (mode = readerToolsMode()): "lite" | "full" =>
  mode === "full" ? "full" : "lite";
