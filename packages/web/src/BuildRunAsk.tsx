import { useState } from "react";
import { AlertTriangle, CloudOff, Loader, Play, ShieldCheck, X } from "lucide-react";
import type { BuildConfig, BuildParam } from "@waterplane/shared";
import type { BuildParamAnswer } from "@waterplane/shared";
import { cleanParamValue, missingParamsText, paramLabel, resolveParamValues, unsafeParamIds, unsafeParamsText } from "@waterplane/shared";
import { SheetHead } from "./Sheet";
import { Unavailable } from "./Unavailable";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";
import { SetNote, SetLine } from "./SettingsKit";

/**
 * The form between the tap and the build: what this run is for.
 *
 * It exists because a parameterised command has no honest default run. Two
 * rules, both from `shared/buildparams.ts` and both re-asserted on the host:
 *
 *  • **Nothing is picked for you.** A choice with no answer yet shows no
 *    selection, and the run verb is REPLACED by the sentence saying what it
 *    still needs (`Unavailable.tsx` — never a dimmed button).
 *  • **A list that could not be read says so.** An `optionsCmd` that failed, or
 *    a phone with no link, falls back to a typed field WITH the reason. An empty
 *    drop-down and a broken one look identical, and only one of them is about
 *    this repo.
 */
export function BuildRunAsk({ build, options, online, onApprove, onCancel, onRun }: {
  build: BuildConfig;
  options?: Record<string, BuildParamAnswer>;
  online: boolean;
  /** The person's tap on "Run this listing" for one parameter. */
  onApprove: (paramId: string, cmd: string) => void;
  onCancel: () => void;
  onRun: (values: Record<string, string>) => void;
}) {
  // Seeded from the defaults and nothing else. A remembered "last value" is the
  // one thing that would make this form lie: the point of asking is that this
  // run may not be the last one.
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const p of build.params ?? []) if (p.default) seed[p.id] = p.default;
    return seed;
  });
  const { values, missing } = resolveParamValues(build.params, vals);
  const unsafe = unsafeParamIds(build.cmd, values);

  return (
    <div className="sheet">
      <SheetHead title={<><Play size={16} /> {build.name}</>} onClose={onCancel} />
      <Hint tone="mono">{build.dir ? `${build.dir}$ ` : ""}{build.cmd}</Hint>
      <div className="build-params">
        {(build.params ?? []).map((p) => (
          <ParamField key={p.id} p={p} value={vals[p.id] ?? ""} answer={options?.[p.id]} online={online} onApprove={(cmd) => onApprove(p.id, cmd)} asked={options !== undefined}
            onChange={(v) => setVals((prev) => ({ ...prev, [p.id]: cleanParamValue(v) }))} />
        ))}
      </div>
      <div className="sheet-actions">
        <Button onClick={onCancel}><X size={16} /> cancel</Button>
        <span className="spacer" />
        {missing.length === 0 && unsafe.length === 0
          ? <button className="send" onClick={() => onRun(values)}><Play size={14} /> Run</button>
          : <Unavailable cants={[{ label: "run", reason: missing.length ? missingParamsText(missing) : unsafeParamsText(unsafe) }]} />}
      </div>
      {!online && (
        <Hint>
          <CloudOff size={13} style={{ verticalAlign: "-2px" }} /> No connection: the run is queued and starts with these values once the link is back.
        </Hint>
      )}
    </div>
  );
}

/** One question, in whichever of its four states it is actually in. */
function ParamField({ p, value, answer, online, asked, onChange, onApprove }: {
  p: BuildParam;
  value: string;
  answer?: BuildParamAnswer;
  online: boolean;
  onApprove: (cmd: string) => void;
  /** Has the host been asked at all yet? Un-asked and answered-with-nothing are
   *  two different claims, and only the second is about this repo. */
  asked: boolean;
  onChange: (v: string) => void;
}) {
  const discovered = answer?.options;
  const list = discovered ?? p.options ?? [];
  const gated = !!answer?.needsApproval;
  const waiting = p.kind === "choice" && !!p.optionsCmd && !answer && !p.options?.length;
  const typed = p.kind === "text" || (!list.length && !waiting);

  return (
    <div className="build-param">
      <SetLine>
        <label>{paramLabel(p)}
          {typed
            ? <input className="search mono" value={value} autoFocus={!value} onChange={(e) => onChange(e.target.value)} />
            : waiting
              ? <SetNote as="span">{online
                ? <><Loader size={13} className="spin" style={{ verticalAlign: "-2px" }} /> reading the list…</>
                : <><CloudOff size={13} style={{ verticalAlign: "-2px" }} /> no connection — the list is read on the desktop</>}</SetNote>
              : <select value={value} onChange={(e) => onChange(e.target.value)}>
                {/* No selection until there is one. The first option is not an
                    answer somebody gave. */}
                <option value="">— pick one —</option>
                {list.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>}
        </label>
        {p.hint && <SetNote as="span">{p.hint}</SetNote>}
        {/* Where the list came from, shown because it is a command out of the
            build config that ran when this form opened — before anybody
            confirmed a run. Never a surprise. */}
        {gated && (
          <SetNote>
            <ShieldCheck size={12} style={{ verticalAlign: "-2px" }} /> This list comes from a command in the repo&apos;s committed build file. It has not been run on this desktop yet:
            <div className="mono">{answer?.cmd ?? p.optionsCmd}</div>
            {online
              ? <Button onClick={() => onApprove(answer?.cmd ?? p.optionsCmd ?? "")}><ShieldCheck size={14} /> Run this listing</Button>
              : <span><CloudOff size={12} style={{ verticalAlign: "-2px" }} /> no connection — the listing runs on the desktop.</span>}
            <span> You can also type the value instead.</span>
          </SetNote>
        )}
        {!gated && p.optionsCmd && !p.options?.length && (
          <SetNote as="span">from <span className="mono">{p.optionsCmd}</span> in the repo{answer?.total && answer.total > list.length ? ` · showing ${list.length} of ${answer.total}` : ""}</SetNote>
        )}
        {answer?.error && (
          <SetNote as="span" className="warn">
            <AlertTriangle size={12} style={{ verticalAlign: "-2px" }} /> {answer.error} — type the value instead.
          </SetNote>
        )}
        {typed && !p.optionsCmd && p.kind === "choice" && asked && !list.length && (
          <SetNote as="span">no options to offer — type the value.</SetNote>
        )}
      </SetLine>
    </div>
  );
}
