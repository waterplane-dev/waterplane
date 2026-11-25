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
 * - **Begun is not untouched.** An offer whose words this desktop saw sent
 *   (`row.sent`) or saw half done (`row.partial`) is `started`: its own list,
 *   above the fresh offers, saying when and what became of it, and its verb
 *   asks once more before sending again. The walk-through counts only the
 *   untouched ones.
 * - **Nothing applies itself.** `fix` runs the host's existing idempotent
 *   setup fix (and shows what it said); `open` lands on the screen that does
 *   the job; `download` saves the repo's own download rule (the Apps screen's write, the rest of
 *   the rule kept); `agent`/`schedule` SEED the Send sheet (`optInSeed.ts`) — words,
 *   repo, and for a schedule the clock, zone and model — and nothing is sent
 *   until the person sends it there.
 * - **A verb that cannot run is not drawn** — no repo, no send surface: the
 *   reason is a sentence (`CantInline`), never a dimmed button.
 * - A refusal from the desktop is printed as ITS sentence.
 */
import { useRef, useState } from "react";
import {
  Check, ChevronDown, ChevronRight, Compass, EyeOff, RefreshCw, RotateCcw, ToggleRight, Undo2,
} from "lucide-react";
import { optInActiveWords, optInCut, optInDef } from "@waterplane/shared";
import type {
  ComplianceReport, OptInChoice, OptInReport, OptInRow, RepoTarget,
} from "@waterplane/shared";
import { api } from "./api";
import { track } from "./usage";
import { OptInDoor, optInVerbIcon, turnDownloadsOn, untokened, useAskedDownloadRule } from "./optInActs";
import { useOfflineGate } from "./kit/offlineGate";
import { useRemoteResource } from "./useRemoteResource";
import { Empty } from "./Empty";
import { CantInline } from "./Unavailable";
import { DEVICE_TZ, type SendSeed } from "./sendIntent";
import { fixConfirmWords, fixNeedsConfirm } from "./setupRemedy";
import {
  OPTINS_GUIDE, SEND_AGAIN_CONFIRM, STARTED_GUIDE, declinedHead, noOffersWords, optInSeed, optInSentWords, optInWalkSeed,
  startedHead, unfitHead, walkLabel, walkOffered,
} from "./optInSeed";
import { ConfirmButton } from "./Confirm";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";

const ICON = 16;

export function OptInRegion({ repo, onSeed, onSeries, onChecklist }: {
  repo: RepoTarget | null;
  /** Open the Send sheet on this seed. Absent ⇒ the agent verbs say why instead. */
  onSeed?: (seed: SendSeed) => void;
  /** Switch this sheet to region 2. */
  onSeries: () => void;
  /** A `fix` returns the re-run checklist; hand it to region 1 so its rows are current. */
  onChecklist?: (report: ComplianceReport) => void;
}) {
  const repoId = repo?.id ?? "";
  /** The tokens of the report on screen, for a gated fix: in memory only. */
  const tokens = useRef<OptInReport["confirm"]>(undefined);
  const keepTokens = (r: OptInReport) => { tokens.current = r.confirm; return untokened(r); };
  const res = useRemoteResource<OptInReport>(`optins:${repoId}`, () => api.optIns(repoId).then(keepTokens), { enabled: !!repoId });
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
      if (r.ok && r.report) res.set(keepTokens(r.report));
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
      const r = await api.complianceFix(repoId, [fix], tokens.current?.[fix]);
      if (r.ok) {
        setNotes(r.notes ?? []);
        if (r.report) onChecklist?.(r.report);
        res.reload({ quiet: true });
      } else {
        setError(r.error || "the fix did not run");
        // The confirm token may have expired under an open screen: this read mints the next one.
        if (fixNeedsConfirm(fix)) res.reload({ quiet: true });
      }
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
  const gate = useOfflineGate();
  useAskedDownloadRule(repo?.worktreePath, cut.offered.concat(cut.started).some((r) => optInDef(r.id)!.action.kind === "download"));

  function turnDownloadOn(r: RepoTarget) {
    turnDownloadsOn(r);
    setTimeout(() => res.reload({ quiet: true }), 1500);
  }

  /** The primary verb for one card, by its action — or the sentence saying why it is not here. */
  function primary(row: OptInRow, again: boolean) {
    const def = optInDef(row.id)!;
    const a = def.action;
    const label = busy === row.id ? "working…" : def.verb;
    if (a.kind === "fix") {
      // Two taps, and the token this report was drawn with: the desktop refuses a gated fix without it.
      if (fixNeedsConfirm(a.fix)) {
        return (
          <ConfirmButton confirm={<>{optInVerbIcon(a)} {fixConfirmWords(a.fix) ?? def.verb}</>} onConfirm={() => void runFix(row.id, a.fix)}>
            {optInVerbIcon(a)} {label}
          </ConfirmButton>
        );
      }
      return <Button onClick={() => void runFix(row.id, a.fix)}>{optInVerbIcon(a)} {label}</Button>;
    }
    if (a.kind === "open") return <OptInDoor action={a} label={label} repo={repo} onSeries={onSeries} />;
    if (a.kind === "download" && repo) {
      if (row.partial) return <OptInDoor action={a} label="open downloads" repo={repo} onSeries={onSeries} />;
      return <><Button onClick={gate.guard("turn this repo's downloads on", () => turnDownloadOn(repo))}>{optInVerbIcon(a)} {label}</Button>{gate.note}</>;
    }
    if (!repo || !onSeed) return <CantInline>No send surface here — open this repo from the launcher to send it.</CantInline>;
    if (again) {
      return (
        <ConfirmButton confirm={SEND_AGAIN_CONFIRM} onConfirm={() => seed(optInSeed(row.id, repo, DEVICE_TZ))}>
          {optInVerbIcon(a)} {label}
        </ConfirmButton>
      );
    }
    return <Button onClick={() => seed(optInSeed(row.id, repo, DEVICE_TZ))}>{optInVerbIcon(a)} {label}</Button>;
  }

  /** One offer card; a started one says what became of it first. */
  function card(row: OptInRow, started: boolean) {
    const def = optInDef(row.id)!;
    return (
      <li key={row.id} className="check-row optin-card">
        <div className="check-top"><span className="check-label">{def.title}</span></div>
        {row.sent && <div className="check-detail optin-sent">{optInSentWords(row.sent)}</div>}
        <div className="check-detail optin-pitch">{def.pitch}</div>
        <div className="check-detail check-detail-quiet">{def.cost}</div>
        {row.detail && <div className="check-detail optin-seen">{row.detail}</div>}
        <div className="check-acts optin-acts">
          {primary(row, started && !!row.sent)}
          <Button onClick={() => void choose(row.id, "done")}><Check size={14} /> mark as done</Button>
          <Button onClick={() => void choose(row.id, "declined")}><EyeOff size={14} /> not for me</Button>
        </div>
      </li>
    );
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

        {cut.started.length > 0 && (<>
          <div className="section">{startedHead(cut.started.length)}</div>
          <Hint>{STARTED_GUIDE}</Hint>
          <ul className="check-list">{cut.started.map((row) => card(row, true))}</ul>
        </>)}

        {cut.offered.length > 0 ? (<>
          {cut.started.length > 0 && <div className="section">Not started</div>}
          <ul className="check-list">{cut.offered.map((row) => card(row, false))}</ul>
        </>) : cut.started.length === 0 && (
          <div className="empty">{noOffersWords(cut.declined.length, cut.unfit.length)}</div>
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
