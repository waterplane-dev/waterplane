/**
 * The shipped fan-out presets, checked as TEXT.
 *
 * `presets.ts` has a value import of `./storage`, so node's type stripping
 * cannot load it the way it loads `activityRows.ts` — and the same argument
 * `theme.test.mjs` makes about `styles.css` applies: the file is parsed here
 * rather than imported, because what needs pinning is what is WRITTEN in it.
 *
 * What this is actually protecting: `clean()` TRUNCATES. A preset whose text
 * passes `MAX_TEXT` is not rejected, it is silently cut — and these prompts are
 * fanned out unattended across many repos, so a cut one is an instruction that
 * stops mid-sentence in twenty checkouts at once. The long ones (the CLAUDE.md
 * groom is ~2.7k) are the ones somebody will extend without counting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./presets.ts", import.meta.url), "utf8");

const num = (name) => {
  const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(SRC);
  assert.ok(m, `${name} not found in presets.ts`);
  return Number(m[1].replace(/_/g, ""));
};
const MAX_TEXT = num("MAX_TEXT");
const MAX_TITLE = num("MAX_TITLE");
const MAX_ITEMS = num("MAX_ITEMS");

/** The `DEFAULT_PRESETS` entries, as {id,title,text} — template literals included. */
function defaults() {
  const block = SRC.slice(SRC.indexOf("export const DEFAULT_PRESETS"));
  const out = [];
  const re = /id: "([^"]+)",\s*\n\s*title: "((?:[^"\\]|\\.)*)",\s*\n\s*text: (`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g;
  for (const m of block.matchAll(re)) {
    out.push({ id: m[1], title: m[2], text: m[3].slice(1, -1) });
  }
  // The one-liners written inline (`{ id: "init", title: "/init", text: "/init" }`).
  for (const m of block.matchAll(/\{ id: "([^"]+)", title: "([^"]*)", text: "([^"]*)" \}/g)) {
    out.push({ id: m[1], title: m[2], text: m[3] });
  }
  return out;
}

test("the preset list parses, and is the size it looks", () => {
  const d = defaults();
  assert.ok(d.length >= 15, `only parsed ${d.length} presets — the regex has drifted from the file`);
  assert.ok(d.length <= MAX_ITEMS, `${d.length} defaults against MAX_ITEMS ${MAX_ITEMS}`);
});

test("no preset is silently truncated on load", () => {
  // `clean()` slices rather than rejecting, so this is the only place a too-long
  // prompt is ever noticed — and it would be noticed as a prompt that stops
  // mid-sentence on every repo it was fanned out to.
  const over = defaults().filter((p) => p.text.length > MAX_TEXT);
  assert.deepEqual(
    over.map((p) => `${p.id}: ${p.text.length} > ${MAX_TEXT}`), [],
    "clean() would CUT these prompts, not refuse them. Shorten the text or raise MAX_TEXT.",
  );
});

test("no preset title is silently truncated", () => {
  const over = defaults().filter((p) => p.title.length > MAX_TITLE);
  assert.deepEqual(over.map((p) => `${p.id}: ${p.title.length} > ${MAX_TITLE}`), []);
});

test("preset ids are unique and stable-looking", () => {
  const ids = defaults().map((p) => p.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  // An id is the identity used by `removed`: two defaults sharing one means
  // deleting either resurrects the other on the next load.
  assert.deepEqual([...new Set(dupes)], [], "duplicate preset ids");
  assert.deepEqual(ids.filter((id) => !/^[a-z0-9-]+$/.test(id)), [], "ids should be kebab-case");
});

test("every check remedy points at a preset that exists", () => {
  // `remedyFor` returns null when the id is missing, so a renamed preset does
  // not throw — the button simply stops being rendered, with nothing anywhere
  // saying why. This is the only place that would notice.
  const map = /CHECK_REMEDY: Record<string, string> = \{([\s\S]*?)\n\};/.exec(SRC);
  assert.ok(map, "CHECK_REMEDY not found — did it move?");
  const pairs = [...map[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length > 0, "CHECK_REMEDY is empty");
  const ids = new Set(defaults().map((p) => p.id));
  assert.deepEqual(
    pairs.filter(([, preset]) => !ids.has(preset)).map(([c, p]) => `${c} -> ${p}`), [],
    "A remedy names a preset that is not in DEFAULT_PRESETS.",
  );
});

test("every preset says what it will and will not touch", () => {
  // These run unattended across many repos at once. A sweep that does not state
  // its blast radius is one you cannot safely fan out, which is the whole point
  // of the feature. Slash commands are exempt — they are the CLI's own.
  const vague = defaults().filter((p) => {
    if (p.text.startsWith("/")) return false;
    return !/do not (change|edit|commit|fix|push)|change no code|delete nothing|commit nothing|touch no other|read-only/i.test(p.text);
  });
  assert.deepEqual(
    vague.map((p) => p.id), [],
    "A fan-out preset must say whether it writes, and whether it commits.",
  );
});
