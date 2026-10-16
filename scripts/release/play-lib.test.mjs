// node --test: Google Play publishing (play-lib.mjs) — the service-account JWT, the next
// versionCode, listing and release-note files against Play's limits, the release a track gets,
// the known-error sentences and the argument parser. Throwaway keys only; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIMITS, SCOPE, explainApiError, latestRelease, nextVersionCode, parseArgs, parseServiceAccount, readListings,
  readReleaseNotes, releaseFor, serviceAccountAssertion,
} from "./play-lib.mjs";

test("the service-account assertion is an RS256 JWT for the publisher scope, verifiable with the key's public half", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const sa = parseServiceAccount(JSON.stringify({ type: "service_account", client_email: "ci@p.iam.gserviceaccount.com", private_key: pem }));
  const jwt = serviceAccountAssertion(sa, 1_000_000);
  const [h, b, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(b, "base64url")), {
    iss: "ci@p.iam.gserviceaccount.com", scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: 1_000_000, exp: 1_003_600,
  });
  assert.equal(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(s, "base64url")), true);
});

test("a key file that is not a service account's is refused by name", () => {
  assert.throws(() => parseServiceAccount("{"), /not JSON/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ type: "authorized_user" })), /not "service_account"/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ type: "service_account", client_email: "x" })), /no private_key/);
});

test("the next versionCode is one past the highest on ANY track, never below the floor", () => {
  const tracks = [
    { track: "internal", releases: [{ versionCodes: ["7"] }] },
    { track: "production", releases: [{ versionCodes: ["5"] }, { versionCodes: ["6"] }] },
    { track: "beta" },
  ];
  assert.equal(nextVersionCode(tracks, 2), 8);
  assert.equal(nextVersionCode([], 2), 2, "nothing on Play yet: the build.gradle default");
  assert.equal(nextVersionCode(tracks, 20), 20);
});

test("latestRelease is the release with the highest versionCode, null on an empty track", () => {
  const a = { name: "a", versionCodes: ["3"] }, b = { name: "b", versionCodes: ["9"] };
  assert.equal(latestRelease({ releases: [a, b] }), b);
  assert.equal(latestRelease({}), null);
});

test("a release is completed, staged (inProgress + fraction), or draft — and versionCodes are strings", () => {
  assert.deepEqual(releaseFor({ versionCodes: [4] }), { versionCodes: ["4"], status: "completed" });
  assert.deepEqual(releaseFor({ versionCodes: [4], fraction: 0.1 }), { versionCodes: ["4"], status: "inProgress", userFraction: 0.1 });
  assert.deepEqual(releaseFor({ versionCodes: [4], fraction: 1 }), { versionCodes: ["4"], status: "completed" });
  assert.equal(releaseFor({ versionCodes: [4], draft: true }).status, "draft");
  const notes = [{ language: "en-US", text: "x" }];
  assert.deepEqual(releaseFor({ versionCodes: [4], name: "1.0 (4)", notes }).releaseNotes, notes);
});

test("listings and notes are read from files; an over-long text is a problem, never cut", () => {
  const dir = mkdtempSync(join(tmpdir(), "play-lib-"));
  try {
    const en = join(dir, "listings/en-US");
    mkdirSync(join(en, "phoneScreenshots"), { recursive: true });
    writeFileSync(join(en, "title.txt"), "waterplane\n");
    writeFileSync(join(en, "short-description.txt"), "s".repeat(LIMITS.shortDescription + 1));
    writeFileSync(join(en, "full-description.txt"), "full");
    writeFileSync(join(en, "phoneScreenshots/2.png"), "");
    writeFileSync(join(en, "phoneScreenshots/1.png"), "");
    writeFileSync(join(en, "phoneScreenshots/notes.md"), "");
    mkdirSync(join(dir, "listings/de-DE"), { recursive: true });
    writeFileSync(join(dir, "listings/de-DE/title.txt"), "nur Titel");
    const { listings, problems } = readListings(dir);
    assert.equal(listings[1].locale, "en-US");
    assert.equal(listings[1].text.title, "waterplane");
    assert.deepEqual(listings[1].images.phoneScreenshots.map((f) => f.slice(-5)), ["1.png", "2.png"]);
    assert.ok(problems.some((p) => /en-US: shortDescription is 81 characters, Play allows 80/.test(p)));
    assert.ok(problems.some((p) => /de-DE: a listing needs all three/.test(p)));

    mkdirSync(join(dir, "release-notes"));
    writeFileSync(join(dir, "release-notes/en-US.txt"), "Fixes.\n");
    writeFileSync(join(dir, "release-notes/de-DE.txt"), "x".repeat(501));
    const r = readReleaseNotes(dir);
    assert.deepEqual(r.notes.map((n) => n.language), ["de-DE", "en-US"]);
    assert.equal(r.problems.length, 1);
    assert.deepEqual(readReleaseNotes(dir, { notes: " only this " }).notes, [{ language: "en-US", text: "only this" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the one-time setup errors Play answers with get a sentence that names the fix", () => {
  assert.match(explainApiError(404, "Package not found: dev.waterplane.app."), /upload the FIRST bundle by hand/);
  assert.match(explainApiError(400, "Only releases with status draft may be created on draft app."), /--draft/);
  assert.match(explainApiError(403, "The caller does not have permission"), /Users and permissions/);
  assert.equal(explainApiError(500, "backend error"), null);
});

test("arguments: dry run by default, internal track, percentages, and the mixes that make no sense refused", () => {
  const d = parseArgs([]);
  assert.equal(d.cmd, "upload"); assert.equal(d.yes, false); assert.equal(d.track, "internal"); assert.equal(d.build, true);
  assert.equal(parseArgs(["--rollout", "10%"]).fraction, 0.1);
  assert.equal(parseArgs(["--rollout=0.25"]).fraction, 0.25);
  assert.equal(parseArgs(["--aab", "x.aab"]).build, false);
  assert.deepEqual((({ from, to }) => ({ from, to }))(parseArgs(["promote", "--to", "production"])), { from: "internal", to: "production" });
  assert.throws(() => parseArgs(["promote"]), /needs --to/);
  assert.throws(() => parseArgs(["rollout", "--track", "production"]), /needs --rollout/);
  assert.throws(() => parseArgs(["--track", "prod"]), /not a track/);
  assert.throws(() => parseArgs(["--rollout", "0"]), /fraction/);
  assert.throws(() => parseArgs(["--draft", "--rollout", "5%"]), /do not mix/);
  assert.throws(() => parseArgs(["deploy"]), /unknown command/);
});
