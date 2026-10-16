/**
 * The share sheet's pure half: what a share holds, and which sessions it may
 * go to.
 */

/** "2 pictures · 1 file · text" — what a share holds, by the routing it will
 *  get (pictures go through the annotator, everything else straight up). */
export function shareSummary(s: { files: readonly { type: string; name: string }[]; text: string }): string {
  const pics = sharePictures(s);
  const rest = s.files.length - pics;
  const parts: string[] = [];
  if (pics) parts.push(`${pics} picture${pics === 1 ? "" : "s"}`);
  if (rest) parts.push(`${rest} file${rest === 1 ? "" : "s"}`);
  if (s.text) parts.push("text");
  return parts.join(" · ") || "nothing";
}
/** How many of a share's files are pictures (the annotator's kind). */
export function sharePictures(s: { files: readonly { type: string; name: string }[] }): number {
  return s.files.filter((f) => isPictureLike(f)).length;
}
const isPictureLike = (f: { type: string; name: string }) =>
  f.type ? f.type.startsWith("image/") && f.type !== "image/svg+xml" : /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(f.name);

/** The sessions a share may go to besides the one on screen: live ones only,
 *  the on-screen one left out (it has its own row), in the listing's order. */
export function shareOtherSessions<S extends { id: string; running: boolean }>(sessions: readonly S[], activeId: string | null | undefined): S[] {
  return sessions.filter((s) => s.running && s.id !== activeId);
}
