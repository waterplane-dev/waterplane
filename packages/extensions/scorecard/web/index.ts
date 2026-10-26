/**
 * The scorecard extension's web half: the sheet, a `score n` chip on a repo with failing checks, the
 * setup row's hand-to-agent button, and the host's one push (`changed` → read again). Imports only
 * `@waterplane/sdk`, `@waterplane/kit`, `@waterplane/shared`, react, lucide-react and its own folder
 * (`local/extension-boundary`). Contract: `shared/wire.mts`.
 *
 * A count is a filter: the chip's n is `openChecks`, and its tap opens the sheet cut to those same
 * checks. The setup row's button opens that cut too — no model call anywhere on this side.
 */
import { createElement, useEffect } from "react";
import { ShieldCheck } from "lucide-react";
import type { RepoTarget } from "@waterplane/shared";
import { featureSheetId, useConnStatus, useStore, type FeatureManifest } from "@waterplane/sdk";
import { CHECK_ID, PUSH_CHANGED } from "../shared/wire.mts";
import { ScorecardSheet } from "./ScorecardSheet.tsx";
import { scoreChip, type ScoreCut } from "./logic.ts";
import { ensureRead, onChanged, openScorecard, views } from "./state.ts";

const cutFor = (repo: RepoTarget): ScoreCut => ({ repo: repo.id });

export const manifest: FeatureManifest = {
  id: "scorecard",
  // The literal form (`tools/webshape.test.mjs` reads it); `state.ts` opens the same id as SCORE_SHEET.
  sheets: [{ id: featureSheetId("scorecard", "main"), persisted: false, render: () => createElement(ScorecardSheet) }],
  pushes: { [PUSH_CHANGED]: (data) => onChanged(data) },
  setupRows: [{ check: CHECK_ID, agentVerb: "see the failing checks",
    guidance: "Close the failing OpenSSF Scorecard checks the sheet lists for this repo, one at a time, starting with the lowest score. Where a check cannot pass for a solo maintainer, say why and propose accepting it with a reason; change nothing you were not asked to.", agent: (repo) => openScorecard(repo, cutFor(repo)) }],
  repoChips: [{
    id: "scorecard",
    icon: ShieldCheck,
    useCount(repo) {
      const m = useStore(views);
      const status = useConnStatus();
      const read = m.get(repo.id);
      // The stamp is a dep: a push that zeroes it makes this chip read again.
      const stamp = read?.at ?? null;
      useEffect(() => { if (status === "open") void ensureRead(repo); }, [status, repo, stamp]);
      const c = scoreChip(read?.view);
      return c ? { ...c, filter: cutFor(repo) } : null;
    },
    open: (repo, filter: ScoreCut) => openScorecard(repo, filter),
  }],
};
