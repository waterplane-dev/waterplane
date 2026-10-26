// node --test: D2 Play vitals (tools/exposure/play.mjs). fetch is injected; no network, and the
// key pair is generated here — nothing real.
import test from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJwt, collectPlayVitals, freshEnd, vitalsFindings, VITALS_MIN_USERS } from "./exposure/play.mjs";

const NOW = new Date("2026-10-26T12:00:00Z");
const PKG = "com.example.app";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const sa = { client_email: "watch@example.test", private_key: pem, token_uri: "https://auth.example.test/token" };
const dir = mkdtempSync(join(tmpdir(), "play-"));
const keyFile = join(dir, "key.json");
writeFileSync(keyFile, JSON.stringify(sa));

const D = (day) => ({ year: 2026, month: 10, day, timeZone: { id: "America/Los_Angeles" } });
const fresh = { freshnessInfo: { freshnesses: [{ aggregationPeriod: "HOURLY", latestEndTime: D(26) }, { aggregationPeriod: "DAILY", latestEndTime: D(24) }] } };
const reply = (metric, rate, users, day = 23) => ({ rows: [{ startTime: D(day), metrics: [{ metric, decimalValue: { value: String(rate) } }, { metric: "distinctUsers", decimalValue: { value: String(users) } }] }] });
const CM = "userPerceivedCrashRate28dUserWeighted", AM = "userPerceivedAnrRate28dUserWeighted";

/** A fake Play: token ok, metric sets fresh, queries answered by `answers[kind]`. Records calls. */
function fake({ token = { status: 200, body: { access_token: "TOK" } }, set = { status: 200, body: fresh }, crash, anr }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, ...init });
    const r = (status, body) => ({ status, ok: status < 400, json: async () => body });
    if (url.includes("auth.example.test")) return r(token.status, token.body);
    if (url.endsWith(":query")) return r(200, url.includes("crash") ? crash : anr);
    return r(set.status, set.body);
  };
  return { fetchImpl, calls };
}

test("buildJwt: header and payload decode, signature verifies with the public key", () => {
  const jwt = buildJwt(sa, NOW);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  const body = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(body.iss, sa.client_email);
  assert.equal(body.scope, "https://www.googleapis.com/auth/playdeveloperreporting");
  assert.equal(body.aud, sa.token_uri);
  assert.equal(body.iat, Math.floor(NOW.getTime() / 1000));
  assert.ok(body.exp - body.iat <= 3600);
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url")));
});

test("freshEnd: the DAILY latestEndTime, null without one", () => {
  assert.equal(freshEnd(fresh).day, 24);
  assert.equal(freshEnd({}), null);
});

test("vitalsFindings: over the line alerts, under it only reads", () => {
  const over = vitalsFindings(PKG, "crash", reply(CM, 0.02, 500), NOW);
  assert.equal(over.findings.length, 1);
  const f = over.findings[0];
  assert.equal(f.level, "alert"); assert.equal(f.severity, "high"); assert.equal(f.measure, "D2");
  assert.equal(f.subject, `play:${PKG}:crash`); assert.equal(f.key, `D2:play:${PKG}:crash`);
  assert.match(f.text, /1\.09%/); assert.doesNotMatch(f.text, /2\.00|500|2026-10-23/, "no daily numbers in text");
  assert.equal(vitalsFindings(PKG, "crash", reply(CM, 0.03, 700, 22), NOW).findings[0].text, f.text, "text is stable day to day");
  const under = vitalsFindings(PKG, "anr", reply(AM, 0.001, 500), NOW);
  assert.equal(under.findings.length, 0);
  assert.deepEqual(under.readings, { [`D2.${PKG}.anr`]: "0.001", [`D2.${PKG}.users`]: "500" });
  assert.equal(vitalsFindings(PKG, "anr", reply(AM, 0.0047, 500), NOW).findings.length, 0); // at the line is not over
  assert.equal(vitalsFindings(PKG, "anr", reply(AM, 0.0048, 500), NOW).findings.length, 1);
});

test("vitalsFindings: below the user floor and empty replies are absent", () => {
  const low = vitalsFindings(PKG, "crash", reply(CM, 0.5, VITALS_MIN_USERS - 1), NOW);
  assert.equal(low.findings.length, 0);
  assert.match(low.absent[0].why, /only 99 users on 2026-10-23: below the floor/);
  assert.equal(vitalsFindings(PKG, "crash", reply(CM, 0.5, VITALS_MIN_USERS), NOW).findings.length, 1);
  assert.match(vitalsFindings(PKG, "crash", {}, NOW).absent[0].why, /no vitals yet/);
});

