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
 * `text/plain` leaves the paste to the textarea.
 *
 * Text drops the PICTURES only: a file copied in a file manager may bring its
 * name as text, and is still the file. Used by the one paste handler
 * (`core/compose/useFileDrop.ts`).
 */
export function pastedFiles(files: readonly File[], text: string, isImage: (f: File) => boolean): File[] {
  return text.trim() ? files.filter((f) => !isImage(f)) : [...files];
}
