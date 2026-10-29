/**
 * The scorecard sheet, for one repo: the score once, where it was read from, a refresh; the failing
 * checks (each with Ask Claude and Accept…), the ones accepted (always visible, with their reason),
 * and the passing ones folded. Opened from the chip it is cut to exactly the chip's open checks — the
 * bar says "n of N" and clears. Nothing is greyed out: a refusal is text. Words never go to a model
 * from here; Ask Claude only files a backlog row that waits for a tap.
 */
import { useState } from "react";
import { BookOpen, ExternalLink, ShieldCheck } from "lucide-react";
import { useConnStatus, useStore } from "@waterplane/sdk";
import { Button, FilterBar, Hint, RowSub, StaleHead, Tag, ago, askConfirm, useNow } from "@waterplane/kit";
import { REASON_MAX, type CheckView, type ScoreView } from "../shared/wire.mts";
import { cutChecks, openChecks, refreshWords, reasonKey, reasonProblem, sections, SLUG_RULE, slugKey, slugProblem } from "./logic.ts";
import { accept, clearCut, closeScorecard, dropDraft, drafts, openLink, refresh, remedy, scoredAs, setDraft, sheet, unaccept, views } from "./state.ts";
import "./scorecard.css";

function CheckRow({ repo, c }: { repo: string; c: CheckView }) {
  // The typed reason lives in the draft store (keyed repo+check), never in this row: the row remounts
  // when the cut clears, and typed words are the last copy.
  const key = reasonKey(repo, c.name);
  const d = useStore(drafts).get(key);
  const form = d?.open ?? false;
  const reason = d?.text ?? "";
  const [shown, setShown] = useState(false);
  const bad = shown ? reasonProblem(reason, REASON_MAX) : null;
  const submit = async () => {
    setShown(true);
    if (reasonProblem(reason, REASON_MAX)) return;
    if (await accept(repo, c.name, reason.trim())) { dropDraft(key); setShown(false); }
  };
  const stop = async () => {
    const ok = await askConfirm({ title: `Stop accepting ${c.name}?`, lines: ["It counts as failing again, and shows in the failing list."], confirmLabel: "stop accepting", tone: "info" });
    if (ok) await unaccept(repo, c.name);
  };
  return (
    <li className="check-row sc-row">
      <div className="sc-title"><b>{c.name}</b><span className="sc-n">{c.score < 0 ? "n/a" : `${c.score}/10`}</span></div>
      <RowSub as="div">{c.reason}</RowSub>
      {c.accepted && (
        <RowSub as="div" className="sc-why">
          Accepted: {c.accepted.reason}
          {c.accepted.builtIn && <> <Tag>built in</Tag> — solo maintainer can't pass this</>}
        </RowSub>
      )}
      {c.details.length > 0 && (
        <details className="sc-details">
          <summary>details · {c.details.length}</summary>
          <ul>{c.details.map((d, i) => <li key={i} className="mono">{d}</li>)}</ul>
        </details>
      )}
      <div className="annot-tools wrap">
        {c.failing && !c.accepted && (
          <>
            <Button onClick={() => void remedy(repo, c.name)}><ShieldCheck size={14} /> ask Claude</Button>
            <Button onClick={() => setDraft(key, { open: !form, text: reason })}>accept…</Button>
          </>
        )}
        {c.accepted && !c.accepted.builtIn && <Button onClick={() => void stop()}>stop accepting</Button>}
        {c.docUrl && <Button title={`what ${c.name} checks`} onClick={() => openLink(c.docUrl!)}><BookOpen size={14} /> doc</Button>}
      </div>
      {form && (
        <div className="sc-form">
          <label>why this is fine
            <textarea rows={3} value={reason} maxLength={REASON_MAX} onChange={(e) => setDraft(key, { open: true, text: e.target.value })} placeholder="solo project; …" />
          </label>
          {bad && <Hint tone="warn">{bad}</Hint>}
          <div className="annot-tools wrap"><Button variant="primary" onClick={() => void submit()}>accept {c.name}</Button><Button title="close the form; what you typed is kept" onClick={() => setDraft(key, { open: false, text: reason })}>cancel</Button></div>
        </div>
      )}
    </li>
  );
}

function ScoredAs({ repo, v }: { repo: string; v: ScoreView }) {
  // Untouched = follows the view; once the person has typed, the draft wins until saved or cleared.
  const key = slugKey(repo);
  const d = useStore(drafts).get(key);
  const text = d ? d.text : v.slugFrom === "set" ? v.slug ?? "" : "";
  const [shown, setShown] = useState(false);
  const bad = shown ? slugProblem(text) : null;
  const save = async () => {
    setShown(true);
    if (slugProblem(text)) return;
    if (await scoredAs(repo, text.trim())) { dropDraft(key); setShown(false); }
  };
  const clear = async () => { if (await scoredAs(repo, null)) { dropDraft(key); setShown(false); } };
  return (
    <div className="sc-form">
      <label>scored as (a public mirror, when this repo's own origin is private)
        <input value={text} onChange={(e) => setDraft(key, { open: true, text: e.target.value })} placeholder="owner/name" title={SLUG_RULE} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </label>
      {bad && <Hint tone="warn">{bad}</Hint>}
      <div className="annot-tools wrap">
        <Button variant="primary" onClick={() => void save()}>save</Button>
        {v.slugFrom === "set" && <Button onClick={() => void clear()}>clear — use the git remote</Button>}
      </div>
    </div>
  );
}

function List({ repo, rows, empty }: { repo: string; rows: CheckView[]; empty: string }) {
  return rows.length === 0 ? <Hint style={{ padding: "0 14px" }}>{empty}</Hint> : <ul className="check-list">{rows.map((c) => <CheckRow key={`${repo}:${c.name}`} repo={repo} c={c} />)}</ul>;
}

export function ScorecardSheet() {
  const s = useStore(sheet);
  const m = useStore(views);
  const status = useConnStatus();
  useNow(10_000);
  const repo = s.repo;
  const read = repo ? m.get(repo.id) : undefined;
  const v = read?.view ?? null;
  // What the person's own refresh found: set only after a tap that answered, cleared when the repo changes.
  const [asked, setAsked] = useState<{ repo: string; words: string | null } | null>(null);
  const askAgain = async (id: string) => {
    const before = views.get().get(id)?.view.date;
    setAsked(null);
    if (await refresh(id)) { const nv = views.get().get(id)?.view; setAsked({ repo: id, words: nv ? refreshWords(before, nv) : null }); }
  };
  const head = (
    <StaleHead title={<><ShieldCheck size={16} /> {repo ? `${repo.repoName} · scorecard` : "scorecard"}</>} onClose={closeScorecard}
      onRefresh={() => repo && void askAgain(repo.id)} refreshTitle="read the Scorecard API again" at={v?.readAt ?? null} />
  );
  if (!repo) return <div className="sheet">{head}<div className="empty">No repo chosen.</div></div>;
  if (!v) return <div className="sheet">{head}{s.err ? <div className="empty">The desktop did not answer: {s.err}</div> : <div className="empty">{status === "open" ? "Asking the desktop…" : "No connection — the desktop can't be asked from here."}</div>}</div>;
  const sec = sections(v);
  const cut = cutChecks(v, s.cut);
  return (
    <div className="sheet">
      {head}
      <div className="sheet-scroll">
        {s.err && <Hint tone="warn" style={{ padding: "0 14px" }}>{s.err}</Hint>}
        {asked && repo && asked.repo === repo.id && asked.words && !s.err && <Hint style={{ padding: "0 14px" }}>{asked.words}</Hint>}
        {v.problem && <Hint tone="warn" style={{ padding: "0 14px" }}>{v.problem}</Hint>}
        {cut && <FilterBar onClear={clearCut} clearLabel="clear">{cut.length} of {v.checks.length} checks — failing, not accepted</FilterBar>}
        {v.score != null ? (
          <div className="sc-head">
            <span className="sc-score">{v.score}/10</span>
            <div>
              <RowSub as="div">
                {v.local ? `scored locally${v.date ? ` ${v.date.slice(0, 10)}` : ""} — private repo, not the public score` : v.date ? `Scorecard scanned ${v.date.slice(0, 10)}` : ""}{v.slug ? ` · ${v.slugFrom === "set" ? `scored as ${v.slug}` : v.slug}` : ""}
              </RowSub>
              {v.viewerUrl && <Button onClick={() => openLink(v.viewerUrl!)}><ExternalLink size={14} /> public report</Button>}
            </div>
          </div>
        ) : <div className="empty">{v.absent ?? "No score yet."}</div>}
        {v.score != null && !cut && <Hint style={{ padding: "0 14px" }}>{openChecks(v).length} failing, {sec.accepted.length} accepted, {sec.passing.length} passing{v.readAt ? ` · asked ${ago(v.readAt)}` : ""}.</Hint>}

        {cut ? <List repo={repo.id} rows={cut} empty="Nothing failing and not accepted." /> : v.score != null && (
          <>
            <div className="section section-head">Failing · {sec.open.length}</div>
            <List repo={repo.id} rows={sec.open} empty="Nothing failing — every check passes or is accepted." />
            <div className="section section-head">Accepted · {sec.accepted.length}</div>
            <List repo={repo.id} rows={sec.accepted} empty="Nothing accepted." />
            <details className="sc-pass">
              <summary className="section section-head">Passing · {sec.passing.length}</summary>
              <List repo={repo.id} rows={sec.passing} empty="Nothing passes yet." />
            </details>
          </>
        )}
        <div className="section section-head">Which repo is scored</div>
        <ScoredAs key={repo.id} repo={repo.id} v={v} />
      </div>
    </div>
  );
}
