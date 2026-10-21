/**
 * `Repo readings`, region 3 — **Opt-ins**: the advanced things a repo can turn
 * on, as offers. The catalog, its words and the ONE bucketing function are
 * `shared/optins.ts`'s; read its header first.
 *
 * Not a reading at all, and that is why it is a region of its own rather than
 * rows on the checklist: a repo without a weekly security review is not
 * BROKEN, so nothing here has a stripe, a pass/warn/fail colour or a place in
 * the badge. It is counted in NOTHING.
 *
 * - **Every count and every list is `optInCut`'s** — the cards, the *On* rows
 *   and the two folded heads come from one call, so a number cannot disagree
 *   with the list it opens. Folded lists start closed; the count IS the list.
 * - **Nothing applies itself.** `fix` runs the host's existing idempotent
 *   setup fix (and shows what it said); `open` lands on the screen that does
 *   the job; `agent`/`schedule` SEED the Send sheet (`optInSeed.ts`) — words,
 *   repo, and for a schedule the clock, zone and model — and nothing is sent
 *   until the person sends it there.
 * - **A verb that cannot run is not drawn** — no repo, no send surface: the
 *   reason is a sentence (`CantInline`), never a dimmed button.
 * - A refusal from the desktop is printed as ITS sentence.
 */
import { useState } from "react";
import {
  Activity, CalendarClock, Check, ChevronDown, ChevronRight, Compass, EyeOff, RefreshCw, RotateCcw, ScanEye, Send,
  ToggleRight, Undo2, Wrench,
} from "lucide-react";
import { optInActiveWords, optInCut, optInDef } from "@waterplane/shared";
import type {
  ComplianceReport, OptInAction, OptInChoice, OptInReport, OptInRow, RepoTarget,
} from "@waterplane/shared";
import { api } from "./api";
import { track } from "./usage";
import { useRemoteResource } from "./useRemoteResource";
import { Empty } from "./Empty";
import { CantInline } from "./Unavailable";
import { DEVICE_TZ, type SendSeed } from "./sendIntent";
import {
  OPTINS_GUIDE, declinedHead, noOffersWords, optInSeed, optInWalkSeed, unfitHead, walkLabel, walkOffered,
} from "./optInSeed";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";

const ICON = 16;

/** One icon per meaning — the verb's glyph says what kind of tap it is. */
function verbIcon(a: OptInAction) {
  switch (a.kind) {
    case "fix": return <Wrench size={14} />;
    case "open": return a.to === "series" ? <Activity size={14} /> : <ScanEye size={14} />;
    case "agent": return <Send size={14} />;
    case "schedule": return <CalendarClock size={14} />;
  }
}

