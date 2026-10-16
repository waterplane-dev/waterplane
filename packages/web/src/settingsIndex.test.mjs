/**
 * The Settings catalogue, and the one check that keeps it from going stale.
 *
 * Search on that screen is matched against `settingsIndex.ts`, never against
 * the rendered DOM — so the failure this file exists for is silent and
 * asymmetric: a row that ships without a catalogue entry is on screen and
 * unfindable, and a catalogue entry with no row makes the group heading appear
 * over nothing. Neither looks broken while you are writing it, and neither is
 * visible in a diff of `App.tsx` alone. So the ids are read back out of the
 * source, exactly like `claudemd.test.mjs` reads the file it is about.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SETTING_GROUPS, SETTING_ROWS, addSettingRows, filterSummary, groupMatches, groupShown, rowMatches, rowShown, settingRow,
  nestedMatches, setRowWords, wordsMatch,
} from "./settingsIndex.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The core's settings sheet (it left App's overlay table). */
const SHEET = join(here, "core", "settings", "SettingsSheet.tsx");

/** The settings screen's own source: the core sheet FIRST (the `<SetGroup>`
 *  tags, so the group ORDER is its), then the files beside it holding the
 *  bodies of some groups (`SettingsGroups.tsx`). */
function settingsBlock() {
  assert.ok(existsSync(SHEET), "core/settings/SettingsSheet.tsx is gone — this test is out of date");
  const dir = dirname(SHEET);
  const rest = readdirSync(dir).filter((f) => f.endsWith(".tsx") && f !== "SettingsSheet.tsx").sort();
  return [SHEET, ...rest.map((f) => join(dir, f))].map((f) => readFileSync(f, "utf8")).join("\n");
}

/** Every feature's settings rows (`features/<x>/<Name>Settings.tsx`, drawn
 *  through `featureSettingsRows`): rows the screen shows, in no group of its own. */
function featureRowsSource() {
  const dir = join(here, "features");
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true })
    .filter((f) => /(^|\/)[A-Z]\w*Settings\.tsx$/.test(f))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

test("every group id is unique and every row points at one that exists", () => {
  const ids = SETTING_GROUPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate group id");
  for (const r of SETTING_ROWS) {
    assert.ok(ids.includes(r.group), `row ${r.id} is in group "${r.group}", which does not exist`);
  }
});

test("every row id is unique", () => {
  const ids = SETTING_ROWS.map((r) => r.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], "duplicate row id — search would hide one of them at random");
});

test("no group is empty", () => {
  for (const g of SETTING_GROUPS) {
    assert.ok(SETTING_ROWS.some((r) => r.group === g.id), `group "${g.id}" has no rows`);
  }
});

test("the catalogue and the screen name the same rows", () => {
  const block = settingsBlock();

  const groups = [...block.matchAll(/<SetGroup\s+id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    groups, SETTING_GROUPS.map((g) => g.id),
    "the groups the settings screen draws are not the groups this catalogue lists, in that order",
  );

  // Every id= in the block that is not a group is a row. Written this way
  // rather than per-component because the components are multi-line and a
  // `[^>]*` would stop at the first `>` inside an arrow function.
  const all = [...`${block}\n${featureRowsSource()}`.matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1]);
  const rendered = new Set(all.filter((id) => !groups.includes(id)));
  const known = new Set(SETTING_ROWS.map((r) => r.id));

  const unlisted = [...rendered].filter((id) => !known.has(id)).sort();
  assert.deepEqual(unlisted, [], "these rows render but are not in settingsIndex.ts — search cannot find them");

  const unrendered = [...known].filter((id) => !rendered.has(id)).sort();
  assert.deepEqual(unrendered, [], "settingsIndex.ts names these rows and nothing renders them");
});

test("a row matches on its label, its keywords and its group's words", () => {
  // Its own label.
  assert.ok(rowMatches("data-saver", "data saver"));
  // A word only the keywords carry — the whole reason keywords exist.
  assert.ok(rowMatches("theme", "dark"));
  assert.ok(rowMatches("text-size", "font"));
  assert.ok(rowMatches("lan-password", "password"));
  assert.ok(rowMatches("notif-shell-battery", "battery"));
  // Its group's heading — searching a group name asks for the whole group.
  assert.ok(rowMatches("notif-kinds", "notifications"));
  // And a word that belongs to none of those.
  assert.ok(!rowMatches("theme", "screenshot"));
});

