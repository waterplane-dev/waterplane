// The upload width cap is PER PANEL for a combined image: four phone screens
// across at 1080 px total left each panel ~260 px (2026-10-25). The column
// count rides in the file name — the one fact that survives the annotator —
// so the writer (`collageFileName`) and the reader (`panelsAcross`) are pinned
// together here.
import test from "node:test";
import assert from "node:assert/strict";

import { collageFileName, panelsAcross, uploadWidthFor } from "./collageName.ts";

test("a collage's name carries its columns, and the cap scales with them", () => {
  const name = collageFileName(4, 4);
  assert.equal(panelsAcross(name), 4);
  assert.equal(uploadWidthFor(name, 1080), 4320);
  // The annotator renames to `<base>-marked.png`; the count must survive that.
  assert.equal(panelsAcross(name.replace(/\.jpg$/, "-marked.png")), 4);
  assert.equal(uploadWidthFor(collageFileName(4, 2), 1080), 2160);
});

test("every other file keeps the plain width; full size stays full size", () => {
  assert.equal(uploadWidthFor("Screenshot_2025.png", 1080), 1080);
  assert.equal(uploadWidthFor("my-combined-4-screens-4across.jpg", 1080), 1080);
  assert.equal(uploadWidthFor(collageFileName(3, 3), 0), 0);
  assert.equal(panelsAcross("combined-2-screens-0across.jpg"), 1);
});