test("collectPlayVitals: no key is absent with the caller's words, no fetch", async () => {
  const { fetchImpl, calls } = fake({});
  let r = await collectPlayVitals(PKG, { fetchImpl });
  assert.match(r.absent[0].why, /EXPOSURE_PLAY_KEY_FILE/); assert.equal(r.absent[0].unreachable, false);
  r = await collectPlayVitals(PKG, { fetchImpl, missingWhy: "the reporting key is dormant — re-arm it" });
  assert.equal(r.absent[0].why, "the reporting key is dormant — re-arm it");
  assert.equal(calls.length, 0);
});

test("collectPlayVitals: a bad key file is absent, not unreachable, and never echoed", async () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, '{"private_key":"SECRET-BITS"}');
  const r = await collectPlayVitals(PKG, { keyFile: bad, fetchImpl: fake({}).fetchImpl });
  assert.equal(r.absent[0].unreachable, false);
  assert.ok(!JSON.stringify(r).includes("SECRET-BITS"));
});

test("collectPlayVitals: token failure is unreachable with status and error only", async () => {
  const { fetchImpl } = fake({ token: { status: 400, body: { error: "invalid_grant", error_description: "SECRETY" } } });
  const r = await collectPlayVitals(PKG, { keyFile, fetchImpl, now: NOW });
  assert.equal(r.absent[0].unreachable, true);
  assert.match(r.absent[0].why, /HTTP 400 invalid_grant/);
  const all = JSON.stringify(r);
  assert.ok(!all.includes("SECRETY") && !all.includes("BEGIN") && !all.includes("TOK"));
});

test("collectPlayVitals: query body carries the DAILY timeline from freshness; findings and readings merge", async () => {
  const { fetchImpl, calls } = fake({ crash: reply(CM, 0.02, 500), anr: reply(AM, 0.001, 500) });
  const r = await collectPlayVitals(PKG, { keyFile, fetchImpl, now: NOW });
  assert.equal(r.findings.length, 1); assert.equal(r.findings[0].subject, `play:${PKG}:crash`);
  assert.equal(r.readings[`D2.${PKG}.anr`], "0.001");
  const q = calls.find((c) => c.url.includes("crashRateMetricSet:query"));
  assert.equal(q.method, "POST");
  assert.equal(q.headers.authorization, "Bearer TOK");
  assert.deepEqual(JSON.parse(q.body), {
    timelineSpec: { aggregationPeriod: "DAILY", startTime: D(23), endTime: D(24) },
    metrics: [CM, "distinctUsers"],
  });
  const t = calls.find((c) => c.url.includes("auth.example.test"));
  assert.match(t.body, /^grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=[\w-]+\.[\w-]+\.[\w-]+$/);
});

test("collectPlayVitals: 404 and 403 on the app are absent naming the package, not unreachable", async () => {
  for (const status of [404, 403]) {
    const r = await collectPlayVitals(PKG, { keyFile, fetchImpl: fake({ set: { status, body: {} } }).fetchImpl, now: NOW });
    assert.equal(r.findings.length, 0);
    assert.ok(r.absent.length >= 1);
    for (const a of r.absent) { assert.match(a.why, new RegExp(PKG.replace(/\./g, "\\."))); assert.equal(a.unreachable, false); }
  }
});

test("collectPlayVitals: a metric set without freshness reports no vitals yet", async () => {
  const r = await collectPlayVitals(PKG, { keyFile, fetchImpl: fake({ set: { status: 200, body: {} } }).fetchImpl, now: NOW });
  assert.match(r.absent[0].why, /no vitals yet/);
});

test("collectPlayVitals: a freshness time without a timeZone queries in America/Los_Angeles", async () => {
  const noTz = { freshnessInfo: { freshnesses: [{ aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 10, day: 24 } }] } };
  const { fetchImpl, calls } = fake({ set: { status: 200, body: noTz }, crash: reply(CM, 0.001, 500), anr: reply(AM, 0.001, 500) });
  await collectPlayVitals(PKG, { keyFile, fetchImpl, now: NOW });
  const body = JSON.parse(calls.find((c) => c.url.includes("crashRateMetricSet:query")).body);
  assert.equal(body.timelineSpec.startTime.timeZone.id, "America/Los_Angeles");
  assert.equal(body.timelineSpec.endTime.timeZone.id, "America/Los_Angeles");
});
