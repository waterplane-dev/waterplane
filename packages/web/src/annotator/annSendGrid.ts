/**
 * The mark sheet's send row as a grid (AnnSendBar, `.annot-send-bar`).
 *
 * Six verbs on one squeezed 360px line broke labels mid-letter ("Se/nd/all");
 * a free wrap dropped the primary send alone onto a second row. So: up to three
 * per row, two rows at most, and the primary — always last — spans whatever
 * cells the last row leaves, so it never sits next to a hole.
 */
export function annSendGrid(n: number): { cols: number; span: number } {
  const count = Math.max(1, n);
  const cols = count <= 3 ? count : Math.ceil(count / 2);
  return { cols, span: cols * Math.ceil(count / cols) - count + 1 };
}
