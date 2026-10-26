// The exposure watch's person-facing half on the setup checklist: accept a finding (with a
// reason, for a while or for good), and the "Accepted (n)" list that keeps every accept visible.
// Sentences are exposureWords.ts's. Nothing here applies itself: the host re-checks the request.
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import type { ComplianceAcceptRequest, ComplianceCheck } from "@waterplane/shared";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";
import { RadioRows } from "./kit/RadioRows";
import {
  BUILT_IN_WORDS, acceptRefusal, acceptRequest, acceptedHead, acceptedLine, digestHead, untilChoices,
  untilVersionOffered, type UntilChoice,
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
                : <Button title="Stop accepting this finding; it counts again" onClick={() => onStop(c.id)}>stop accepting</Button>}
            </div>
            <div className="check-detail check-detail-quiet">{acceptedLine(c.accepted!, now)}</div>
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
