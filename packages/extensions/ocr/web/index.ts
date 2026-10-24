/**
 * The text-in-marks extension's web half (R-images-015): an `imageText` reader the annotator asks
 * when a highlight, box or circle is finished, and its row in Settings › Tools & diagnostics.
 * Imports only `@waterplane/sdk`, `@waterplane/kit`, react, lucide-react and its own folder
 * (`local/extension-boundary`).
 *
 * Optional and OFF by default. Switching it on downloads the reader once from the person's own
 * desktop (`assets.ts`); switching it off stops the worker and offers to delete the download.
 * Every reading happens on the phone: nothing is sent to the desktop or a cloud model (R-images-012).
 */
import { createElement } from "react";
import { watchExtensionEnabled, type FeatureManifest } from "@waterplane/sdk";
import { engineFiles, ensure, switchedOff } from "./assets.ts";
import { createEngine } from "./engine.ts";
import { OCR_ID } from "./logic.ts";
import { OcrRow } from "./OcrRow.tsx";

const engine = createEngine(engineFiles);

export const manifest: FeatureManifest = {
  id: "ocr", // the literal form (`tools/webshape.test.mjs` reads it); OCR_ID is the same string
  imageText: { read: (crop, { signal }) => engine.read(crop, signal) },
  boot: () => watchExtensionEnabled(OCR_ID, (on) => {
    if (on) void ensure();
    else { engine.stop(); void switchedOff(); }
  }),
  settings: [{
    group: "tools", order: 31, render: () => createElement(OcrRow),
    rows: [{ id: "ocr-reader", label: "text in marks", keywords: "ocr read words text recognition highlight box circle marks image picture tesseract english german offline download" }],
  }],
};
