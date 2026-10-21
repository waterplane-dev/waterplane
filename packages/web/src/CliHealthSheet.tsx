/**
 * The CLI integration's own health, on the phone.
 *
 * Decision 8's argument in one line: everything this app does rests on driving
 * a TUI it does not own, every one of those readings degrades SILENTLY, and a
 * fallback nobody is told about becomes the architecture. The host records ten
 * signals (`shared/clihealth.ts` is the catalog and the rule); this is the
 * screen that says what they are doing. Without it the whole feature is a tree
 * falling in an empty forest.
 *
 * Two rules govern what is written here.
 *
 *  1. **Nothing is re-derived.** The verdict is `signalVerdict`, the sentence
 *     is `healthSentence`, the ordering is `CLI_SIGNALS`' own, and the "what it
 *     means" prose is the catalog's `means`. A second copy of any of those on
 *     the client is a second answer that drifts from the host's notification
 *     body and from the badge — the exact failure `budgetReasonText` and
 *     `blockedReasonText` are shaped to avoid. This file contains no thresholds
 *     and no adjectives about a signal.
 *
 *  2. **It paints with the tunnel down.** The frame arrives unprompted on
 *     `hello` and on change, and `App` writes every one to a snapshot; that
 *     snapshot is this sheet's cache, seeded FIRST through `useRemoteResource`,
 *     which is also what makes the age label non-optional. A health board is
 *     read at exactly the moment the link is misbehaving, which is the moment a
 *     live-only read shows nothing at all.
 *
 * Deliberately a POINT-IN-TIME read rather than a live subscription: the host
 * debounces its broadcast to ~5 s and a verdict moves over minutes, so a board
 * that repaints under the reader buys nothing and costs the ability to say when
 * it was taken. The head carries a re-read button; the launcher's chip is what
 * stays live.
 */
import { useMemo } from "react";
import { Bug, Check, ChevronDown, Waypoints, X } from "lucide-react";
import {
  CLI_SIGNALS,
  agoText,
  blankSignal,
  healthSentence,
  signalSpec,
  signalVerdict,
  supersededByGood,
  type CliHealth,
  type HealthRollup,
  type HealthVerdict,
  type HostMessage,
  type SignalRecord,
} from "@waterplane/shared";
import { ConfirmButton, Empty, FilterBar, StaleHead, useRemoteResource, Hint } from "./kit";
import { loadCliHealthSnap } from "./localState";

/** The `clihealth` frame's checkout pointer — present only from a developer's install. */
export type CliHealthSource = NonNullable<Extract<HostMessage, { t: "clihealth" }>["source"]>;

/** What one row in trouble says, already worded by `@waterplane/shared` — the
 *  sheet hands these over; nothing here grades a signal. */
export interface InspectFacts {
  id: string;
  name: string;
  verdict: HealthVerdict;
  version: string | null;
  sentence: string;
  /** "press-and-look · last 1m ago", or absent. */
  via?: string;
  sample?: string;
  /** "1m ago", with the sample. */
  sampleAgo?: string;
  stats?: string;
}

export interface CliHealthDoc {
  health: CliHealth;
  rollup: HealthRollup;
  /** Only from a host running out of a source checkout — what gates "inspect". */
  source?: CliHealthSource;
}

/**
 * A version change is worth naming for a while and then stops being the story.
 * Twenty-four hours: long enough that "it went red at the upgrade" is still the
 * first thing the reader sees, short enough that a week-old upgrade is not
 * offered as an explanation for something that started this morning.
 */
const REARM_RECENT_MS = 24 * 3600_000;

const VERDICT_LABEL: Record<HealthVerdict, string> = {
  healthy: "working",
  degraded: "degraded",
  broken: "broken",
  unknown: "unknown",
};

