// What a desktop paste into the compose box hands the annotator (`pasteImages.ts`).
import test from "node:test";
import assert from "node:assert/strict";

import { pastedImages } from "./pasteImages.ts";

const file = (name, type) => ({ name, type });
const isImage = (f) => f.type.startsWith("image/");
const clip = (files, text = "") => ({ files, getData: (t) => (t === "text/plain" ? text : "") });

test("a screenshot on the clipboard is a picture to send", () => {
  const png = file("image.png", "image/png");
  assert.deepEqual(pastedImages(clip([png]), isImage), [png]);
});

test("text beside the picture wins — copied spreadsheet cells paste as cells", () => {
  assert.deepEqual(pastedImages(clip([file("image.png", "image/png")], "a\tb\n1\t2"), isImage), []);
});

test("blank text does not count as text", () => {
  const png = file("image.png", "image/png");
  assert.deepEqual(pastedImages(clip([png], "  \n"), isImage), [png]);
});

test("non-image files and an empty clipboard give nothing", () => {
  assert.deepEqual(pastedImages(clip([file("a.pdf", "application/pdf")]), isImage), []);
  assert.deepEqual(pastedImages(clip([]), isImage), []);
  assert.deepEqual(pastedImages(null, isImage), []);
});
