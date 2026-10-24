/**
 * Every feature, listed once. A static list, not a loader: nothing here is
 * lazily imported (the sheets are opened from a phone on a link that may be
 * gone, so they must already be in the bundle), and adding a feature is one
 * import and one entry below. Order is the order message handlers and boots
 * run in. `tools/webshape.test.mjs` checks every folder under `features/` is
 * listed exactly once and nothing listed is missing.
 *
 * The in-repo EXTENSIONS are the exception to "one import each": they are
 * GLOBBED (`import.meta.glob`, eager — still in the bundle, never lazy), every
 * `packages/extensions/<id>/web/index.ts` there is, in id order, after the core.
 * A folder, never a core edit: the public snapshot leaves the private ones out
 * (`deploy/public-allowlist.txt`) and this list must neither name nor miss them.
 *
 * Add a feature: docs/notes/web-architecture.md, "Adding a feature".
 */
import type { FeatureManifest } from "../sdk";
import { manifest as authGate } from "./authGate";
import { manifest as sentLog } from "./sentLog";
import { manifest as cliHealth } from "./cliHealth";
import { manifest as tokens } from "./tokens";
import { manifest as plugins } from "./plugins";
import { manifest as pull } from "./pull";
import { manifest as clipboard } from "./clipboard";
import { manifest as notifications } from "./notifications";
import { manifest as build } from "./build";
import { manifest as capture } from "./capture";
import { manifest as limits } from "./limits";
import { manifest as questions } from "./questions";
import { manifest as search } from "./search";
import { manifest as history } from "./history";
import { manifest as scrollback } from "./scrollback";
import { manifest as tools } from "./tools";
import { manifest as context } from "./context";
import { manifest as fanout } from "./fanout";
import { manifest as snippets } from "./snippets";
import { manifest as toolbarCfg } from "./toolbarCfg";
import { manifest as schedule } from "./schedule";
import { manifest as backlog } from "./backlog";
import { manifest as activity } from "./activity";
import { manifest as queue } from "./queue";
import { manifest as setup } from "./setup";
import { manifest as hostTools } from "./hostTools";
import { manifest as hosts } from "./hosts";
import { manifest as peers } from "./peers";
import { manifest as pad } from "./pad";
import { manifest as images } from "./images";
import { manifest as share } from "./share";
import { manifest as shells } from "./shells";
import { manifest as shellLogins } from "./shellLogins";
import { manifest as sessionBudget } from "./sessionBudget";
import { manifest as onboard } from "./onboard";
import { manifest as codeFolder } from "./codeFolder";
import { manifest as demoTour } from "./demoTour";
import { manifest as newSession } from "./newSession";
import { manifest as halt } from "./halt";
import { manifest as askRules } from "./askRules";
import { manifest as cliRestart } from "./cliRestart";

// In-repo EXTENSIONS (packages/extensions/<id>/web): the same contract, globbed, listed after the core.
const EXTENSION_MODULES = import.meta.glob<{ manifest: FeatureManifest }>("../../../extensions/*/web/index.ts", { eager: true });
const EXTENSIONS: FeatureManifest[] = Object.keys(EXTENSION_MODULES).sort().map((k) => EXTENSION_MODULES[k].manifest);

export const FEATURES: readonly FeatureManifest[] = [
  authGate,
  sentLog,
  cliHealth,
  tokens,
  plugins,
  pull,
  clipboard,
  notifications,
  build,
  capture,
  limits,
  questions,
  search,
  history,
  scrollback,
  tools,
  context,
  fanout,
  snippets,
  toolbarCfg,
  schedule,
  backlog,
  activity,
  queue,
  setup,
  hostTools,
  hosts,
  peers,
  pad,
  images,
  share,
  shells,
  shellLogins,
  sessionBudget,
  onboard,
  codeFolder,
  demoTour,
  newSession,
  halt,
  askRules,
  cliRestart,
  // extensions
  ...EXTENSIONS,
];
