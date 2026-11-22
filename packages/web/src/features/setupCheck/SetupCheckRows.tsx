/**
 * The Setup check's rows: one finding card, and the three checked-off folds. Each card carries its
 * own controls (evidence door, remedy, waive); a control that cannot run says why in text.
 */
import { useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink, Wrench } from "lucide-react";
import { CONTEXT_CLOCK, backendsWhy, backendsWords, passedWords, seenWords } from "@waterplane/shared";
import type { BillingProfile, Finding, NotChecked, PassedCheck } from "@waterplane/shared";
import { api } from "../../api";
import { core } from "../../sdk";
import { Button, ConfirmButton, Explain, Hint, useRemoteResource } from "../../kit";
import { agentVerb, fixConfirmWords, fixNeedsConfirm, fixVerb, setupRows } from "../../setupRemedy";
import { doorOffered, evidenceLabel, savingLine, writePlanWords } from "../../setupCheckWords";
import { agentRemedy, openEvidence, permissionsDoorOn, runFix, runHostFix, seedRemedy, waive, writeRules } from "./actions";
import { WEIGHT_FINDING_ID, backendLabels, blockLines, notCheckedSentences, evidenceDoorOf, fixRoute, weightClocksOf } from "./logic";
import { SeriesSpark } from "../../RepoHealthTiles";
import { rankSentence, seriesValueWords } from "../../repoHealthWords";
import { withoutApproveToken } from "../../resourceCache";

interface RowCtx {
  repoId: string | null;
  profile?: BillingProfile;
  /** Re-read the findings after something changed. */
  reload: () => void;
  /** A repo's confirm token for a gated fix (the compliance report's). */
  confirmFor: (fixId: string) => string | undefined;
}

export function FindingCard({ f, ctx }: { f: Finding; ctx: RowCtx }) {
  const [note, setNote] = useState<string | null>(null);
  const saving = savingLine(f.saving, ctx.profile);
  const labels = backendLabels(core().world.backends);
  const be = f.backends.unread.length ? backendsWords(f.backends, labels) : "";
  const why = f.backends.unread.length ? backendsWhy(f.backends, labels) : "";
  const seen = seenWords(f.seen);
  const evidence = evidenceDoorOf(f);
  const door = evidence && doorOffered(evidence, permissionsDoorOn()) ? evidence : null;

  async function doWaive() {
    const r = await waive(f.id, true, ctx.repoId, undefined, f.waive.via);
    if (r.ok) ctx.reload(); else setNote(r.error);
  }
  async function doFix(fixId: string) {
    // A machine finding's fix is the desktop's own (`/api/host/setup/fix`), never a repo's.
    if (fixRoute(f.scope) === "host") {
      const h = await runHostFix(fixId);
      if (h.ok) { setNote(h.notes.join(" ") || "Done."); ctx.reload(); } else setNote(h.error);
      return;
    }
    if (!ctx.repoId) { setNote("Pick a repo first: a fix changes one repo's files."); return; }
    const r = await runFix(ctx.repoId, fixId, ctx.confirmFor(fixId));
    if (r.ok) { setNote(r.notes.join(" ") || "Done."); ctx.reload(); } else setNote(r.error);
  }

  const doorButton = door ? <Button title={`open ${evidenceLabel(door)}, where this is measured`} onClick={() => openEvidence(door, ctx.repoId)}><ExternalLink size={12} /> {evidenceLabel(door)}</Button> : null;
  const waiveButton = f.waive.via !== "none" ? <Button title="set this aside; it stays listed under waived and can be taken back" onClick={doWaive}>waive</Button> : null;

  return (
    <div className="sc-card" data-finding={f.id}>
      <div className="sc-what">{f.what}</div>
      {seen && <div className="sc-sub">{seen}</div>}
      {f.id === WEIGHT_FINDING_ID && ctx.repoId && <WeightClocks repoId={ctx.repoId} />}
      {saving && <div className="sc-sub">{saving}</div>}
      {be && <div className="sc-sub">{be} <Explain of="which agents this check read">{why}</Explain></div>}
      {f.remedy.kind === "write" && ctx.repoId
        ? <WriteControl repoId={ctx.repoId} target={f.remedy.target} done={ctx.reload} setNote={setNote} lead={doorButton} trail={waiveButton} />
        : <div className="sc-acts">{doorButton}<RemedyControl f={f} ctx={ctx} setNote={setNote} doFix={doFix} />{waiveButton}</div>}
      {note && <Hint>{note}</Hint>}
    </div>
  );
}

/**
 * The context-weight finding's evidence: the same weight on the series' clock. The finding's own
 * sentence states the working tree; this names the clock of the last commit the series measured (no
 * hash, no explanation: the two are never reconciled and the working-tree figure is not repeated),
 * with the two halves and the tool's rank sentence. Absent where the series has no reading: nothing
 * is drawn, never a zero.
 */
