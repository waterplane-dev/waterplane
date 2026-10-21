import { useState } from "react";
import { AlertTriangle, CloudOff, Loader, Play, X } from "lucide-react";
import type { BuildConfig, BuildParam } from "@waterplane/shared";
import { cleanParamValue, missingParamsText, paramLabel, resolveParamValues } from "@waterplane/shared";
import { SheetHead } from "./Sheet";
import { Unavailable } from "./Unavailable";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";

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
export function BuildRunAsk({ build, options, online, onCancel, onRun }: {
  build: BuildConfig;
  options?: Record<string, { options?: string[]; total?: number; error?: string }>;
  online: boolean;
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

  return (
    <div className="sheet">
      <SheetHead title={<><Play size={16} /> {build.name}</>} onClose={onCancel} />
      <Hint tone="mono">{build.dir ? `${build.dir}$ ` : ""}{build.cmd}</Hint>
      <div className="build-params">
        {(build.params ?? []).map((p) => (
          <ParamField key={p.id} p={p} value={vals[p.id] ?? ""} answer={options?.[p.id]} online={online} asked={options !== undefined}
            onChange={(v) => setVals((prev) => ({ ...prev, [p.id]: cleanParamValue(v) }))} />
        ))}
      </div>
      <div className="sheet-actions">
        <Button onClick={onCancel}><X size={16} /> cancel</Button>
        <span className="spacer" />
        {missing.length === 0
          ? <button className="send" onClick={() => onRun(values)}><Play size={14} /> Run</button>
          : <Unavailable cants={[{ label: "run", reason: missingParamsText(missing) }]} />}
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
function ParamField({ p, value, answer, online, asked, onChange }: {
  p: BuildParam;
  value: string;
  answer?: { options?: string[]; total?: number; error?: string };
  online: boolean;
  /** Has the host been asked at all yet? Un-asked and answered-with-nothing are
   *  two different claims, and only the second is about this repo. */
  asked: boolean;
  onChange: (v: string) => void;
}) {
  const discovered = answer?.options;
  const list = discovered ?? p.options ?? [];
  const waiting = p.kind === "choice" && !!p.optionsCmd && !answer && !p.options?.length;
  const typed = p.kind === "text" || (!list.length && !waiting);

  return (
    <div className="build-param">
      <div className="set-row">
        <label>{paramLabel(p)}
          {typed
            ? <input className="search mono" value={value} autoFocus={!value} onChange={(e) => onChange(e.target.value)} />
            : waiting
              ? <span className="set-note">{online
                ? <><Loader size={13} className="spin" style={{ verticalAlign: "-2px" }} /> reading the list…</>
                : <><CloudOff size={13} style={{ verticalAlign: "-2px" }} /> no connection — the list is read on the desktop</>}</span>
              : <select value={value} onChange={(e) => onChange(e.target.value)}>
                {/* No selection until there is one. The first option is not an
                    answer somebody gave. */}
                <option value="">— pick one —</option>
                {list.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>}
        </label>
        {p.hint && <span className="set-note">{p.hint}</span>}
        {/* Where the list came from, shown because it is a command out of the
            build config that ran when this form opened — before anybody
            confirmed a run. Never a surprise. */}
        {p.optionsCmd && !p.options?.length && (
          <span className="set-note">from <span className="mono">{p.optionsCmd}</span> in the repo{answer?.total && answer.total > list.length ? ` · showing ${list.length} of ${answer.total}` : ""}</span>
        )}
        {answer?.error && (
          <span className="set-note warn">
            <AlertTriangle size={12} style={{ verticalAlign: "-2px" }} /> {answer.error} — type the value instead.
          </span>
        )}
        {typed && !p.optionsCmd && p.kind === "choice" && asked && !list.length && (
          <span className="set-note">no options to offer — type the value.</span>
        )}
      </div>
    </div>
  );
}
