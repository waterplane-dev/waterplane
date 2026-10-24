import { useState } from "react";
import { formatPairCode, type PairTarget, type SavedHost } from "@waterplane/shared";
import { KeyRound, Link2, Loader2, Monitor, Pencil } from "lucide-react";
import { api } from "./api";
import { pickDeviceName } from "./deviceToken";
import { browserKV, switchTo } from "./hosts";
import { deviceModel, deviceName } from "./installLog";
import { lanRouteNow } from "./lanLink";
import {
  fieldsFromPaste, heldTokenFor, pairLinkSentence, pairTargetOf, readRedeemReply, redeemErrorText, storeRedeemed, type PairFields,
} from "./pairRedeem";
import { showToast } from "./toast";
import { Button } from "./kit/Button";
import { SetNote, SetLine } from "./SettingsKit";

/**
 * "Pair with code" — the half of `HostSetup` that takes a code shown as a QR
 * on a phone already paired (`features/hosts/HostQrSheet.tsx`). Android shell
 * only, like the rest of `HostSetup`.
 *
 * The address field also takes a pasted landing URL or deep link, which fills
 * both fields. A form a DEEP LINK filled says so and names the address — any
 * app can fire that link, so nothing is sent until the person taps pair
 * (`pairRedeem.ts` holds the rules; this is the screen).
 */
export function PairForm({ mode, initial, fromLink, onDone }: {
  mode: "first" | "add";
  initial?: PairTarget | null;
  /** The fields came from a `<scheme>://pair` link, not the person. */
  fromLink?: boolean;
  /** Paired onto a host that is not made active now (no reload). */
  onDone: (host: SavedHost) => void;
}) {
  const [fields, setFields] = useState<PairFields>({
    address: initial?.base ?? "",
    code: initial ? formatPairCode(initial.code) : "",
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A link-filled form opens as one question — this desktop, this code, pair? —
  // with the fields one tap away for a link that got something wrong.
  const [editing, setEditing] = useState(!(fromLink && initial));
  const target = pairTargetOf(fields);

  function setAddress(text: string): void {
    setProblem(null);
    const both = fieldsFromPaste(text);
    setFields(both ? { address: both.address, code: formatPairCode(both.code) } : { ...fields, address: text });
  }

  async function pair(activate: boolean): Promise<void> {
    if (!target || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      let got: { status: number; body: unknown };
      try {
        const kv0 = browserKV();
        const held = kv0 ? heldTokenFor(kv0, target.base) : null;
        got = await api.pair.redeem(target.base, { code: target.code, deviceName: pickDeviceName(deviceName(), deviceModel()) }, held);
      } catch {
        setProblem(`Could not reach ${target.base}. Check that Tailscale is connected on this phone and the desktop is awake.`);
        return;
      }
      const reply = readRedeemReply(got.status, got.body);
      if (!reply.ok) { setProblem(redeemErrorText(reply)); return; }
      const kv = browserKV();
      if (!kv) { setProblem("This phone's storage is not available."); return; }
      const r = storeRedeemed(kv, reply, target);
      if (!r.ok) { setProblem(r.why); return; }
      if (reply.note) showToast(reply.note);
      if (!r.isActive && (mode === "first" || activate)) {
        // Park and reload onto it — the token and identity were written
        // parked, so the boot's restore brings them in with the host.
        switchTo(r.host.id);
        return;
      }
      if (r.isActive) lanRouteNow("pair");
      showToast(`paired with ${r.host.name}`);
      onDone(r.host);
    } finally {
      setBusy(false);
    }
  }

  const status = (
    <>
      {busy && (
        <SetNote style={{ marginTop: 10 }}>
          <Loader2 size={13} className="spin" style={{ verticalAlign: "-2px" }} /> pairing…
        </SetNote>
      )}
      {problem && <SetNote style={{ marginTop: 10, color: "var(--dead)" }}>{problem}</SetNote>}
    </>
  );

  if (!editing && target) {
    return (
      <div className="pair-confirm">
        <div className="pair-confirm-icon"><Monitor size={22} /></div>
        <div className="pair-confirm-q">Pair with this desktop?</div>
        <div className="pair-confirm-host">{target.base.replace(/^https?:\/\//, "")}</div>
        <div className="pair-confirm-code">code <code>{formatPairCode(target.code)}</code></div>
        {status}
        {!busy && (
          <Button variant="primary" className="pair-wide" style={{ marginTop: 16 }} onClick={() => void pair(true)}>
            <KeyRound size={15} /> {mode === "add" ? "pair and switch" : "pair"}
          </Button>
        )}
        {!busy && mode === "add" && (
          <Button className="pair-wide" style={{ marginTop: 8 }} onClick={() => void pair(false)}>pair, stay here</Button>
        )}
        <SetNote className="warn pair-confirm-note">
          <Link2 size={12} style={{ verticalAlign: "-2px" }} /> A pairing link filled this in. Nothing is sent until you tap pair —
          if you did not open a link just now, do not.
        </SetNote>
        {!busy && (
          <Button className="pair-link-btn" onClick={() => setEditing(true)}><Pencil size={13} /> change address or code</Button>
        )}
      </div>
    );
  }

  return (
    <>
      {fromLink && initial && (
        <SetNote className="warn" style={{ marginBottom: 10 }}>
          <Link2 size={13} style={{ verticalAlign: "-2px" }} /> {pairLinkSentence(initial)}
        </SetNote>
      )}
      <ol className="pair-steps">
        <li>On a phone already paired, or the desktop's web page: Settings → <b>pair another phone</b>.</li>
        <li>Scan its QR, tap <b>open the app on this phone</b> there, or type the address and code below.</li>
      </ol>
      <input
        className="auth-input"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="desktop address — 100.64.0.5 · mac.tailnet.ts.net"
        value={fields.address}
        onChange={(e) => setAddress(e.target.value)}
      />
      <input
        className="auth-input"
        style={{ marginTop: 10 }}
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        placeholder="pairing code — ABCD-EFGH"
        value={fields.code}
        onChange={(e) => { setProblem(null); setFields({ ...fields, code: e.target.value }); }}
      />
      {target ? (
        <SetNote style={{ marginTop: 8, opacity: 0.75 }}>
          will connect to <code>{target.base}</code> with code <code>{formatPairCode(target.code)}</code>
        </SetNote>
      ) : (fields.address.trim() || fields.code.trim()) ? (
        <SetNote style={{ marginTop: 8 }}>
          {!fields.address.trim() ? "Type the desktop's address too."
            : !pairTargetOf({ address: fields.address, code: "AAAAAAAA" }) ? "Not an address. Use a host name or IP, optionally with a port."
            : "The code is 8 letters and digits, as the paired phone shows it."}
        </SetNote>
      ) : (
        <SetNote style={{ marginTop: 8 }}>A pasted pairing link fills both fields.</SetNote>
      )}
      {status}
      {target && !busy && (
        <SetLine style={{ marginTop: 14, flexWrap: "wrap", gap: 8 }}>
          {mode === "first" && <Button variant="primary" className="pair-wide" onClick={() => void pair(true)}><KeyRound size={14} /> pair</Button>}
          {mode === "add" && <Button variant="primary" onClick={() => void pair(true)}><KeyRound size={14} /> pair and switch</Button>}
          {mode === "add" && <Button onClick={() => void pair(false)}>pair</Button>}
        </SetLine>
      )}
    </>
  );
}
