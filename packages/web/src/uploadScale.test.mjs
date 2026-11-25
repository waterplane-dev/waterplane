// A canvas encode must not wait on Chromium's idle time ("combining…" took seconds,
// 2026-11-22 and 11-24), and a live canvas must not be read after its caller repainted it.
import test from "node:test";
import assert from "node:assert/strict";
import "../../../scripts/lib-tsload.mjs";

const { encodeCanvas } = await import("./uploadScale.ts");

/** A canvas whose pixels are one word, so a test can read which picture was encoded. */
function fakeCanvas(pixels, { toBlob = "never", sync = true } = {}) {
  return {
    width: 10, height: 10, pixels, syncs: 0,
    toBlob(cb, type) {
      const at = this.pixels;
      if (toBlob === "now") cb(new Blob([at], { type }));
      else if (typeof toBlob === "number") setTimeout(() => cb(new Blob([at], { type })), toBlob);
      else if (toBlob === "null") cb(null);
    },
    toDataURL(type) { this.syncs++; return sync ? `data:${type};base64,${btoa(this.pixels)}` : "data:,"; },
    getContext() { return { drawImage: (src) => { this.pixels = src.pixels; } }; },
  };
}
const withDocument = async (copy, fn) => {
  globalThis.document = { createElement: () => copy };
  try { return await fn(); } finally { delete globalThis.document; }
};

test("a toBlob that answers at once is used, and the main thread is not blocked", async () => {
  const c = fakeCanvas("one", { toBlob: "now" });
  assert.equal(await (await encodeCanvas(c)).text(), "one");
  assert.equal(c.syncs, 0);
});

test("a starved toBlob is overtaken by the synchronous encoder within a second", async () => {
  const c = fakeCanvas("one");
  const t = Date.now();
  assert.equal(await (await encodeCanvas(c)).text(), "one");
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

test("where the synchronous encoder fails, the late toBlob still counts", async () => {
  const c = fakeCanvas("one", { toBlob: 500, sync: false });
  assert.equal(await (await encodeCanvas(c)).text(), "one");
});

test("a live canvas repainted meanwhile still yields the picture it was called with", async () => {
  const c = fakeCanvas("one");
  const blob = await withDocument(fakeCanvas(""), () => {
    const p = encodeCanvas(c, "image/png", undefined, { live: true });
    c.pixels = "two";
    return p;
  });
  assert.equal(await blob.text(), "one");
});

test("a live canvas that cannot be copied is never read late", async () => {
  const c = fakeCanvas("one", { toBlob: 400 });
  const blob = await withDocument({ width: 0, height: 0, getContext: () => null }, () => {
    const p = encodeCanvas(c, "image/png", undefined, { live: true });
    c.pixels = "two";
    return p;
  });
  assert.equal(await blob.text(), "one");
  assert.equal(c.syncs, 0);
});
