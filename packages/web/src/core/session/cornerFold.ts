/**
 * The corner group's fold (`useCornerDrag.ts`): overshoot past the right edge
 * becomes fewer columns. Pure and extension-free imports so node --test can
 * load it.
 */
/** Columns for `n` buttons pushed `excess` px past the right edge, one column
 *  off per `step` px; never fewer than one. Pure, for the unit test. */
export function foldCols(n: number, excess: number, step: number): number {
  if (n <= 1 || excess <= 0 || step <= 0) return n;
  return Math.max(1, n - Math.floor(excess / step));
}

/** The overshoot a fold of `cols` stands for — `foldCols`' inverse, so a drag
 *  that starts folded continues from where the last one left it. */
export function foldExcess(n: number, cols: number, step: number): number {
  return Math.max(0, n - cols) * step;
}
