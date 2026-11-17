import { useEffect, useRef, useState } from "react";
import { ClipboardCopy, SquareTerminal } from "lucide-react";
import { BRAND, backendsWords, findingCut, passedWords, savingWords } from "@waterplane/shared";
import type { Finding } from "@waterplane/shared";
import type { FindingsDoc, ToExtension, ToWebview } from "../src/protocol";
import { Button } from "@waterplane/kit";
import { Absent } from "./Absent";
import { Loading } from "./Loading";

let taps = 0;

/** Where a finding's evidence lives in this panel, as one button; null where the panel has no such view. */
function evidenceOf(f: Finding, folder: string, post: (m: ToExtension) => void): { label: string; go: () => void } | null {
  const e = f.evidence;
  if (!e) return null;
  switch (e.screen) {
    case "alwayson": return { label: "Open always-on context", go: () => post({ t: "openPanel", tab: "always-on" }) };
    case "tokens": return { label: "Open all sessions", go: () => post({ t: "openPanel", tab: "all" }) };
    case "readings": return { label: "Open repo health", go: () => post({ t: "openPanel", tab: "health" }) };
    case "file": return { label: `Open ${e.path}`, go: () => post({ t: "openFile", folder, path: e.path }) };
    default: return null;
  }
}

/** [Copy] and [Type into terminal] for one finding's remedy text. Typed, never sent; the receipt is the extension's. */
function RemedyActions({ id, terminal, post }: { id: string; terminal: string | null; post: (m: ToExtension) => void }) {
  const [said, setSaid] = useState<string | null>(null);
  const mine = useRef<number | null>(null);
  useEffect(() => {
    const on = (e: MessageEvent<ToWebview>) => {
      const m = e.data;
      if (m && typeof m === "object" && m.t === "receipt" && m.tap != null && m.tap === mine.current) setSaid(m.text);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  const send = (how: "copy" | "terminal") => {
    mine.current = ++taps;
    setSaid(null);
    post({ t: "finding", id, how, tap: mine.current });
  };
  return (
    <div className="prompt-actions">
      <div className="btn-row">
        <Button type="button" onClick={() => send("copy")}><ClipboardCopy size={14} aria-hidden /> Copy the prompt</Button>
        {terminal != null && <Button type="button" onClick={() => send("terminal")}><SquareTerminal size={14} aria-hidden /> Type into terminal</Button>}
      </div>
      {terminal == null && <Absent>No terminal is open, so this can only be copied. Open one to type it there.</Absent>}
      <div className="said" role="status" aria-live="polite">{said}</div>
    </div>
  );
}

function FindingCard({ f, folder, terminal, post }: { f: Finding; folder: string; terminal: string | null; post: (m: ToExtension) => void }) {
  const ev = evidenceOf(f, folder, post);
  const saving = f.saving ? savingWords(f.saving) : "";
  const unread = f.backends.unread.length ? backendsWords(f.backends) : "";
  const r = f.remedy;
  return (
    <section className="prompt-card" aria-labelledby={`fd-${f.id}`}>
      <h3 id={`fd-${f.id}`}>{f.what}</h3>
      {saving && <p>{saving}</p>}
      {unread && <p>{unread}</p>}
      {r.kind === "howto" && <p>{r.text}</p>}
      {r.kind === "fix" && <p>This one is fixed from the {BRAND.displayName} desktop app’s Setup check; nothing here changes a file.</p>}
      {r.kind === "write" && <p>Adds the efficiency rules to {r.target}. Copy the block and paste it in; nothing here writes it.</p>}
      <div className="btn-row">
        {ev && <Button type="button" onClick={ev.go}>{ev.label}</Button>}
      </div>
      {(r.kind === "seed" || r.kind === "write") && <RemedyActions id={f.id} terminal={terminal} post={post} />}
    </section>
  );
}

/**
 * The Setup check for this folder: ranked findings, then the checked-off list and what could not be
 * checked, so the view is never empty. Copy or type a remedy; nothing is sent or applied.
 */
export function FindingsView({ doc, why, terminal, post }: {
  doc: FindingsDoc | null;
  why?: string;
  terminal: string | null;
  post: (m: ToExtension) => void;
}) {
  if (!doc) return why ? <Absent>{why}</Absent> : <Loading>Reading this folder’s setup…</Loading>;
  const { rows, count } = findingCut(doc.findings, {});
  const empty = count === 0;
  return (
    <>
      {empty && <Absent>Nothing to fix here. What was checked is listed below.</Absent>}
      {rows.map((f) => <FindingCard key={f.id} f={f} folder={doc.folder} terminal={terminal} post={post} />)}
      <details className="hint-more" open={empty}>
        <summary>Checked, nothing to fix · {doc.passed.length}</summary>
        {doc.passed.length ? <ul>{doc.passed.map((p) => <li key={`${p.scope}:${p.id}`}>{passedWords(p)}</li>)}</ul> : <Absent>No check has run clean yet.</Absent>}
      </details>
      <details className="hint-more" open={doc.notChecked.length > 0}>
        <summary>Not checked · {doc.notChecked.length}</summary>
        {doc.notChecked.length ? <ul>{doc.notChecked.map((n) => <li key={`${n.scope}:${n.rule}`}>{n.why.charAt(0).toUpperCase() + n.why.slice(1)}.</li>)}</ul> : <Absent>Every check could run.</Absent>}
      </details>
      {!doc.account && <div className="empty ts-caveat">Your account’s limits and quotas are the {BRAND.displayName} desktop’s: turn on reading the desktop to add them.</div>}
    </>
  );
}
