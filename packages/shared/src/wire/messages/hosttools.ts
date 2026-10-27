// Host → client: synced settings, builds, captures, assessments, fan-out, pulls, schedules, intents. Member list of `HostMessage` in `../messages.ts`. 

import type { ArtifactPolicy } from "../../artifacts.js";
import type { BudgetVerdict, UsageBudget } from "../../budget.js";
import type { PeriodState } from "../../period.js";
import type { BillingStatus } from "../../billing.js";
import type { CliHealth, HealthRollup } from "../../clihealth.js";
import type { LocalRuntimeSample } from "../localrt.js";
import type { Intent } from "../../intent.js";
import type { ScheduleEntry } from "../../schedule.js";
import type { SettingsDoc } from "../../settings.js";
import type { InstallLogDoc } from "../install.js";
import type { NotificationItem, NotifyPrefs } from "../notify.js";
import type { BuildParamAnswer } from "../../buildparams.js";
import type { BuildCandidate } from "../../buildscan.js";
import type { BuildRecord } from "../../buildstamp.js";
import type { CaptureBackendInfo, CaptureRun, CaptureTarget } from "../capture.js";
import type { OnboardJob } from "../onboard.js";
import type { LimitResumeMode } from "../session.js";
import type { HaltState } from "../../halt.js";
import type { MeterSummary } from "../telemetry.js";
import type { AssessRun, AutoPullConfig, BuildConfig, BuildRun, FanoutRun, PullItem } from "../work.js";

