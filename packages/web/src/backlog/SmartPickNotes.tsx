/**
 * The smart pick's explainer and its second home (*on in N repos*, a count
 * that opens those N), and the last-look strip, worded by the host.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { fmtCount, smartpickOutcomeText } from "@waterplane/shared";
import { ago } from "../format";
import { track } from "../usage";
import type { BacklogModel } from "./backlogTypes";
import { ENGINE_LABEL } from "./backlogLabels";

export function SmartPickNotes({ m }: { m: BacklogModel }) {
  const {
    p, pass, passNotes, repoDir, repoLabel, selectRepo, setPassNotes, setSmartMore, setSmartWhere, smartMore,
    smartOn, smartWhere,
  } = m;
  return (
    <>
      {/* What the tick buys, in ONE line — and the rest behind a disclosure.
          It was six lines of wall under the repo bar, on a phone, above the
          list it is about. The two facts a person needs before leaving an
          automatic spender running are that nothing is destroyed and that their
          own drag is never re-placed, and those are the sentence; how it is
          done, what it costs and what happens when it fails are the answer to
          "tell me more", which is a tap.

          **Smart pick's second home rides in the same block**: which repos have
          it on, at a glance. It was a toggle in this sheet and nowhere else, so
          the only way to learn that four repos groom themselves was to open four
          backlogs. It reads `smartPick` — the same array the tick above is drawn
          from — so it is a READOUT, never a second source of truth, and A COUNT
          ON A CONTROL IS A FILTER: "on in 3 repos" opens exactly those three, as
          buttons that scope this sheet to them, which is where the switch is.
          Drawn whether or not THIS repo is ticked: "which repos" is the question
          you cannot answer from here, and an answer that only appears once you
          are already in one of them answers nobody.

          The two were two `.form` blocks in a column — one sentence, one link,
          a block boundary, one more link — which is four vertical bands about
          one feature above the list it grooms. One block, and the two
          disclosures are one line of links (`.bl-notelinks`). Neither is drawn
          on its own condition any less: the sentence is the tick's, the count is
          the array's, and with the tick off the count still appears. */}
      {(smartOn || (p.smartPick && p.smartPick.length > 0)) && (
        <div className="form"><div className="form-hint">
          {smartOn && <>
            Before each item starts, a cheap look picks the next one and merges items that are one job —
            nothing is thrown away, and anything you dragged stays put.
          </>}
          <div className="bl-notelinks">
            {smartOn && (
              <button className="bl-pass-notes" onClick={() => setSmartMore((v) => !v)}
                title="what the look does, what it costs, and what happens when it fails">
                {smartMore ? <ChevronDown size={11} style={{ verticalAlign: "-1px" }} /> : <ChevronRight size={11} style={{ verticalAlign: "-1px" }} />}{" "}
                how it works
              </button>
            )}
            {p.smartPick && p.smartPick.length > 0 && (
              <button className="bl-pass-notes" data-hint="backlog.smartpickrepos"
                onClick={() => { track("action:backlog.smartpick.where"); setSmartWhere((v) => !v); }}
                title="the repos whose backlog takes a look before each item — tap to see them">
                {smartWhere ? <ChevronDown size={11} style={{ verticalAlign: "-1px" }} /> : <ChevronRight size={11} style={{ verticalAlign: "-1px" }} />}{" "}
                <Sparkles size={11} style={{ verticalAlign: "-1px" }} /> smart pick is on in {fmtCount(p.smartPick.length)}{" "}
                repo{p.smartPick.length === 1 ? "" : "s"}
              </button>
            )}
          </div>
          {smartMore && smartOn && (
            <div>
              The originals of a merge go to <b>archived</b> with their own words, and the row that replaces them carries
              <b> put them back</b>. The rest are sorted around anything you placed by hand. haiku, no tools, a few
              seconds — and if the look fails, the item fires in the order you already had.
            </div>
          )}
          {smartWhere && p.smartPick && (
            <div className="annot-tools wrap" style={{ marginTop: 6 }}>
              {p.smartPick.map((dir) => (
                <button key={dir} className={`key ${dir === repoDir ? "active" : ""}`}
                  title={dir === repoDir ? "this is the repo you are looking at" : `show this repo's backlog — the switch is on its bar`}
                  onClick={() => selectRepo(dir)}>
                  {repoLabel(dir)}{dir === repoDir ? " · here" : ""}
                </button>
              ))}
            </div>
          )}
        </div></div>
      )}
      {/* The last look. The one window onto an automatic spender, so it words a
          failure as plainly as a success: every outcome but `applied` and `noop`
          ends on "fired in the order you had", which is the promise. The
          sentence is `@waterplane/shared`'s and is never reworded here — the host
          writes the same one into its record. */}
      {pass && (
        <div className="form">
          <div className="bl-pass">
            <span className="bl-pass-head">
              <Sparkles size={12} style={{ verticalAlign: "-1px" }} />{" "}
              last look{pass.looked > 0 ? ` over ${pass.looked} item${pass.looked === 1 ? "" : "s"}` : ""} {ago(pass.at)}
              {/* Offline this whole sheet is a copy, and a pass sentence with no
                  age on it reads as a fact about right now. */}
              {!p.online && p.snapAt ? ` · from the backlog synced ${ago(p.snapAt)}` : ""}
            </span>
            <span className={`bl-pass-said bl-pass-${pass.outcome}`}>{smartpickOutcomeText(pass)}</span>
            {pass.why?.trim() && <span className="bl-pass-why">{pass.why.trim()}</span>}
            {/* What it cost, where this repo already shows cost. Every number is
                read off the `claude -p` envelope and is ABSENT when the envelope
                carried none — a pass drawn as `$0.00` because nobody measured it
                is the wrong number this app refuses to print. */}
            <span className="bl-pass-cost">
              {pass.model || ENGINE_LABEL[pass.engine] || pass.engine}
              {pass.tokens ? ` · ${fmtCount(pass.tokens.inTok + pass.tokens.outTok + pass.tokens.cacheRead + pass.tokens.cacheWrite)} tokens` : ""}
              {pass.usd != null ? ` · $${pass.usd < 0.01 ? pass.usd.toFixed(4) : pass.usd.toFixed(2)}` : ""}
              {!pass.tokens && pass.usd == null ? " · no token count came back with this pass" : ""}
            </span>
            {/* Every refusal the sanitiser made. A count on a control is a
                filter: this opens exactly those notes and nothing else. */}
            {pass.notes.length > 0 && (
              <>
                <button className="bl-pass-notes" onClick={() => setPassNotes((v) => !v)}
                  title="what the look refused to do, and why">
                  {passNotes ? <ChevronDown size={11} style={{ verticalAlign: "-1px" }} /> : <ChevronRight size={11} style={{ verticalAlign: "-1px" }} />}{" "}
                  {pass.notes.length} note{pass.notes.length === 1 ? "" : "s"}
                </button>
                {passNotes && (
                  <ul className="bl-pass-notelist">
                    {pass.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
