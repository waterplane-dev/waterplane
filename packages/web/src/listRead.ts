/**
 * A host list as the phone holds it: its rows, and when the host last answered for them (`readAt`,
 * epoch ms; 0 = never on this device). An empty array alone is two states — not read yet, and read
 * with nothing in it — and two readers of the same `[]` used to decide them opposite ways: the
 * launcher said "No repos under host root." before the first read, the git screen said "waiting"
 * for ever on a host with no repos (design round 2026-10-30 W4). Every reader asks this, never
 * `rows.length` on its own.
 */
export interface HostList<T> {
  readonly rows: readonly T[];
  readonly readAt: number;
}

/** `rows` — something to draw · `empty` — the host said there is nothing · `unread` — nobody has
 *  heard yet. Rows win over a missing read time: a snapshot kept from an older build still shows. */
export type ListRead = "unread" | "empty" | "rows";

export function listRead<T>(list: HostList<T>): ListRead {
  if (list.rows.length > 0) return "rows";
  return list.readAt > 0 ? "empty" : "unread";
}