test("terms are ANDed, not ORed", () => {
  // "tab order" under OR matches every row carrying either word and the query
  // stops narrowing anything.
  assert.ok(rowMatches("tabs-order", "tab order"));
  assert.ok(!rowMatches("tabs-count", "tab order"));
  assert.ok(!rowMatches("reader-tools", "tab order"));
});

test("matching is substring, so it narrows while you are still typing", () => {
  assert.ok(rowMatches("notif-push", "notif"));
  assert.ok(rowMatches("repo-colours", "colour"));
  assert.ok(rowMatches("theme", "col")); // "colour" in its keywords
});

test("an empty query hides nothing, and an unknown id is never hidden", () => {
  for (const r of SETTING_ROWS) assert.ok(rowMatches(r.id, ""));
  for (const r of SETTING_ROWS) assert.ok(rowMatches(r.id, "   "));
  // A control that predates its catalogue entry must still draw — search going
  // stale may not be allowed to delete a working switch off the screen.
  assert.ok(rowMatches("something-nobody-listed", "theme"));
});

test("a group's own words never match its rows wholesale", () => {
  // The bug this pins: "gemini" was a keyword on the Sessions GROUP, so a
  // search for it returned all fourteen session rows — the backend picker, the
  // model, both budget ceilings — instead of the rows about the oracle (a
  // plugin now, whose one catalogued row is `plugins`).
  const hits = (q) => SETTING_ROWS.filter((r) => rowMatches(r.id, q)).map((r) => r.id);
  for (const id of hits("gemini")) assert.equal(id, "plugins", `"gemini" matched ${id}`);
  for (const id of hits("battery")) assert.ok(["notif-shell-battery", "bg-fresh"].includes(id), `"battery" matched ${id}`);
  assert.ok(!SETTING_GROUPS.some((g) => "keywords" in g), "a group with keywords matches every row under it");
});

test("a group's TITLE does match its rows — searching a group name asks for the group", () => {
  const inGroup = (g) => SETTING_ROWS.filter((r) => r.group === g).map((r) => r.id);
  for (const id of inGroup("notifications")) assert.ok(rowMatches(id, "notifications"), id);
  for (const id of inGroup("appearance")) assert.ok(rowMatches(id, "appearance"), id);
});

test("settingRow answers with the row's own metadata", () => {
  assert.equal(settingRow("theme")?.group, "appearance");
  assert.equal(settingRow("nope"), undefined);
});

test("the filter bar says n of N, and says the count differently when nothing matched", () => {
  assert.equal(filterSummary(9, 54, ""), "");
  assert.equal(filterSummary(9, 54, "  "), "");
  assert.equal(filterSummary(9, 54, "dark"), "9 of 54 settings match “dark”");
  // Nothing matched: the total is still said, because "nothing matches" on its
  // own reads as an empty screen rather than as a filter.
  assert.match(filterSummary(0, 54, "zzz"), /nothing matches .*54 settings/);
});

test("keywords are lower case, so a typed capital still finds the row", () => {
  // The query is lowered; the haystack is built lowered too. This pins the one
  // that would silently stop matching: a keyword list written in Title Case.
  assert.ok(rowMatches("notif-push", "OS PUSH"));
  assert.ok(rowMatches("tool-cli-health", "CLI Health"));
});

/**
 * **A feature row lands in the group its manifest names, and search must agree.**
 *
 * A feature draws its rows through `SettingsRowsDef` (`group`, `order`,
 * `render`), and the catalogue names a group per row id separately. The id
 * check above only asks that both SIDES know the id; a row declared into
 * `sessions` while the catalogue files it under `tools` passes it, and then
 * search hides the heading it is drawn under and shows it under one it is not.
 * So each feature's `settings: [...]` is read out of its `index.ts`, the
 * component it renders followed into its file (and into the same-file
 * components that one draws), and every row id found there must carry that
 * declaration's group in `settingsIndex.ts`.
 */
