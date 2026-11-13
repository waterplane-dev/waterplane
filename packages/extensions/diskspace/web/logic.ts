/**
 * The disk-space sheet's words and sums, pure (`logic.test.mjs` runs them straight off the
 * TypeScript). Sizes are DECIMAL (1 GB = 10^9 bytes), as Finder and "About This Mac" print them, so
 * the header agrees with what the person already saw on the desktop. An unknown size is said as
 * unknown and never summed as 0: a total over rows with unknowns says "at least".
 */
import type { DiskDeleteResult, DiskEntry, DiskProfile, DiskScan, DiskSide, DiskState, DiskVolume, LargeScan } from "../shared/wire.mts";

/** KiB (du's unit) → "4.2 GB". */
export function sizeText(kb: number): string {
  const bytes = kb * 1024;
  const units: [number, string][] = [[1e12, "TB"], [1e9, "GB"], [1e6, "MB"], [1e3, "KB"]];
  for (const [n, u] of units) {
    if (bytes >= n) { const v = bytes / n; return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${u}`; }
  }
  return `${Math.round(bytes)} B`;
}

/** A row's size as words: "4.2 GB", "at least 4.2 GB", or "size unknown". */
export function entrySize(e: Pick<DiskEntry, "sizeKb" | "partial">): string {
  if (e.sizeKb == null) return "size unknown";
  return e.partial ? `at least ${sizeText(e.sizeKb)}` : sizeText(e.sizeKb);
}

export interface Total { kb: number; unknown: number; partial: boolean }

/** The sum of the known sizes, how many are unknown, and whether the sum is a floor. Rows sharing a
 *  `copy` are one copy on disk and are counted once. */
export function total(rows: readonly Pick<DiskEntry, "sizeKb" | "partial" | "copy">[]): Total {
  let kb = 0, unknown = 0, partial = false;
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.copy != null) { if (seen.has(r.copy)) continue; seen.add(r.copy); }
    if (r.sizeKb == null) { unknown++; continue; }
    kb += r.sizeKb;
    if (r.partial) partial = true;
  }
  return { kb, unknown, partial: partial || unknown > 0 };
}

export function totalText(t: Total): string {
  const n = t.partial ? `at least ${sizeText(t.kb)}` : sizeText(t.kb);
  return t.unknown ? `${n} (${t.unknown} more of unknown size)` : n;
}

export function volumeLine(v: DiskVolume | null): string {
  if (!v) return "Free space could not be read.";
  const pct = v.totalKb > 0 ? Math.round((v.freeKb / v.totalKb) * 100) : null;
  return `${v.label ? `${v.label} ` : ""}${sizeText(v.freeKb)} free of ${sizeText(v.totalKb)}${pct != null ? ` (${pct}%)` : ""}`;
}

/** What deleting a row frees, said where there are two disks (wsl); null where there is one. */
export function sideLine(side: DiskSide | undefined): string | null {
  if (side === "wsl") return "Frees space inside WSL only — Windows gets it back after the WSL disk is compacted (see WSL's virtual disk under Show only).";
  if (side === "windows") return "Frees space on the Windows drive directly.";
  return null;
}

/** The second free-space line on wsl: the Linux side's own disk. */
export function wslVolumeLine(v: DiskVolume | null | undefined): string | null {
  if (v === undefined) return null;
  if (!v) return "Inside WSL: free space could not be read.";
  return `Inside WSL: ${sizeText(v.freeKb)} free of ${sizeText(v.totalKb)}. Deleting there does not give the Windows drive space until the WSL disk is compacted.`;
}

/** "12 s", "3 min", "2 h" — for a running scan's clock. */
export function secondsText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 180) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** What the scan is doing, as a line; null when nothing runs and a scan exists. */
export function scanLine(s: DiskState, now: number, ago: (ts: number) => string): string | null {
  // The rest is measured and listed; the code-root walk says what it is doing in its own line (`codeLine`).
  if (s.scanning && s.phase === "code") return null;
  if (s.scanning) {
    const started = s.scanStartedAt != null ? ` — started ${secondsText(now - s.scanStartedAt)} ago` : "";
    return s.scan ? `Scanning${started}. The lists below are from the scan ${ago(s.scan.at)}.` : `Scanning${started}. du measures every folder, so this takes a minute or two.`;
  }
  return s.scan ? null : "Not scanned yet.";
}

/**
 * The code-root walk's line, in the build-output area: still being looked for (and since when), not
 * looked for on its own and why (wsl, code root on the Windows drive), or when it was looked for.
 * Null from a host older than the field.
 */
export function codeLine(s: Pick<DiskState, "code">, now: number, ago: (ts: number) => string): string | null {
  const c = s.code;
  if (!c) return null;
  const what = `build output and node_modules under ${c.root}`;
  if (c.running) {
    return c.startedAt == null
      ? `Looking for ${what} next, once the rest is measured.`
      : `Still looking for ${what} — started ${secondsText(now - c.startedAt)} ago. Everything else listed here is already measured.`;
  }
  const slow = "folders on the Windows drive are slow to read from inside WSL";
  if (c.at == null) return c.onTap ? `A scan does not look for ${what}: ${slow}, so it can take many minutes. Tap look for them to start it; the rest of this screen keeps working meanwhile.` : null;
  const took = c.tookMs != null ? `, took ${secondsText(c.tookMs)}` : "";
  return `Looked for ${what} ${ago(c.at)}${took}.${c.onTap ? ` A scan does not repeat it (${slow}) — tap look again for a fresh list.` : ""}`;
}

/** The code-walk button's words; null when there is none (the walk is part of every scan, or it is running). */
export function codeButton(s: Pick<DiskState, "code">): string | null {
  const c = s.code;
  if (!c?.onTap || c.running) return null;
  return c.at == null ? "look for them" : "look again";
}

/** The armed delete's question. */
export function deleteAsk(e: DiskEntry, scannedAt: number | null, ago: (ts: number) => string): { title: string; lines: string[]; confirmLabel: string } {
  const size = entrySize(e);
  const when = scannedAt != null ? ` by the scan ${ago(scannedAt)}` : "";
  return {
    title: `Delete ${e.label}?`,
    lines: [
      e.sizeKb == null ? `Its size is unknown${e.sizeNote ? ` (${e.sizeNote})` : ""}.` : `${size}${when}.`,
      ...(e.note ? [e.note] : []),
      ...(e.regen ? [`What puts it back: ${e.regen}`] : []),
      ...(sideLine(e.side) ? [sideLine(e.side)!] : []),
      e.id.startsWith("ollama:") ? "Removed with `ollama rm` on the desktop." : "Removed from the desktop for good — not moved to the Trash.",
    ],
    confirmLabel: e.sizeKb == null ? "Delete" : `Delete ${size}`,
  };
}

const LIST_MAX = 10;

/** "Clean all temporary"'s question: the total, and what is in it. */
export function cleanAllAsk(rows: readonly DiskEntry[]): { title: string; lines: string[]; confirmLabel: string } {
  const t = total(rows);
  const shown = rows.slice(0, LIST_MAX).map((r) => `${r.label} — ${entrySize(r)}`);
  return {
    title: `Clean all temporary — ${totalText(t)}?`,
    lines: [
      `${rows.length} folder${rows.length === 1 ? "" : "s"}, ${totalText(t)} in all. Each is a cache or build output that rebuilds itself when it is needed again (a slower next build or download).`,
      ...shown,
      ...(rows.length > LIST_MAX ? [`and ${rows.length - LIST_MAX} more`] : []),
      ...(rows.some((r) => r.side === "wsl") ? ["What is inside WSL frees space there only — Windows gets it back after the WSL disk is compacted."] : []),
      "Removed from the desktop for good — not moved to the Trash.",
    ],
    confirmLabel: t.kb > 0 ? `Delete ${t.partial ? "at least " : ""}${sizeText(t.kb)}` : "Delete all",
  };
}

/** One delete outcome as a sentence. */
export function resultLine(r: DiskDeleteResult, profile?: DiskProfile): string {
  const counts = r.removed != null || r.skipped != null ? `${r.removed ?? 0} removed, ${r.skipped ?? 0} in use and skipped${r.partial ? ` (${r.partial} of them partly cleared)` : ""}` : "";
  if (!r.ok) return `Could not delete ${r.label}: ${r.error ?? "no reason given"}${counts ? ` (${counts})` : ""}`;
  const size = counts ? ` — ${counts}` : r.sizeKb != null ? ` — ${sizeText(r.sizeKb)} by the scan` : "";
  const where = r.side === "wsl" ? "free space inside WSL" : r.side === "windows" ? "free space on the Windows drive" : "free space";
  const why = r.side || profile === "linux" ? "" : " (a Time Machine local snapshot can hold deleted files until it expires)";
  const rose = r.freeDeltaKb == null ? "" : r.freeDeltaKb > 0 ? `; ${where} rose by ${sizeText(r.freeDeltaKb)}` : `; ${where} did not rise${why}`;
  const wsl = r.side === "wsl" ? " Windows gets this space back only after the WSL disk is compacted." : "";
  return `Deleted ${r.label}${size}${rose}.${wsl}`;
}

/** The large-file section's status line. */
export function largeLine(l: LargeScan | null, now: number, limitS: number, ago: (ts: number) => string): string {
  if (!l) return `Not run yet. A plain find over your home folder (one disk, no model call), stopped after ${limitS} s.`;
  if (l.running) return `Searching — started ${secondsText(now - l.at)} ago; it stops itself after ${limitS} s.`;
  if (l.error) return l.error;
  const took = l.tookMs != null ? ` in ${secondsText(l.tookMs)}` : "";
  const head = l.found === 0 ? `No file over 500 MB found${took}` : `${l.found} file${l.found === 1 ? "" : "s"} over 500 MB${took}${l.found > l.items.length ? `, the biggest ${l.items.length} listed` : ""}`;
  const stopped = l.stoppedAfterS != null ? ` — stopped after ${l.stoppedAfterS} s, so the list is partial` : "";
  return `${head}${stopped} (${ago(l.at)}).${l.note ? ` ${l.note}` : ""}`;
}

const bySize = (a: DiskEntry, b: DiskEntry) => (b.sizeKb ?? -1) - (a.sizeKb ?? -1);

/** Rows grouped, biggest group first and biggest row first in each; an unknown size sorts last. */
export function byWeight(rows: readonly DiskEntry[]): [string, DiskEntry[]][] {
  return grouped(rows)
    .map(([g, list]): [string, DiskEntry[], number] => [g, [...list].sort(bySize), total(list).kb])
    .sort((a, b) => b[2] - a[2])
    .map(([g, list]) => [g, list]);
}

/** A path-shaped label as [folder part, last part] so the eye lands on the last part; anything with
 *  a space in it (a sentence-shaped label) or no slash stays whole. */
export function splitLabel(label: string): [string, string] {
  if (/\s/.test(label)) return ["", label];
  const i = label.lastIndexOf("/", label.length - 2);
  return i < 0 ? ["", label] : [label.slice(0, i + 1), label.slice(i + 1)];
}

/** Text with `backticks` as [text, isCode] parts. */
export function codeParts(text: string): [string, boolean][] {
  return text.split("`").map((t, i): [string, boolean] => [t, i % 2 === 1]).filter(([t]) => t !== "");
}

export interface VolumeBar { usedPct: number; freePct: number; tempPct: number; modelPct: number; low: boolean }

/** Under this share free the volume is drawn as low. */
export const LOW_FREE = 0.1;

/**
 * The volume as bar widths: temporary and models as their own slices of the USED part. A slice is
 * drawn only when it fits inside what statfs says is used — a sum that does not fit is a measuring
 * disagreement, and the bar then shows used/free alone rather than a wrong split.
 */
export function volumeBar(v: DiskVolume | null, tempKb: number, modelKb: number): VolumeBar | null {
  if (!v || v.totalKb <= 0) return null;
  const free = Math.min(Math.max(v.freeKb, 0), v.totalKb);
  const used = v.totalKb - free;
  const pct = (kb: number) => (kb / v.totalKb) * 100;
  const fits = tempKb + modelKb <= used;
  return {
    usedPct: pct(used), freePct: pct(free),
    tempPct: fits ? pct(tempKb) : 0, modelPct: fits ? pct(modelKb) : 0,
    low: free / v.totalKb < LOW_FREE,
  };
}

/**
 * The temporary and model totals the header bar may paint as slices of ITS volume. On wsl the bar is
 * one disk: the Windows drive when the second line (the Linux side) exists, else the Linux side —
 * only rows on that disk count; a Linux-side row lives inside the virtual disk, not as its own bytes
 * on C:. Elsewhere there is one disk and every row counts.
 */
export function barTotals(scan: Pick<DiskScan, "profile" | "wslVolume" | "temp" | "models">): { tempKb: number; modelKb: number } {
  const on = scan.profile === "wsl" ? (scan.wslVolume !== undefined ? "windows" : "wsl") : null;
  const pick = (rows: readonly DiskEntry[]) => (on ? rows.filter((e) => e.side === on) : rows);
  return { tempKb: total(pick(scan.temp)).kb, modelKb: total(pick(scan.models)).kb };
}

/** Rows in display order, grouped: [group, rows] in first-seen order. */
export function grouped(rows: readonly DiskEntry[]): [string, DiskEntry[]][] {
  const m = new Map<string, DiskEntry[]>();
  for (const r of rows) m.set(r.group, [...(m.get(r.group) ?? []), r]);
  return [...m];
}

