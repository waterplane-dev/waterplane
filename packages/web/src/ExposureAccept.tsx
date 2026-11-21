// The exposure watch's person-facing half on the setup checklist: accept a finding (with a
// reason, for a while or for good), and the "Accepted (n)" list that keeps every accept visible.
// Sentences are exposureWords.ts's. Nothing here applies itself: the host re-checks the request.
import { useState, type ReactNode } from "react";
import { ChevronDown, BadgeCheck, ChevronRight, CircleAlert, CircleCheck, CircleHelp, RotateCcw, Send, ShieldCheck } from "lucide-react";
import { type ComplianceAcceptRequest, type ComplianceCheck, type ComplianceTriageRequest, type ExposureTriage } from "@waterplane/shared";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";
import { Explain } from "./Explain";
import { RadioRows } from "./kit/RadioRows";
import {
  BUILT_IN_WORDS, TRIAGE_STATES, acceptRefusal, acceptRequest, acceptedHead, acceptedLine,
  MARKED_STALE_WORDS, MARKED_UNCHECKED_WORDS, MARKED_WORDS, NOT_MEASURED_NEXT, REOPEN_LABEL, REOPEN_WORDS,
  clearTriageRequest, crashOfGroup, crashTitle, digestHead, markShort, markedHead, notMeasuredLine, triageControl, watchRowTitle, watchTally, watchVerdict, triageRefusal, triageRequest, untilChoices, untilVersionOffered,
  type TriageState, type UntilChoice,
} from "./exposureWords";

/** `Accept…` under an exposure card; opens the form in place. `onAccept` resolves to the host's
 *  refusal as text, or null when it took it (the form then closes). */
