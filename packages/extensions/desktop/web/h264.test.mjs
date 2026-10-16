/**
 * The H.264 bytes the player reads before it hands anything to a decoder: Annex-B split on both
 * start-code lengths, keyframe detection off the IDR slice, and the `avc1.PPCCLL` codec string
 * off the SPS (emulation-prevention bytes removed).
 *
 *     node --test packages/extensions/desktop/web/h264.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAL_IDR, NAL_PPS, NAL_SPS, codecFromSps, codecOf, findSps, isKeyframe, splitAnnexB } from "./h264.ts";

const u8 = (...b) => new Uint8Array(b);
// SPS: header 0x67, profile 0x4D (Main), constraints 0x40, level 0x1F (3.1), then payload.
const SPS = [0x67, 0x4d, 0x40, 0x1f, 0xe8, 0x80];
const PPS = [0x68, 0xee, 0x3c, 0x80];
const IDR = [0x65, 0x88, 0x84, 0x00, 0x33];
const P = [0x41, 0x9a, 0x02, 0x03];

test("Annex-B splits on 4- and 3-byte start codes and names each unit's type", () => {
  const buf = u8(0, 0, 0, 1, ...SPS, 0, 0, 1, ...PPS, 0, 0, 0, 1, ...IDR);
  const nals = splitAnnexB(buf);
  assert.deepEqual(nals.map((n) => n.type), [NAL_SPS, NAL_PPS, NAL_IDR]);
  assert.deepEqual([...nals[0].data], SPS);
  assert.deepEqual([...nals[1].data], PPS);
  assert.deepEqual([...nals[2].data], IDR);
});

test("a buffer with no start code has no units; junk before the first is skipped", () => {
  assert.deepEqual(splitAnnexB(u8(1, 2, 3)), []);
  assert.deepEqual(splitAnnexB(u8(9, 9, 0, 0, 1, ...P)).map((n) => n.type), [1]);
});

test("a keyframe is an access unit with an IDR slice; a P-frame is not", () => {
  assert.equal(isKeyframe(u8(0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS, 0, 0, 0, 1, ...IDR)), true);
  assert.equal(isKeyframe(u8(0, 0, 0, 1, ...P)), false);
  // SPS and PPS alone start nothing.
  assert.equal(isKeyframe(u8(0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS)), false);
});

test("the codec string comes off the SPS: profile, constraint flags, level, in hex", () => {
  assert.equal(codecFromSps(u8(...SPS)), "avc1.4D401F");
  assert.equal(codecFromSps(u8(0x67, 0x42, 0xe0, 0x1e, 0x00)), "avc1.42E01E"); // Constrained Baseline 3.0
  assert.equal(codecFromSps(u8(0x67, 0x64, 0x00, 0x28)), "avc1.640028"); // High 4.0
  assert.equal(codecOf(u8(0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...IDR)), "avc1.4D401F");
  assert.equal(codecOf(u8(0, 0, 0, 1, ...P)), null);
  assert.deepEqual([...findSps(u8(0, 0, 1, ...SPS))], SPS);
});

test("an emulation-prevention byte inside the first fields is removed before reading", () => {
  // profile 0x00? never real, but 00 00 03 after the header must read as 00 00 then the next byte.
  assert.equal(codecFromSps(u8(0x67, 0x00, 0x00, 0x03, 0x01, 0x99)), "avc1.000001");
});

test("not an SPS, or too short, is no codec — never a guessed one", () => {
  assert.equal(codecFromSps(u8(...PPS)), null);
  assert.equal(codecFromSps(u8(0x67, 0x4d)), null);
});