export type HostToolsMsg =
  // ── Synced settings ──
  /** The whole synced document. Sent on hello and on `settings.get`. */
  | { t: "settings.all"; doc: SettingsDoc }
  /**
   * One setting changed. Broadcast to EVERY socket including the writer's: the
   * echo is what tells a client its write was accepted, and a client applies it
   * only when `ts` is newer than what it holds, so the round trip cannot loop.
   */
  | { t: "settings.update"; key: string; value: string; ts: number; device?: string }
  /**
   * The install log, whole. Sent on hello, on `install.get`, and broadcast to
   * EVERY socket whenever a phone reports something new — so a second device
   * watching the screen sees the first one update itself.
   */
  | { t: "install.log"; doc: InstallLogDoc }
  /** Transient status note for the client to surface as a toast. */
  | { t: "toast"; text: string }
  /** A new in-app notification (also fired as OS push when subscribed). */
  | { t: "notification"; item: NotificationItem }
  /** Full in-app notification feed (newest first). */
  | { t: "notification.list"; items: NotificationItem[] }
  /** Which notification kinds are muted (sent on hello and on every change).
   *  Sparse: a kind not present takes `NOTIFY_DEFAULT_OFF`'s default. */
  | { t: "notify.prefs"; prefs: NotifyPrefs; /** Information is pushed too. Absent = off (or an older host). */ pushInfo?: boolean }
  /**
   * The usage budget and what it currently says (sent on hello, on every
   * change, and whenever the verdict itself flips).
   *
   * The verdict rides along rather than being re-derived on the phone even
   * though the rule is shared: the reading it is computed from (`UsageInfo`) is
   * scraped on the host, and a client that has been offline through a reset
   * would otherwise explain a queue with a percentage from an hour ago.
   */
  | {
      t: "budget.state"; budget: UsageBudget; verdict: BudgetVerdict;
      /** Each configured period and where it stands (`periodBounds` at send time,
       *  spend from the host's ledger). Optional: an older host omits it and the
       *  phone shows today's two windows; an older phone ignores it. Additive,
       *  `PROTOCOL_VERSION` stays 2. */
      periods?: PeriodState[];
    }
  /**
   * Which billing profile this desktop's claude runs under (`shared/billing.ts`):
   * probed, or the person's override (`source: "setting"`). Sent on hello and on
   * change, and as the answer to `billing.get` / `billing.set`. Absent from an
   * older host: the phone treats that as `unknown` and shows today's subscription
   * chrome. Additive, `PROTOCOL_VERSION` stays 2.
   */
  | ({ t: "billing.status" } & BillingStatus)
  /**
   * The health board and its rollup — sent on hello and on change (debounced
   * ~5 s: a health record must not become a frame source on this link).
   *
   * The rollup rides along rather than being re-derived on the phone even
   * though the rule is shared, for the same reason `budget.state` carries its
   * verdict: every verdict here is relative to a CLOCK, and a client that has
   * been offline for a day would otherwise render yesterday's misses as today's
   * alarm. `PROTOCOL_VERSION` did not move for it — this is additive.
   */
  | { t: "clihealth"; health: CliHealth; rollup: HealthRollup;
      /** Only from a host running out of a source checkout (`devSource`, host
       *  `clihealth.ts`): what the phone's "inspect in a session" names, both
       *  absolute desktop paths — the checkout a session opens in, and the
       *  state dir holding `clihealth.json` + `clifixtures/`. Absent elsewhere,
       *  so a packaged install never offers to inspect code it does not have. */
      source?: { repo: string; stateDir: string } }
  /**
   * One reading of the local runner. The host keeps NO history of these — the
   * phone keeps the ring (`shared/wire/localrt.ts`).
   *
   * `disabled` is sent once per watch when `WATERPLANE_LOCAL_RUNTIME=0` and the host
   * will not poll at all. It exists to keep "polling is switched off on this
   * desktop" apart from "the runner did not answer", which are different
   * sentences and would otherwise both arrive as `reachable: false`.
   */
  | { t: "localrt.sample"; sample: LocalRuntimeSample; disabled?: true }
  /** The answer to `localrt.evict`: did the runner unload it? `error` is the
   *  runner's own sentence (an HTTP status or a fetch failure), never a code —
   *  there is no vocabulary to translate it into that would say more. */
  | { t: "localrt.evict"; name: string; ok: boolean; error?: string }
  | { t: "meter.status"; summary: MeterSummary }
  /** Global auto-continue-on-usage-limit switch (sent on hello and on change),
   *  plus the resume queue's host-wide state: `resumingId` is the session being
   *  resumed right now, and `holdUntil` is set when a resume attempt came back
   *  still blocked — the limit demonstrably has not reset, so no OTHER session
   *  may spend an attempt proving the same thing until then. */
  | { t: "limit.config"; enabled: boolean; resumingId: string | null; resumingIds?: string[]; holdUntil: number | null; mode?: LimitResumeMode }
  /** The halt latch (sent on hello and on every change). */
  | { t: "halt.state"; halt: HaltState }
  | { t: "pong" } // heartbeat reply to { t: "ping" }
  // ── Build buttons ──
  /** A repo's build config + recent runs (sent on request and on save). `builds` is the
   *  MERGED list (committed `.waterplane-shared/builds.json`, then this desktop's own
   *  `.waterplane/builds.json`, local winning by id). `localIds`: the ids that live in
   *  the local file — every other entry came with the checkout. Absent from an older
   *  host: nobody said, so the phone draws no attribution. `versions`: each artifact's
   *  recent builds (`versions.jsonl`, `buildstamp.ts`), newest first, keyed by
   *  `BuildRecord.name` — absent from an older host. */
  | { t: "build.list"; repoDir: string; builds: BuildConfig[]; runs: BuildRun[]; localIds?: string[]; versions?: Record<string, BuildRecord[]> }
  /** Streamed build output. `full` (on a fresh list/reconnect) = the retained
   *  tail, replacing the client's buffer; absent/false = a live delta to append. */
  | { t: "build.output"; runId: string; dataB64: string; full?: boolean }
  /** A run's state changed (started / done / failed / cancelled). Artifacts ride the terminal states. */
  | { t: "build.run"; run: BuildRun }
  /** What this repo does with what its builds produce (`artifacts.get`/`.save`). */
  | { t: "artifacts.config"; repoDir: string; policy: ArtifactPolicy }
  /**
   * The first-app onboarding job, whole, on every step transition (broadcast; additive, so
   * `PROTOCOL_VERSION` stays). A host-to-phone frame only: starting and resuming are
   * `POST /api/onboard` / `POST /api/onboard/resume`, and a reconnecting phone reads
   * `GET /api/onboard` rather than waiting for the next frame. The build's own output rides
   * `build.output` under `job.buildRunId`.
   */
  | { t: "onboard.progress"; job: OnboardJob }
  /**
   * The answer to `build.scan`: build commands this repo already describes.
   *
   * `total` is how many were found before the list was capped, so the editor
   * can say what it is not showing instead of implying the repo has sixty.
   * An empty `candidates` with `total: 0` is a real answer — this repo's
   * manifests describe nothing — and is worded as one.
   */
  | { t: "build.candidates"; repoDir: string; candidates: BuildCandidate[]; total: number }
  /**
   * The answer to `build.options`: what each discovered parameter may be set to.
   *
   * One entry per parameter whose options were READ (a static list needs no
   * round trip — the client already has it on the config). `total` is what the
   * command produced before the cap, so a cut list can say so; `error` is the
   * honest alternative to an empty one, because "that command failed" and "this
   * monorepo has no apps" are opposite facts and only one of them means the
   * form should offer a typed field instead.
   */
  | { t: "build.options"; repoDir: string; buildId: string; options: Record<string, BuildParamAnswer> }
  // ── Verified capture ──
  /**
   * A repo's capture targets + recent runs (sent on request and on save).
   *
   * `backends` rides ALONG rather than being asked for separately, because the
   * sheet's alternative to having the sentence in hand is guessing: it would
   * draw a button, then learn Playwright is missing, then have to explain a
   * failure it could have prevented. With availability on the list it says
   * "web needs Playwright" where the button would be — words, never a greyed-out
   * control (CLAUDE.md).
   */
  | { t: "capture.list"; repoDir: string; targets: CaptureTarget[]; runs: CaptureRun[]; backends: CaptureBackendInfo[] }
  /** A run's state changed (started / done / failed / cancelled). The verdict,
   *  the verification level and the frames ride the terminal states —
   *  `build.run`'s shape exactly. */
  | { t: "capture.run"; run: CaptureRun }
  /** Streamed capture output. `full` (on a fresh list/reconnect) = the retained
   *  tail, replacing the client's buffer; absent/false = a live delta to append.
   *  `build.output`'s contract, deliberately identical. */
  | { t: "capture.output"; runId: string; dataB64: string; full?: boolean }
  // ── Assessment ──
  /**
   * One repo's newest assessment run, pushed on every state change.
   *
   * Its own snapshot rather than a filter over an existing one, because an
   * assess row falls out of BOTH of them: `isBacklogRow` wants a prompt payload
   * and `isBuildRow` wants a build one, so a run would otherwise appear in no
   * host snapshot at all — invisible for the whole time it works, which is the
   * failure this rework is against. `run: null` means "this repo has never been
   * assessed", which is a different sentence from "we could not ask".
   */
  | { t: "assess.state"; repoDir: string; run: AssessRun | null }
  // ── Fan-out ──
  /** A fan-out run's state (sent on every target transition) — newest runs first in fanout.list. */
  | { t: "fanout.run"; run: FanoutRun }
  | { t: "fanout.list"; runs: FanoutRun[] }
  // ── Auto-download ──
  /** A repo's auto-pull rule (sent on request and on save). */
  | { t: "pull.config"; repoDir: string; config: AutoPullConfig }
  /** The whole pull queue, newest first (on hello, on request, after a dismiss). */
  | { t: "pull.list"; items: PullItem[] }
  /** One newly-queued file. Broadcast the moment it is detected so an attached
   *  phone starts fetching without waiting for the next list. */
  | { t: "pull.new"; item: PullItem }
  // ── Scheduled prompts ──
  /** The whole schedule list (on hello, on request, after every mutation and
   *  every fire — `nextAt` and `lastResult` are host-computed, so the client
   *  never derives them). */
  | { t: "schedule.list"; entries: ScheduleEntry[] }
  // ── The durable Intent ──
  /** Every intent this host is holding, newest first. Sent on request; a client
   *  that was off all night learns from this alone what ran and what did not. */
  | { t: "intent.list"; intents: Intent[] }
  /**
   * One intent changed state. Pushed the moment it does — the `pull.new` /
   * `delivery.settled` shape, and for the same reason: a row never vanishes on
   * a state change, it changes verdict, and the phone must be able to see that
   * happen without asking.
   */
  | { t: "intent.changed"; intent: Intent }
  | { t: "error"; message: string; context?: string };
