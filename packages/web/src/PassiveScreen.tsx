import { useEffect, useRef, useState } from "react";
import { Lock, LockOpen, Package, RotateCw } from "lucide-react";
import { passiveUnlockErrorText, unlockedUntilText, type PassiveUnlockResponse } from "@waterplane/shared";
import { pulls, type PullRecord } from "./pull";
import { passiveApi } from "./passiveApi";
import { passiveRows, passiveRowText, relockDelayMs } from "./passiveMode";
import { hhmm } from "./format";
import { showToast } from "./toast";

/** How often the passive screen asks the desktop for new builds while visible. */
const CHECK_MS = 60_000;

/**
 * **The one screen a passive device gets** (R-connection-014): its apps and
 * how each update is getting on, when the desktop was last asked, and a small
 * "Unlock". No burger menu, no settings, no sessions — and no WebSocket, which
 * the host would refuse anyway (`host/passive.ts`).
 *
 * It feeds the desktop's auto-pull list (`GET /api/passive/state`, APKs only)
 * into the same download engine the full app uses (`pull.ts`), so a new build
 * downloads, and installs itself when that package is on this phone's
 * auto-install list, exactly as it would with the whole app open.
 */
export function PassiveScreen({ onUnlocked }: { onUnlocked: (until: number) => void }) {
  const [records, setRecords] = useState<PullRecord[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [reach, setReach] = useState<"ok" | "unreachable" | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => { pulls.start(); return pulls.subscribe(setRecords); }, []);

  const check = async (): Promise<void> => {
    const st = await passiveApi.state();
    if (!st) { setReach("unreachable"); return; }
    setReach("ok");
    setCheckedAt(st.checkedAt);
    if (st.unlockedUntil && st.unlockedUntil > Date.now()) { onUnlocked(st.unlockedUntil); return; }
    pulls.sync(st.items);
    pulls.pump();
  };

  useEffect(() => {
    void check();
    const t = setInterval(() => { if (document.visibilityState === "visible") void check(); }, CHECK_MS);
    const wake = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", wake);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", wake); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only poll; `check` reads no render state and `onUnlocked` is main.tsx's setter arrow
  }, []);

  const rows = passiveRows(records);

  return (
    <div className="auth-gate passive-screen">
      <div className="auth-card">
        <div className="auth-title"><Package size={16} style={{ verticalAlign: "-3px" }} /> Apps</div>
        {rows.length === 0 && (
          <div className="set-note">No new app builds right now. New ones download here by themselves.</div>
        )}
        {rows.map((r) => (
          <div key={r.item.id} className="passive-row">
            <div className="passive-name">{r.item.name}</div>
            <div className="set-note">{r.item.repoName} · {passiveRowText(r)}</div>
          </div>
        ))}
        <div className="passive-foot">
          <span className="set-note">
            {reach === "unreachable"
              ? `Desktop not reachable${checkedAt ? ` — last check ${hhmm(checkedAt)}` : ""}`
              : checkedAt ? `Last check ${hhmm(checkedAt)}` : "Checking…"}
          </span>
          <button className="link-btn" title="check the desktop for new builds now" onClick={() => { void check(); showToast("checking for new builds"); }}>
            <RotateCw size={12} /> check now
          </button>
        </div>
        {!asking && (
          <button className="link-btn passive-unlock" title="unlock the full app with the PIN" onClick={() => setAsking(true)}>
            <Lock size={12} /> Unlock
          </button>
        )}
        {asking && <PinForm onCancel={() => setAsking(false)} onUnlocked={onUnlocked} />}
      </div>
    </div>
  );
}

function PinForm({ onCancel, onUnlocked }: { onCancel: () => void; onUnlocked: (until: number) => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setWhy(null);
    let r: PassiveUnlockResponse | null = null;
    try { r = await passiveApi.unlock(pin); } catch { r = null; }
    setBusy(false);
    if (!r) { setWhy("The desktop did not answer. Try again when it is reachable."); return; }
    if (r.ok) { onUnlocked(r.unlockedUntil); return; }
    setPin("");
    setWhy(r.message || passiveUnlockErrorText(r.error));
  };

  return (
    <form className="passive-pin" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input
        ref={ref}
        className="auth-input"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        placeholder="PIN"
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))}
        aria-label="unlock PIN"
      />
      <button type="submit" className="key primary" title="unlock for 30 minutes">
        {busy ? "checking…" : "unlock"}
      </button>
      <button type="button" className="key" onClick={onCancel}>not now</button>
      {why && <div className="set-note" style={{ color: "var(--dead)" }}>{why}</div>}
    </form>
  );
}

/**
 * The strip a passive device wears while the PIN has it unlocked: "Unlocked
 * until HH:MM · Lock now". When the time runs out the host closes the socket
 * and refuses the token again; the page reloads just after, and opens on the
 * passive screen.
 */
export function UnlockedBar({ until }: { until: number }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => window.location.reload(), relockDelayMs(until));
    return () => clearTimeout(t);
  }, [until]);
  const text = unlockedUntilText(until);
  if (!text) return null;
  const lock = async (): Promise<void> => {
    setBusy(true);
    try { await passiveApi.lock(); } catch { /* the reload asks the host again either way */ }
    window.location.reload();
  };
  return (
    <div className="passive-bar" role="status">
      <LockOpen size={13} /> {text} ·{" "}
      <button className="link-btn" title="back to the passive screen now" onClick={() => void lock()}>
        {busy ? "locking…" : "Lock now"}
      </button>
    </div>
  );
}
