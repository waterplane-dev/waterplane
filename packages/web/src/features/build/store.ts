/**
 * What the build feature holds, and every writer of it.
 *
 * Moved out of `App.tsx`, where it was nine `useState`s, a ref, a tick and a
 * ref-mirror. **One writer per store**: `actions.ts`, which the wire handlers in
 * `index.ts` and the sheet call — the sheet itself only reads (`useStore`).
 *
 * The per-repo command list is seeded from the device cache, not empty: the
 * build sheet is what you open when the link is bad, and an empty list there
 * is a false claim ("no build commands yet") that talks you into spending
 * tokens defining them again. `builds.cfgs.at` says when the host last
 * confirmed each repo's list — a cached list that cannot say how old it is
 * reads as current. (`scripts/e2e-offlinelists.mjs` holds both.)
 */
import type { ArtifactPolicy, BuildCandidate, BuildConfig, BuildRun, RepoTarget } from "@waterplane/shared";
import { useCallback } from "react";
import { createStore, repoRunStore, useStore } from "../../sdk";
import { loadBuildsSnap, saveBuildsSnap } from "../../localState";
import { buildBusyIn, buildNameIn } from "./logic";

/** Per repo: the ids living in this desktop's own file (`build.list.localIds`).
 *  A repo with no entry, or an entry of `undefined`, is an older host: nothing
 *  is attributed and `build.save` sends no `local`. Not cached to disk. */
export const buildLocalIds = createStore<ReadonlyMap<string, string[] | undefined>>(new Map());

export const builds = repoRunStore<BuildConfig, BuildRun>({ load: loadBuildsSnap, save: saveBuildsSnap });

/** The repo whose BuildSheet is open (and which a reconnect re-asks for). Never
 *  cleared — App never cleared `buildRepo` either; the overlay is what closes. */
export const buildRepo = createStore<RepoTarget | null>(null);

/**
 * What each repo can already build, read off its own manifests (`build.scan`).
 *
 * Deliberately NOT cached to disk like the command list is. That cache exists
 * because an empty build list is a CLAIM a phone must not make with the link
 * down; this list is a convenience while TYPING a new command, which needs the
 * desktop anyway (`build.save` is live-only), so a stale copy would buy
 * nothing and could offer a script the repo dropped last week.
 *
 * A missing entry means "nobody has asked yet", which the editor words
 * differently from an empty array — the repo describing no build at all is a
 * real answer and reads as one.
 */
export const buildCands = createStore<ReadonlyMap<string, { list: BuildCandidate[]; total: number }>>(new Map());

export type ParamOptions = Record<string, Record<string, { options?: string[]; total?: number; error?: string }>>;
/**
 * What a parameterised build's questions may be answered with, keyed
 * `repoDir` → `buildId` → `paramId` (`build.options`).
 *
 * Not cached to disk, `buildCands`' reasoning exactly, plus one of its own:
 * these rows come from RUNNING a listing command on the desktop, and a
 * remembered list of a monorepo's apps is stale the week somebody adds one.
 * A missing entry means nobody has asked yet, and the form words that
 * differently from a command that answered nothing.
 */
export const buildOpts = createStore<ReadonlyMap<string, ParamOptions>>(new Map());

/** What each repo does with what its builds PRODUCE (`artifacts.config`).
 *  Absent means never asked or never answered — the Build sheet says nothing
 *  rather than drawing a default that may not be this repo's. */
export const artifactPolicies = createStore<ReadonlyMap<string, ArtifactPolicy>>(new Map());

/** A build's display name by id, off the cached lists as they are NOW — for a
 *  TAP (App's `shell` intent). Something RENDERED from it uses `useBuildNames`,
 *  or a list that lands later never repaints the name. */
export function buildNameOf(cwd: string, id: string): string {
  return buildNameIn(builds.cfgs.get().lists, cwd, id);
}

/** `buildNameOf`, subscribed: a new function whenever the lists move, so the
 *  Send sheet's `buildName` prop re-renders on a `build.list` frame. */
export function useBuildNames(): (cwd: string, id: string) => string {
  const { lists } = useStore(builds.cfgs);
  return useCallback((cwd: string, id: string) => buildNameIn(lists, cwd, id), [lists]);
}

/** `buildBusyIn`, subscribed to the runs — the launcher's hammer spinner. */
export function useBuildBusy(repo: Pick<RepoTarget, "worktreePath" | "buildRunning">): { name: string } | null {
  return buildBusyIn(useStore(builds.runs), repo);
}
