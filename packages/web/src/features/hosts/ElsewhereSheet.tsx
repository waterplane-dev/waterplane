/**
 * The `elsewhere` sheet: what the person's OTHER desktops wait on them for — exactly the rows the
 * launcher chip counted (`elsewhereRows`, one call for both). One card per desktop: what waits
 * there, how old the reading is, and "switch to <name>"; each waiting item is its own row whose
 * tap switches AND lands on it (`switchHost(id, open)` → the next boot's `shellOpen`). A desktop
 * that stopped answering or signed this phone out says so in a sentence, with no number and no
 * switch button. Nothing switches until a tap.
 */
import { ArrowLeftRight, CircleDot, KeyRound, MonitorDot, MonitorOff, Server } from "lucide-react";
import { Sheet } from "../../Sheet";
import { realHosts } from "../../hosts";
import { agoText } from "../../format";
import { useNow } from "../../useNow";
import { Button, Hint, Row, RowSub, RowTitle } from "../../kit";
import { useCore } from "../../sdk";
import { openHosts, switchHost } from "./actions";
import { elsewhereRowText, elsewhereRows, elsewhereSaidText, itemOpenTarget, itemWord, type ElsewhereRow } from "./logic";
import { useElsewhere, useHosts } from "./store";

const ICON = 16;

export function ElsewhereSheet() {
  const c = useCore();
  const { hosts, activeId } = useHosts();
  const reads = useElsewhere();
  const now = useNow(15_000);
  const rows = elsewhereRows(realHosts(hosts), activeId, reads, now);
  const here = hosts.find((h) => h.id === activeId)?.name ?? "this desktop";
  return (
    <Sheet title="Waiting on other desktops" icon={<MonitorDot size={ICON} />} onClose={() => c.nav.close("elsewhere")}>
      {rows.length === 0 ? (
        <Hint>Nothing waits on you on your other desktops right now.</Hint>
      ) : (
        <div className="list">
          {rows.map((r) => <HostCard key={r.host.id} row={r} now={now} />)}
        </div>
      )}
      <Hint>
        You are on {here}. Switching reloads the app onto the other desktop; your drafts and queue here stay saved for when you come back.
      </Hint>
    </Sheet>
  );
}

function HostCard({ row, now }: { row: ElsewhereRow; now: number }) {
  const name = row.host.name;
  if (row.state !== "waiting") {
    const Icon = row.state === "signedOut" ? KeyRound : MonitorOff;
    return (
      <Row kind="wrap">
        <Row kind="grow">
          <RowTitle><Icon size={12} /> {name}</RowTitle>
          <RowSub>{elsewhereSaidText(row, now)}</RowSub>
        </Row>
        {row.state === "signedOut" && (
          <div className="row-acts">
            {/* The pair form lives in the switcher: add or edit that desktop there with a new code. */}
            <Button aria-label={`open the desktops list to pair again with ${name}`} onClick={openHosts}><Server size={ICON} /> desktops</Button>
          </div>
        )}
      </Row>
    );
  }
  const s = row.summary;
  const oneSession = s.sessions.n === 1 ? s.sessions.ids[0] : undefined;
  return (
    <div className="elsewhere-card">
      <Row kind="wrap">
        <Row kind="grow">
          <RowTitle><MonitorDot size={12} /> {name} · {row.total} waiting</RowTitle>
          <RowSub>{elsewhereRowText(s)}</RowSub>
          <RowSub className="dim">read {agoText(now - row.at)}</RowSub>
        </Row>
        <div className="row-acts">
          <Button onClick={() => switchHost(row.host.id)}><ArrowLeftRight size={ICON} /> switch to {name}</Button>
        </div>
      </Row>
      {s.attention.items.map((i) => {
        const open = itemOpenTarget(i);
        return (
          <Row key={i.id} as="button" kind="grow" onClick={() => switchHost(row.host.id, open)}>
            <RowTitle><CircleDot size={12} /> {i.title}</RowTitle>
            <RowSub className="dim">{itemWord(i)} · {agoText(now - i.ts)} · tap to switch and {open ? "open it" : "see it"}</RowSub>
          </Row>
        );
      })}
      {s.sessions.n > 0 && (
        <Row as="button" kind="grow" onClick={() => switchHost(row.host.id, oneSession)}>
          <RowTitle><CircleDot size={12} /> {s.sessions.n === 1 ? "1 session on a question" : `${s.sessions.n} sessions on a question`}</RowTitle>
          <RowSub className="dim">tap to switch and {oneSession ? "open it" : "see them under waiting"}</RowSub>
        </Row>
      )}
    </div>
  );
}
