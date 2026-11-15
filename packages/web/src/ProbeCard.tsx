/**
 * The Agent readings region's "Search test" card (was "Lookup probe") (R-metrics-074), under the headline: start a
 * probe (host `probe.ts`, R-metrics-071) and read its result. No screen of its own.
 *
 *  - Which kinds are possible: model A vs B (the first use), save a baseline, rerun against a
 *    baseline — the third only once a non-void baseline is stored, and said why when it is not.
 *  - The price is shared `probeEstimate` over the same draw the host will make, shown BEFORE the
 *    tap and sent back as `accepted`; the start is a two-tap `ConfirmButton` naming the price. A
 *    refusal is the host's sentence, shown as it came.
 *  - Progress: while the status says running, the view is re-read on a timer over plain fetch (the
 *    one WebSocket carries nothing for this); nothing waits on it, and leaving the screen is fine.
 *  - The result: the correctness gate pass or fail, tokens and requests a question per arm, the
 *    paired ratio with its band said outside or within normal variation, void with its reason when
 *    the leak check fired; `probeSourceText()` once, `probeFromText` naming the desktop it ran on.
 *    Never "better" or "worse" (`probeWords.ts`).
 *  - A repo with no pool gets the host's one line on how to add one.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  probeEstimate, probeFingerprintDiff, probeFromText, probeSourceText,
  type AgentPointsResponse, type ProbeKind, type ProbeResult, type ProbeResultsView, type ProbeView,
} from "@waterplane/shared";
import { api } from "./api";
import { Button } from "./kit/Button";
import { ConfirmButton } from "./Confirm";
import { Explain } from "./Explain";
import { useOfflineGate } from "./kit/offlineGate";
import { showToast } from "./toast";
import type { RemoteResource } from "./useRemoteResource";
import {
  PROBE_AGAINST_NONE, PROBE_BASELINE_ASK, PROBE_KINDS, PROBE_KIND_HELP, PROBE_KIND_LABEL, PROBE_MODEL_B_MISSING, PROBE_MODEL_MISSING, PROBE_MODELS_ASK,
  PROBE_POOL_READING, PROBE_RESULTS_NONE, PROBE_RUNNING_ELSEWHERE, PROBE_TITLE, PROBE_WHAT, probeResultsUnreadLine,
  probeAgainstWhich, probeArmLabels, probeArmLine, probeConfirmText, probeGateLine, probeHelp, probePairLine, probeResultTitle, probeStartedText, probeStatusLine, probeVoidLine,
} from "./probeWords";

/** How often a running probe's status is re-read. */
const POLL_MS = 5000;

