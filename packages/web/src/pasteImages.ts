/**
 * Which pasted files are a PICTURE someone meant to send — Ctrl+V of a
 * screenshot on a desktop.
 *
 * Those take the picker's route (`routeFiles`: one image → the annotator,
 * several → the combine-or-not question), so a pasted screenshot and a picked
 * one cannot end up treated differently.
 *
 * **Text wins.** Office and many editors put a rendered PNG of the selection on
 * the clipboard BESIDE its text: copying three Excel cells must paste the
 * cells, not open the annotator on a picture of them. So any non-blank
 * `text/plain` leaves the paste to the textarea and this returns nothing.
 */
export interface PasteData {
  files: ArrayLike<File>;
  getData(type: string): string;
}

export function pastedImages(d: PasteData | null | undefined, isImage: (f: File) => boolean): File[] {
  if (!d) return [];
  if (d.getData("text/plain").trim()) return [];
  return Array.from(d.files).filter(isImage);
}
