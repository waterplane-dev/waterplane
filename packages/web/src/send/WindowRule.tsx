/** The usage-window rule's fields. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import { LS, lsSet } from "../storage";
import { GUARD_LABEL, LEADS, guardWords, pctChoices, pctOk, pctWords } from "../sendIntent";
import type { SendSheetModel } from "./useSendSheet";

export function WindowRule({ m }: { m: SendSheetModel }) {
  const {
    anchorW, guardW, pctOpen, setPctOpen, savedPct, setSavedPct, pctRaw, setPctRaw, patchRule,
  } = m;
  const rule = m.rule as NonNullable<typeof m.rule>;
  return (
    <>
      <>
        <div className="segmented">
          <button className={`seg${(rule.window ?? "session") === "session" ? " on" : ""}`}
            onClick={() => patchRule({ window: "session" })}>session window</button>
          <button className={`seg${rule.window === "weekly" ? " on" : ""}`}
            onClick={() => patchRule({ window: "weekly" })}>weekly window</button>
        </div>
        <div className="segmented">
          <button className={`seg${(rule.edge ?? "before") === "before" ? " on" : ""}`}
            title="spend what is left before the window rolls over"
            onClick={() => patchRule({ edge: "before", offsetMin: Math.min(0, rule.offsetMin ?? -60) })}>before it resets</button>
          {/* The condition is no longer cleared on the way in.
              `right after it resets` used to wipe `minPctLeft`,
              because a condition on a window that has JUST reset can
              only ever mean "never run" — true of that window, and
              only that one. A guard naming the OTHER meter asks a
              question with a real answer at exactly that instant,
              which is the whole reason `guardWindow` exists. */}
          <button className={`seg${rule.edge === "after" ? " on" : ""}`}
            title="start the moment the allowance is back"
            onClick={() => patchRule({ edge: "after", offsetMin: 0 })}>right after it resets</button>
        </div>

        {(rule.edge ?? "before") === "before" && (
          <>
            <div className="section section-head"><span>How long before</span></div>
            <div className="sched-days">
              {LEADS.filter((m) => m > 0).map((m) => (
                <button key={m} className={`row-chip${(rule.offsetMin ?? 0) === -m ? " on" : ""}`}
                  onClick={() => patchRule({ offsetMin: -m })}>{m < 60 ? `${m}m` : `${m / 60}h`}</button>
              ))}
            </div>
          </>
        )}

        {/* The condition. Written as what is LEFT, not what is
            used: the question being asked is "is there enough
            headroom to be worth spending?", and naming it the
            other way round would make every reading of it an
            inversion done in the head against a meter that
            reports the opposite.
            Drawn under BOTH edges now. It used to be hidden under
            `right after it resets` entirely, which was the correct
            shape while a condition could only ever read the window
            the rule was anchored to — and which made the one
            instruction people kept asking for unsayable. */}
        <div className="section section-head">
          <span>Only if there is headroom <span className="section-hint">· checked when it fires, not now</span></span>
        </div>
        <div className="sched-days">
          <button className={`row-chip${rule.minPctLeft == null ? " on" : ""}`}
            title="run whatever the meter says"
            onClick={() => patchRule({ minPctLeft: undefined })}>no condition</button>
          {/* The fixed four plus whatever was typed — one row of
              equals, not four chips and an afterthought. See
              `pctChoices`. */}
          {pctChoices(savedPct, rule.minPctLeft).map((p) => (
            <button key={p} className={`row-chip${rule.minPctLeft === p ? " on" : ""}`}
              onClick={() => patchRule({ minPctLeft: p })}>{p}% left</button>
          ))}
          <button className={`row-chip${pctOpen ? " on" : ""}`}
            title="type a percentage the chips don't cover — it is kept on this phone and offered beside them next time"
            onClick={() => setPctOpen((v) => !v)}>another…</button>
        </div>
        {pctOpen && (
          <>
            <div className="search-row sched-row">
              <span>at least</span>
              <input className="search" type="number" inputMode="numeric" min={1} max={100} step={1}
                value={pctRaw}
                onChange={(e) => {
                  setPctRaw(e.target.value);
                  const n = pctOk(e.target.value);
                  // Only a value that parses reaches the rule, and
                  // only one that reached the rule is remembered:
                  // the saved chip is a percentage that was
                  // actually asked for, never a keystroke on the
                  // way to one.
                  if (n != null) { patchRule({ minPctLeft: n }); setSavedPct(n); lsSet(LS.schedPctLeft, String(n)); }
                }} />
              <span>% left</span>
            </div>
            {/* Never a dimmed field and never a refusal: the chips
                above still answer the question, so an unusable
                number owes the reader a sentence and nothing more. */}
            <div className="form-hint">
              {pctWords(pctRaw) ?? `Kept on this phone — ${pctOk(pctRaw)}% left is offered as a chip on the next rule you write.`}
            </div>
          </>
        )}
        {rule.minPctLeft != null && (
          <>
            {/* Which METER, said as a control rather than left to be
                inferred from the anchor above it. The two questions
                "when does this become possible" and "is it worth
                doing" are about different windows as often as they
                are about the same one, and one field answering both
                meant the shape everybody wanted was the one it
                could not hold. Both meters are named outright —
                "this one" would have made the line depend on a
                segmented control two rows up. */}
            <div className="section section-head">
              <span>…in which window <span className="section-hint">· the meter it reads, not the reset it waits for</span></span>
            </div>
            <div className="segmented">
              {(["session", "weekly"] as const).map((w) => (
                <button key={w} className={`seg${guardW === w ? " on" : ""}`}
                  // Naming the rule's OWN window is not a guard at
                  // all, and `cleanRule` drops it — so the control
                  // stores exactly what the host would keep. One
                  // way to say each thing.
                  onClick={() => patchRule({ guardWindow: w === anchorW ? undefined : w })}>
                  {GUARD_LABEL[w]}
                </button>
              ))}
            </div>
            {/* Not a dimmed control and never a refusal, in any of
                the three cases: the rule is savable exactly as
                written and `guardWords` says what it will DO. */}
            <div className="form-hint">{guardWords(rule)}</div>
          </>
        )}
        <div className="form-hint">
          Anchored to the reset, not to a clock: the session window slides with whenever you last
          started using it, so there is no time of day that means the same thing twice.
          Nothing is armed until the host has read the window once.
        </div>
      </>
    </>
  );
}
