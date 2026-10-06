/**
 * The requirements extension's web half: the setup row's words, the list sheet and the line in a
 * repo's menu — no chip on the repo row, which only said the menu line's count a second time.
 * Imports only `@waterplane/sdk`, `@waterplane/kit`, `@waterplane/shared`, react, lucide-react and
 * its own folder.
 *
 * Two doors to the same update: the sheet's `update` button and the setup row's hand-to-agent button
 * (`agent: handUpdate`). Both add a backlog row that WAITS for a tap — nothing here fires a model call.
 */
import { createElement } from "react";
import { ListChecks } from "lucide-react";
import type { RepoTarget } from "@waterplane/shared";
import { featureSheetId, type FeatureManifest } from "@waterplane/sdk";
import type { ReqCut } from "./cut.ts";
import { ensureSummary, handUpdate, openRequirements, summaries } from "./data.ts";
import { RequirementsSheet } from "./RequirementsSheet.tsx";
import { REQUIREMENTS_ROW } from "./setupRow.ts";

/** The menu line, with the requested count once known (`ensureSummary` is TTL-guarded, so asking per render is free). */
function menuLabel(repo: RepoTarget): string {
  void ensureSummary(repo);
  const r = summaries.get().get(repo.id)?.res;
  if (!r?.ok) return "requirements";
  if (!r.result.setUp) return "requirements — not set up";
  return `requirements · ${r.result.requested} requested`;
}

/** A count on the line is a filter: "131 requested" opens exactly those, the sheet says "n of N — clear". */
function requestedCut(repo: RepoTarget): ReqCut | undefined {
  const r = summaries.get().get(repo.id)?.res;
  return r?.ok && r.result.setUp && r.result.requested > 0 ? { status: "requested", area: null } : undefined;
}

export const manifest: FeatureManifest = {
  id: "requirements",
  setupRows: [{ ...REQUIREMENTS_ROW, agent: (repo) => { void handUpdate(repo); } }],
  // The literal form (`tools/webshape.test.mjs` reads it); `data.ts` opens the same id as REQ_SHEET.
  sheets: [{ id: featureSheetId("requirements", "list"), persisted: false, render: () => createElement(RequirementsSheet) }],
  // Never null and never disabled: a menu tap only opens the sheet, which says what is missing. It writes no files.
  repoActions: [{ id: "list", icon: ListChecks, label: (r) => menuLabel(r), run: (r) => openRequirements(r, requestedCut(r)) }],
};
