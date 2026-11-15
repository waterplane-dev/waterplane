/**
 * The demo's skills-and-plugins screen and the one checklist row that opens it (`numbers.skills`,
 * scenario `skills-switch`). Fictional, small, and the same shapes the real host sends: a repo
 * report whose only check is `context-weight` (the row that carries the door), and an inventory
 * with a plugin, a personal skill and a locked one. Absent flag = the honest 404 the contract lists.
 */
import { addLocalDays } from "@waterplane/shared";
import type { ComplianceReport, SkillInventoryDoc, SkillRecommendResponse, SlowJob, SlowJobKind } from "@waterplane/shared";

export function demoCompliance(repoId: string, repoName: string): ComplianceReport {
  return {
    repoId, repoName, ok: true,
    checks: [{ id: "context-weight", label: "Agent context weight", status: "pass", detail: "CLAUDE.md is about 2k tokens.", fix: null }],
  };
}

export function demoSkills(repoId: string, now: number): SkillInventoryDoc {
  return {
    v: 1, at: now, repoId,
    layers: [
      { level: "global", path: "~/.claude/settings.json", rev: "absent", readable: true },
      { level: "repo-local", path: ".claude/settings.local.json", rev: "absent", readable: true },
      { level: "repo-shared", path: ".claude/settings.json", rev: "absent", readable: true },
    ],
    rows: [
      { kind: "plugin", id: "garden-tools@synced", name: "garden-tools", scope: "synced", set: {}, enabled: true, from: "default", skills: ["water-plan"], listingChars: 640 },
      { kind: "skill", id: "water-plan", source: "plugin", plugin: "garden-tools@synced", set: {}, effective: "on", from: "default", switchable: false, listingChars: 640 },
      { kind: "skill", id: "release-notes", source: "personal", set: {}, effective: "on", from: "default", switchable: true, listingChars: 420 },
      { kind: "skill", id: "tidy-imports", source: "project", set: {}, effective: "on", from: "default", switchable: true, listingChars: 180 },
    ],
    totals: { skillChars: 600, pluginChars: 640, unmeasured: 0 },
    usage: { state: "absent", why: "Uses are not counted in the demo.", since30: addLocalDays(now, -30) },
  };
}

/**
 * A slow job (`/api/repos/<id>/jobs/<kind>`) in the demo: nothing here is slow, so every start or
 * read answers a run already DONE with its result, and no `slowjob.state` frame is ever needed.
 * The suggestions are a model call on a real desktop, so the demo's run is a refusal in words.
 */
export function demoSlowJob(kind: SlowJobKind, repoId: string, repoName: string, now: number): SlowJob {
  const refused: SkillRecommendResponse = { ok: false, suggestions: [], dropped: 0, error: "Suggestions are one model call on a real desktop; the demo makes none." };
  const result = kind === "setup.check" ? demoCompliance(repoId, repoName) : kind === "skills.recommend" ? refused : demoSkills(repoId, now);
  return { id: `demo-${kind}-${repoId}`, key: `${kind}:${repoId}`, kind, repoId, state: "done", startedAt: now, finishedAt: now, result, hasResult: true };
}
