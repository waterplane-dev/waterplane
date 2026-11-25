/**
 * The demo's opt-ins: one answer per offer in the shared catalog, the same for every demo repo. The
 * download one is on (the demo desktop has no rule to read, and an off card asks for it), the rest
 * are what a young Android repo would answer.
 */
import { OPT_INS, type OptInReport, type OptInRow } from "@waterplane/shared";

const ROWS: Record<string, Omit<OptInRow, "id">> = {
  "requirements": { relevant: true, state: "off", detail: "Neither .claude/skills/requirements/SKILL.md nor docs/requirements/.state.json exists." },
  "security-review": { relevant: true, state: "off", detail: "No recurring schedule in this repo carries the security-review marker." },
  "exposure-watch": { relevant: true, state: "off", detail: "This repo is not on the watch list." },
  "npm-supply-chain": { relevant: true, state: "off", detail: "package.json is here and no .npmrc sets a release age." },
  "local-ci": { relevant: true, state: "on", detail: "The git hooks directory contains a pre-push hook." },
  "links": { relevant: true, state: "off", detail: "The links extension is off on this desktop, so no links are kept." },
  "apk-download": { relevant: true, state: "on", detail: "This repo's download rule is on." },
  "apk-install": { relevant: true, state: "off", detail: "Off for {pkg}: a new build waits until you tap install." },
};

export function demoOptIns(repoId: string, repoName: string, now: number): OptInReport {
  const pkg = `app.${repoName.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  return {
    repoId, repoName, checkedAt: now,
    rows: OPT_INS.map((d) => {
      const r = ROWS[d.id] ?? { relevant: false, state: "off" as const, detail: "Does not fit the demo's repo." };
      return { id: d.id, ...r, detail: r.detail.replace("{pkg}", pkg) };
    }),
  };
}
