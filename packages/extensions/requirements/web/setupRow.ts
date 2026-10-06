/**
 * The words of the requirements row in every repo's setup checklist. The row itself is contributed by
 * the host half (`host/index.mts`, `api.setupCheck`/`setupFix`); this is how the phone talks about it.
 * They lived in the core's `setupRemedy.ts` until the row became the extension's to describe — pinned
 * byte for byte by `setupRow.test.mjs`.
 */
import type { SetupRowDef } from "@waterplane/sdk";
import { REQ_UPDATE_GUIDANCE } from "../shared/methods.mts";

export const REQUIREMENTS_ROW: SetupRowDef = {
  check: "requirements",
  fix: "requirements",
  fixVerb: "set up",
  agentVerb: "update the list in this repo",
  guidance: REQ_UPDATE_GUIDANCE,
};
