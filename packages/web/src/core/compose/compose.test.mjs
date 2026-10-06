// The compose bar's two never-rules, pinned on the source because neither is
// a value a unit test can observe: typed words are the last copy (a
// `setCompose("")` is a delete unless the words are provably somewhere else),
// and there is ONE prompt-writing surface (`PromptComposer.tsx`) beside the
// compose bar's own box. A new clear site or a second <textarea> here is a
// decision made in review, with this count raised in the same change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Code, not prose: a comment that names `setCompose("")` is not a site. Crude
 *  on purpose — block comments and whole-line `//` comments only. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (rel) => code(readFileSync(new URL(rel, import.meta.url), "utf8"));
const hook = read("./useCompose.ts");
const bar = read("./ComposeBar.tsx");
const sendHook = read("../send/useSend.tsx");
const count = (src, needle) => src.split(needle).length - 1;

/** Every .ts/.tsx under packages/web/src, relative, comments stripped. */
const SRC = fileURLToPath(new URL("../../", import.meta.url));
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const TREE = walk(SRC).map((p) => ({ rel: relative(SRC, p).split("\\").join("/"), text: code(readFileSync(p, "utf8")) }));
const CLEAR = /\bsetCompose\(\s*(?:""|''|``)\s*\)/g;

/**
 * Every clear in the tree, by file, and — in file order — the ACCEPT each one
 * must follow: the line that proves the words are somewhere else now (a send
 * the queue took, a pad note that landed, the second tap of an armed clear, a
 * sheet that posted). A clear is checked to sit after its own accept and after
 * the clear before it, so a new one cannot borrow an earlier guard.
 */
const CLEARS = {
  "core/compose/useCompose.ts": [
    // clearCompose: the SECOND tap — the first only arms and returns.
    /if \(!clearArmed\) \{[^\n]*return; \}/,
    // sendCompose ×3: dispatchIntent / queueBacklog / submitInput accepted it.
    /if \(!dispatchIntent\(/,
    /if \(offline === null\) return;/,
    /if \(!submitInput\(/,
    // openComposeSend: only once the sheet has posted, and only the box it came from.
    /onPosted: \(\) => \{\s*if \(activeIdRef\.current === from\)/,
    // keepOnPad: addPadNote returned no refusal.
    /if \(why\) \{ showToast\(why\); return; \}/,
  ],
  // The annotator's round trip: the picture's message was queued (`null` is a
  // refusal) or submitted (`false` is one) before the box it came from empties.
  "core/queue/uploads.ts": [
    /if \(queued === null\) return;/,
    /if \(!submitInput\(/,
  ],
};

test("the draft is cleared only where the words went somewhere, counted across the tree", () => {
  const found = Object.fromEntries(TREE
    .map((f) => [f.rel, (f.text.match(CLEAR) ?? []).length])
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b)));
  const want = Object.fromEntries(Object.entries(CLEARS).map(([f, g]) => [f, g.length]));
  assert.deepEqual(found, want,
    `setCompose("") sites. A clear is a DELETE of the only copy of typed words unless something just took\n` +
    `them; a new one is a decision made in review — add it to CLEARS with the accept it follows.`);
  assert.equal(count(bar, 'setCompose("")'), 0, "the bar edits the draft only through the change handler");
  assert.equal(count(sendHook, "setCompose"), 0, "the send core never touches the compose draft");
});

test("each clear follows the accept that took the words", () => {
  for (const [rel, guards] of Object.entries(CLEARS)) {
    const text = TREE.find((f) => f.rel === rel).text;
    const clears = [...text.matchAll(CLEAR)].map((m) => m.index);
    let prev = -1;
    for (const [n, g] of guards.entries()) {
      const rest = text.slice(prev + 1);
      const at = rest.search(g);
      assert.ok(at >= 0 && prev + 1 + at < clears[n],
        `${rel}: clear #${n + 1} must come after ${g} (and after the clear before it)`);
      prev = clears[n];
    }
  }
});

test("the annotator's append rebuilds from the box it is appending to", () => {
  // `setCompose(withDraft)` is the one non-clear REPLACE in the queue core:
  // safe only because `withDraft` starts from what the box already holds and
  // only runs while that box is the one on screen.
  const up = TREE.find((f) => f.rel === "core/queue/uploads.ts").text;
  assert.match(up, /const withDraft = base \? `\$\{base\}/);
  assert.match(up, /\} else if \(targetIsActive\) \{\s*setCompose\(withDraft\);/);
});

test("dictation and snippets append; nothing seeds over the draft", () => {
  assert.match(hook, /read: \(\) => composeNow\.current/, "voice reads the box at landing, not a snapshot");
  assert.match(hook, /setCompose\(\(c\) => \(c && !\/\\s\$\/\.test\(c\) \? c \+ "\\n" : c\) \+ s\.text\)/);
  assert.match(hook, /function insertCompose\(text: string\) \{ setCompose\(\(c\) => \(c \?/);
});

test("one textarea in the compose bar, and no second prompt composer", () => {
  assert.equal(count(bar, "<textarea"), 1);
  assert.doesNotMatch(bar, /from "[^"]*PromptComposer"/);
});

test("the Send sheet's draft slot has one spelling, sendIntent.ts's", () => {
  // `SEND_DRAFT` is defined once, in sendIntent.ts (the images feature and the
  // core both import it); a literal here would be a second key a round trip
  // through the annotator never finds.
  const entry = read("../send/SendSheetEntry.tsx");
  for (const src of [sendHook, entry, hook, bar]) assert.equal(count(src, '"send.compose"'), 0);
  assert.match(sendHook, /SEND_DRAFT,[^;]*from "\.\.\/\.\.\/sendIntent"/);
  assert.match(entry, /import \{ SEND_DRAFT \} from "\.\.\/\.\.\/sendIntent"/);
});
