/**
 * Pins for splitting the reader (docs/notes/transcript-architecture.md).
 *
 * `TranscriptView.tsx` was one ~1100-line component. It is now a facade over
 * `transcript/` (one state hook, region components). A copy-then-delete move
 * can DUPLICATE a fetch or a poll, or DROP an export an importer needs. So:
 *
 *  - P1: the facade exports exactly the names it did, read off the type checker.
 *  - P2: the reader's side-effect sites are counted as TEXT over the facade +
 *    `transcript/**`, file-agnostic: the same counts hold before and after.
 *  - P3: its never-do list (no native modal, no socket of its own, no textarea).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertSurface } from "./exportsurface.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "web", "src");

const SURFACE = ["TranscriptStatus:type", "TranscriptView:value"];

test("P1: TranscriptView.tsx exports exactly its pinned surface, values and types alike", () => {
  const file = join(SRC, "TranscriptView.tsx");
  assertSurface(file, SURFACE);
});

/** `TranscriptView.tsx` plus everything under `transcript/`, as text. */
function reader() {
  const parts = [readFileSync(join(SRC, "TranscriptView.tsx"), "utf8")];
  const dir = join(SRC, "transcript");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir, { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f)).sort()) {
      parts.push(readFileSync(join(dir, f), "utf8"));
    }
  }
  return parts.join("\n");
}
const count = (re) => [...reader().matchAll(re)].length;

test("P2: one fetch of the document, one of the tool details, two cache writes, two timers", () => {
  assert.equal(count(/api\.transcript\(/g), 1);
  assert.equal(count(/api\.transcriptTools\(/g), 1);
  assert.equal(count(/\bputTranscript\(/g), 2, "debounced write and the unmount flush");
  assert.equal(count(/\bputToolDetails\(/g), 1);
  assert.equal(count(/\bsetInterval\(/g), 2, "the poll and the 1 Hz heartbeat");
  assert.equal(count(/track\("action:read\.stop"\)/g), 1);
  assert.equal(count(/<PromptAnswer\b/g), 1, "the one choice-box card");
  assert.equal(count(/^export function TranscriptView\(/gm), 1);
});

test("P3: the reader's never-do list", () => {
  const all = reader();
  assert.doesNotMatch(all, /window\.confirm|\bconfirm\(/, "no native modal");
  assert.equal(count(/<textarea/g), 0);
  assert.equal(count(/new WebSocket|sendWs\(|ws\.send\(/g), 0, "no send path of its own");
});
