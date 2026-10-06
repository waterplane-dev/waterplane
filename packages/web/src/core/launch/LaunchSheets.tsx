/**
 * The launch core's sheets, as `overlayViews` entries (`launch.sheets`):
 * `launchask` and `hostedack` finish a tap `askLaunchFirst` deferred,
 * `new` and `branches` start one, `model` is `ModelSheet.tsx`.
 *
 * Each entry is a thunk App spreads into its overlay table, so the ids stay
 * exactly the ones `routing.ts` knows; a missing subject returns null and the
 * table falls through to the screen underneath, as before.
 */
import type { ReactNode } from "react";
import type { BackendInfo, LaunchOpts, RepoTarget, SessionBudget, SessionInfo } from "@waterplane/shared";
import { NewMenu } from "../../NewMenu.tsx";
import { BranchPicker } from "../../BranchPicker.tsx";
import { LaunchAskSheet } from "../../LaunchAskSheet.tsx";
import { HostedAckSheet } from "../../HostedAckSheet.tsx";
import { writeHostedAck } from "../../hostedAck.ts";
import { agentBackends, showBackendPicker, type hasCap, type capReason } from "../../backendCaps.ts";
import type { Overlay } from "../../routing.ts";
import { ModelSheet } from "./ModelSheet.tsx";
import { openOnboard } from "../../features/onboard";

/** What the launch question answered about the budget: a cap, or `null` for "asked, and none".
 *  `undefined` is "nobody asked", where the caller's own budget stands. */
export type AskedBudget = SessionBudget | null;
type LaunchAskFor = { title: string; run: (launch: LaunchOpts, budget?: AskedBudget) => void; onCancel?: () => void; budget?: SessionBudget } | null;
type HostedAskFor = { title: string; launch: LaunchOpts; run: (launch: LaunchOpts, budget?: AskedBudget) => void; onCancel?: () => void; budget?: AskedBudget } | null;

export interface LaunchSheetCtx {
  backends: BackendInfo[] | null;
  launch: LaunchOpts;
  root: string;
  repos: RepoTarget[];
  active: SessionInfo | null | undefined;
  launchAskFor: LaunchAskFor;
  setLaunchAskFor(v: LaunchAskFor): void;
  hostedAskFor: HostedAskFor;
  setHostedAskFor(v: HostedAskFor): void;
  branchPick: RepoTarget | null;
  setBranchPick(v: RepoTarget | null): void;
  modelInput: string;
  setModelInput(v: string): void;
  setOverlay(o: Overlay): void;
  submitInput(id: string, cwd: string, text: string, kind: "prompt" | "command", holdUntilIdle?: boolean): boolean;
  refreshRepos(): void;
  openCwd(cwd: string, title: string): void;
  pickBackend(id: string | undefined): void;
  setLaunchOpt(patch: Partial<LaunchOpts>): void;
  relaunch(s: SessionInfo, patch: Partial<LaunchOpts>): void;
  sessionCan(s: { backend?: string } | null | undefined, cap: Parameters<typeof hasCap>[2]): boolean;
  sessionCant(s: { backend?: string } | null | undefined, cap: Parameters<typeof capReason>[2]): string | null;
  /** Ask the host to look again at the backends that said unavailable. */
  recheckBackends(): void;
}

export type LaunchSheets = Record<"branches" | "new" | "launchask" | "hostedack" | "model", () => ReactNode>;

export function launchSheets(c: LaunchSheetCtx): LaunchSheets {
  const { backends, launch, setOverlay } = c;
  return {
    branches: () => {
      if (!(c.branchPick)) return null;
      return <BranchPicker primary={c.branchPick} targets={c.repos}
        onClose={() => { setOverlay(null); c.setBranchPick(null); }}
        onOpen={(cwd, title) => { setOverlay(null); c.setBranchPick(null); c.openCwd(cwd, title); }} />;
    },

    new: () => {
      // The backend picker rides along ONLY where there is a choice to make:
      // `showBackendPicker` is false on a host that never described one, and
      // then this sheet renders exactly what it always did.
      return <NewMenu root={c.root} repos={c.repos} onClose={() => setOverlay(null)} onChanged={c.refreshRepos} onOpen={c.openCwd}
        backends={showBackendPicker(backends) ? [...agentBackends(backends)!] : undefined}
        backend={launch.backend}
        onBackend={c.pickBackend}
        onBuildApp={openOnboard} />;
    },

    launchask: () => {
      // Scoped to a pending open held in memory, so a route that arrives
      // without one paints nothing rather than a Start button with nothing to
      // start (`routing.ts` keeps this overlay out of the URL for that reason).
      if (!c.launchAskFor) return null;
      const target = c.launchAskFor;
      return <LaunchAskSheet title={target.title} backends={backends} defaults={launch} budget={target.budget} onRecheck={c.recheckBackends}
        onStart={(l, b) => {
          // Cleared BEFORE the tap is resumed: `run` re-enters the very function
          // that posed the question, and it asks again unless the answer is
          // already in hand — which it is, as the override it is handed.
          c.setLaunchAskFor(null);
          setOverlay(null);
          target.run(l, b);
        }}
        // A dismissal is not a no-op: the tap that posed this question had
        // already been handed the words (see `onCancel` on `launchAskFor`), so
        // whoever was holding them gets them back before the sheet goes.
        onClose={() => { c.setLaunchAskFor(null); setOverlay(null); target.onCancel?.(); }} />;
    },

    hostedack: () => {
      // Same scoping rule as `launchask`, and `routing.ts` keeps this one out of
      // the URL for the same reason plus one: it is a consent sheet standing in
      // front of a `session.create`, and a reload is an answer of "not now".
      if (!c.hostedAskFor) return null;
      const target = c.hostedAskFor;
      return <HostedAckSheet title={target.title} backends={backends} launch={target.launch}
        onAccept={() => {
          // Written BEFORE the tap is resumed. `run` re-enters the very
          // function that posed the question for two of the three start sites,
          // and it would ask a second time for the same tap unless the record
          // is already on disk.
          writeHostedAck();
          c.setHostedAskFor(null);
          setOverlay(null);
          target.run(target.launch, target.budget);
        }}
        // Same as `launchask`: declining the notice must hand the words back
        // to the sheet that was holding them, never drop them.
        onClose={() => { c.setHostedAskFor(null); setOverlay(null); target.onCancel?.(); }} />;
    },

    model: () => {
      if (!(c.active)) return null;
      return <ModelSheet cur={c.active} backends={backends}
        modelInput={c.modelInput} setModelInput={c.setModelInput}
        submitInput={c.submitInput} setLaunchOpt={c.setLaunchOpt} relaunch={c.relaunch}
        sessionCan={c.sessionCan} sessionCant={c.sessionCant}
        onClose={() => setOverlay(null)} />;
    },
  };
}
