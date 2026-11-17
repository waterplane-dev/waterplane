/** The Setup check's wire answers, as the phone reads them (`GET /api/setupcheck`, `…/efficiencyrules`). */
import type { Finding, NotChecked, PassedCheck, Rollup } from "@waterplane/shared";

/** `GET /api/setupcheck`: the engine's three lists, what a source could not be read for, and when. */
export interface SetupCheckResponse {
  findings: Finding[];
  passed: PassedCheck[];
  notChecked: NotChecked[];
  absent: { what: string; why: string }[];
  at: number;
  /** A first sweep that outlasted the host's wait: nothing is known yet. */
  pending?: boolean;
}

/** `GET /api/repos/:id/efficiencyrules`. */
export interface EfficiencyRulesState {
  version: number;
  block: string;
  suggested: string;
  present: boolean;
  targets: { target: string; exists: boolean; plan: "append" | "upToDate" | "replace" | "refuse"; why?: string; sha: string }[];
  /** One-shot token for the POST, only when a target would change. */
  confirm?: string;
}

export type EfficiencyWriteAnswer =
  | { ok: true; written: boolean; plan: string; created?: boolean }
  | { ok: false; code?: string; error: string };

/** `GET /api/setupcheck/repos`: the all-repos roll-up. Doors only: no remedy and no evidence route rides it. */
export interface AllReposResponse {
  rollup: Rollup;
  /** What "this machine · N" says; absent when no repo's check has answered yet. */
  machine: { count?: number };
  /** Repos checked so far, of the repos in the overview. */
  done: number;
  total: number;
  pending?: boolean;
  /** Repos the phone hides from its launcher: left out and said once. */
  hidden: number;
  at: number;
}
