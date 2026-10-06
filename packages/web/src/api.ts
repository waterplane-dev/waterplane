import { isOffline } from "@waterplane/shared";
import { sessionsApi } from "./webapi/webapiSessions";
import { statsApi } from "./webapi/webapiStats";
import { filesApi } from "./webapi/webapiFiles";
import { reposApi } from "./webapi/webapiRepos";
import { gitApi } from "./webapi/webapiGit";
import { treeApi } from "./webapi/webapiTree";
import { repoOpsApi } from "./webapi/webapiRepoOps";
import { hostApi } from "./webapi/webapiHost";
import { netApi } from "./webapi/webapiNet";

/** Re-exported so call sites keep importing their network helpers from one
 *  place; the rules themselves live in `shared/netfuse.ts`. */
export { isOffline };
export { bgFetch, bgJson } from "./webapi/webapiBg";
export { copyText } from "./webapi/webapiClipboard";
export * from "./webapi/webapiTypes";

/**
 * The HTTP client: one object, assembled from the slices in `webapi/`
 * (docs/notes/webclient-architecture.md). Keep every `/api/...` URL a literal
 * call argument inside its slice — `demo/contract.test.mjs` reads them off the AST.
 */
export const api = {
  ...sessionsApi,
  ...statsApi,
  ...filesApi,
  ...reposApi,
  ...gitApi,
  ...treeApi,
  ...repoOpsApi,
  ...hostApi,
  ...netApi,
};
