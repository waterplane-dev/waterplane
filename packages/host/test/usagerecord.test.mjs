/**
 * The CLI's per-reply usage record, read by ONE module (`ctxlog/usagerecord.ts`).
 *
 *     node --test packages/host/test/usagerecord.test.mjs
 *
 * Five readers used to spell the record's rules by hand — skip `<synthetic>`,
 * dedupe by `message.id`, anchor on the first request that CARRIED context — and
 * a fix landed in one copy: c3190495 taught `tokenscan.ts` that an output-only
 * first record is not the anchor while `backends/overhead.ts` kept returning
 * null on it. The agreement test below is the one that failed then: every
 * reader that names a conversation's first request must name the same one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstRequestOf } from "../dist/backends/overhead.js";
import { summarizeLog } from "../dist/tokenscan.js";
import { updateContextLog } from "../dist/ctxlog.js";

const rec = (id, model, usage) => JSON.stringify({ type: "assistant", timestamp: "2026-10-01T10:00:00Z", message: { id, model, usage } });
const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

// The usage wall's stand-in, an output-only reply, then the first request that
// carried context (streamed: its usage repeated under one id), then another.
const LOG = [
  rec("s0", "<synthetic>", zero),
  rec("m0", "claude-opus-4-1", { ...zero, output_tokens: 12 }),
  rec("m1", "claude-opus-4-1", { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 }),
  rec("m1", "claude-opus-4-1", { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 }),
  rec("m2", "claude-opus-4-1", { input_tokens: 1, output_tokens: 9, cache_read_input_tokens: 143, cache_creation_input_tokens: 20 }),
].join("\n") + "\n";

test("every reader anchors on the first request that carried context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-usagerecord-"));
  const p = join(dir, "conv.jsonl");
  writeFileSync(p, LOG);
  const scan = await summarizeLog(p, statSync(p).size, 1);
  const series = updateContextLog(p, null);
  const overhead = firstRequestOf(LOG);
  assert.equal(scan?.b, 143, "tokenscan: b");
  assert.equal(series?.carried.firstReq?.tok, 143, "ctxlog: carried's anchor");
  assert.deepEqual(overhead, { model: "claude-opus-4-1", tok: 143 }, "overhead: the first request, past the wall row and the output-only reply");
});

test("overhead skips a <synthetic> row even when it carries numbers", () => {
  const head = [
    rec("s0", "<synthetic>", { ...zero, input_tokens: 7 }),
    rec("m1", "qwen", { ...zero, input_tokens: 5661 }),
  ].join("\n");
  assert.deepEqual(firstRequestOf(head), { model: "qwen", tok: 5661 });
});
