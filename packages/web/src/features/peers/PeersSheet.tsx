/**
 * Peer desktops: pair two saved desktops so a session on one can hand a job to
 * the other, list what is paired, unpair. Opened from the Hosts sheet.
 *
 * Nothing here is greyed: a pairing that cannot be made is explained in text
 * under the pickers, and a tap on "pair" while it cannot say the same words.
 * The phone writes BOTH desktops (`actions.ts`), so a one-sided result is
 * named, never hidden.
 */
import { useEffect } from "react";
import { Link2, Trash2 } from "lucide-react";
import { Sheet } from "../../Sheet";
import { isNativeShell } from "../../hostUrl";
import { loadPeers, pairHosts, pairableHosts, pick, unpair } from "./actions";
import { pairCandidates, pairRefusal, selfAddrs, pairedNote, pairedRows, pairedTitle, peerSignInNote } from "./logic";
import { usePeers } from "./store";
import { Button, Row, RowTitle, RowSub, Hint } from "../../kit";
import { SetLine } from "../../SettingsKit";

const ICON = 16;

export function PeersSheet({ onClose }: { onClose: () => void }) {
  const st = usePeers();
  useEffect(() => { void loadPeers(); }, []);

  if (!isNativeShell()) {
    return (
      <Sheet title="Helper desktops" icon={<Link2 size={ICON} />} onClose={onClose}>
        <div className="empty">Helper desktops are set up in the Android app, which is the one that knows more than one desktop.</div>
      </Sheet>
    );
  }

  const cands = pairCandidates(pairableHosts(), selfAddrs(st.ledgers));
  const a = cands.find((c) => c.host.id === st.pick.a);
  const b = cands.find((c) => c.host.id === st.pick.b);
  const refusal = st.pick.a || st.pick.b ? pairRefusal(a, b) : null;
  const rows = pairedRows(st.ledgers);
  const unread = st.ledgers.filter((l) => !l.rows);

  return (
    <Sheet title="Helper desktops" icon={<Link2 size={ICON} />} onClose={onClose}>
      <Hint>
        A helper desktop runs one job for the other and reports back to that session as one prompt. Linking
        gives each desktop the other's address and a fresh secret in each direction; the secrets are made on this device,
        sent once and not kept here.
      </Hint>
      <Hint>
        A job only runs while the other desktop's auto-run is on, and that desktop's budget pause applies to it like to its
        own work — what it spends there counts against the same account when both desktops sign in as you.
      </Hint>

      {cands.length < 2 ? (
        <div className="empty">Helper desktops need two saved desktops. Add the other one under Desktops first.</div>
      ) : (
        <SetLine style={{ display: "grid", gap: 8 }}>
          {(["a", "b"] as const).map((w) => (
            <select key={w} aria-label={w === "a" ? "first desktop" : "second desktop"} value={st.pick[w] ?? ""}
              onChange={(e) => pick(w, e.target.value || null)}>
              <option value="">{w === "a" ? "first desktop…" : "second desktop…"}</option>
              {cands.map((c) => (
                <option key={c.host.id} value={c.host.id}>{c.host.name}{c.addr ? ` · ${c.addr}` : " · cannot be linked"}</option>
              ))}
            </select>
          ))}
          {refusal && <Hint as="span">{refusal}</Hint>}
          <Button onClick={() => {
            if (st.busy > 0) return;
            void pairHosts(st.pick.a ?? "", st.pick.b ?? "");
          }}><Link2 size={ICON} /> Link as helpers</Button>
          {cands.filter((c) => c.why).map((c) => (
            <Hint key={c.host.id} as="span">{c.host.name}: {c.why}</Hint>
          ))}
        </SetLine>
      )}

      {st.busy > 0 && <Hint>working…</Hint>}
      {st.note && <Hint role="status">{st.note}</Hint>}

      <Hint style={{ marginTop: 10 }}>Helpers</Hint>
      {!st.loaded ? (
        <div className="empty">reading each desktop…</div>
      ) : rows.length === 0 ? (
        <div className="empty">No desktop is a helper for another yet.</div>
      ) : (
        <div className="list">
          {rows.map((p) => {
            const note = pairedNote(p);
            const signIn = peerSignInNote(p, st.signedIn[p.key]);
            return (
              <Row key={p.key} kind="wrap">
                <Row kind="grow">
                  <RowTitle>{pairedTitle(p)}</RowTitle>
                  <RowSub className="dim">{p.host.name} knows it as {p.row.name} · {p.row.addr}</RowSub>
                  {note && <RowSub>{note}</RowSub>}
                  {signIn && <RowSub className="warn" role="status">{signIn}</RowSub>}
                </Row>
                <div className="row-acts">
                  <Button aria-label={`remove helper link ${pairedTitle(p)}`} onClick={() => void unpair(p)}><Trash2 size={ICON} /></Button>
                </div>
              </Row>
            );
          })}
        </div>
      )}
      {unread.map((l) => (
        <Hint key={l.host.id}>{l.host.name}'s peers could not be read: {l.error}</Hint>
      ))}
    </Sheet>
  );
}