function bodyOfFn(text, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(text);
  if (!m) return "";
  let i = m.index + m[0].length - 1;
  for (let d = 0; i < text.length; i++) {
    if (text[i] === "(") d++;
    else if (text[i] === ")" && --d === 0) break;
  }
  const open = text.indexOf("{", i);
  for (let d = 0, j = open; j < text.length; j++) {
    if (text[j] === "{") d++;
    else if (text[j] === "}" && --d === 0) return text.slice(open, j + 1);
  }
  return "";
}

/** Row ids a component draws, following `<Sub` into same-file components. */
function idsDrawnBy(text, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const body = bodyOfFn(text, name);
  const ids = [...body.matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1]);
  for (const [, sub] of body.matchAll(/<([A-Z]\w*)[\s/>]/g)) ids.push(...idsDrawnBy(text, sub, seen));
  return ids;
}

test("every feature settings row sits in the group its manifest declares", () => {
  const featDir = join(here, "features");
  const problems = [];
  const reached = new Set();
  let decls = 0;
  for (const name of readdirSync(featDir).sort()) {
    const idx = join(featDir, name, "index.ts");
    if (!existsSync(idx)) continue;
    const src = readFileSync(idx, "utf8");
    const at = src.search(/\bsettings:\s*\[/);
    if (at < 0) continue;
    const block = src.slice(at, src.indexOf("\n  ],", at));
    const from = Object.fromEntries([...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.\/[^"]+)"/g)]
      .flatMap((m) => m[1].split(",").map((s) => [s.trim(), m[2]])));
    for (const [, group, comp] of block.matchAll(/\{\s*group:\s*"([\w-]+)"[^}]*?createElement\((\w+)\)/g)) {
      decls++;
      assert.ok(from[comp], `features/${name}/index.ts renders ${comp}, imported from nowhere this test can read`);
      const file = join(featDir, name, `${from[comp].replace(/^\.\//, "").replace(/\.tsx?$/, "")}.tsx`);
      const ids = idsDrawnBy(readFileSync(file, "utf8"), comp);
      if (!ids.length) problems.push(`${name}: ${comp} draws no row id this test can see`);
      for (const id of ids) {
        reached.add(id);
        const row = settingRow(id);
        if (row && row.group !== group) {
          problems.push(`${id}: drawn by ${comp} into "${group}" (features/${name}/index.ts), catalogued under "${row.group}"`);
        }
      }
    }
  }
  assert.ok(decls >= 7, `read only ${decls} feature settings declarations — has the manifest shape changed?`);
  assert.deepEqual(problems, [],
    "a feature row's SettingsRowsDef.group and its settingsIndex.ts group disagree — search would show\n" +
    "it under one heading while the screen draws it under another. Move one of them.");
  const drawn = new Set([...featureRowsSource().matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1]));
  const unread = [...drawn].filter((id) => !reached.has(id)).sort();
  assert.deepEqual(unread, [], "feature settings rows no manifest declaration was followed to — the walk has gone blind");
});

// ── a door's pin (`settingsFocus.ts`) ────────────────────────────────────
// "Change this" from a readout opens Settings on ONE row, not on the top.

test("a pinned row shows alone, and wins over a query", () => {
  assert.equal(rowShown("net-pulse", "", "net-pulse"), true);
  assert.equal(rowShown("theme", "", "net-pulse"), false);
  assert.equal(rowShown("theme", "theme", "net-pulse"), false);
  assert.equal(rowShown("theme", "theme", null), true);
  assert.equal(groupShown("appearance", "", "net-pulse"), true);
  assert.equal(groupShown("sessions", "", "net-pulse"), false);
});

test("the pin's filter bar names the row and what it hides", () => {
  assert.equal(filterSummary(1, 54, "", "lan-password"), "showing “LAN password” only — 1 of 54 settings");
  // The row is conditional (host trusted path only) — say so, never a blank screen.
  assert.equal(filterSummary(0, 50, "", "lan-password"), "“LAN password” is not on this screen right now — 50 settings here");
});

test("every openSettingsAt names a catalogued row", () => {
  const files = readdirSync(here, { recursive: true })
    .filter((f) => /\.tsx?$/.test(f) && !f.includes("node_modules"));
  const ids = new Set(SETTING_ROWS.map((r) => r.id));
  let n = 0;
  for (const f of files) {
    for (const m of readFileSync(join(here, f), "utf8").matchAll(/openSettingsAt\("([^"]+)"\)/g)) {
      n++;
      assert.ok(ids.has(m[1]), `${f}: openSettingsAt("${m[1]}") names no row in settingsIndex.ts`);
    }
  }
  assert.ok(n > 0, "no doors found — the scan is looking in the wrong place");
});

