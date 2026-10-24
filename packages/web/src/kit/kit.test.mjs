import { test } from "node:test";
import assert from "node:assert/strict";
import { chipText, toggleChip, chipRows } from "./chips.ts";

test("a chip says its count, and its detail when there is one", () => {
  assert.equal(chipText("older than 30 days", { count: 27, detail: "3.9 GB" }), "older than 30 days · 27 · 3.9 GB");
  assert.equal(chipText("open", { count: 4 }), "open · 4");
});

test("a 0-count bucket is still a chip", () => {
  const rows = chipRows(["a", "b"], (k) => ({ count: k === "a" ? 0 : 2 }), (k) => k.toUpperCase());
  assert.deepEqual(rows.map((r) => r.text), ["A · 0", "B · 2"]);
});

test("the bucketing function is called once per key, and feeds the text", () => {
  let calls = 0;
  chipRows(["a", "b", "c"], () => { calls++; return { count: 1 }; }, (k) => k);
  assert.equal(calls, 3);
});

test("tapping the active chip clears, another moves", () => {
  assert.equal(toggleChip("a", "a"), null);
  assert.equal(toggleChip("a", "b"), "b");
  assert.equal(toggleChip(null, "b"), "b");
});

import { keyClass } from "./keyClass.ts";
import { rowClass, rowPartClass } from "./rowClass.ts";
import { hintClass, noteClass, tagClass } from "./hintClass.ts";
import { readFileSync } from "node:fs";

test("keyClass reproduces every hand-written .key string", () => {
  assert.equal(keyClass(), "key");
  assert.equal(keyClass("primary"), "key primary");
  assert.equal(keyClass("danger"), "key danger");
  assert.equal(keyClass("primary", "pair-wide"), "key primary pair-wide");
  assert.equal(keyClass(undefined, "rh-verb"), "key rh-verb");
  assert.equal(keyClass(undefined, "hdr-typing-keep hdr-typing-menu"), "key hdr-typing-keep hdr-typing-menu");
  assert.equal(keyClass(undefined, "usage-key danger"), "key usage-key danger"); // danger not 2nd: className
});

test("an empty className adds no token: `key ${off ? 'x' : ''}` used to render \"key \"", () => {
  assert.equal(keyClass(undefined, ""), "key");
  assert.equal(keyClass("primary", ""), "key primary");
  assert.equal(keyClass(undefined, " "), "key  "); // `key ${""} ${""}` (DownloadButton)
  assert.equal(keyClass(undefined, "cli-key "), "key cli-key ");
});

test("Button keeps className the FIRST attribute and sets no type", () => {
  const src = readFileSync(new URL("./Button.tsx", import.meta.url), "utf8");
  assert.match(src, /<button className=\{keyClass\(variant, className\)\} \{\.\.\.rest\}/);
  assert.doesNotMatch(src, /\btype=/);
  const idx = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.ok(idx.includes('export { Button, type ButtonProps } from "./Button";'));
});

test("rowClass / rowPartClass reproduce every hand-written row string", () => {
  assert.equal(rowClass(), "row");
  assert.equal(rowClass("grow"), "row grow");
  assert.equal(rowClass("wrap"), "row-wrap");
  assert.equal(rowPartClass("row-title"), "row-title");
  assert.equal(rowPartClass("row-sub", "dim"), "row-sub dim");
  assert.equal(rowPartClass("row-title", "mono"), "row-title mono");
  assert.equal(rowPartClass("row-sub", ""), "row-sub"); // `row-sub ${bad ? "warn" : ""}` when fine: the trailing space is gone
});

test("Row parts write className FIRST and set no type", () => {
  const src = readFileSync(new URL("./Row.tsx", import.meta.url), "utf8");
  // Exactly Row's createElement shape: the element, then `{ className: <fn>(…), ...rest }` and nothing else.
  const calls = [...src.matchAll(/createElement\(([^;]*?)\);/g)].map((m) => m[1]);
  assert.equal(calls.length, 3, "Row, RowTitle, RowSub each make one element");
  for (const c of calls) {
    assert.match(c, /^\w+, \{ className: row(Part)?Class\([^)]*\), \.\.\.rest \}$/, `className first, then the call site's props: ${c}`);
    assert.doesNotMatch(c, /\btype\b/, `no default type: ${c}`);
  }
  assert.match(src, /type NotOnDiv = \{ disabled\?: never; type\?: never;/, "a div row cannot carry button-only props");
  const idx = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(idx, /Row, RowTitle, RowSub/);
});

test("hintClass and tagClass reproduce every hand-written form-hint / tag string", () => {
  assert.equal(hintClass(), "form-hint");
  assert.equal(hintClass("warn"), "form-hint warn");
  assert.equal(hintClass("mono"), "form-hint mono");
  assert.equal(hintClass(undefined, "mw-says"), "form-hint mw-says");
  assert.equal(hintClass(undefined, ""), "form-hint"); // `form-hint ${c ? "warn" : ""}` lost its trailing space
  assert.equal(hintClass("warn", "x"), "form-hint warn x");
  assert.equal(tagClass(), "tag");
  assert.equal(tagClass("ok"), "tag ok");
  assert.equal(tagClass("danger"), "tag danger");
  assert.equal(tagClass("coding"), "tag coding");
  assert.equal(tagClass(undefined, "tag-filter on"), "tag tag-filter on");
  assert.equal(tagClass(undefined, ""), "tag");
});

test("hintClass and tagClass: every tone with and without a className, in order", () => {
  for (const tone of [undefined, "warn", "mono"]) {
    for (const cls of [undefined, "", "x y"]) {
      assert.equal(hintClass(tone, cls), "form-hint" + (tone ? ` ${tone}` : "") + (cls ? ` ${cls}` : ""));
    }
  }
  for (const tone of [undefined, "ok", "danger", "coding"]) {
    for (const cls of [undefined, "", "x y"]) {
      assert.equal(tagClass(tone, cls), "tag" + (tone ? ` ${tone}` : "") + (cls ? ` ${cls}` : ""));
    }
  }
  assert.equal(tagClass("ok", "tag-filter"), "tag ok tag-filter");
});

test("noteClass is set-note plus the call site's own class, an empty one adding nothing", () => {
  assert.equal(noteClass(), "set-note");
  assert.equal(noteClass("warn"), "set-note warn");
  assert.equal(noteClass("warn pair-confirm-note"), "set-note warn pair-confirm-note");
  assert.equal(noteClass(""), "set-note");
});

test("Hint and Tag components route through hintClass / tagClass, className after the tone", () => {
  assert.match(readFileSync(new URL("./Hint.tsx", import.meta.url), "utf8"), /hintClass\(/);
  assert.match(readFileSync(new URL("./Tag.tsx", import.meta.url), "utf8"), /tagClass\(/);
});

test("ConfirmButton renders a `key…` class through Button, anything else raw", () => {
  const src = readFileSync(new URL("../Confirm.tsx", import.meta.url), "utf8");
  assert.match(src, /import[^;]*\bButton\b[^;]*from/); // it composes the kit Button
  assert.match(src, /\/\^key/); // and picks it by the class starting with `key`
  assert.match(src, /<Button\b[^>]*\{\.\.\.props\}/); // the key branch
  assert.match(src, /<button\b[^>]*\{\.\.\.props\}/); // the raw branch exists too
});
