/** The Opt-ins region's seeds and words (`optInSeed.ts`). */
import test from "node:test";
import assert from "node:assert/strict";

import { optInMarker } from "@waterplane/shared";
import {
  declinedHead, noOffersWords, optInSeed, optInSentWords, optInWalkSeed, postableOptIns, startedHead, unfitHead, walkLabel,
  walkOffered,
} from "./optInSeed.ts";

const repo = { id: "r1", repoName: "myapp", worktreePath: "/dev/myapp" };
const row = (id) => ({ id, relevant: true, state: "off", detail: "" });

test("an agent offer is a new-session seed in this repo with its own words, no clock", () => {
  const s = optInSeed("local-ci", repo, "Europe/Berlin");
  assert.deepEqual(s.target, { kind: "repo", cwd: "/dev/myapp" });
  assert.equal(s.when, undefined);
  assert.equal(s.repoId, "r1");
  assert.equal(s.cwdHint, "/dev/myapp");
  assert.equal(s.prompts.length, 1);
  assert.match(s.prompts[0], /myapp/);
  assert.ok(s.prompts[0].endsWith(optInMarker("local-ci")));
  assert.equal(s.origin, "From myapp's opt-ins — Checks before every push");
});

test("a schedule offer carries the weekly rule in the phone's zone, the model and waitUntilFree", () => {
  const s = optInSeed("security-review", repo, "America/New_York");
  assert.deepEqual(s.target, { kind: "repo", cwd: "/dev/myapp", launch: { model: "fable" } });
  assert.deepEqual(s.when, {
    kind: "at",
    rule: { kind: "weekly", days: [1], hour: 9, minute: 0, tz: "America/New_York" },
    graceMin: 720,
    name: "Weekly security review",
    waitUntilFree: true,
  });
  assert.ok(s.prompts[0].endsWith(optInMarker("security-review")));
});

test("an empty zone falls back to UTC rather than a rule with no zone", () => {
  assert.equal(optInSeed("security-review", repo, "").when.rule.tz, "UTC");
});

test("fix/open offers and unknown ids seed nothing", () => {
  assert.equal(optInSeed("requirements", repo, "UTC"), null);
  assert.equal(optInSeed("repo-health", repo, "UTC"), null);
  assert.equal(optInSeed("no-such-offer", repo, "UTC"), null);
});

test("the walk-through is offered only with two postable offers, and N counts every card", () => {
  const offered = [row("requirements"), row("local-ci"), row("screenshots")];
  assert.equal(postableOptIns(offered).length, 1);
  assert.equal(walkOffered(offered), false);
  const more = [...offered, row("npm-supply-chain")];
  assert.equal(walkOffered(more), true);
  assert.equal(walkLabel(more.length), "walk me through these 4…");
  const s = optInWalkSeed(more, repo);
  assert.deepEqual(s.target, { kind: "repo", cwd: "/dev/myapp" });
  assert.equal(s.when, undefined);
  assert.match(s.prompts[0], /Do NOT set any of them up/);
  assert.equal(optInWalkSeed([], repo), null);
});

test("folded heads and the empty sentence", () => {
  assert.equal(declinedHead(2), "2 you said not for me");
  assert.equal(unfitHead(1), "1 doesn't fit this repo");
  assert.equal(unfitHead(3), "3 don't fit this repo");
  assert.doesNotMatch(noOffersWords(0, 0), /folded/);
  assert.match(noOffersWords(1, 0), /folded below/);
});

test("a sent offer says when and what became of it, one sentence per status", () => {
  const day = () => "24 Oct";
  const words = (status) => optInSentWords({ at: 1, status }, day);
  assert.equal(words("waiting"), "Sent 24 Oct — waiting in this repo's backlog.");
  assert.equal(words("open"), "Sent 24 Oct to a session that is still open.");
  assert.match(words("ended"), /session has closed, and it is not set up yet/);
  const all = ["waiting", "running", "done", "failed", "canceled", "open", "ended"].map(words);
  assert.equal(new Set(all).size, all.length, "every status reads differently");
  assert.equal(startedHead(2), "Started here · 2");
});

import { optInSentWords as sentWordsOf } from "./optInSeed.ts";

test("optInSentWords words a status this build does not know", () => {
  // `OptInSent.status` is the host's; a newer host's word reached this switch
  // with no case and printed "undefined".
  const text = sentWordsOf({ status: "someFutureStatus", at: 0 }, () => "24 Oct");
  assert.equal(typeof text, "string");
  assert.doesNotMatch(text, /undefined/);
  assert.match(text, /^Sent 24 Oct/);
});
