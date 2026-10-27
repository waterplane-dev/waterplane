// The exposure watch's person-facing half on the setup checklist: accept a finding (with a
// reason, for a while or for good), and the "Accepted (n)" list that keeps every accept visible.
// Sentences are exposureWords.ts's. Nothing here applies itself: the host re-checks the request.
import { useState, type ReactNode } from "react";
import { ChevronDown, BadgeCheck, ChevronRight, ShieldCheck } from "lucide-react";
import { triageWords, type ComplianceAcceptRequest, type ComplianceCheck, type ComplianceTriageRequest, type ExposureTriage } from "@waterplane/shared";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";
import { RadioRows } from "./kit/RadioRows";
import {
  BUILT_IN_WORDS, TRIAGE_STATES, acceptRefusal, acceptRequest, acceptedByMark, acceptedHead, acceptedLine,
  clearTriageRequest, digestHead, staleMarksHead, triageControl, triageRefusal, triageRequest, untilChoices, untilVersionOffered,
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
    <div className="check-acts" style={{ display: "block" }}>
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
      <div className="check-acts" style={{ display: "block" }}>
        {ctl.line && <div className="check-detail check-detail-quiet">{ctl.line}</div>}
        <div className="check-acts">
          <Button onClick={openForm}>
            <BadgeCheck size={12} /> {ctl.open}
          </Button>
          {ctl.canClear && (
            <Button onClick={() => void send(clearTriageRequest(check.id), false)}>{sending ? "Clearing…" : "Clear mark"}</Button>
          )}
        </div>
        {error && <Hint tone="warn">{error}</Hint>}
      </div>
    );
  }
  const refusal = triageRefusal(state, fixedIn, commit, note);
  return (
    <div className="check-acts" style={{ display: "block" }}>
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
export function AcceptedSection({ rows, now, onStop, onClearMark }: {
  rows: ComplianceCheck[];
  now: number;
  onStop: (id: string) => void;
  onClearMark: (id: string) => void;
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
                : acceptedByMark(c)
                ? <Button onClick={() => onClearMark(c.id)}>Clear mark</Button>
                : <Button onClick={() => onStop(c.id)}>stop accepting</Button>}
            </div>
            <div className="check-detail check-detail-quiet">{acceptedLine(c.accepted!, now)}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** "Marked, not in today's reading (n)": marks whose group is absent from the newest reading (it may return).
 *  Each says its mark in the shared words and clears with the same triage request as a card's Clear mark. */
export function StaleMarksSection({ marks, onClear }: {
  marks: Array<{ triageId: string; triage: ExposureTriage }>;
  onClear: (triageId: string) => void;
}) {
  if (!marks.length) return null;
  return (
    <>
      <div className="section">{staleMarksHead(marks.length)}</div>
      <ul className="check-list">
        {marks.map((m) => (
          <li key={m.triageId} className="check-row check-ignored">
            <div className="check-top">
              <span className="check-icon"><BadgeCheck size={16} color="var(--dim)" /></span>
              <span className="check-label">{m.triageId.replace(/^exposure:/, "")}</span>
              <Button onClick={() => onClear(m.triageId)}>Clear mark</Button>
            </div>
            <div className="check-detail check-detail-quiet">{triageWords(m.triage)}</div>
          </li>
        ))}
      </ul>
    </>
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
