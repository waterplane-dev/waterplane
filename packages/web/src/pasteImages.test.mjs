// What a desktop paste into the compose box hands the annotator (`pasteImages.ts`).
import test from "node:test";
import assert from "node:assert/strict";

import { pastedFiles } from "./pasteImages.ts";

const file = (name, type) => ({ name, type });
const isImage = (f) => f.type.startsWith("image/");

test("a screenshot on the clipboard is a picture to send", () => {
  const png = file("image.png", "image/png");
  assert.deepEqual(pastedFiles([png], "", isImage), [png]);
});

test("text beside the picture wins — copied spreadsheet cells paste as cells", () => {
  assert.deepEqual(pastedFiles([file("image.png", "image/png")], "a\tb\n1\t2", isImage), []);
});

test("blank text does not count as text", () => {
  const png = file("image.png", "image/png");
  assert.deepEqual(pastedFiles([png], "  \n", isImage), [png]);
});

test("text drops the pictures, never the other files", () => {
  const png = file("image.png", "image/png"), pdf = file("a.pdf", "application/pdf");
  assert.deepEqual(pastedFiles([png, pdf], "", isImage), [png, pdf]);
  assert.deepEqual(pastedFiles([pdf], "a.pdf", isImage), [pdf], "a copied file's name rides as text");
  assert.deepEqual(pastedFiles([], "", isImage), []);
});
