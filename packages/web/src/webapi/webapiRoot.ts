import type { RootInfo, RootPostReply } from "@waterplane/shared";
import { jget, jpost } from "./webapiFetch";
import { askRulesApi } from "./webapiAskRules";

/**
 * The code folder the host scans (`features/codeFolder`). A check names the folder and its repo
 * count; a save also says how it takes effect. A refusal (403 not from here, 409 the variable names
 * it) is a JSON `{ ok: false, error }` with the sentence ready, so `jpost` — which does not throw
 * on it — fits. One slice of `api` (see api.ts).
 */
export const rootApi = {
  ...askRulesApi,
  rootInfo: () => jget<RootInfo>("/api/host/root"),
  checkRoot: (path: string) => jpost<RootPostReply>("/api/host/root", { path }),
  saveRoot: (path: string) => jpost<RootPostReply>("/api/host/root", { path, save: true }),
};