/** The models this repo's sessions ran, most sessions first: the inputs' suggestions and defaults. */
function seenModels(pts: AgentPointsResponse | null): string[] {
  if (!pts?.ok) return [];
  const n = new Map<string, number>();
  for (const p of pts.points) if (p.model) n.set(p.model, (n.get(p.model) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m).slice(0, 6);
}

function ResultBlock({ r, all }: { r: ProbeResultsView["results"][number]; all: ProbeResultsView["results"] }) {
  const { result, analysis: an } = r;
  const base = result.against ? all.find((x) => x.result.id === result.against) ?? null : null;
  const labels = probeArmLabels(result, base?.result ?? null);
  const arms = result.kind === "against"
    ? [...(base ? [{ label: labels.a!, s: base.analysis.arms[0]! }] : []), ...(an.arms[0] ? [{ label: labels.b!, s: an.arms[0] }] : [])]
    : an.arms.map((s, i) => ({ label: (i === 0 ? labels.a : labels.b) ?? s.model, s }));
  const fb = base?.result.fingerprints[base.result.arms[0]?.arm ?? ""];
  const fn = result.fingerprints[result.arms[0]?.arm ?? ""];
  const diff = result.kind === "against" && fb && fn ? probeFingerprintDiff(fb, fn) : "";
  return (
    <div className="ar-part-group">
      <div className="ar-chart-title">{probeResultTitle(result)}</div>
      <div className="rh-cap">{probeFromText(result)}</div>
      {an.void ? <div>{probeVoidLine(an.void)}</div> : (<>
        {result.stopped ? <div className="rh-cap">Stopped early: {result.stopped}.</div> : null}
        {diff ? <div className="rh-cap">{diff}</div> : null}
        {arms.length ? <div>{probeGateLine(arms, an.gate.pass)}</div> : null}
        {arms.map(({ label, s }) => <div key={label}>{probeArmLine(label, s)}</div>)}
        {an.paired && labels.a && labels.b ? (<>
          <div className="rh-cap">Over the {an.paired.n} questions both found every time:</div>
          <div>{probePairLine("tokens", an.paired.tokens, labels.a, labels.b)}</div>
          <div>{probePairLine("requests", an.paired.requests, labels.a, labels.b)}</div>
          <div className="rh-cap">{probePairLine("tool calls", an.paired.calls, labels.a, labels.b)} Calls repeat least well; read tokens first.</div>
        </>) : an.pairedAbsent && an.gate.pass ? <div className="rh-cap">Not compared: {an.pairedAbsent}.</div> : null}
      </>)}
    </div>
  );
}

export function ProbeCard({ repoId, view, results, pts }: {
  repoId: string;
  view: RemoteResource<ProbeView>;
  results: RemoteResource<ProbeResultsView>;
  pts: RemoteResource<AgentPointsResponse>;
}) {
  const v = view.data?.ok ? view.data : null;
  const res = results.data?.ok ? results.data.results : [];
  // Not read is not none: the empty-state words and "no baseline" need a successful read behind them.
  const resRead = results.data?.ok === true;
  const resUnread = probeResultsUnreadLine(results.state === "loading" && !results.data, results.error);
  const running = v?.status.state === "running";
  const gate = useOfflineGate();
  const models = useMemo(() => seenModels(pts.data), [pts.data]);
  const [kind, setKind] = useState<ProbeKind>("models");
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const modelA = (a ?? models[0] ?? "").trim();
  const modelB = (b ?? models[1] ?? "").trim();
  const baseline = res.find((x) => x.result.kind === "baseline" && !x.analysis.void && x.result.arms.length === 1)?.result ?? null;

  // Re-read the status while a run is live; once it ends, re-read the results once.
  const wasRunning = useRef(false);
  const reloadView = view.reload;
  const reloadResults = results.reload;
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      const t = setInterval(() => reloadView({ quiet: true }), POLL_MS);
      return () => clearInterval(t);
    }
    if (wasRunning.current) { wasRunning.current = false; reloadResults({ quiet: true }); }
    return undefined;
  }, [running, reloadView, reloadResults]);

  const plan = useMemo((): { models: string[]; questions: number; repeats: number; base?: ProbeResult } | { missing: string } | null => {
    if (!v || "absent" in v.pool) return null;
    const draw = Math.min(v.defaults.draw, v.pool.count);
    if (kind === "models") {
      if (!modelA) return { missing: PROBE_MODEL_MISSING };
      if (!modelB || modelB === modelA) return { missing: PROBE_MODEL_B_MISSING };
      return { models: [modelA, modelB], questions: draw, repeats: v.defaults.repeats };
    }
    if (kind === "baseline") return modelA ? { models: [modelA], questions: draw, repeats: v.defaults.repeats } : { missing: PROBE_MODEL_MISSING };
    if (!baseline) return { missing: resRead ? PROBE_AGAINST_NONE : resUnread };
    return { models: [baseline.arms[0]!.model], questions: baseline.questions.length, repeats: baseline.repeats, base: baseline };
  }, [v, kind, modelA, modelB, baseline, resRead, resUnread]);
  const est = plan && "models" in plan ? probeEstimate(plan.models, plan.questions, plan.repeats) : null;

  const start = gate.guard("start the probe", async () => {
    if (!plan || !("models" in plan) || !est) return;
    setRefused(null);
    try {
      const r = await api.probeStart(repoId, {
        kind, accepted: { tokens: est.tokens, usd: est.usd }, ...(v?.confirm ? { confirm: v.confirm } : {}),
        ...(kind === "against" ? { baselineId: plan.base!.id } : { models: plan.models }),
      });
      if (r.ok) { showToast(probeStartedText()); view.reload({ quiet: true }); }
      else { setRefused(r.refused); showToast(r.refused); view.reload({ quiet: true }); }
    } catch (err) {
      const why = `The desktop did not take the start: ${err instanceof Error ? err.message : String(err)}`;
      setRefused(why); showToast(why);
    }
  });

  return (
    <div className="rh-card">
      <div className="section-head">
        <span className="rh-chart-label">{PROBE_TITLE}</span>
        <Explain of={PROBE_TITLE}>{probeHelp()}</Explain>
      </div>
      <div className="rh-gutter">
        <div className="rh-cap">{PROBE_WHAT}</div>
        {!view.data ? <div className="rh-cap">{view.state === "error" || view.state === "offline" ? `The search test could not be read: ${view.error ?? "the desktop is not reachable"}` : PROBE_POOL_READING}</div>
          : !v ? <div className="rh-cap">The search test could not be read.</div>
            : "absent" in v.pool ? <div className="rh-cap">{v.pool.absent}</div>
              : running ? <div>{probeStatusLine(v.status)} {PROBE_RUNNING_ELSEWHERE}</div>
                : (<>
                  <div className="ar-share-acts" role="group" aria-label="probe kind">
                    {PROBE_KINDS.map((k) => (
                      <Button key={k} className={kind === k ? "active" : undefined} onClick={() => { setKind(k); setRefused(null); }}>{PROBE_KIND_LABEL[k]}</Button>
                    ))}
                  </div>
                  <div className="rh-cap">{PROBE_KIND_HELP[kind]}</div>
                  {kind !== "against" ? (<>
                    <div className="rh-cap">{kind === "models" ? PROBE_MODELS_ASK : PROBE_BASELINE_ASK}</div>
                    <div className="ar-share-acts">
                      <input className="ar-share-name mono" value={a ?? models[0] ?? ""} list="probe-models" maxLength={80} spellCheck={false}
                        onChange={(e) => setA(e.target.value)} aria-label={kind === "models" ? "model A" : "the baseline's model"} />
                      {kind === "models" ? (
                        <input className="ar-share-name mono" value={b ?? models[1] ?? ""} list="probe-models" maxLength={80} spellCheck={false}
                          onChange={(e) => setB(e.target.value)} aria-label="model B" />
                      ) : null}
                      <datalist id="probe-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
                    </div>
                  </>) : baseline ? <div className="rh-cap">{probeAgainstWhich(baseline)}</div> : null}
                  {plan && "missing" in plan ? <div className="rh-cap">{plan.missing}</div> : null}
                  {est ? (<>
                    <div>Estimate: {est.text}</div>
                    <div className="ar-share-acts">
                      <ConfirmButton className="key" confirm={probeConfirmText(est)} onConfirm={start}>start the test</ConfirmButton>
                    </div>
                  </>) : null}
                  {refused ? <div className="rh-cap">{refused}</div> : null}
                  {gate.note}
                </>)}

        {res.length ? <ResultBlock r={res[0]!} all={res} />
          : !resRead ? <div className="rh-cap">{resUnread}</div>
            : v && !("absent" in v.pool) ? <div className="rh-cap">{PROBE_RESULTS_NONE}</div> : null}
        {/* Once for the card (R-metrics-069). */}
        <div className="rh-cap">{probeSourceText()}</div>
      </div>
    </div>
  );
}
