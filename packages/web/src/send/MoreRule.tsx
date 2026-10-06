/** Lead time, run hours, late runs and the name. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import { GRACES, LEADS, hoursWords } from "../sendIntent";
import type { SendSheetModel } from "./useSendSheet";
import { HOURS_FROM, HOURS_TO, hhmm, minuteOfDay } from "./sendTargets";

export function MoreRule({ m }: { m: SendSheetModel }) {
  const {
    retime, setWhen, more, setMore, patchRule,
  } = m;
  const when = m.when as Extract<typeof m.when, { kind: "at" }>;
  const rule = m.rule as NonNullable<typeof m.rule>;
  return (
    <>
      {more ? (
        <>
          {/* Lead time is an ANCHOR concept, so it belongs to
              `weekly` alone: the anchor is a recurring fact about the
              world (the reset rolls over on Thursday) and the lead is
              the policy against it. A `once` has no anchor — the
              instant in the picker IS the fire time. */}
          {rule.kind === "weekly" && (
            <>
              <div className="section section-head"><span>Lead time <span className="section-hint">· fire before the time above</span></span></div>
              <div className="sched-days">
                {LEADS.map((m) => (
                  <button key={m} className={`row-chip${(rule.offsetMin ?? 0) === -m ? " on" : ""}`}
                    onClick={() => patchRule({ offsetMin: -m })}>{m === 0 ? "on time" : `${m < 60 ? `${m}m` : `${m / 60}h`} before`}</button>
                ))}
              </div>
              <div className="form-hint">
                The time above is the thing you are tracking — a usage window rolling over, a nightly deploy.
                The lead is when to act on it. Keeping them apart means a moved reset is one field to change.
              </div>
            </>
          )}
          {/* THE RUN WINDOW, and deliberately under *more* rather
              than beside the anchor: it is not a second anchor and it
              never moves the occurrence.

              Not called "quiet hours" anywhere a person can read it.
              The fields default to 07:00–22:00 and `inHours`,
              `describeRule` and the host all read them as the hours it
              MAY run — the loud ones. Two labels called that window
              quiet hours, so anybody who wanted "not while I'm asleep"
              set 22:00 to 07:00 and got exactly the opposite. "Every day at 03:00" is a
              fact about when the work becomes worth doing; "not while
              I am asleep" is a policy over every anchor, which is why
              it survives a switch between *at a time* and *a usage
              window* (`composeRule` carries it across) and why it
              reads as one clause at the end of the rule line rather
              than as part of it. Rare, so it is one disclosure away;
              real, so it is expressible at all. */}
          <div className="section section-head">
            <span>Only between <span className="section-hint">· the hours it may run, over whichever anchor is set</span></span>
          </div>
          <div className="sched-days">
            <button className={`row-chip${rule.hours ? "" : " on"}`}
              title="no run window — it may run at whatever hour the anchor lands on"
              onClick={() => patchRule({ hours: undefined })}>any time</button>
          </div>
          <div className="search-row sched-row">
            <span>from</span>
            <input className="search" type="time" aria-label="run window opens"
              value={hhmm(rule.hours?.from ?? HOURS_FROM)}
              onChange={(e) => {
                const m = minuteOfDay(e.target.value);
                if (m != null) patchRule({ hours: { from: m, to: rule.hours?.to ?? HOURS_TO } });
              }} />
            <span>to</span>
            <input className="search" type="time" aria-label="run window closes"
              value={hhmm(rule.hours?.to ?? HOURS_TO)}
              onChange={(e) => {
                const m = minuteOfDay(e.target.value);
                if (m != null) patchRule({ hours: { from: rule.hours?.from ?? HOURS_FROM, to: m } });
              }} />
          </div>
          {/* A zero-width window and a window that wraps midnight
              are both SAID rather than refused or silently reshaped —
              `hoursWords` owns all three readings. */}
          <div className="form-hint">{hoursWords(rule)}</div>

          <div className="section section-head"><span>If the host was asleep</span></div>
          <div className="sched-days">
            {GRACES.map((g) => (
              <button key={g.min} className={`row-chip${when.graceMin === g.min ? " on" : ""}`}
                onClick={() => setWhen({ ...when, graceMin: g.min })}>{g.label}</button>
            ))}
          </div>
          {/* A re-time never renames the rows it moves — each keeps its own title. */}
          {!retime && (
            <input className="search" placeholder="name it — “weekly security sweep”"
              value={when.name ?? ""} onChange={(e) => setWhen({ ...when, name: e.target.value })} />
          )}
        </>
      ) : (
        <button className="linkish" onClick={() => setMore(true)}>more — lead time, run hours, late runs, a name</button>
      )}
    </>
  );
}
