import { SLOW_OP_TIMEOUT_MS, cleanOptInRow } from "@waterplane/shared";
import type { OptInChoice, OptInChoiceResult, OptInReport, OptInRow } from "@waterplane/shared";
import type { ComplianceAcceptRequest, ExposureRunResult, ComplianceAcceptResult, ComplianceFixResult, ComplianceIgnoreResult, ComplianceLimitsResult, ComplianceReport, ComplianceTriageRequest, ContextWeightLimits, GitBranch, HealthIndexResponse, HostSetupFixResult, HostSetupReport, RepoHealthView } from "@waterplane/shared";
import { nfetch, jget, jpost } from "./webapiFetch";
import type { EnvFileInfo, SecretResult, WriteTarget } from "./webapiTypes";

/** An opt-ins report off the wire, every row through `cleanOptInRow`: a row
 *  this phone cannot read is dropped, never rounded into an offer. */
function cleanOptInReport(r: OptInReport): OptInReport {
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return { ...r, rows: rows.map(cleanOptInRow).filter((x): x is OptInRow => !!x) };
}

/** Branches, secrets, setup compliance and repo health. One slice of `api` (see api.ts). */
export const repoOpsApi = {
  gitBranches: (repoId: string) =>
    jget<{ branches: GitBranch[] }>(`/api/repos/${repoId}/git/branches`).then((d) => d.branches),
  gitCheckout: (repoId: string, branch: string) =>
    jpost<{ ok: boolean; output?: string; error?: string }>(`/api/repos/${repoId}/git/checkout`, { branch }, SLOW_OP_TIMEOUT_MS),
  gitCreateBranch: (repoId: string, name: string, opts?: { from?: string; checkout?: boolean }) =>
    jpost<{ ok: boolean; output?: string; error?: string }>(`/api/repos/${repoId}/git/branch`, { name, ...opts }),
  gitDeleteBranch: (repoId: string, name: string, force = false) =>
    nfetch(`/api/repos/${repoId}/git/branch`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, force }),
    }).then((r) => r.json() as Promise<{ ok: boolean; output?: string; error?: string }>),

  // Secrets (write-only — there is no getter on purpose).
  envFiles: (repoId: string) =>
    jget<{ files: EnvFileInfo[] }>(`/api/repos/${repoId}/envfiles`).then((d) => d.files),
  secretTargets: () =>
    jget<{ targets: WriteTarget[] }>("/api/secret/targets").then((d) => d.targets),
  setSecret: (body: { scope: "host" | "repo"; repoId?: string; file?: string; key?: string; value: string; targetId?: string }) =>
    jpost<SecretResult>("/api/secret", body),

  // Setup compliance checklist (per-repo).
  compliance: (repoId: string) => jget<ComplianceReport>(`/api/repos/${repoId}/compliance`),
  // `confirm`: the report's token for a confirm-gated fix, sent with that one id alone.
  complianceFix: (repoId: string, fixes: string[], confirm?: string) =>
    jpost<ComplianceFixResult>(`/api/repos/${repoId}/compliance/fix`, confirm ? { fixes, confirm } : { fixes }),
  // The context-weight thresholds for one repo. A patch: an absent field keeps
  // falling through to the host's env and then the shipped default, so one knob
  // can be moved without freezing the other two at today's numbers.
  complianceLimits: (repoId: string, patch: Partial<ContextWeightLimits> | { reset: true }) =>
    jpost<ComplianceLimitsResult>(`/api/repos/${repoId}/compliance/limits`, patch),
  // Ignore (or stop ignoring) one advisory row in one repo.
  complianceIgnore: (repoId: string, id: string, ignore: boolean) =>
    jpost<ComplianceIgnoreResult>(`/api/repos/${repoId}/compliance/ignore`, { id, ignore }),
  // One exposure-watch finding: accept it (a reason, how long it holds) or mark it seen / investigating / fixed-in.
  complianceAccept: (repoId: string, req: ComplianceAcceptRequest) => jpost<ComplianceAcceptResult>(`/api/repos/${repoId}/compliance/accept`, req),
  complianceTriage: (repoId: string, req: ComplianceTriageRequest) => jpost<ComplianceAcceptResult>(`/api/repos/${repoId}/compliance/triage`, req),
  exposureRun: (repoId: string) => jpost<ExposureRunResult>(`/api/repos/${repoId}/exposure/run`, {}, 330_000), // host exposurerun.ts, ≤5 min; a 409 body is the refusal
  // Opt-ins (`shared/optins.ts`): optional things a repo can turn on, counted
  // in nothing. `choice: null` clears what the person said.
  optIns: (repoId: string) =>
    jget<OptInReport>(`/api/repos/${repoId}/optins`).then(cleanOptInReport),
  optInChoice: (repoId: string, id: string, choice: OptInChoice | null) =>
    jpost<OptInChoiceResult>(`/api/repos/${repoId}/optins/choice`, { id, choice })
      .then((r) => (r.report ? { ...r, report: cleanOptInReport(r.report) } : r)),
  // The auto-compact window the checklist writes, host-wide. `null` = back to
  // the shipped default.
  hostSetup: () => jget<HostSetupReport>("/api/host/setup"),
  hostSetupFix: (fixes: string[]) => jpost<HostSetupFixResult>("/api/host/setup/fix", { fixes }),
  setupPrefs: (signal?: AbortSignal) => jget<{ ok: boolean; autoCompactDefault: string; chosen: boolean }>("/api/host/setupprefs", undefined, signal),
  setSetupPrefs: (autoCompactDefault: string | null) =>
    jpost<{ ok: boolean; error?: string; autoCompactDefault?: string; chosen?: boolean }>("/api/host/setupprefs", { autoCompactDefault }),

  // The repo-health series (`tools/repohealth.mjs`, zero tokens: git, regex and
  // arithmetic). The READ is cheap and stat-only — it never runs the tool.
  // `scope` reads ONE SUBTREE's own series instead of the repo's — the same
  // view shape over different rows. It is a query parameter and not a second
  // route because it is a cut of the same resource, and the host validates it
  // against the worktree before it ever reaches a spawn.
  repoHealth: (repoId: string, scope?: string | null) =>
    jget<RepoHealthView>(`/api/repos/${repoId}/repohealth${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`),
  /** The weekly health score (`shared/healthindex.ts`) for the whole repo. */
  healthIndex: (repoId: string) =>
    jget<HealthIndexResponse>(`/api/repos/${repoId}/healthindex`),
  /** Which subtrees this repo measures separately. The answer is what was
   *  STORED, which is not always what was asked for — a scope that no longer
   *  names a directory is dropped, and a client that kept drawing it would be
   *  offering a reading nothing is measuring. */
  repoHealthScopes: (repoId: string, scopes: readonly string[]) =>
    jpost<{ ok: boolean; scopes: string[] }>(`/api/repos/${repoId}/repohealth/scopes`, { scopes }),
  /**
   * Run it. The explicit 200 s EXCEEDS the host's own 180 s cap on purpose.
   *
   * A cold backfill here walks every first-parent commit and takes ~18 s, and
   * a repo with more history takes longer; the host is the one thing that
   * knows when to stop waiting, and it says so in the outcome. A shorter fuse
   * on the phone would abort the request while the desktop's run carried on to
   * a successful append — a run that WORKED, read on screen as a failure, with
   * the rows it added appearing only on the next read. The phone's timeout is
   * therefore a backstop for a dead tunnel, never a second policy about how
   * long the tool may take.
   *
   * `jpost` does not throw on a non-2xx and this route answers **200 always**:
   * a refusal (exit 3, a series measured under two definitions) is the tool
   * running and saying no, not a transport failure. Read `ok` and `last.refused`
   * off the body — an HTTP error here means the host, not the tool.
   */
  repoHealthRefresh: (repoId: string, scope?: string | null, approveEngine?: boolean, approveToken?: string) =>
    jpost<RepoHealthView & { ok: boolean }>(
      `/api/repos/${repoId}/repohealth/refresh`, { ...(scope ? { scope } : {}), ...(approveEngine ? { approveEngine: true, ...(approveToken ? { approveToken } : {}) } : {}) }, 200_000,
    ),
};
