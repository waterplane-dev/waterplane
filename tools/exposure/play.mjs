// D2 "Play vitals" of the exposure watch: is an app's user-perceived crash / ANR rate over the line
// Google Play itself calls bad behaviour? Read from the Play Developer Reporting API (v1beta1) with a
// Google service-account key. The key FILE PATH comes from the caller (the CLI takes it from env
// EXPOSURE_PLAY_KEY_FILE); nothing here reads the environment, waits for a person or prompts — no key,
// a dormant key or a bad key is an ABSENT reading with words, never a pass. The token, the JWT and the
// key never reach a message. The thresholds are Play Console's bad-behaviour lines (1.09 % crash,
// 0.47 % ANR, user-perceived, 28-day user-weighted); the user floor keeps a tiny audience's noisy
// rate from alerting. Pure parts (buildJwt, freshEnd, vitalsFindings) are separate from the I/O glue.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export const VITALS_MIN_USERS = 100;
export const CRASH_LINE = 0.0109;
export const ANR_LINE = 0.0047;

const SCOPE = "https://www.googleapis.com/auth/playdeveloperreporting";
const API = "https://playdeveloperreporting.googleapis.com/v1beta1/";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const FETCH_MS = 15_000;
const DAY = 86400000;
const KINDS = {
  crash: { set: "crashRateMetricSet", metric: "userPerceivedCrashRate28dUserWeighted", line: CRASH_LINE, label: "crash rate" },
  anr: { set: "anrRateMetricSet", metric: "userPerceivedAnrRate28dUserWeighted", line: ANR_LINE, label: "ANR rate" },
};

// keyOf/finding/absent are copied from parse.mjs (which copies core.mjs) so this file stands alone.
function keyOf({ measure, subject, version, advisory }) {
  if (advisory) return `adv:${advisory}:${subject}`;
  return `${measure}:${subject}${version ? `@${version}` : ""}`;
}
function finding(f) {
  const out = { level: "digest", sources: [], ...f };
  out.key = keyOf(out);
  return out;
}
const absent = (why, unreachable = false) => ({ measure: "D2", why, unreachable });

const b64u = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");

/** The self-signed RS256 JWT assertion Google's token endpoint trades for an access token. */
export function buildJwt(sa, now = new Date()) {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64u({ alg: "RS256", typ: "JWT" });
  const body = b64u({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || TOKEN_URI, iat, exp: iat + 3600 });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(sa.private_key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const dtMs = (d) => Date.UTC(d.year, (d.month || 1) - 1, d.day || 1);
const dtStr = (d) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
const dtAt = (ms, tz) => { const x = new Date(ms); return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate(), ...(tz ? { timeZone: tz } : {}) }; };

/** The DAILY `latestEndTime` (a DateTime) of a metric set document; null when Play lists none. */
export function freshEnd(set) {
  const f = (set?.freshnessInfo?.freshnesses ?? []).find((x) => x.aggregationPeriod === "DAILY");
  const t = f?.latestEndTime;
  return t && t.year ? t : null;
}

/** One query reply → a finding when over the line, a reading when under, an absence when unreadable or too few users. */
export function vitalsFindings(pkg, kind, resp, now = new Date()) {
  const k = KINDS[kind], out = { findings: [], absent: [], readings: {} };
  const rows = (resp?.rows ?? []).filter((r) => r.startTime?.year);
  if (!rows.length) return { ...out, absent: [absent("Play reports no vitals yet")] };
  const row = rows.reduce((a, b) => (dtMs(b.startTime) > dtMs(a.startTime) ? b : a));
  const val = (m) => { const e = (row.metrics ?? []).find((x) => x.metric === m); const n = Number(e?.decimalValue?.value); return e && Number.isFinite(n) ? n : null; };
  const rate = val(k.metric), users = val("distinctUsers"), date = dtStr(row.startTime);
  if (rate === null || users === null) return { ...out, absent: [absent(`Play returned no ${k.label} or user count for ${pkg} on ${date}`)] };
  if (users < VITALS_MIN_USERS) return { ...out, absent: [absent(`only ${users} users on ${date}: below the floor Play's rate needs to mean anything`)] };
  out.readings = { [`D2.${pkg}.${kind}`]: String(rate), [`D2.${pkg}.users`]: String(users) };
  if (rate > k.line) out.findings.push(finding({
    measure: "D2", subject: `play:${pkg}:${kind}`, level: "alert", severity: "high", sources: ["Play Developer Reporting"],
    text: `${pkg}: user-perceived ${k.label} (28-day, user-weighted) is over Play's bad-behaviour line of ${(k.line * 100).toFixed(2)}% on the latest day; the reading is in the row`, // no daily numbers: an until-change accept compares text
  }));
  return out;
}

// Own small fetch wrapper (sources.mjs's `http` is not exported): 15 s timeout, one retry on a network error.
async function call(fetchImpl, url, { method = "GET", headers, body } = {}, retry = true) {
  try {
    const res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(FETCH_MS) });
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    return { status: res.status, ok: res.ok, data };
  } catch (e) {
    if (retry) return call(fetchImpl, url, { method, headers, body }, false);
    return { status: 0, ok: false, data: null, why: String(e?.name ?? "error") };
  }
}