export function OptInRegion({ repo, onSeed, onSeries, onCapture, onChecklist }: {
  repo: RepoTarget | null;
  /** Open the Send sheet on this seed. Absent ⇒ the agent verbs say why instead. */
  onSeed?: (seed: SendSeed) => void;
  /** Switch this sheet to region 2. */
  onSeries: () => void;
  /** Open the capture sheet for this repo. */
  onCapture?: (repo: RepoTarget) => void;
  /** A `fix` returns the re-run checklist; hand it to region 1 so its rows are current. */
  onChecklist?: (report: ComplianceReport) => void;
}) {
  const repoId = repo?.id ?? "";
  const res = useRemoteResource<OptInReport>(`optins:${repoId}`, () => api.optIns(repoId), { enabled: !!repoId });
  const report = res.data;
  /** The WRITE half: which id is in flight, and what the desktop said. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [openDeclined, setOpenDeclined] = useState(false);
  const [openUnfit, setOpenUnfit] = useState(false);

  async function choose(id: string, choice: OptInChoice | null) {
    if (!repoId || busy) return;
    track(choice === "declined" ? "action:optins.decline" : choice === "done" ? "action:optins.done" : "action:optins.clear");
    setBusy(id); setError(null); setNotes([]);
    try {
      const r = await api.optInChoice(repoId, id, choice);
      if (r.ok && r.report) res.set(r.report);
      else if (r.ok) res.reload({ quiet: true });
      else setError(r.error || "the desktop did not store it");
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(null);
    }
  }

  async function runFix(id: string, fix: string) {
    if (!repoId || busy) return;
    track("action:optins.fix");
    setBusy(id); setError(null); setNotes([]);
    try {
      const r = await api.complianceFix(repoId, [fix]);
      if (r.ok) {
        setNotes(r.notes ?? []);
        if (r.report) onChecklist?.(r.report);
        res.reload({ quiet: true });
      } else setError(r.error || "the fix did not run");
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(null);
    }
  }

  function seed(s: SendSeed | null) {
    if (s && onSeed) { track("action:optins.seed"); onSeed(s); }
  }

  const cut = optInCut(report?.rows ?? []);

  /** The primary verb for one card, by its action — or the sentence saying why it is not here. */
  function primary(row: OptInRow) {
    const def = optInDef(row.id)!;
    const a = def.action;
    const label = busy === row.id ? "working…" : def.verb;
    if (a.kind === "fix") {
      return <Button onClick={() => void runFix(row.id, a.fix)}>{verbIcon(a)} {label}</Button>;
    }
    if (a.kind === "open" && a.to === "series") {
      return <Button onClick={() => { track("action:optins.series"); onSeries(); }}>{verbIcon(a)} {label}</Button>;
    }
    if (a.kind === "open") {
      if (!repo || !onCapture) return <CantInline>The capture screen cannot be opened from here.</CantInline>;
      return <Button onClick={() => { track("action:optins.capture"); onCapture(repo); }}>{verbIcon(a)} {label}</Button>;
    }
    if (!repo || !onSeed) return <CantInline>No send surface here — open this repo from the launcher to send it.</CantInline>;
    return <Button onClick={() => seed(optInSeed(row.id, repo, DEVICE_TZ))}>{verbIcon(a)} {label}</Button>;
  }

  return (
    <>
      <div className="section-head">
        <span className="section section-hint">{OPTINS_GUIDE}</span>
        <Button onClick={() => res.reload({ quiet: true })} title="read the offers again">
          <RefreshCw size={14} className={res.inflight ? "spin" : undefined} /> re-check
        </Button>
      </div>

      <Empty res={res} empty={!report} thing="the opt-ins" noun="list of opt-ins">
        The desktop listed no opt-ins for this repo.
      </Empty>
      {error && <Hint style={{ color: "var(--dead)" }}>The desktop said: {error}</Hint>}
      {notes.map((n, i) => <Hint key={i}>{n}</Hint>)}

      {report && (<>
        {repo && onSeed && walkOffered(cut.offered) && (
          <>
            <button className="send" onClick={() => seed(optInWalkSeed(cut.offered, repo))}>
              <Compass size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
              {walkLabel(cut.offered.length)}
            </button>
            <Hint>
              One session that asks which of these you want, then posts each one as its own piece of work. Nothing is set up in it.
            </Hint>
          </>
        )}

        {cut.offered.length === 0 ? (
          <div className="empty">{noOffersWords(cut.declined.length, cut.unfit.length)}</div>
        ) : (
          <ul className="check-list">
            {cut.offered.map((row) => {
              const def = optInDef(row.id)!;
              return (
                <li key={row.id} className="check-row optin-card">
                  <div className="check-top"><span className="check-label">{def.title}</span></div>
                  <div className="check-detail optin-pitch">{def.pitch}</div>
                  <div className="check-detail check-detail-quiet">{def.cost}</div>
                  {row.detail && <div className="check-detail optin-seen">{row.detail}</div>}
                  <div className="check-acts optin-acts">
                    {primary(row)}
                    {row.state === "unknown" && (
                      <Button onClick={() => void choose(row.id, "done")}><Check size={14} /> mark as done</Button>
                    )}
                    <Button onClick={() => void choose(row.id, "declined")}><EyeOff size={14} /> not for me</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {cut.active.length > 0 && (<>
          <div className="section">On</div>
          <ul className="check-list">
            {cut.active.map((row) => (
              <li key={row.id} className="check-row optin-on">
                <div className="check-top">
                  <span className="check-label">{optInDef(row.id)!.title}<span className="check-kind"> · {optInActiveWords(row)}</span></span>
                  {row.choice === "done" && (
                    <Button onClick={() => void choose(row.id, null)}><Undo2 size={14} /> undo</Button>
                  )}
                </div>
                {row.detail && <div className="check-detail check-detail-quiet">{row.detail}</div>}
              </li>
            ))}
          </ul>
        </>)}

        {cut.declined.length > 0 && (<>
          <button className="section optin-fold" onClick={() => setOpenDeclined((o) => !o)} aria-expanded={openDeclined}>
            {openDeclined ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {declinedHead(cut.declined.length)}
          </button>
          {openDeclined && (
            <ul className="check-list">
              {cut.declined.map((row) => (
                <li key={row.id} className="check-row optin-on">
                  <div className="check-top">
                    <span className="check-label">{optInDef(row.id)!.title}</span>
                    <Button onClick={() => void choose(row.id, null)}><RotateCcw size={14} /> offer again</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>)}

        {cut.unfit.length > 0 && (<>
          <button className="section optin-fold" onClick={() => setOpenUnfit((o) => !o)} aria-expanded={openUnfit}>
            {openUnfit ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {unfitHead(cut.unfit.length)}
          </button>
          {openUnfit && (
            <ul className="check-list">
              {cut.unfit.map((row) => (
                <li key={row.id} className="check-row optin-on">
                  <div className="check-top"><span className="check-label">{optInDef(row.id)!.title}</span></div>
                  <div className="check-detail check-detail-quiet">{row.detail || "The desktop did not say why."}</div>
                </li>
              ))}
            </ul>
          )}
        </>)}
      </>)}
    </>
  );
}

/** The repo menu's door to region 3 — `RepoHealthMenuItem`'s shape, landing on `optins`. */
export function OptInMenuItem({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="more-act" onClick={onOpen} title="optional things this repo can turn on">
      <ToggleRight size={ICON} />opt-ins
    </button>
  );
}
