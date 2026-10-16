// Live streams on the one socket (`shared/src/stream.ts`): the 12-byte binary header both ends
// must agree on, and the backlog line that keeps video from standing in front of PTY output.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STREAM_FLAG_DROPPABLE,
  STREAM_FLAG_KEY,
  STREAM_HEADER_BYTES,
  decodeStreamFrame,
  encodeStreamFrame,
  jsonBytes,
  streamBacklogLimit,
} from "../dist/index.js";

test("a frame round-trips, payload included", () => {
  const payload = new Uint8Array([0, 0, 0, 1, 0x67, 0x42]);
  const buf = encodeStreamFrame({ streamId: 513, seq: 0xfffffffe, kind: 7, flags: STREAM_FLAG_KEY }, payload);
  assert.equal(buf.byteLength, STREAM_HEADER_BYTES + payload.byteLength);
  const f = decodeStreamFrame(buf.buffer);
  assert.ok(f);
  assert.equal(f.streamId, 513);
  assert.equal(f.seq, 0xfffffffe);
  assert.equal(f.kind, 7);
  assert.equal(f.flags, STREAM_FLAG_KEY);
  assert.deepEqual([...f.payload], [...payload]);
});

test("seq wraps instead of throwing", () => {
  const f = decodeStreamFrame(encodeStreamFrame({ streamId: 1, seq: 2 ** 32 + 5, kind: 0, flags: 0 }, new Uint8Array()));
  assert.equal(f?.seq, 5);
});

test("a view into a larger buffer decodes from its own offset", () => {
  const inner = encodeStreamFrame({ streamId: 9, seq: 3, kind: 1, flags: STREAM_FLAG_DROPPABLE }, new Uint8Array([42]));
  const big = new Uint8Array(inner.byteLength + 10);
  big.set(inner, 5);
  const f = decodeStreamFrame(big.subarray(5, 5 + inner.byteLength));
  assert.equal(f?.streamId, 9);
  assert.deepEqual([...f.payload], [42]);
});

test("anything that is not one of ours decodes to null, never throws", () => {
  assert.equal(decodeStreamFrame(new Uint8Array(4)), null);
  const ok = encodeStreamFrame({ streamId: 1, seq: 0, kind: 0, flags: 0 }, new Uint8Array(3));
  const badMagic = ok.slice(); badMagic[0] = 0x58;
  const badVer = ok.slice(); badVer[1] = 2;
  const zeroId = ok.slice(); zeroId[2] = 0; zeroId[3] = 0;
  for (const b of [badMagic, badVer, zeroId]) assert.equal(decodeStreamFrame(b), null);
});

test("an out-of-range header field is a programming error", () => {
  for (const h of [{ streamId: 0 }, { streamId: 0x10000 }, { kind: 256 }, { flags: -1 }]) {
    assert.throws(() => encodeStreamFrame({ streamId: 1, seq: 0, kind: 0, flags: 0, ...h }, new Uint8Array()));
  }
});

test("the backlog line is ~0.4 s of the stream, clamped, with a default for no bitrate", () => {
  assert.equal(streamBacklogLimit(), 256 * 1024);
  assert.equal(streamBacklogLimit(Number.NaN), 256 * 1024);
  assert.equal(streamBacklogLimit(100_000), 64 * 1024);
  assert.equal(streamBacklogLimit(2_000_000), 100_000);
  assert.equal(streamBacklogLimit(100_000_000), 1024 * 1024);
});

test("jsonBytes measures UTF-8, and -1 for what does not serialise", () => {
  assert.equal(jsonBytes({ a: "é" }), '{"a":"é"}'.length + 1);
  const cyc = {}; cyc.self = cyc;
  assert.equal(jsonBytes(cyc), -1);
  assert.equal(jsonBytes(undefined), 4);
});
