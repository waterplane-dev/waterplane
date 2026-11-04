import { useEffect, useState } from "react";
import { BRAND, formatPairCode, isPlainRoute, parsePairInput, type PairTarget, type SavedHost } from "@waterplane/shared";
import { KeyRound, Link2, Loader2, Monitor, Pencil, Wifi } from "lucide-react";
import { api } from "./api";
import { askConfirm } from "./Confirm";
import { heldTokens, pickDeviceName, sealedMode } from "./deviceToken";
import { browserKV, readHosts, reloadToLauncher, switchTo } from "./hosts";
import { deviceModel, deviceName } from "./deviceInfo";
import { routeContext, tokenWithheld } from "./hostUrl";
import { lanRouteNow } from "./lanLink";
import { pinSealed } from "./pairNative";
import { PAIR_CODE_SENT_PLAIN, PAIR_NOT_RECORDED, PAIR_NOT_SENT, codeMark, codeWentPlain, markCodePlain, pairStep, pairUnreachable } from "./pairPake";
import {
  PAIR_SEALED_KEPT, fieldsFromPaste, heldTokenFor, pairAddressOf, pairLinkSentence, pairTargetOf, pairedNoRoute, readRedeemReply, redeemErrorText, sealedAsk, storeRedeemed, storeSealed,
  type PairFields, type StoreResult,
} from "./pairRedeem";
import { hasShellTls } from "./sdk/shellTls";
import { resyncShellLink } from "./shellLink";
import { currentNet } from "./shellNet";
import { rewrapAfterPair, unlockSignIns } from "./core/Banners";
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
 * (`pairRedeem.ts` and `pairPake.ts` hold the rules; this is the screen).
 */
/** Paired, with no way to the desktop from here: what the receipt says, and `go`, the rest of the tap. */
export interface PairNoRoute { host: SavedHost; sentence: string; go: () => void }

