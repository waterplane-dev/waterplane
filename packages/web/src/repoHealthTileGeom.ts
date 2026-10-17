/**
 * The two pure decisions the tiles grid makes, node-tested
 * (`repoHealthTileGeom.test.mjs`): which tile is open, and the area wash under
 * a tile's curve.
 *
 * Not in `repoHealthPlot.ts`: that module has no imports and draws what the
 * tool states. The wash is paint over its paths, and it reuses the kit's one
 * closed-area writer rather than a second copy of the `M`→`L` splice.
 */
import { closedArea } from "./kit/chart/chartPath.ts";

/**
 * The open tile after a tap on `key`: the same key folds it, any other key
 * opens that one and folds the last — one open at a time, so the grid never
 * becomes a column of full-width tiles again.
 */
export function toggleOpen(open: string | null, key: string): string | null {
  return open === key ? null : key;
}

/**
 * The open key as it stands against the keys drawn now. A refresh can drop a
 * series; an open key naming nothing on screen would leave the grid with no
 * open tile but a state claiming one, and the next tap on a new tile would
 * read as a toggle of a ghost.
 */
export function openAmong(open: string | null, keys: readonly string[]): string | null {
  return open !== null && keys.includes(open) ? open : null;
}

/**
 * The area under a sparkline: each run of `sparkGeom`'s `d` closed to `base`.
 *
 * Empty for a FLAT series — it is drawn at mid-height, and a wash under it
 * would claim a magnitude the fitted axis does not have — and for no path at
 * all. A hole stays a hole: each run is closed on its own, so the wash never
 * bridges a missing reading the line itself refuses to join.
 */
export function sparkAreaPath(d: string, base: number, flat: boolean): string {
  if (flat || !d) return "";
  const b = base.toFixed(1);
  return d
    .split("M")
    .filter((run) => run.includes("L"))
    .map((run) => {
      const pts = run.split("L");
      const first = pts[0].split(",")[0];
      const last = pts[pts.length - 1].split(",")[0];
      return closedArea(`M${run}`, first, last, b);
    })
    .join("");
}

/** The index of the newest drawn reading, or null — what an untouched readout names. */
export function latestIndex(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) return i;
  }
  return null;
}
