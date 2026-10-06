/** How often, the once and weekly fields, the next-fire line and the week bar. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import { DAY_LABELS, composeRule, describeRule } from "@waterplane/shared";
import { ScheduleWeekBar } from "../ScheduleWeekBar";
import { DEVICE_TZ, fmtWhen, inWords, quickTimes, toLocalInput } from "../sendIntent";
import type { SendSheetModel } from "./useSendSheet";
import { MoreRule } from "./MoreRule";
import { WindowRule } from "./WindowRule";

export function RuleEditor({ m }: { m: SendSheetModel }) {
  const {
    usage, preview, days, recurs, quickKey, setQuickKey, patchRule, replaceRule,
  } = m;
  const when = m.when as Extract<typeof m.when, { kind: "at" }>;
  const rule = m.rule as NonNullable<typeof m.rule>;
  const anchor = m.anchor as NonNullable<typeof m.anchor>;
  return (
    <>
      {/* HOW OFTEN, ahead of the fields it picks between: a schedule
          is "once" or "repeating" before it is anything else, and the
          old order — fields, then the selector that chose them below
          — meant changing the choice meant scrolling past what it had
          already drawn. For the clock anchor this picks the FIELD
          SHAPE too (an instant has nothing to repeat; a weekly
          pattern does), which is why its on-state reads `rule.kind`
          rather than `recurs` — flipping "just the next one" inside
          the weekly block below must not relabel this row. For the
          usage-window anchor there is only the one field shape, so
          this directly toggles whether it recurs. */}
      <div className="section section-head"><span>How often</span></div>
      <div className="segmented">
        <button className={`seg${(anchor === "window" ? !recurs : rule.kind === "once") ? " on" : ""}`}
          title="fire the next one and stop"
          onClick={() => { setQuickKey(null); replaceRule(composeRule(anchor, false, rule, Date.now(), DEVICE_TZ)); }}>
          once
        </button>
        <button className={`seg${(anchor === "window" ? recurs : rule.kind === "weekly") ? " on" : ""}`}
          title={anchor === "window" ? "every time that window resets" : "every week, on the days below"}
          onClick={() => { setQuickKey(null); replaceRule(composeRule(anchor, true, rule, Date.now(), DEVICE_TZ)); }}>
          repeating
        </button>
      </div>

      {/* The chips come FIRST: they are the answer most of the time,
          and a `datetime-local` under them is the escape hatch rather
          than the toll gate. Tapping one is a complete decision — the
          primary button renames itself on the same tap. */}
      {rule.kind === "once" && (
        <>
          <div className="sched-days">
            {quickTimes().map((q) => (
              <button key={q.key} className={`row-chip${quickKey === q.key ? " on" : ""}`}
                title={fmtWhen(q.at)}
                onClick={() => { setQuickKey(q.key); patchRule({ at: q.at }); }}>{q.label}</button>
            ))}
          </div>
          <div className="search-row sched-row">
            <span>at</span>
            <input className="search" type="datetime-local"
              value={toLocalInput(rule.at ?? Date.now() + 3600e3)}
              onChange={(e) => {
                const t = new Date(e.target.value).getTime();
                if (Number.isFinite(t)) { setQuickKey(null); patchRule({ at: t }); }
              }} />
          </div>
        </>
      )}
      {rule.kind === "weekly" && (
        <>
          <div className="sched-days">
            {DAY_LABELS.map((d, i) => (
              <button key={d} className={`row-chip${days.includes(i) ? " on" : ""}`}
                title={days.includes(i) ? `stop running on ${d}` : `also run on ${d}`}
                onClick={() => patchRule({ days: days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort() })}>{d}</button>
            ))}
            <button className={`row-chip${days.length === 0 ? " on" : ""}`} title="every day"
              onClick={() => patchRule({ days: [] })}>daily</button>
          </div>
          <div className="search-row sched-row">
            <span>at</span>
            <input className="search" type="time"
              value={`${String(rule.hour ?? 18).padStart(2, "0")}:${String(rule.minute ?? 0).padStart(2, "0")}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) patchRule({ hour: h, minute: m });
              }} />
            <input className="search" placeholder="Europe/Berlin" value={rule.tz ?? ""}
              title="The zone the time above is written in. Stored as a zone, not an instant, so daylight saving can't shift the run by an hour."
              onChange={(e) => patchRule({ tz: e.target.value.trim() })} />
          </div>
          {!rule.tz && (
            <div className="form-hint">No zone — the host&apos;s own clock decides, which is a different time than yours whenever the two machines disagree.</div>
          )}
          {/* A weekly PATTERN that only fires once — "next Thursday
              18:00", named by its own weekday rather than resolved to
              a date, so a DST change between now and then does not
              move it. Independent of "How often" above: that row
              picks the field shape (an instant has no days to check),
              this picks whether the pattern above keeps firing after
              the next match. */}
          <button className={`row-chip${rule.oneShot === true ? " on" : ""}`}
            title="run the next matching day above, then stop — instead of every week"
            onClick={() => patchRule({ oneShot: rule.oneShot === true ? undefined : true })}>
            just the next one
          </button>
        </>
      )}

      {rule.kind === "window" && <WindowRule m={m} />}
      <MoreRule m={m} />
      <div className="form-hint">
        {preview != null
          ? <>Next fire: <b>{fmtWhen(preview)}</b> · {inWords(preview)}{rule.tz ? ` (anchor in ${rule.tz})` : ""}{recurs ? "" : " · then it stops"}</>
          : rule.kind === "window"
            // A `window` rule's preview is null until the host has read
            // a usage figure — that is not "never", it is "not yet",
            // and saying "pick a later one" over a field with no clock
            // to pick told the reader to do something this rule has no
            // control to do.
            ? <>Not armed yet — the desktop arms this the first time it reads the window. {describeRule(rule)}.</>
            : <>This never fires — the time it resolves to has already passed. Pick a later one.</>}
      </div>
      {/* A window rule names an instant nobody can see — draw it: the
          same week bar the Schedules sheet carries, with this one
          draft as its only pin, at the preview the line above prints. */}
      {rule.kind === "window" && (
        <ScheduleWeekBar usage={usage} title={() => when.name?.trim() || "this schedule"}
          entries={[{ id: "draft", name: "", enabled: true, rule, createdAt: 0, graceMin: 0, nextAt: preview,
            action: { kind: "backlog", repoDir: "", text: "" } }]} />
      )}
    </>
  );
}