// ── rows the catalogue file cannot name ──────────────────────────────────
// An extension's row and an installed plugin's section were on screen and
// gone under any query: "vaul" read "nothing matches" with the vault row right
// there, because its group matched no catalogued row and hid it whole.

test("an extension's catalogued row is found, and keeps its group's heading up", () => {
  addSettingRows([{ id: "test-ext-vault", group: "tools", label: "vault", keywords: "secret fingerprint" }]);
  assert.equal(rowMatches("test-ext-vault", "vaul"), true);
  assert.equal(rowMatches("test-ext-vault", "fingerprint"), true);
  assert.equal(groupMatches("tools", "vaul"), true);
  assert.equal(groupMatches("sessions", "vaul"), false);
  // A core id is never overridden by an extension claiming it.
  addSettingRows([{ id: "theme", group: "tools", label: "not the theme" }]);
  assert.equal(settingRow("theme").group, "appearance");
});

test("run-time words find the plugins row, and are replaced whole", () => {
  assert.equal(rowMatches("plugins", "sensors"), false);
  setRowWords("plugins", "Mac sensors CPU/GPU temperature");
  assert.equal(rowMatches("plugins", "sensors"), true);
  assert.equal(groupMatches("tools", "mac sens"), true);
  setRowWords("plugins", "");
  assert.equal(rowMatches("plugins", "sensors"), false);
});

test("every extension settings row is catalogued in its manifest", () => {
  const extDir = join(here, "..", "..", "extensions");
  const problems = [];
  let decls = 0;
  // Manifests that mention settings at all. Counted, not fixed at 2: the extensions that declare
  // rows today are private, so the public snapshot has none, and that is no parse failure.
  let mentions = 0;
  for (const name of readdirSync(extDir).sort()) {
    const idx = join(extDir, name, "web", "index.ts");
    if (!existsSync(idx)) continue;
    const src = readFileSync(idx, "utf8");
    if (/\bsettings\s*:/.test(src)) mentions++;
    const at = src.search(/\bsettings:\s*\[/);
    if (at < 0) continue;
    const block = src.slice(at, src.indexOf("\n  ],", at) + 1 || undefined);
    const declared = new Set([...block.matchAll(/\bid:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]));
    for (const [, comp] of block.matchAll(/createElement\((\w+)\)/g)) {
      decls++;
      const file = join(extDir, name, "web", `${comp}.tsx`);
      if (!existsSync(file)) { problems.push(`${name}: ${comp}.tsx not found beside index.ts`); continue; }
      const ids = [...readFileSync(file, "utf8").matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1]);
      if (!ids.length) problems.push(`${name}: ${comp} draws no row id — search will hide it under any query`);
      for (const id of ids) if (!declared.has(id)) problems.push(`${name}: ${comp} draws "${id}", not in its manifest's rows`);
    }
  }
  assert.ok(decls >= mentions, `read only ${decls} extension settings declarations from ${mentions} manifests that have settings — has the manifest shape changed?`);
  assert.deepEqual(problems, []);
});

test("a nested section shows whole under its parent's catalogued words, else only when its own words match", () => {
  assert.ok(nestedMatches("plugins", "Notary", ""), "no query: everything");
  assert.ok(nestedMatches("plugins", "Notary", "plugin"), "searching the row's own words shows every section");
  assert.ok(nestedMatches("plugins", "Notary sign", "notar"));
  assert.ok(!nestedMatches("plugins", "Decision oracle", "notar"), "the plugin beside it steps aside");
  // Run-time words on the parent (`setRowWords`) do not count as the parent's own:
  // they are the sections' words, and would show every section for any one name.
  setRowWords("plugins", "Notary Decision oracle");
  assert.ok(!nestedMatches("plugins", "Decision oracle", "notar"));
  setRowWords("plugins", "");
  assert.ok(wordsMatch("Open The Notary", "notary open"), "case-insensitive, AND, substring");
});
