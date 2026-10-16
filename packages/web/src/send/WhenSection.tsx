/** The When row: now / when it's free, the anchors, after-another, wait-until-free. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import { CalendarClock, ChevronDown, ChevronRight, Files, Gauge, Hourglass, Link2 } from "lucide-react";
import { RadioRows } from "../kit";
import { intentTitle } from "../activityRows";
import { CHAIN_EMPTY, CHAIN_NOTE, chainOkWords, RETIME_NOW_SEG, whenWords } from "../sendIntent";
import { Empty } from "../Empty";
import { retimeOffClockNote } from "../backlogFilter";
import type { SendSheetModel } from "./useSendSheet";
import { chainRowState } from "./sendTargets";
import { RuleEditor } from "./RuleEditor";

export function WhenSection({ m }: { m: SendSheetModel }) {
  const {
    retime, atMemo, rule, preview, chainRows, waitsForFiles, anchor, target, when, setWhen, open, setOpen, setAnchor, setAfter, leaveAt,
  } = m;
  return (
    <>
      {/* ── When ───────────────────────────────────────────────────── */}
      <button className="send-sum" onClick={() => setOpen(open === "when" ? null : "when")}>
        <span className="send-sum-k">When</span>
        <span className="send-sum-v">{whenWords(when, preview)}</span>
        {open === "when" ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open === "when" && (
        <div className="send-exp">
          {/* Row one is not a schedule at all — "now" and "when it's free"
              are instructions about a live target, not a rule. Row two is:
              pick an ANCHOR, a clock time or a usage reset. Splitting them
              onto two rows says that out loud rather than presenting four
              peers where two of them do not belong to the same question. */}
          <RadioRows<"now" | "idle"> label="When to run it"
            value={when.kind === "now" || when.kind === "idle" ? when.kind : null}
            options={[
              { key: "now", label: retime ? RETIME_NOW_SEG : "now" },
              { key: "idle", label: "when it's free", title: "hold it until the target can take it — turn ended, no question open, no usage-limit block" },
            ]}
            onChange={(k) => leaveAt({ kind: k })} />
          {/* A re-time with no clock MOVES the rows: off the clock list, onto
              the repo's ⌛ chip. Said here, before the tap, and again in the
              receipt — rows that vanish from where you were looking read as lost. */}
          {retime && when.kind !== "at" && <div className="form-hint">{retimeOffClockNote(retime.ids.length)}</div>}
          {/* …and the rule that tap left behind is still there. Without this
              sentence the only way to find out was to tap back, which is
              exactly what a person avoids doing after something vanished. */}
          {when.kind !== "at" && atMemo.current && (
            <div className="form-hint">
              The schedule you set is kept — tap <b>at a time</b> or <b>a usage window</b> to get it back.
            </div>
          )}
          {/* What "free" MEANS depends on the target, and the two answers are
              not the same wait: a live session is free when its turn ends,
              while a new one is waiting on the desktop having a slot to spend
              at all. Said in text rather than in a `title`, which never
              appears on the device this sheet is used from. */}
          {when.kind === "idle" && (
            <div className="form-hint">
              {target.kind === "repo"
                // One clause for this wait, everywhere it is named — the
                // button, this hint and the toast after the tap all say "when
                // this repo is free". What that MEANS is the sentence after
                // it; what it is CALLED does not change between three screens.
                ? "When this repo is free: a slot on the desktop, and nothing else running in this checkout. The desktop holds it — this phone can be shut."
                : target.kind === "repos"
                  ? "Each one starts when its own repo is free. The desktop holds them — this phone can be shut."
                  : "Turn ended, no question open, no usage-limit block. The desktop holds it, so this phone can be shut."}
            </div>
          )}
          <RadioRows<"clock" | "window" | "after"> label="What it waits for"
            value={when.kind === "at" ? (anchor === "window" ? "window" : "clock") : when.kind === "after" ? "after" : null}
            options={[
              { key: "clock", label: <><CalendarClock size={13} /> at a time</> },
              { key: "window", label: <><Gauge size={13} /> a usage window</>, title: "anchor this to a usage window resetting, rather than to a time of day" },
              { key: "after", label: <><Link2 size={13} /> after another…</>, title: "wait for another item to finish, rather than for a time" },
            ]}
            onChange={(k) => { if (k === "after") setAfter(); else setAnchor(k); }} />
          {when.kind === "after" && (
            <>
              <div className="pad-pick">
                <div className="form-hint">Which item does it wait for?</div>
                {chainRows.map((c) => (
                  <button key={c.id} className={`row${when.id === c.id ? " sched-on" : ""}`}
                    onClick={() => setWhen({ ...when, id: c.id, title: intentTitle(c) })}>
                    {/* Titled by `intentTitle`, which is the Activity sheet's
                        own rule — so the row you pick here is the row you
                        recognise there, and the name snapshotted onto the
                        trigger is the name that screen will keep using. */}
                    <span className="row-title">{intentTitle(c)}</span>
                    <span className="row-sub">{chainRowState(c)}</span>
                  </button>
                ))}
                {/* An empty picker is a STATE, said in words. The segment
                    above stays live and stays tappable: a dimmed control with
                    the reason hidden in a `title` is a control that says
                    nothing at all on a phone. */}
                {!chainRows.length && (
                  <Empty>{CHAIN_EMPTY}</Empty>
                )}
              </div>
              <div className="sched-days">
                <button className={`row-chip${when.onlyIfOk ? " on" : ""}`}
                  onClick={() => setWhen({ ...when, onlyIfOk: when.onlyIfOk ? undefined : true })}>
                  only if it succeeded
                </button>
              </div>
              <div className="form-hint">{chainOkWords(when.onlyIfOk)}</div>
              <div className="form-hint">{CHAIN_NOTE}</div>
            </>
          )}
          {/* An ADDITION to the anchor above, never a third one to pick
              between — ticking it does not change WHEN this is due, it holds
              the fire, once due, until the desktop is doing nothing else.
              Deliberately its own row rather than folded into "when it's
              free" above: that row is an instruction about a LIVE target and
              stops applying the moment a wall-clock rule exists at all,
              which is exactly the bug this fixes — a dozen repos each
              anchored to "right after it resets" all become due in the same
              instant, and without this they all fire together. */}
          {when.kind === "at" && (
            <>
              <div className="sched-days" style={{ marginTop: 6 }}>
                <button className={`row-chip${when.waitUntilFree ? " on" : ""}`}
                  onClick={() => setWhen({ ...when, waitUntilFree: !when.waitUntilFree })}>
                  <Hourglass size={13} /> hold until the desktop is free
                </button>
              </div>
              {/* Said in TEXT, not in the `title` this used to hide in: a
                  `title` never appears on a phone, which is the only device
                  this sheet is used from, so the one sentence explaining what
                  the chip does was invisible to everyone who could tap it. */}
              <div className="form-hint">
                {when.waitUntilFree
                  ? "Still due at the time above — but held, once due, until this repo's own session is free and nothing else on the desktop is starting or running."
                  : "Fires at the time above whatever else is running. Tick it to hold instead — the fix for a dozen repos anchored to the same reset all going off in one burst."}
              </div>
            </>
          )}

          {when.kind === "at" && rule && anchor && <RuleEditor m={m} />}
        </div>
      )}

      {/* The fifth WHEN, which nobody chooses: a prompt naming an upload is
          held by the HOST until the bytes land (`launch.ts`), for hours, with
          this phone closed. Said here because it changes what "now" means. */}
      {!retime && waitsForFiles > 0 && when.kind !== "at" && (
        <div className="form-hint">
          <Files size={12} /> It names {waitsForFiles} file{waitsForFiles > 1 ? "s" : ""} in the inbox — the desktop holds the
          send until {waitsForFiles > 1 ? "they have" : "it has"} arrived, even with this app closed.
        </div>
      )}
    </>
  );
}