function WeightClocks({ repoId }: { repoId: string }) {
  const res = useRemoteResource(`repohealth:${repoId}:`, () => api.repoHealth(repoId, null), { cacheScrub: withoutApproveToken });
  const w = weightClocksOf(res.data?.plot?.series);
  if (!w) return null;
  const line = w.total != null && Number.isFinite(w.total) ? `${seriesValueWords(w.total)} ${CONTEXT_CLOCK.commit}` : null;
  const rank = rankSentence((w.claudeMd ?? w.desc)?.reading);
  return (
    <div className="rh-twin" data-weight-clocks>
      {line && <div className="rh-twin-line">{line}</div>}
      <ul className="rh-twin-rows">
        {[w.claudeMd, w.desc].filter((s): s is NonNullable<typeof s> => !!s).map((s) => (
          <li key={s.key}>
            <span className="rh-twin-key">{s.label}</span>
            <span className="rh-twin-val">{seriesValueWords(s.last, s.unit)}</span>
            {/* Fixed width: a card has no measured box, and this is a second look at a number, not a chart to read values off. */}
            <SeriesSpark points={s.points} width={96} height={18} label={s.label} />
          </li>
        ))}
      </ul>
      {rank && <div className="rh-twin-read">{rank}</div>}
    </div>
  );
}

function RemedyControl({ f, ctx, setNote, doFix }: { f: Finding; ctx: RowCtx; setNote: (s: string | null) => void; doFix: (id: string) => Promise<void> }) {
  const r = f.remedy;
  switch (r.kind) {
    case "seed":
      return <Button title="opens the Send sheet with the words for the agent; nothing is sent" onClick={() => { const a = seedRemedy(f, ctx.repoId); setNote(a.ok ? null : a.why); }}>ask the agent</Button>;
    case "agent":
      return <Button title="opens the Send sheet with the words for the agent; nothing is sent" onClick={() => { const a = agentRemedy(f, ctx.repoId); setNote(a.ok ? null : a.why); }}>{agentVerb(r.checkId, setupRows())}</Button>;
    case "fix":
      return fixNeedsConfirm(r.fixId)
        ? <ConfirmButton confirm={<><Wrench size={12} /> {fixConfirmWords(r.fixId) ?? "apply the fix"}</>} onConfirm={() => void doFix(r.fixId)}><Wrench size={12} /> {fixVerb(r.fixId)}</ConfirmButton>
        : <Button title="the desktop applies this patch" onClick={() => void doFix(r.fixId)}><Wrench size={12} /> {fixVerb(r.fixId)}</Button>;
    case "write":
      return <Hint>Pick a repo to write into its {r.target}.</Hint>;
    case "door":
      return doorOffered(r.route, permissionsDoorOn()) ? <Button onClick={() => openEvidence(r.route, ctx.repoId)}><ExternalLink size={12} /> {evidenceLabel(r.route)}</Button> : null;
    case "howto":
      return <Hint>{r.text}</Hint>;
  }
}

/**
 * The efficiency-rules write: shows the plan (what, which file, how many lines) before anything is written.
 * The exact text is a fold of its own and the plan a line above ONE row of actions (`lead`, write, `trail`).
 */
function WriteControl({ repoId, target, done, setNote, lead, trail }: { repoId: string; target: string; done: () => void; setNote: (s: string | null) => void; lead: ReactNode; trail: ReactNode }) {
  // The plan carries a one-shot confirm token: never cached to disk.
  const res = useRemoteResource(`efficiencyrules:${repoId}`, () => api.efficiencyRules(repoId), { cache: false });
  const st = res.data;
  const row = (button: ReactNode) => <div className="sc-acts">{lead}{button}{trail}</div>;
  if (res.error) return <><Hint tone="warn">The plan could not be read: {res.error}</Hint>{row(null)}</>;
  if (!st) return <><Hint>Reading what a write would do…</Hint>{row(null)}</>;
  const t = st.targets.find((x) => x.target === target) ?? st.targets.find((x) => x.target === st.suggested);
  if (!t) return row(null);
  const words = writePlanWords(t.plan, t.target, blockLines(st.block), t.why);
  if (t.plan === "upToDate" || t.plan === "refuse" || !st.confirm) return <><Hint tone={t.plan === "refuse" ? "warn" : undefined}>{words}</Hint>{row(null)}</>;
  return (
    <>
      <Fold head={`the exact text for ${t.target}`}><pre className="sc-block">{st.block}</pre></Fold>
      <Hint>{words}</Hint>
      {row(
        <ConfirmButton confirm={`write ${blockLines(st.block)} lines to ${t.target}`} title={`writes the rules into ${t.target}; nothing is committed`}
          onConfirm={async () => { const r = await writeRules(repoId, t.target, st.confirm!, t.sha); if (r.ok) { setNote(`Wrote the rules into ${t.target}. Nothing was committed.`); done(); } else setNote(r.error); }}>
          <Wrench size={12} /> write rules
        </ConfirmButton>,
      )}
    </>
  );
}

export function Fold({ head, open, children }: { head: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="sc-fold" open={open}>
      <summary><ChevronRight size={14} className="sk-chev" />{head}</summary>
      {children}
    </details>
  );
}

export function PassedRows({ rows, onTakeBack }: { rows: PassedCheck[]; onTakeBack?: (p: PassedCheck) => void }) {
  const labels = backendLabels(core().world.backends);
  return <>{rows.map((p) => (
    <div key={p.id} className="sc-chk">
      <div>{passedWords(p, labels)}</div>
      {onTakeBack && p.waived !== undefined && <div className="sc-acts"><Button title="list it as a finding again" onClick={() => onTakeBack(p)}>take back</Button></div>}
    </div>
  ))}</>;
}

/** Plain sentences, no rule ids: the fold is headed "not checked", so the row says only why. Two rules with one reason read once. */
export function NotCheckedRows({ rows }: { rows: NotChecked[] }) {
  return <>{notCheckedSentences(rows).map((w) => <div key={w} className="sc-chk"><div>{w}</div></div>)}</>;
}
