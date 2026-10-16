/**
 * The pictures picked to combine, in TAP order: the order is the panel numbering the collage sheet
 * starts from (① is the first tap), so a second tap on a picked row takes it out and the rest keep
 * their order. `key` names a row (repo + path). Pure; no DOM.
 */
export function togglePick<T>(picked: readonly T[], row: T, key: (r: T) => string): T[] {
  const k = key(row);
  return picked.some((p) => key(p) === k) ? picked.filter((p) => key(p) !== k) : [...picked, row];
}

/** What the pick bar says: how to pick, and how many are picked. A combine needs two. */
export function pickText(n: number): string {
  if (n === 0) return "Tap the pictures to combine, in the order you want them numbered.";
  if (n === 1) return "1 picked — tap one more: a combined picture needs at least two.";
  return `${n} picked, numbered in the order you tapped them.`;
}
