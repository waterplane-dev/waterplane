/**
 * The LAN password gate. The host closed this (untrusted) socket pending a
 * password; this takes over the screen. On success the cookie is set and the
 * socket reconnects — the new handshake carries it, so the host lets us in and
 * sends a normal welcome. Lifted from `App.tsx` unchanged.
 */
import { useState } from "react";
import { Lock, RotateCw } from "lucide-react";
import { api } from "../../api";
import { useStore } from "../../sdk";
import { gate } from "./store";
import { unlocked } from "./actions";
import { Button } from "../../kit";

const ICON = 16;

export function AuthGate({ reconnect }: {
  /** App's `connRef.current.reconnect()` — the ONE socket, re-dialled. */
  reconnect: () => void;
}) {
  const authGate = useStore(gate);
  const [authPw, setAuthPw] = useState("");
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const doLogin = async () => {
    setAuthBusy(true); setAuthErr(null);
    try {
      const r = await api.auth.login(authPw);
      if (r.ok) { setAuthPw(""); unlocked(); reconnect(); }
      else setAuthErr(r.error || "login failed");
    } catch (e) {
      setAuthErr(String((e as Error).message || e));
    } finally {
      setAuthBusy(false);
    }
  };

  if (!authGate) return null;
  return (
    <div className="sheet auth-gate">
      <div className="auth-card">
        <div className="auth-title"><Lock size={20} style={{ verticalAlign: "-3px", marginRight: 6 }} />Locked</div>
        {authGate.enabled ? (
          <>
            <p className="set-note">This device is on the {authGate.kind === "lan" ? "local network" : "network"}, which is password-protected. Enter the password to continue.</p>
            {/* The button stays pressable with nothing typed and SAYS why it did not
                unlock, rather than greying out (`Unavailable.tsx`). */}
            <form onSubmit={(e) => { e.preventDefault(); if (!authPw) setAuthErr("type the password first"); else if (!authBusy) doLogin(); }}>
              <input
                className="auth-input" type="password" autoFocus placeholder="password"
                value={authPw} onChange={(e) => { setAuthPw(e.target.value); setAuthErr(null); }}
              />
              {authErr && <div className="set-note oracle-warn" style={{ marginTop: 8 }}>{authErr}</div>}
              <Button variant="primary" type="submit" style={{ marginTop: 12, width: "100%" }}>
                {authBusy ? "checking…" : "unlock"}
              </Button>
            </form>
          </>
        ) : (
          <>
            <p className="set-note">This device is on the local network, and LAN access is protected — but no password has been set yet. Set one from the desktop itself, or from a phone connected over Tailscale (Settings → LAN access), then retry.</p>
            <Button style={{ marginTop: 12 }} onClick={() => reconnect()}><RotateCw size={ICON} /> retry</Button>
          </>
        )}
      </div>
    </div>
  );
}
