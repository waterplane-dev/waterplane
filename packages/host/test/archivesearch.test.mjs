/**
 * Archived-conversation search: the CLI's prompt history, grouped by conversation.
 * Pins what the sheet's words promise — prompts only, open sessions left out, a
 * deleted log left out, newest first, and the caps COUNTED rather than hidden.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARCHIVED_CONVERSATIONS_CAP, ARCHIVED_HITS_PER_CONVERSATION, parseHistory, searchPrompts } from "../dist/archivesearch.js";

const line = (display, sessionId, timestamp, project = "/r/a", pasted = {}) =>
  JSON.stringify({ display, pastedContents: pasted, timestamp, project, sessionId });

test("parseHistory keeps pasted text and skips lines it cannot open", () => {
  const rows = parseHistory([
    line("look at [Pasted text #1]", "c1", 1, "/r/a", { 1: { id: 1, type: "text", content: "the zebra stack" } }),
    JSON.stringify({ display: "no id", timestamp: 2, project: "/r/a" }),
    "{broken",
    "",
  ].join("\n"));
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /zebra/);
});

test("searchPrompts groups by conversation, newest first, skipping live and deleted ones", () => {
  const rows = parseHistory([
    line("fix the zebra", "old", 10),
    line("/compact zebra", "old", 11),
    line("zebra again", "live", 20),
    line("zebra gone", "deleted", 30),
    line("newer zebra", "new", 40, "/r/b"),
    line("unrelated", "other", 50),
  ].join("\n"));
  const { results, omitted } = searchPrompts(rows, "ZEBRA", new Set(["live"]), (_cwd, c) => c !== "deleted", (_cwd, c) => `t-${c}`);
  assert.deepEqual(results.map((r) => r.id), ["new", "old"]);
  assert.equal(omitted, 0);
  const old = results[1];
  assert.equal(old.archived, true);
  assert.equal(old.total, 2);
  assert.equal(old.title, "t-old");
  assert.equal(old.matches[0].turn.kind, "command", "newest prompt first, a slash command labelled as one");
  assert.equal(results[0].cwd, "/r/b");
});

test("both caps keep counting what they drop", () => {
  const many = [];
  for (let i = 0; i < ARCHIVED_CONVERSATIONS_CAP + 3; i++) many.push(line(`zebra ${i}`, `c${i}`, i));
  for (let i = 0; i < ARCHIVED_HITS_PER_CONVERSATION + 4; i++) many.push(line(`zebra deep ${i}`, "deep", 1000 + i));
  const { results, omitted } = searchPrompts(parseHistory(many.join("\n")), "zebra", new Set(), () => true, () => "");
  assert.equal(results.length, ARCHIVED_CONVERSATIONS_CAP);
  assert.equal(omitted, 4);
  const deep = results.find((r) => r.id === "deep");
  assert.equal(deep.matches.length, ARCHIVED_HITS_PER_CONVERSATION);
  assert.equal(deep.total, ARCHIVED_HITS_PER_CONVERSATION + 4);
  assert.equal(deep.title, "(no prompt)");
});
