/**
 * A title from `sheetNames.ts` that ends in " - session" / " - repo" names the thing it is cut to:
 * "History - session" reads "History · <the session's name>" once a name is known, else the
 * title as written. One place, so the three session-scoped sheets (History, Sent commands,
 * Decision log) never word the join three ways.
 */
export function scopedTitle(title: string, name?: string | null): string {
  return name ? `${title.replace(/ - [a-z]+$/, "")} · ${name}` : title;
}
