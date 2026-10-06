/**
 * Background shells read off `ps` — the discriminator that keeps MCP servers
 * and `caffeinate` out (they are CLI children too, but share its own pgid),
 * the eval'd command text, the transcript join, CPU-movement tracking and the
 * task output file's stat.
 *
 * The `ps` fixture below is shaped exactly like real output captured on this
 * desktop (`ps -axo pid=,ppid=,pgid=,etime=,time=,command=`), including the
 * real wait-loop bug this feature exists to name: a `pgrep -f "pytest -q -x"`
 * exit condition that can never see "nothing matches" because the pattern is
 * part of its own process's command line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanShellOutput,
  evalText,
  evalTextFull,
  foregroundWrapperPids,
  isShellWrapper,
  joinShellFact,
  killShellGroup,
  parseCpuMs,
  parseEtimeSec,
  parsePsTable,
  pruneCpuTrack,
  shellOutputStat,
  shellTranscriptFacts,
  shellsUnder,
  trackCpu,
} from "../dist/shells.js";

const CLI_PID = 5000;

// A wrapper for an emulator (a real worker under it: qemu), a self-matching
// wait loop (its own `sleep` child, excluded from `workers`), an MCP server
// and `caffeinate` sharing the CLI's own pgid (never shells).
const PS_FIXTURE = `
${CLI_PID}     1 ${CLI_PID}       21:37   0:03.10 /Users/x/.local/bin/claude
 5010 ${CLI_PID} ${CLI_PID}       21:30   0:00.20 /Users/x/.local/share/claude/mcp/some-server
 5011 ${CLI_PID} ${CLI_PID}       20:00   0:00.05 /usr/bin/caffeinate -i -w ${CLI_PID}
 6001 ${CLI_PID} 6001 04-21:29:31 1431:44.29 /bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && eval '~/Library/Android/sdk/emulator/emulator -avd obs_test -no-snapshot-load -no-audio -no-boot-anim > /tmp/emu.log 2>&1' < /dev/null && pwd -P >| /tmp/claude-aaaa-cwd
 6011      6001 6001       10:02   0:41.00 qemu-system-aarch64 -avd obs_test
 6002 ${CLI_PID} 6002    17:43:27   0:00.00 /bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-2-b.sh 2>/dev/null || true && eval 'until ! pgrep -f "pytest -q -x" >/dev/null; do sleep 10; done; tail -3 /tmp/out' < /dev/null && pwd -P >| /tmp/claude-bbbb-cwd
 6003      6002 6002       00:03   0:00.00 sleep 10
`;

test("parseEtimeSec: dd-hh:mm:ss, hh:mm:ss, mm:ss", () => {
  assert.equal(parseEtimeSec("04-21:29:31"), 4 * 86400 + 21 * 3600 + 29 * 60 + 31);
  assert.equal(parseEtimeSec("17:43:27"), 17 * 3600 + 43 * 60 + 27);
  assert.equal(parseEtimeSec("21:37"), 21 * 60 + 37);
  assert.equal(parseEtimeSec("garbage"), undefined);
});

test("parseCpuMs: mm:ss.cc (arbitrary-width minutes) and hh:mm:ss", () => {
  assert.equal(parseCpuMs("1431:44.29"), Math.round((1431 * 60 + 44.29) * 1000));
  assert.equal(parseCpuMs("0:00.00"), 0);
  assert.equal(parseCpuMs("2:03:04"), (2 * 3600 + 3 * 60 + 4) * 1000);
  assert.equal(parseCpuMs("nope"), undefined);
});

test("parsePsTable: reads every well-formed row, skips junk", () => {
  const rows = parsePsTable(`${PS_FIXTURE}\nnot a ps line\n`);
  assert.equal(rows.length, 7);
  const wrapper = rows.find((r) => r.pid === 6001);
  assert.equal(wrapper.ppid, CLI_PID);
  assert.equal(wrapper.pgid, 6001);
  assert.equal(wrapper.etimeSec, 4 * 86400 + 21 * 3600 + 29 * 60 + 31);
});

test("isShellWrapper: MCP servers and caffeinate are excluded — they share the CLI's own pgid", () => {
  const rows = parsePsTable(PS_FIXTURE);
  const mcp = rows.find((r) => r.pid === 5010);
  const caffeinate = rows.find((r) => r.pid === 5011);
  const wrapper = rows.find((r) => r.pid === 6001);
  assert.equal(isShellWrapper(mcp, CLI_PID), false);
  assert.equal(isShellWrapper(caffeinate, CLI_PID), false);
  assert.equal(isShellWrapper(wrapper, CLI_PID), true);
});

test("shellsUnder: one group per wrapper, workers exclude sleep/pipeline utilities", () => {
  const rows = parsePsTable(PS_FIXTURE);
  const groups = shellsUnder(CLI_PID, rows);
  assert.equal(groups.length, 2);

  const emulator = groups.find((g) => g.wrapper.pid === 6001);
  assert.equal(emulator.workers.length, 1); // qemu, not the wrapper itself
  assert.equal(emulator.workers[0].pid, 6011);

  const waitLoop = groups.find((g) => g.wrapper.pid === 6002);
  assert.equal(waitLoop.members.length, 1); // its own `sleep`
  assert.equal(waitLoop.workers.length, 0); // sleep is excluded — a loop that only sleeps
});

test("evalTextFull: the same unescape, never capped — the opened row's whole command", () => {
  const long = "y".repeat(300);
  assert.equal(evalTextFull(`x && eval '${long}' < /dev/null && pwd`), long);
  assert.equal(evalTextFull(`x && eval 'echo '\\''a'\\''' < /dev/null && pwd`), "echo 'a'");
  assert.equal(evalTextFull("no eval here"), undefined);
});

test("cleanShellOutput: a \\r-redrawn line keeps what it finally said, escapes dropped", () => {
  assert.equal(cleanShellOutput("10%\r50%\r100%\nok\r\n"), "100%\nok\n");
  assert.equal(cleanShellOutput("\x1b[32mgreen\x1b[0m done"), "green done");
  // a trailing \r is the end of a redraw, not an empty line
  assert.equal(cleanShellOutput("step 3/3\r"), "step 3/3");
});

test("evalText: unescapes both quote-escaping styles and caps at 240", () => {
  assert.equal(
    evalText(`/bin/zsh -c ... && eval 'echo hi' < /dev/null && pwd -P >| /tmp/x`),
    "echo hi",
  );
  // '\'' — a literal single quote escaped bash's own way
  assert.equal(
    evalText(`x && eval 'grep -qE "OK" '\\''report OK'\\''.log' < /dev/null && pwd`),
    "grep -qE \"OK\" 'report OK'.log",
  );
  // '"'"' — the other escaping style
  assert.equal(
    evalText(`x && eval 'echo '"'"'quoted'"'"'' < /dev/null && pwd`),
    "echo 'quoted'",
  );
  const long = "x".repeat(300);
  const capped = evalText(`x && eval '${long}' < /dev/null && pwd`);
  assert.equal(capped.length, 240);
  assert.ok(capped.endsWith("…"));
  // no eval boundary at all
  assert.equal(evalText("/bin/zsh -c plain"), undefined);
});

test("shellTranscriptFacts: joins a tool_use to its own tool_result by tool_use_id", () => {
  const lines = [
    { message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pytest -q", description: "Run tests", run_in_background: true } }] } },
    { message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Command running in background with ID: bxi729ipa. Output is being written to: /tmp/tasks/bxi729ipa.output." }] } },
    { message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "long build" } }] } },
    { message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "… was moved to the background (ID: bz7wblik1). Output is being written to: /tmp/tasks/bz7wblik1.output" }] } ] } },
    { message: { content: [{ type: "tool_result", tool_use_id: "unknown-id", content: "no match here" }] } },
  ];
  const tail = lines.map((l) => JSON.stringify(l)).join("\n");
  const facts = shellTranscriptFacts(tail);
  assert.equal(facts.length, 2);
  assert.deepEqual(facts[0], { command: "pytest -q", description: "Run tests", taskId: "bxi729ipa", launch: "background" });
  assert.deepEqual(facts[1], { command: "long build", description: undefined, taskId: "bz7wblik1", launch: "timeout" });
});

test("joinShellFact: whitespace-normalised equality, capped the same way both sides", () => {
  const facts = [{ command: "grep  -E  'x'   file.log", description: "search", taskId: "t9", launch: "background" }];
  assert.equal(joinShellFact("grep -E 'x' file.log", facts).taskId, "t9");
  assert.equal(joinShellFact("something else", facts), undefined);
});

test("trackCpu: first reading has no movedAt; a change stamps now; a repeat holds it", () => {
  const map = new Map();
  assert.equal(trackCpu(map, 1, 100, 1000), undefined);
  assert.equal(trackCpu(map, 1, 100, 2000), undefined); // unchanged
  assert.equal(trackCpu(map, 1, 150, 3000), 3000); // moved
  assert.equal(trackCpu(map, 1, 150, 4000), 3000); // unchanged again — movedAt holds
});

test("pruneCpuTrack: drops pids that are no longer live", () => {
  const map = new Map([[1, { cpuMs: 1 }], [2, { cpuMs: 2 }]]);
  pruneCpuTrack(map, new Set([1]));
  assert.deepEqual([...map.keys()], [1]);
});

test("foregroundWrapperPids: unjoined + status busy ⇒ foreground; status shell ⇒ every wrapper is a background survivor", () => {
  const rows = parsePsTable(PS_FIXTURE);
  // No claudeSessionId at all ⇒ no join is even attempted, same as readShellList.
  const busy = foregroundWrapperPids(CLI_PID, rows, "/repo", undefined, "busy");
  assert.deepEqual([...busy].sort(), [6001, 6002]);
  const idle = foregroundWrapperPids(CLI_PID, rows, "/repo", undefined, "shell");
  assert.deepEqual([...idle], []);
});

test("foregroundWrapperPids: a transcript join proves background even while the CLI still says busy", () => {
  const home = mkdtempSync(join(tmpdir(), "waterplane-shells-fg-"));
  process.env.WATERPLANE_CLAUDE_HOME = home;
  const cwd = "/Users/x/dev/myapp-shells-fg-fixture";
  const claudeSessionId = "fg-conv-id";
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(home, ".claude", "projects", slug);
  try {
    mkdirSync(dir, { recursive: true });
    const emuCmd = "~/Library/Android/sdk/emulator/emulator -avd obs_test -no-snapshot-load -no-audio -no-boot-anim > /tmp/emu.log 2>&1";
    const lines = [
      { message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: emuCmd, description: "boot the emulator" } }] } },
      { message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Command running in background with ID: emu1" }] } },
    ];
    writeFileSync(join(dir, `${claudeSessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const rows = parsePsTable(PS_FIXTURE);
    const busy = foregroundWrapperPids(CLI_PID, rows, cwd, claudeSessionId, "busy");
    // 6001 (the emulator) joined — proven background regardless of "busy".
    // 6002 (the wait loop) never joined — still foreground under "busy".
    assert.deepEqual([...busy], [6002]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("killShellGroup: refuses when the pid is already gone", async () => {
  const v = await killShellGroup(5000, 6001, Date.now() - 60_000, Date.now(), { rows: [] });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "that shell has already ended");
});

test("killShellGroup: refuses a ppid mismatch (pid no longer under this session)", async () => {
  const rows = [{ pid: 6001, ppid: 9999, pgid: 6001, etimeSec: 60, cpuMs: 0, command: "x" }];
  const v = await killShellGroup(5000, 6001, Date.now() - 60_000, Date.now(), { rows });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no longer under this session/);
});

test("killShellGroup: refuses pgid !== pid (not its own group leader)", async () => {
  const rows = [{ pid: 6001, ppid: 5000, pgid: 5000, etimeSec: 60, cpuMs: 0, command: "x" }];
  const v = await killShellGroup(5000, 6001, Date.now() - 60_000, Date.now(), { rows });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no longer under this session/);
});

test("killShellGroup: refuses a startedAt drift past 2s — a pid the OS recycled", async () => {
  const now = Date.now();
  const rows = [{ pid: 6001, ppid: 5000, pgid: 6001, etimeSec: 60, cpuMs: 0, command: "x" }];
  // The row's own startedAt is now - 60s; ask about a very different one.
  const v = await killShellGroup(5000, 6001, now - 500, now, { rows });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "that shell has already ended");
});

test("killShellGroup: SIGTERM alone stops it — ok:true, no SIGKILL sent", async () => {
  const now = Date.now();
  const rows = [{ pid: 6001, ppid: 5000, pgid: 6001, etimeSec: 60, cpuMs: 0, command: "x" }];
  const signals = [];
  const v = await killShellGroup(5000, 6001, now - 60_000, now, {
    rows,
    kill: (pid, sig) => signals.push([pid, sig]),
    sleep: async () => {},
    readPs: () => [], // gone by the time the survivor check runs
  });
  assert.equal(v.ok, true);
  assert.deepEqual(signals, [[-6001, "SIGTERM"]]);
});

test("killShellGroup: a survivor gets SIGKILL and a re-verify — ok:true once it is actually gone", async () => {
  const now = Date.now();
  const rows = [{ pid: 6001, ppid: 5000, pgid: 6001, etimeSec: 60, cpuMs: 0, command: "x" }];
  const survivor = [{ pid: 6001, ppid: 5000, pgid: 6001, etimeSec: 63, cpuMs: 0, command: "x" }];
  const signals = [];
  let reads = 0;
  const v = await killShellGroup(5000, 6001, now - 60_000, now, {
    rows,
    kill: (pid, sig) => signals.push([pid, sig]),
    sleep: async () => {},
    readPs: () => { reads++; return reads === 1 ? survivor : []; }, // alive after SIGTERM, gone after SIGKILL
  });
  assert.equal(v.ok, true);
  assert.deepEqual(signals, [[-6001, "SIGTERM"], [-6001, "SIGKILL"]]);
});

test("killShellGroup: still there after SIGKILL ⇒ ok:false 'did not stop', never a false ok:true", async () => {
  const now = Date.now();
  const rows = [{ pid: 6001, ppid: 5000, pgid: 6001, etimeSec: 60, cpuMs: 0, command: "x" }];
  const survivor = [{ pid: 6001, ppid: 5000, pgid: 6001, etimeSec: 63, cpuMs: 0, command: "x" }];
  const v = await killShellGroup(5000, 6001, now - 60_000, now, {
    rows,
    kill: () => {},
    sleep: async () => {},
    readPs: () => survivor, // still there, both times
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "that shell did not stop");
});

test("killShellGroup: re-checks ppid before SIGKILL — a pid recycled during the wait is not signalled", async () => {
  const now = Date.now();
  const rows = [{ pid: 6001, ppid: 5000, pgid: 6001, etimeSec: 60, cpuMs: 0, command: "x" }];
  // After SIGTERM, the wrapper's OWN pid row now belongs to an unrelated
  // process (a different ppid) that happens to share the old pgid.
  const recycled = [{ pid: 6001, ppid: 1, pgid: 6001, etimeSec: 0, cpuMs: 0, command: "unrelated" }];
  const signals = [];
  const v = await killShellGroup(5000, 6001, now - 60_000, now, {
    rows,
    kill: (pid, sig) => signals.push([pid, sig]),
    sleep: async () => {},
    readPs: () => recycled,
  });
  assert.deepEqual(signals, [[-6001, "SIGTERM"]], "no SIGKILL sent to a recycled pid");
  assert.equal(v.ok, false);
});

test("shellOutputStat: only fills in past 0 bytes — a 0-byte file is silence by design", () => {
  const home = mkdtempSync(join(tmpdir(), "waterplane-shells-home-"));
  const cwd = "/Users/x/dev/myapp-shells-fixture";
  const conv = "fixture-conv-id";
  const taskId = "task123";
  const uid = process.getuid ? process.getuid() : 0;
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join("/private/tmp", `claude-${uid}`, slug, conv, "tasks");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${taskId}.output`), "");
    assert.equal(shellOutputStat(cwd, conv, taskId), undefined);
    writeFileSync(join(dir, `${taskId}.output`), "some output\n");
    const st = shellOutputStat(cwd, conv, taskId);
    assert.ok(st);
    assert.equal(st.outputBytes, 12);
    assert.equal(shellOutputStat(cwd, conv, "no-such-task"), undefined);
  } finally {
    rmSync(join("/private/tmp", `claude-${uid}`, slug), { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