export function CliHealthSheet({ online, request, onClose, filter, onClearFilter, onClearWarnings, onInspect }: {
  /** The socket's own verdict, not `navigator.onLine` — see the hook's note. */
  online: boolean;
  /** Ask the host and resolve on its answer. Owned by `App`, which is where
   *  the socket is; rejects like a fetch would so `isOffline` can tell a dead
   *  tunnel from a refusal. */
  request: () => Promise<CliHealthDoc>;
  onClose: () => void;
  /** Set when opened from the topbar chip, which names a COUNT — "2 broken ·
   *  2 degraded" — over the ten-row board. A count on a control is a filter:
   *  the tap must open exactly those rows, never the unfiltered board for the
   *  reader to re-derive them from. `null`/absent is the unfiltered board
   *  (Settings' "open feed" opens whole, on purpose). */
  filter?: HealthVerdict[] | null;
  onClearFilter?: () => void;
  /** Send the clear and say so; false when it could not go (the link). Per
   *  signal, the newest miss THIS board showed — see `clearSeen`. */
  onClearWarnings?: (through: Record<string, number>, count: number) => boolean;
  /** Seed a coding session with one row in trouble. Drawn only where the
   *  host said it runs from a source checkout (`doc.source`): everybody else's
   *  desktop has no code to inspect, so they never see the button. */
  onInspect?: (facts: InspectFacts, source: CliHealthSource) => void;
}) {
  const res = useRemoteResource<CliHealthDoc>("clihealth", request, {
    offline: !online,
    fromCache: async () => loadCliHealthSnap(),
  });
  const doc = res.data;
  // One clock for the whole render. Ten rows each calling `Date.now()` would
  // grade the last signal a few milliseconds later than the first — invisible,
  // but it means the sentence and the pill on one row could in principle
  // disagree, and this sheet's entire value is that they cannot.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `doc` is the trigger: one clock per fetched document, though the body never reads it
  const now = useMemo(() => Date.now(), [doc]);

  const allRows: SignalRecord[] = doc
    // Catalog order, because `CLI_SIGNALS` says in its own header that it IS
    // the order a readout lists them in — a board that re-sorts itself by
    // severity moves rows under the reader between two visits and makes "the
    // third one" un-sayable. A signal with no record yet is synthesized rather
    // than skipped: "has not been checked" is a fact about the integration, and
    // a missing row is the silence this whole feature is against.
    ? CLI_SIGNALS.map((spec) => doc.health.signals[spec.id] ?? blankSignal(spec.id, doc.health.version))
    : [];

  // The filter is read against each row's OWN verdict, computed with the same
  // `now` the row itself paints with — never against the rollup's stale
  // lists, which were true when the chip was drawn and may not be true now.
  const rows = filter && filter.length > 0
    ? allRows.filter((sig) => filter.includes(signalVerdict(sig, now).verdict))
    : allRows;

  // What the clear button clears: the rows in trouble on THIS render, each
  // bounded by the newest miss it shows — so the tap can only remove what the
  // reader had in front of them. Same verdict call as the filter above.
  const warned = allRows.filter((sig) => {
    const v = signalVerdict(sig, now).verdict;
    return (v === "degraded" || v === "broken") && sig.lastMissAt != null;
  });
  const through: Record<string, number> = {};
  for (const sig of warned) through[sig.id] = sig.lastMissAt!;

  const rollup = doc?.rollup;
  const changed = doc?.health.versionChangedAt ?? null;
  const rearmed = changed != null && now - changed < REARM_RECENT_MS;

  return (
    <div className="sheet">
      <StaleHead title={<><Waypoints size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} />CLI health</>} onClose={onClose}
        bare iconSize={14} onRefresh={() => res.reload()}
        refreshTitle="re-read — the board is a point-in-time answer, not a live feed" />

      <Hint>
        Every point where this app reads something it does not own: the choice-box
        detector, the hook pipe, the echo probe, the conversation log. Each one
        degrades to nothing rather than to a wrong answer — this is where that
        nothing gets said out loud.
      </Hint>

      <div className="list">
        {rollup && (
          <div className={`cli-summary cli-${rollup.verdict}`}>
            <span className={`cli-pill cli-${rollup.verdict}`}>{VERDICT_LABEL[rollup.verdict]}</span>
            <span className="cli-summary-txt">
              {rollup.broken.length + rollup.degraded.length > 0
                ? `${rollup.broken.length ? `${rollup.broken.length} broken` : ""}${rollup.broken.length && rollup.degraded.length ? " · " : ""}${rollup.degraded.length ? `${rollup.degraded.length} degraded` : ""}`
                : "nothing is failing"}
              {rollup.unknown.length > 0 && <> · {rollup.unknown.length} not observed lately</>}
            </span>
            <span className="cli-summary-ver">
              {/* The version is part of the record because it is the single
                  most likely cause of a heuristic breaking. */}
              claude {doc?.health.version ?? "?"}
              {doc?.health.versionSeenAt != null && <> · seen {agoText(now - doc.health.versionSeenAt)} ago</>}
            </span>
            {rearmed && (
              <span className="cli-rearm">
                The CLI changed {agoText(now - (changed ?? now))} ago — every signal’s history was cleared, so a
                verdict here is about this version only.
              </span>
            )}
            {onClearWarnings && warned.length > 0 && (
              // Two taps: a clear drops the captured sample and the fallback
              // note too, the evidence a fix would start from. A miss after
              // the board was drawn is never cleared, and the next one that
              // tips a signal back into trouble brings its row and alert back.
              <ConfirmButton className="key cli-clear"
                title="you have read these: drop their misses so the board reads clean until something new fails"
                confirm={<>clear {warned.length === 1 ? "it" : `all ${warned.length}`} — read?</>}
                onConfirm={() => { if (onClearWarnings(through, warned.length)) res.reload(); }}>
                <Check size={13} /> clear {warned.length} warning{warned.length === 1 ? "" : "s"}
              </ConfirmButton>
            )}
          </div>
        )}

        {filter && filter.length > 0 && allRows.length > 0 && (
          // What is being hidden, and a way to see it again — the same
          // `.filter-bar` the session list's status filter uses. Counts come
          // from the UNFILTERED board, so "4 of 10" is the whole answer.
          // The label is NOT "clear". On a board whose whole subject is what is
          // broken, `clear` beside a filter reads as "clear the alarms", and the
          // tap does the opposite: MORE rows appear. So the label says the effect
          // — `show all 10`, the unfiltered board's count, the number the line
          // ends with. The session list's filter keeps `clear`: it hides no problem.
          <FilterBar section onClear={onClearFilter!}
            clearTitle={`show every signal, including the ${allRows.length - rows.length} working or unobserved ones`}
            clearLabel={<><X size={13} /> show all {allRows.length}</>}>
            showing {filter.map((v) => VERDICT_LABEL[v]).join(" and ")}
            {" · "}{rows.length} of {allRows.length}
            {rows.length === 0 && " — nothing is in that state any more"}
          </FilterBar>
        )}

        {/* The nothing-here branch is narrow on purpose: a board that HAS been
            read always draws ten rows, because a signal with no record is
            synthesized rather than skipped. So the only empty this can be is
            "no board at all" — loading, offline, refused, or a host that
            answered with nothing. The filtered-empty case above is a
            different claim (some rows exist, none match) and is worded apart. */}
        <Empty res={res} empty={allRows.length === 0} thing="the CLI health record" noun="health board">
          The host answered with no health record at all.
        </Empty>

        {rows.map((sig) => <Row key={sig.id} sig={sig} now={now} version={doc?.health.version ?? null}
          onInspect={onInspect && doc?.source ? (f) => onInspect(f, doc.source!) : undefined} />)}
      </div>
    </div>
  );
}