const errWord = (r) => (r.status ? `HTTP ${r.status}${typeof r.data?.error === "string" ? ` ${r.data.error}` : ""}` : `network error (${r.why})`);

/** D2 for one package: `{ findings, absent, readings? }`. Never throws, never waits for a person. */
export async function collectPlayVitals(pkg, { keyFile, missingWhy, now = new Date(), fetchImpl = fetch } = {}) {
  const none = (why, unreachable = false) => ({ findings: [], absent: [absent(why, unreachable)] });
  try {
    if (!keyFile) return none(missingWhy || "no Play reporting key given (EXPOSURE_PLAY_KEY_FILE)");
    let sa;
    try {
      sa = JSON.parse(readFileSync(keyFile, "utf8"));
      if (!sa.client_email || !sa.private_key) throw new Error("fields");
    } catch {
      return none("the Play reporting key file could not be read as a service-account key (needs client_email and private_key)");
    }
    let assertion;
    try { assertion = buildJwt(sa, now); } catch { return none("the Play reporting key's private_key could not sign a token"); }
    const tok = await call(fetchImpl, sa.token_uri || TOKEN_URI, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
    });
    if (!tok.ok || !tok.data?.access_token) return none(`Play token request failed: ${errWord(tok)}`, true);
    const headers = { authorization: `Bearer ${tok.data.access_token}`, "content-type": "application/json" };
    const res = { findings: [], absent: [], readings: {} };
    for (const kind of Object.keys(KINDS)) {
      const k = KINDS[kind], base = `${API}apps/${encodeURIComponent(pkg)}/${k.set}`;
      const set = await call(fetchImpl, base, { headers });
      if (set.status === 404 || set.status === 403) { res.absent.push(absent(`Play has no ${k.label} for ${pkg}: app not found or this account lacks "view app information" access in Play Console`)); continue; }
      if (!set.ok) { res.absent.push(absent(`Play ${k.label} for ${pkg}: ${errWord(set)}`, true)); continue; }
      const end = freshEnd(set.data);
      if (!end) { res.absent.push(absent("Play reports no vitals yet")); continue; }
      const tz = end.timeZone?.id ? end.timeZone : { id: "America/Los_Angeles" }; // DAILY timelines accept only this zone
      const q = await call(fetchImpl, `${base}:query`, {
        method: "POST", headers,
        body: JSON.stringify({ timelineSpec: { aggregationPeriod: "DAILY", startTime: dtAt(dtMs(end) - DAY, tz), endTime: dtAt(dtMs(end), tz) }, metrics: [k.metric, "distinctUsers"] }),
      });
      if (!q.ok) { res.absent.push(absent(`Play ${k.label} query for ${pkg}: ${errWord(q)}`, q.status !== 404 && q.status !== 403)); continue; }
      const v = vitalsFindings(pkg, kind, q.data, now);
      res.findings.push(...v.findings); res.absent.push(...v.absent); Object.assign(res.readings, v.readings);
    }
    return res;
  } catch {
    return none("Play vitals could not be read (unexpected error)", true);
  }
}
