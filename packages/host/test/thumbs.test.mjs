// The thumbnail converter must name its decoder from the extension — content
// sniffing would run an MVG/MSL/TEXT "png" or an HLS/concat "mp4".
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertPlan } from "../dist/thumbs.js";

const all = { sips: false, magick: "magick", ffmpeg: true, policyDir: "/tmp/policy" };

test("magick plan names the coder and pins the policy dir", () => {
  const p = convertPlan("/r/a.PNG", "/o.jpg", 320, all);
  assert.equal(p.cmd, "magick");
  assert.ok(p.args[0].startsWith("png:"));
  assert.equal(p.env.MAGICK_CONFIGURE_PATH, "/tmp/policy");
  assert.equal(convertPlan("/r/a.jpg", "/o.jpg", 320, all).args[0], "jpeg:/r/a.jpg");
  assert.equal(convertPlan("/r/a.tif", "/o.jpg", 320, all).args[0], "tiff:/r/a.tif");
});

test("ffmpeg plan restricts protocols and demuxer before -i", () => {
  const a = convertPlan("/r/v.mp4", "/o.jpg", 320, all).args;
  const i = a.indexOf("-i");
  const w = a.indexOf("-protocol_whitelist");
  assert.ok(w >= 0 && w < i);
  assert.equal(a[w + 1], "file");
  assert.ok(a.indexOf("-f") >= 0 && a.indexOf("-f") < i);
  assert.equal(a[a.indexOf("-f") + 1], "mov");
  assert.ok(a.includes("-nostdin"));
});

test("unknown extension has no plan", () => {
  assert.equal(convertPlan("/r/a.xyz", "/o.jpg", 320, all), null);
});

test("sips plan is unchanged", () => {
  const p = convertPlan("/r/a.png", "/o.jpg", 320, { sips: true, magick: "magick", ffmpeg: true });
  assert.deepEqual(p, { cmd: "sips", args: ["-s", "format", "jpeg", "-s", "formatOptions", "60", "-Z", "320", "/r/a.png", "--out", "/o.jpg"] });
});

test("no policy dir on disk means no magick plan — never an unpoliced ImageMagick", () => {
  assert.equal(convertPlan("/r/a.png", "/o.jpg", 320, { sips: false, magick: "magick", ffmpeg: false }), null);
});

test("image2 stills disable sequence patterns; heif is covered", () => {
  const a = convertPlan("/r/a%d.png", "/o.jpg", 320, { sips: false, magick: null, ffmpeg: true }).args;
  const f = a.indexOf("-f");
  assert.equal(a[f + 1], "image2");
  assert.deepEqual(a.slice(f + 2, f + 4), ["-pattern_type", "none"]);
  assert.ok(a.indexOf("-pattern_type") < a.indexOf("-i"));
  assert.equal(convertPlan("/r/a.heif", "/o.jpg", 320, all).args[0], "heic:/r/a.heif");
});

test("magick plan env starts with the policy dir and keeps a user's path", () => {
  const prior = process.env.MAGICK_CONFIGURE_PATH;
  try {
    delete process.env.MAGICK_CONFIGURE_PATH;
    assert.equal(convertPlan("/r/a.png", "/o.jpg", 320, all).env.MAGICK_CONFIGURE_PATH, "/tmp/policy");
    process.env.MAGICK_CONFIGURE_PATH = "/u/magick";
    const v = convertPlan("/r/a.png", "/o.jpg", 320, all).env.MAGICK_CONFIGURE_PATH;
    assert.ok(v.startsWith("/tmp/policy"));
    assert.ok(v.endsWith("/u/magick"));
  } finally {
    if (prior === undefined) delete process.env.MAGICK_CONFIGURE_PATH; else process.env.MAGICK_CONFIGURE_PATH = prior;
  }
});