function Row({ sig, now, version, onInspect }: {
  sig: SignalRecord; now: number; version: string | null; onInspect?: (f: InspectFacts) => void;
}) {
  const spec = signalSpec(sig.id);
  const check = signalVerdict(sig, now);
  // A breadcrumb the primary rule has since been confirmed over is history,
  // not a state — `supersededByGood` is the fact that settles it, and the two
  // loudest things on the row are the two that must obey it.
  const viaPast = supersededByGood(sig, sig.lastFallbackAt);
  const samplePast = supersededByGood(sig, sig.sampleAt);
  return (
    <div className={`cli-row cli-${check.verdict}`}>
      <div className="cli-row-top">
        <span className="cli-name">{spec.name}</span>
        <span className={`cli-pill cli-${check.verdict}`}>{VERDICT_LABEL[check.verdict]}</span>
      </div>
      {/* The one sentence, generated in `@waterplane/shared`. The host's push
          notification says the same words; that is the point. */}
      <div className="cli-say">{healthSentence(sig, now)}</div>

      {sig.via && (
        // "Never silently substitute" — taking the fallback is itself the event
        // to report, and naming it is what stops it from becoming permanent.
        // Tense is load-bearing: the record is kept for ever, so a fallback the
        // primary rule has been confirmed over says "fell back", in the muted
        // colour, and never the amber present tense that claims the app is
        // standing on it now.
        <div className={viaPast ? "cli-via cli-past" : "cli-via"}>
          {viaPast ? <>Fell back to <b>{sig.via}</b></> : <>Falling back to <b>{sig.via}</b></>}
          {sig.lastFallbackAt != null && <> · last {agoText(now - sig.lastFallbackAt)} ago</>}
          {viaPast && <> · working again since then</>}
        </div>
      )}

      {sig.sample && (
        // The captured input is the actionable half: "this line no longer
        // matches" is only worth saying if the line was kept. `line` samples
        // are redacted screen text, `shape` samples carry no characters at all
        // — both decided host-side by the signal's own `capture` mode.
        <pre className={samplePast ? "cli-sample cli-past" : "cli-sample"}>
          {sig.sample}
          {sig.sampleAt != null && (
            <span className="cli-sample-at">  ({agoText(now - sig.sampleAt)} ago{samplePast ? ", working again since then" : ""})</span>
          )}
        </pre>
      )}

      {spec.means && (
        <details className="cli-means">
          <summary><ChevronDown size={12} /> what this breaks</summary>
          <div>{spec.means}</div>
          {spec.fallback && <div className="cli-means-fb">Without it, the app falls back to {spec.fallback}.</div>}
        </details>
      )}

      <div className="cli-stats">
        {/* A rate below the module's own sample floor is `check.rate === null`
            because "one miss out of two is 50% and is not a fact about
            anything" — and printing "0 of the last 1 failed" beside "38 good /
            7 missed all-time" is that same non-fact, wearing the shape of a
            statistic and reading like a bug in the counter. So the fraction is
            drawn on exactly the samples the verdict was allowed to use it on. */}
        {check.rate != null && <>{check.failed} of the last {check.samples} failed · </>}
        {sig.totalGood + sig.totalMiss > 0 && <>{sig.totalGood} good / {sig.totalMiss} missed all-time</>}
      </div>

      {onInspect && (check.verdict === "degraded" || check.verdict === "broken") && (
        <button type="button" className="key cli-inspect"
          title="open the Send sheet with this row's facts and where its record and captures live, aimed at a new session in the checkout"
          onClick={() => onInspect({
            id: sig.id, name: spec.name, verdict: check.verdict, version,
            sentence: healthSentence(sig, now),
            via: sig.via ? `${sig.via}${sig.lastFallbackAt != null ? ` · last ${agoText(now - sig.lastFallbackAt)} ago` : ""}` : undefined,
            sample: sig.sample ?? undefined,
            sampleAgo: sig.sampleAt != null ? `${agoText(now - sig.sampleAt)} ago` : undefined,
            stats: [
              check.rate != null ? `${check.failed} of the last ${check.samples} failed` : "",
              sig.totalGood + sig.totalMiss > 0 ? `${sig.totalGood} good / ${sig.totalMiss} missed all-time` : "",
            ].filter(Boolean).join(" · ") || undefined,
          })}>
          <Bug size={13} /> inspect in a session
        </button>
      )}
    </div>
  );
}