export function AcceptControl({ check, onAccept }: {
  check: ComplianceCheck;
  onAccept: (req: ComplianceAcceptRequest) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [choice, setChoice] = useState<UntilChoice>("change");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const offered = untilVersionOffered(check);

  if (!open) {
    return (
      <div className="check-acts">
        <Button onClick={() => setOpen(true)} title="Accept this finding, with a reason">
          <ShieldCheck size={12} /> Accept…
        </Button>
      </div>
    );
  }
  const refusal = acceptRefusal(reason, choice, value);
  async function submit() {
    setSending(true);
    setError(null);
    const err = await onAccept(acceptRequest(check.id, reason, choice, value));
    setSending(false);
    // Typed words stay on a refusal: the form is the last copy of them.
    if (err) setError(err); else setOpen(false);
  }
  return (
    <div className="check-acts check-form">
      <Hint>Accepting keeps the row, with your reason, under Accepted — it is not counted while accepted.</Hint>
      <textarea className="search" rows={2} value={reason} autoFocus placeholder="why is this fine here?"
        aria-label="reason" onChange={(e) => setReason(e.target.value)} />
      <RadioRows label="How long" value={choice} onChange={(k) => { setChoice(k); setValue(""); }}
        options={untilChoices(offered)} />
      {choice === "date" && (
        <input className="search" type="date" value={value} aria-label="accept until"
          onChange={(e) => setValue(e.target.value)} />
      )}
      {choice === "version" && (
        <input className="search mono" value={value} aria-label="newest version you accept"
          placeholder={`newest version you accept (now ${offered})`} onChange={(e) => setValue(e.target.value)} />
      )}
      {error && <Hint tone="warn">{error}</Hint>}
      <div className="check-acts check-acts-split">
        {refusal ? <Hint as="span">{refusal}</Hint>
          : <Button variant="primary" onClick={() => void submit()}>{sending ? "Accepting…" : "Accept"}</Button>}
        <Button onClick={() => { setOpen(false); setError(null); }}>cancel</Button>
      </div>
    </div>
  );
}

/** `Mark…` under an exposure card: seen / investigating / fixed in <version>. `onMark` resolves to the host's
 *  refusal as text, or null when it took it. A marked card offers Change mark… and Clear mark. */
export function TriageControl({ check, onMark }: {
  check: ComplianceCheck;
  onMark: (req: ComplianceTriageRequest) => Promise<string | null>;
}) {
  const t = check.exposure?.triage;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TriageState>(t?.state ?? "seen");
  const [fixedIn, setFixedIn] = useState(t?.fixedIn ?? "");
  const [commit, setCommit] = useState(t?.commit ?? "");
  const [note, setNote] = useState(t?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ctl = triageControl(check);
  // The fields seed from the CURRENT mark each time the form opens, never from the first render: the
  // instance outlives report refreshes, so a mark made since would otherwise be silently downgraded.
  function openForm() {
    const cur = check.exposure?.triage;
    setState(cur?.state === "fixed" && !ctl.offerFixed ? "seen" : cur?.state ?? "seen");
    setFixedIn(cur?.fixedIn ?? "");
    setCommit(cur?.commit ?? "");
    setNote(cur?.note ?? "");
    setError(null);
    setOpen(true);
  }

  async function send(req: ComplianceTriageRequest, close: boolean) {
    setSending(true);
    setError(null);
    const err = await onMark(req);
    setSending(false);
    // Typed words stay on a refusal: the form is the last copy of them.
    if (err) setError(err); else if (close) setOpen(false);
  }
  if (!open) {
    return (
      <>
        {ctl.line && <div className="check-detail check-detail-quiet">{ctl.line}</div>}
        <div className="check-acts">
          <Button onClick={openForm}>
            <BadgeCheck size={12} /> {ctl.open}
          </Button>
          {ctl.canClear && (
            <Button onClick={() => void send(clearTriageRequest(check.id), false)}>{sending ? "Reopening…" : REOPEN_LABEL}</Button>
          )}
        </div>
        {error && <Hint tone="warn">{error}</Hint>}
      </>
    );
  }
  const refusal = triageRefusal(state, fixedIn, commit, note);
  return (
    <div className="check-acts check-form">
      <Hint>{TRIAGE_STATES.find((s) => s.key === state)!.hint}</Hint>
      <RadioRows label="Mark as" value={state} onChange={setState}
        options={TRIAGE_STATES.filter((s) => s.key !== "fixed" || ctl.offerFixed).map((s) => ({ key: s.key, label: s.label }))} />
      {!ctl.offerFixed && <Hint>{ctl.noFixedWhy}</Hint>}
      {state === "fixed" && (
        <>
          <input className="search mono" value={fixedIn} aria-label="version that carries the fix" autoFocus
            placeholder="the version that carries the fix" onChange={(e) => setFixedIn(e.target.value)} />
          <input className="search mono" value={commit} aria-label="commit (optional)"
            placeholder="commit (optional)" onChange={(e) => setCommit(e.target.value)} />
        </>
      )}
      <textarea className="search" rows={2} value={note} aria-label="note (optional)" placeholder="note (optional)"
        onChange={(e) => setNote(e.target.value)} />
      {error && <Hint tone="warn">{error}</Hint>}
      <div className="check-acts check-acts-split">
        {refusal ? <Hint as="span">{refusal}</Hint>
          : <Button variant="primary" onClick={() => void send(triageRequest(check.id, state, fixedIn, commit, note), true)}>
            {sending ? "Marking…" : "Mark"}
          </Button>}
        <Button onClick={() => { setOpen(false); setError(null); }}>cancel</Button>
      </div>
    </div>
  );
}

/** "Accepted (n)": every accepted row, with its reason. A built-in one has no way back here. */
export function AcceptedSection({ rows, now, onStop }: {
  rows: ComplianceCheck[];
  now: number;
  onStop: (id: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <>
      <div className="section">{acceptedHead(rows.length)}</div>
      <ul className="check-list">
        {rows.map((c) => (
          <li key={c.id} className="check-row check-ignored">
            <div className="check-top">
              <span className="check-icon"><ShieldCheck size={16} color="var(--dim)" /></span>
              <span className="check-label">{c.label}</span>
              {c.accepted!.builtIn
                ? <Hint as="span">{BUILT_IN_WORDS}</Hint>
                : <Button onClick={() => onStop(c.id)}>stop accepting</Button>}
            </div>
            <div className="check-detail check-detail-quiet">{acceptedLine(c.accepted!, now)}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The answer the region opens with: is anything open today? Counts come from `exposureCut`, so the
 *  number is the rows drawn below. A measure the reading could not take heads it as UNKNOWN, never as clean. */
export function WatchVerdict({ summary, alerts, digest, marked, accepted, now, investigate }: {
  summary: ComplianceCheck;
  alerts: number; digest: number; marked: number; accepted: number; now: number;
  /** Hand every open crash group to the agent to investigate and mark (seeds Send; nothing is sent by the tap). */
  investigate?: { label: string; run: () => void } | null;
}) {
  const nm = summary.notMeasured ?? [];
  // An older host sends no readAt/notMeasured: fall back to its own sentence, never to a guessed verdict.
  if (summary.readAt === undefined && !nm.length) {
    return <div className="watch-verdict watch-unknown"><div className="watch-verdict-sub">{summary.detail}</div></div>;
  }
  const stale = summary.status !== "pass" && !nm.length;
  const v = watchVerdict({ alerts, digest, marked, accepted, notMeasured: nm.length, stale });
  const Icon = v.tone === "ok" ? CircleCheck : v.tone === "needs" ? CircleAlert : CircleHelp;
  return (
    <div className={`watch-verdict watch-${v.tone}`} data-check={summary.id}>
      <div className="watch-verdict-head"><Icon size={20} /> {v.head}</div>
      <div className="watch-verdict-sub">{watchTally({ readAt: summary.readAt ?? null, now, marked, accepted, digest })}</div>
      {nm.map((m) => <div key={m.measure} className="watch-verdict-why">{notMeasuredLine(m)}</div>)}
      {nm.length > 0 && <Hint>{NOT_MEASURED_NEXT}</Hint>}
      {investigate && (
        <div className="check-acts">
          <Button onClick={investigate.run}><Send size={12} /> {investigate.label}</Button>
        </div>
      )}
    </div>
  );
}

/** "Marked fixed (n)": every crash group with a fixed mark — the ones today's reading still lists (old installs)
 *  and the ones it does not. What the marks mean is behind a `?`; each row its app, error, place and fix. */
export function MarkedSection({ rows, stale, unread, onReopen }: {
  rows: ComplianceCheck[];
  stale: Array<{ triageId: string; triage: ExposureTriage }>;
  /** The crash list could not be read today: a stale mark was not CHECKED, not absent. */
  unread: boolean;
  onReopen: (triageId: string) => void;
}) {
  const n = rows.length + stale.length;
  if (!n) return null;
  return (
    <>
      <div className="section">{markedHead(n)} <Explain of="marked fixed">{MARKED_WORDS} {REOPEN_WORDS}</Explain></div>
      <ul className="check-list">
        {rows.map((c) => {
          const { title, where } = watchRowTitle(c);
          const from = c.exposure?.appVersion;
          return <MarkedRow key={c.id} id={c.id} t={c.exposure?.triage} title={title} where={where}
            state={from ? `seen on v${from}` : null} onReopen={onReopen} />;
        })}
        {stale.map((m) => {
          const crash = crashOfGroup(m.triageId);
          const { title, where } = crash ? crashTitle(crash) : { title: m.triageId, where: null };
          return <MarkedRow key={m.triageId} id={m.triageId} t={m.triage} title={title} where={where}
            state={unread ? MARKED_UNCHECKED_WORDS : MARKED_STALE_WORDS} onReopen={onReopen} />;
        })}
      </ul>
    </>
  );
}

function MarkedRow({ id, t, title, where, state, onReopen }: {
  id: string; t: ExposureTriage | undefined; title: string; where: string | null; state: string | null;
  onReopen: (id: string) => void;
}) {
  // The note is context, not the headline: two lines until tapped, then all of it.
  const [noteOpen, setNoteOpen] = useState(false);
  return (
    <li className="check-row check-ignored">
      <div className="check-top">
        <span className="check-icon"><BadgeCheck size={16} color="var(--ok)" /></span>
        <span className="check-label">{title}</span>
        <Button onClick={() => onReopen(id)}><RotateCcw size={12} /> {REOPEN_LABEL}</Button>
      </div>
      {where && <div className="check-detail">{where}</div>}
      <div className="check-detail check-detail-quiet">{[t ? markShort(t) : null, state].filter(Boolean).join(" · ")}</div>
      {/* raw: a tap target over prose, not a control the kit draws */}
      {t?.note && <button type="button" className={`check-detail check-detail-quiet mark-note${noteOpen ? " open" : ""}`}
        aria-expanded={noteOpen} onClick={() => setNoteOpen(!noteOpen)}>{t.note}</button>}
    </li>
  );
}

/** The digest rows as ONE closed head (ciqkit has ~28); the cards are the caller's. */
export function DigestGroup({ n, children }: { n: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!n) return null;
  return (
    <>
      <div className="section">
        <Button onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {digestHead(n)}
        </Button>
      </div>
      {open && <ul className="check-list">{children}</ul>}
    </>
  );
}
