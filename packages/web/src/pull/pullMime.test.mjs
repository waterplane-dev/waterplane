import { test } from "node:test";
import assert from "node:assert/strict";
import { mimeFor, typedBlob, OCTET_STREAM } from "./pullMime.ts";

test("mimeFor: the type follows the name's extension, case-insensitively; an unlisted one is octet-stream", () => {
  assert.equal(mimeFor("report.pdf"), "application/pdf");
  assert.equal(mimeFor("shot.PNG"), "image/png");
  assert.equal(mimeFor("notes.md"), "text/markdown");
  assert.equal(mimeFor("app.apk"), "application/vnd.android.package-archive");
  assert.equal(mimeFor("page.html"), "text/html");
  assert.equal(mimeFor("weird.xyz"), OCTET_STREAM);
  assert.equal(mimeFor("noext"), OCTET_STREAM);
  assert.equal(mimeFor(""), OCTET_STREAM);
});

test("typedBlob: a blob named .pdf is typed pdf whatever its bytes say — HTML inside is never a page", async () => {
  const html = "<script>alert(1)</script>";
  const b = typedBlob([html], "invoice.pdf");
  assert.equal(b.type, "application/pdf");
  assert.equal(await b.text(), html);
  assert.equal(typedBlob([new Blob([html])], "x.bin").type, OCTET_STREAM);
  assert.equal(new Blob([html]).type, "", "the untyped Blob this replaces is what the browser would sniff");
});
