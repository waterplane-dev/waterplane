import { useState } from "react";
import { CalendarClock, CloudOff, Gauge, X } from "lucide-react";
import type { BuildConfig, BuildParamAnswer, ScheduleEntry, WindowResets } from "@waterplane/shared";
import { cleanParamValue } from "@waterplane/shared";
import { SheetHead } from "./Sheet";
import { Unavailable } from "./Unavailable";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";
import { RadioRows } from "./kit";
import { ParamField } from "./BuildRunAsk";
import { RuleEditor } from "./send/RuleEditor";
import { useRuleFields } from "./send/useRuleFields";
import { previewOf, type SendWhen } from "./sendIntent";
import { buildScheduleBlocker, buildScheduleValues, buildScheduleWhen } from "./buildSchedule";

/**
 * **Run this build on a clock** — the schedule-a-build form, opened from the
 * entry's own editor (`run on a clock…`) or from a build rule's card (*edit*).
 *
 * The WHEN is the Send sheet's own `RuleEditor` over the same state hook
 * (`useRuleFields`), never a second copy of the rule logic; only the anchor
 * row (*at a time* / *a usage window*) is drawn here, since a build has no
 * *now* or *after another…* on a clock. The parameter fields are
 * `BuildRunAsk`'s, seeded from the build's stored defaults and nothing else
 * (or, editing, from the rule's own values): a missing value REPLACES Save
 * with the sentence. The name is the rule editor's own field under *more*;
 * left empty, the rule takes the build's name.
 *
 * Save hands the entry back; the caller sends it as `schedule.save` on the
 * durable queue (`queueOp`, ackId) — no send path of its own.
 */
export function BuildScheduleForm({ build, entry, usage, options, online, onApprove, onCancel, onSave }: {
  build: BuildConfig;
  /** The rule being edited, or null for a new one. */
  entry: ScheduleEntry | null;
  usage?: WindowResets | null;
  options?: Record<string, BuildParamAnswer>;
  online: boolean;
  onApprove: (paramId: string, cmd: string) => void;
  onCancel: () => void;
  onSave: (when: Extract<SendWhen, { kind: "at" }>, vals: Record<string, string>, preview: number | null) => void;
}) {
  const [when, setWhen] = useState<SendWhen>(() => buildScheduleWhen(entry, Date.now()));
  const [vals, setVals] = useState<Record<string, string>>(() => buildScheduleValues(build, entry));
  const fields = useRuleFields(when, setWhen);
  const preview = previewOf(when, usage ?? undefined);
  const blocker = buildScheduleBlocker(build, vals, when, preview);
  const at = when.kind === "at" ? when : null;

  return (
    <div className="sheet">
      <SheetHead title={<><CalendarClock size={16} /> {entry ? "Edit the schedule" : "Run on a clock"} · {build.name}</>} onClose={onCancel} />
      <div className="build-body">
        <Hint tone="mono">{build.dir ? `${build.dir}$ ` : ""}{build.cmd}</Hint>
        {build.params?.length ? (
          <div className="build-params">
            {build.params.map((p) => (
              <ParamField key={p.id} p={p} value={vals[p.id] ?? ""} answer={options?.[p.id]} online={online} asked={options !== undefined}
                onApprove={(cmd) => onApprove(p.id, cmd)}
                onChange={(v) => setVals((prev) => ({ ...prev, [p.id]: cleanParamValue(v) }))} />
            ))}
          </div>
        ) : null}
        <div className="send-exp">
          <div className="section section-head"><span>What it waits for</span></div>
          <RadioRows<"clock" | "window"> label="What it waits for"
            value={fields.anchor === "window" ? "window" : "clock"}
            options={[
              { key: "clock", label: <><CalendarClock size={13} /> at a time</> },
              { key: "window", label: <><Gauge size={13} /> a usage window</>, title: "anchor this to a usage window resetting, rather than to a time of day" },
            ]}
            onChange={(k) => fields.switchAnchor(k)} />
          <RuleEditor m={{ ...fields, when, setWhen, preview, usage, retime: null }} />
        </div>
      </div>
      <div className="sheet-actions">
        <Button onClick={onCancel}><X size={16} /> cancel</Button>
        <span className="spacer" />
        {!blocker && at
          ? <button className="send" onClick={() => onSave(at, vals, preview)}><CalendarClock size={14} /> Save</button>
          : <Unavailable cants={[{ label: "save", reason: blocker ?? "" }]} />}
      </div>
      {!online && (
        <Hint>
          <CloudOff size={13} style={{ verticalAlign: "-2px" }} /> No connection: the schedule is queued and saved on the desktop once the link is back.
        </Hint>
      )}
    </div>
  );
}
