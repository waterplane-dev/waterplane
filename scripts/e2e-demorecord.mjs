// Demo record mode end to end: the real host driven by the stub TUI's `demo`
// script with WATERPLANE_WIRE_RECORD on, then tools/demo-scenario.mjs over the
// recording. Pins: the recording holds both frame directions and /api responses;
// the scrub passes and leaves nothing the policy forbids; ids/seq/clock are
// renumbered; and a secret planted in what the "user" typed makes the scrub
// FAIL CLOSED (exit 1, nothing written) instead of being passed or silently masked.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDemoSession } from "./lib-demorecord.mjs";
import { SLUG } from "./lib-brand.mjs";
import { CLOCK_START, findLeaks, parseRecording } from "../tools/demo-scenario.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

const dir = mkdtempSync(join(tmpdir(), `${SLUG}-demorec-`));
const tool = (wire, out) => spawnSync("node", ["tools/demo-scenario.mjs", wire, "--id", "e2e-demo", "--out", out], { encoding: "utf8" });

try {
  // ── a clean recording ──────────────────────────────────────────────
  const wire = join(dir, "wire.jsonl");
  await recordDemoSession(wire);
  const recs = parseRecording(readFileSync(wire, "utf8"));
  check(recs.some((r) => r.dir === "in" && r.msg.t === "session.create"), "recording holds client frames");
  check(recs.some((r) => r.dir === "out" && r.msg.t === "welcome"), "recording holds host frames");
  check(recs.some((r) => r.dir === "http" && r.path === "/api/repos"), "recording holds /api responses");
  check((statSync(wire).mode & 0o777) === 0o600, "the raw recording is owner-only (0600)");
  check(findLeaks(recs).length > 0, "the RAW recording is dirty (so a passing scrub means something)");

  const out = join(dir, "scenario.json");
  const ok = tool(wire, out);
  check(ok.status === 0, `scrub passes on the stub recording (${ok.stderr.trim()})`);
  const sc = JSON.parse(readFileSync(out, "utf8"));
  check(sc.meta.id === "e2e-demo" && typeof sc.meta.protocol === "number" && /^[0-9a-f]{12}$/.test(sc.meta.stamp), "meta has id, protocol, stamp");
  check(sc.clock.start === CLOCK_START, "clock is pinned");
  check(findLeaks(sc).length === 0, "the scenario holds nothing the policy forbids");
  const frames = sc.script.map((e) => e.event.msg);
  check(frames.some((m) => m.t === "session.updated" && m.session.prompt?.options?.length === 2), "the choice box is in the script");
  check(frames.some((m) => m.t === "pty" && Buffer.from(m.dataB64, "base64").toString().includes("sorted by due date")), "the result text is in the pty stream");
  check(sc.state.model.recording.handshake[0].t === "welcome" && sc.state.model.recording.handshake[0].root === "demo", "welcome is redacted (root: demo)");
  check(!sc.state.model.recording.http.some((h) => h.path === "/api/health"), "denylisted /api/health is dropped");
  const ptySeq = frames.filter((m) => m.t === "pty" && !m.full).map((m) => m.seq);
  check(ptySeq.length > 1 && ptySeq.every((s, i) => i === 0 || s > ptySeq[i - 1]), "pty seq is renumbered and increasing");
  check(sc.script.every((e, i) => i === 0 || e.at >= sc.script[i - 1].at), "script is in time order");

  // ── a planted secret ──────────────────────────────────────────────
  const dirty = join(dir, "dirty.jsonl");
  await recordDemoSession(dirty, { plant: "with key sk-ant-api03-Zk3JQ0v9xT2mN8aB4cD7eF1gH5iL6" });
  const outDirty = join(dir, "dirty.json");
  const bad = tool(dirty, outDirty);
  check(bad.status === 1, "a planted API key makes the scrub fail (exit 1)");
  check(/api key prefix/.test(bad.stderr), "…and names the rule that caught it");
  check(!existsSync(outDirty), "…and writes no scenario");
} catch (e) {
  console.error(e);
  failed = true;
}
process.exit(failed ? 1 : 0);
