/**
 * The first-app journey's pure half (`features/onboard/logic.ts`).
 *
 *     node --test packages/web/src/features/onboard/logic.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  NAME_WORDS, BROWSER_CANT_INSTALL, aboutBytes, answersFrom, artifactFile, checklist, clockText, consentRows, consentToSend,
  defaultPath, existingReposLine, firstRunCard, fixLabel, neverRanSession, goBlocker, handOff, initialTicks, plannedSteps, progressHead, questionsBlocker,
  suggestName, withAllowed,
} from "./logic.ts";

const facts = (over = {}) => ({ online: true, sessions: 0, recent: 0, closed: 0, job: null, dismissed: false, demo: false, ...over });
const job = (over = {}) => ({
  id: "onb_1", state: "running", answers: { name: "hello-otter", path: "web", setup: true },
  consent: { repo: true, session: true }, name: "hello-otter", folder: "/r/hello-otter",
  steps: [], suggestedPrompt: "make the button count taps", summary: "building", createdAt: 0, updatedAt: 1, ...over,
});

test("the first-run card: only a host that never opened a session, online, outside the demo", () => {
  assert.equal(firstRunCard(facts()), "first-run");
  assert.equal(firstRunCard(facts({ sessions: 1 })), "none");
  assert.equal(neverRanSession({ sessions: 0, recent: 0, closed: 0 }), true);
  assert.equal(neverRanSession({ sessions: 0, recent: 0, closed: 1 }), false);
  assert.equal(firstRunCard(facts({ recent: 3 })), "none", "a recent conversation means a session was opened");
  assert.equal(firstRunCard(facts({ closed: 1 })), "none");
  assert.equal(firstRunCard(facts({ online: false })), "none", "every verb on it needs the desktop");
  assert.equal(firstRunCard(facts({ dismissed: true })), "none");
  assert.equal(firstRunCard(facts({ demo: true })), "none");
  assert.equal(firstRunCard(facts({ job: undefined })), "first-run", "not read yet is not a job");
});

test("a running or stopped job owns the card whatever else is open; a finished one does not", () => {
  assert.equal(firstRunCard(facts({ sessions: 4, job: job() })), "job");
  assert.equal(firstRunCard(facts({ sessions: 4, dismissed: true, job: job({ state: "stopped" }) })), "job");
  assert.equal(firstRunCard(facts({ sessions: 4, job: job({ state: "done" }) })), "none");
  assert.equal(firstRunCard(facts({ job: job({ state: "done" }) })), "first-run");
  assert.equal(firstRunCard(facts({ demo: true, job: job() })), "none");
});

test("the name is hello-<word>, every word a valid folder and package segment", () => {
  assert.equal(suggestName(() => 0), `hello-${NAME_WORDS[0]}`);
  assert.equal(suggestName(() => 0.9999), `hello-${NAME_WORDS[NAME_WORDS.length - 1]}`);
  for (const w of NAME_WORDS) assert.match(`hello-${w}`, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  assert.ok(`hello-${NAME_WORDS.reduce((a, b) => (a.length > b.length ? a : b))}`.length <= 40);
});

test("Android is preselected only where this phone installs apps", () => {
  assert.equal(defaultPath(true), "android");
  assert.equal(defaultPath(false), "web");
});

test("answers: a plain hello world sends no description; Next says what is missing instead of greying", () => {
  assert.deepEqual(answersFrom({ name: " x ", path: "web", describe: false, description: "ignored", setup: true }), { name: "x", path: "web", setup: true });
  assert.deepEqual(answersFrom({ name: "x", path: "android", describe: true, description: " a timer ", setup: false }),
    { name: "x", path: "android", description: "a timer", setup: false });
  assert.match(questionsBlocker({ name: " ", describe: false, description: "" }), /name/);
  assert.match(questionsBlocker({ name: "x", describe: true, description: "" }), /one line/);
  assert.equal(questionsBlocker({ name: "x", describe: false, description: "" }), null);
});

const plan = {
  ok: true, path: "android", name: "hello-otter", folder: "/r/hello-otter", packageId: "dev.waterplane.app.hellootter",
  steps: [
    { id: "probe", needed: true, what: "Look" }, { id: "toolchain", needed: true, what: "Install" },
    { id: "scaffold", needed: true, what: "Create" }, { id: "setup", needed: false, what: "Setup: off" },
  ],
  consent: [
    { id: "repo", what: "Create /r/hello-otter", where: "/r/hello-otter", required: true },
    { id: "toolchain", what: "Install a JDK", where: "~/Library/Android/sdk", bytes: 520 * 1048576, link: "https://developer.android.com/studio/terms", required: true },
    { id: "installApps", what: "Let this phone install", required: false, phone: true },
    { id: "session", what: "Run claude", where: "/r/hello-otter", required: false },
  ],
  suggestedPrompt: "x",
};

test("consent rows are exactly the plan's lines, with size and licence; a browser cannot take the install line", () => {
  const rows = consentRows(plan, true);
  assert.deepEqual(rows.map((r) => r.id), ["repo", "toolchain", "installApps", "session"]);
  assert.equal(rows[1].size, "about 520 MB to download");
  assert.equal(rows[0].where, undefined, "a folder the sentence already names is not said twice");
  assert.equal(rows[1].where, "~/Library/Android/sdk");
  assert.equal(rows[1].link, "https://developer.android.com/studio/terms");
  assert.equal(rows[2].cant, undefined);
  const browser = consentRows(plan, false);
  assert.equal(browser[2].cant, BROWSER_CANT_INSTALL);
  assert.deepEqual(initialTicks(browser), { repo: true, toolchain: true, session: true }, "a line the phone cannot act on starts unticked");
  assert.equal(aboutBytes(2.5 * 1024 * 1048576), "about 2.5 GB to download");
  assert.equal(aboutBytes(0), undefined);
  assert.equal(aboutBytes(undefined), undefined);
});

test("Go sends only ticks of lines shown, and is replaced by a sentence while a needed line is unticked", () => {
  const rows = consentRows({ ...plan, consent: plan.consent.filter((l) => l.id !== "toolchain") }, true);
  const sent = consentToSend(rows, { repo: true, toolchain: true, signingKey: true, session: false, installApps: true });
  assert.deepEqual(sent, { repo: true, installApps: true }, "toolchain and signingKey were not on screen");
  assert.equal(goBlocker(rows, { repo: true }), null, "optional lines may be unticked");
  assert.match(goBlocker(rows, {}), /needed/);
  const full = consentRows(plan, true);
  assert.match(goBlocker(full, { repo: true }), /web page needs nothing installed/);
  assert.deepEqual(plannedSteps(plan), ["Look", "Install", "Create"]);
});

test("the checklist: host words, icons per status, a clock on the running step, a fix on a stopped one", () => {
  const j = job({
    state: "stopped",
    steps: [
      { id: "scaffold", status: "done", what: "Create", startedAt: 0, endedAt: 2500 },
      { id: "setup", status: "skipped", what: "Setup", note: "you turned it off" },
      { id: "toolchain", status: "needs-you", what: "Install", note: "cannot create", command: "sudo mkdir -p /x" },
      { id: "build", status: "running", what: "First build, about 5 minutes", startedAt: 1000 },
      { id: "session", status: "needs-consent", what: "Open" },
      { id: "signing-key", status: "failed", what: "Key", command: "keytool …" },
      { id: "probe", status: "pending", what: "Look" },
    ],
  });
  const rows = checklist(j, 66_000);
  assert.deepEqual(rows.map((r) => r.icon), ["done", "skipped", "stopped", "running", "stopped", "stopped", "pending"]);
  assert.equal(rows[0].clock, "0:02");
  assert.equal(rows[3].clock, "1:05");
  assert.equal(rows[3].what, "First build, about 5 minutes", "the estimate is the host's words, shown as is");
  assert.deepEqual(rows[2].fix, { verb: "retry" });
  assert.equal(rows[2].command, "sudo mkdir -p /x");
  assert.deepEqual(rows[4].fix, { verb: "allow", consent: "session" });
  assert.equal(rows[4].command, undefined);
  assert.equal(rows[1].note, "you turned it off");
  assert.equal(fixLabel({ verb: "retry" }, "needs-you"), "I ran it — carry on");
  assert.equal(fixLabel({ verb: "retry" }, "failed"), "retry");
  assert.equal(fixLabel({ verb: "allow", consent: "session" }, "needs-consent"), "allow it and carry on");
  assert.equal(clockText(3_723_000), "1:02:03");
  assert.match(progressHead(j), /^Stopped: /);
  assert.equal(progressHead(job({ state: "done" })), "hello-otter is ready.");
  assert.equal(progressHead(job({ summary: "starting" })), "Making hello-otter…");
});

test("hand-off: attach with the suggested prompt once, never over a description, follow an opening intent", () => {
  const done = job({ state: "done", sessionId: "s1" });
  assert.deepEqual(handOff(done, new Set(["s1"]), false), { kind: "attach", sessionId: "s1", seed: "make the button count taps" });
  assert.deepEqual(handOff(done, new Set(["s1"]), true), { kind: "attach", sessionId: "s1", seed: null }, "a second tap appends nothing");
  const described = job({ state: "done", sessionId: "s1", answers: { name: "x", path: "web", description: "a timer" } });
  assert.equal(handOff(described, new Set(["s1"]), false).seed, null, "the description already went in as the first prompt");
  assert.equal(handOff(done, new Set(), false).kind, "wait");
  assert.deepEqual(handOff(job({ state: "done", intentId: "onb_1-session" }), new Set(), false), { kind: "follow", intentId: "onb_1-session" });
  assert.equal(handOff(job({ consent: { repo: true }, sessionId: "s1" }), new Set(["s1"]), false).kind, "none");
});

test("the install allow-list is only ever ADDED to", () => {
  assert.deepEqual(withAllowed(["a"], "b"), ["a", "b"]);
  assert.deepEqual(withAllowed(["a", "b"], "b"), ["a", "b"]);
  assert.deepEqual(withAllowed(["a"], undefined), ["a"]);
});

test("the artifact is a gallery file of the new repo", () => {
  assert.deepEqual(artifactFile(job({ repoId: "r1", artifact: ".claude/outbox/hello-otter.html" })),
    { repoId: "r1", relPath: ".claude/outbox/hello-otter.html", name: "hello-otter.html" });
  assert.equal(artifactFile(job({ artifact: "x.apk" })), null, "no repo id, nothing to open");
});

test("existingReposLine: repos listed below are pointed at in words, with their count; none means no line", () => {
  assert.equal(existingReposLine(0), null);
  assert.equal(existingReposLine(1), "Or tap + now on one of your 1 repo below to open a session in it.");
  assert.match(existingReposLine(34), /34 repos below/);
});