export function PairForm({ mode, initial, fromLink, onDone, onNoRoute }: {
  mode: "first" | "add";
  initial?: PairTarget | null;
  /** The fields came from a `<scheme>://pair` link, not the person. */
  fromLink?: boolean;
  /** Paired onto a host that is not made active now (no reload). */
  onDone: (host: SavedHost) => void;
  /** In place of `onDone` when the pairing left no route (`pairedNoRoute`). */
  onNoRoute: (receipt: PairNoRoute) => void;
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
  // The link that filled the form, by tap or by paste: `s=1`, `k=` and `l=` live here.
  const [link, setLink] = useState<PairTarget | null>(initial ?? null);
  const target = pairTargetOf(fields, link);

  // A shell that says there is no tailnet here: the LAN address that came with the link or the row
  // is the one that can answer. The person still reads it before anything is sent.
  useEffect(() => {
    if (!initial?.lan) return;
    void currentNet().then((n) => {
      setFields((f) => (f.address === initial.base ? { ...f, address: pairAddressOf(initial, n) } : f));
    });
  }, []);

  function setAddress(text: string): void {
    setProblem(null);
    const both = fieldsFromPaste(text);
    if (both) setLink(parsePairInput(text));
    setFields(both ? { address: both.address, code: formatPairCode(both.code) } : { ...fields, address: text });
  }

  async function pair(activate: boolean): Promise<void> {
    if (!target || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      // Sealed and not opened this run: the old sign-in for this desktop is in the blob, and the
      // host can only retire its ledger row if it is sent. The rewrap after the redeem needs the
      // blob open as well, so this is the one sheet, asked first.
      if (sealedMode() && !heldTokens()) {
        const why = await unlockSignIns();
        if (why && sealedMode()) { setProblem(why); return; }
      }
      const kv = browserKV();
      if (!kv) { setProblem("This phone's storage is not available."); return; }
      const row = readHosts(kv).find((h) => h.base === target.base) ?? null;
      const plain = isPlainRoute(target.base, routeContext(target.base, row, hasShellTls(), await currentNet()));
      const mark = await codeMark(target.code);
      if (mark && codeWentPlain(kv, mark, Date.now())) { setProblem(PAIR_CODE_SENT_PLAIN); return; }
      const name = pickDeviceName(deviceName(), deviceModel());
      const presented = heldTokenFor(kv, target.base, true);
      const next = await pairStep(target, plain, { deviceName: name, ...(presented ? { presented } : {}) }, { start: api.pair.pakeStart, finish: api.pair.pakeFinish });
      if (next.kind === "stop") { setProblem(next.why); return; }
      if (next.kind === "ask" && !(await askConfirm(next.ask))) { setProblem(PAIR_NOT_SENT); return; }
      let r: StoreResult;
      let note: string | undefined;
      if (next.kind === "sealed") {
        const ask = sealedAsk(kv, next.reply, target);
        if (ask && !(await askConfirm(ask))) { setProblem(PAIR_SEALED_KEPT); return; }
        r = storeSealed(kv, next.reply, target);
        if (r.ok) {
          await pinSealed(r.host, next.reply);
          await resyncShellLink();
        }
        note = next.reply.note;
      } else {
        // Before the code leaves, because a killed app must not forget it left.
        if (next.kind === "ask" && mark && !markCodePlain(kv, mark, Date.now())) { setProblem(PAIR_NOT_RECORDED); return; }
        let got: { status: number; body: unknown };
        try {
          // A pinned row's old token is never put in a header on an address that reads plain now.
          const held = row && tokenWithheld(target.base, row) ? null : heldTokenFor(kv, target.base);
          got = await api.pair.redeem(target.base, { code: target.code, deviceName: name }, held);
        } catch {
          setProblem(pairUnreachable(target.base, plain));
          return;
        }
        const reply = readRedeemReply(got.status, got.body);
        if (!reply.ok) { setProblem(redeemErrorText(reply)); return; }
        r = storeRedeemed(kv, reply, target);
        note = reply.note;
      }
      if (!r.ok) { setProblem(r.why); return; }
      if (note) showToast(note);
      // Sealed: the token is in memory only, and the switch below reloads.
      const stuck = r.sealedPending ? await rewrapAfterPair(r.host.name) : null;
      const paired = r;
      const switching = !paired.isActive && (mode === "first" || activate);
      if (switching && stuck) { setProblem(stuck); return; }
      const finish = (): void => {
        // Park and reload onto it — the token and identity were written
        // parked, so the boot's restore brings them in with the host.
        if (switching) { switchTo(paired.host.id); return; }
        // A host address is only ever replaced by a reload.
        if (paired.isActive && paired.moved && !stuck) { reloadToLauncher(); return; }
        if (paired.isActive) lanRouteNow("pair");
        showToast(stuck ?? `paired with ${paired.host.name}`);
        onDone(paired.host);
      };
      const sentence = next.kind === "sealed" && !stuck ? pairedNoRoute(paired.host, target.base, await currentNet()) : null;
      if (sentence) onNoRoute({ host: paired.host, sentence, go: finish });
      else finish();
    } finally {
      setBusy(false);
    }
  }

  const lanSwap = target?.lan && target.lan !== target.base && !busy && (
    <Button className="pair-link-btn" onClick={() => { setProblem(null); setFields({ ...fields, address: target.lan! }); }}>
      <Wifi size={13} /> no Tailscale here? use {target.lan.replace(/^https?:\/\//, "")}
    </Button>
  );

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
        {lanSwap}
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
        <li>On the desktop, run <code>{BRAND.slug} pair</code>: it prints the address and a code. Or open Settings › <b>pair another phone</b> on the desktop's web page or a phone already paired: it shows a QR.</li>
        <li>Type the address and code below, or scan the QR with this phone's camera app (this app has no scanner). It opens this app, or a page with <b>Open in app</b>.</li>
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
      {lanSwap}
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
