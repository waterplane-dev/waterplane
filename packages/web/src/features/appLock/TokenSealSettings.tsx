/**
 * Settings › Connection › lock the desktop sign-ins. The list under the switch is what the choice
 * applies to, so it is drawn either way, and turning on shows the cost for these desktops first.
 * Every sentence is `tokenSealWords.ts`'s; the flows and what they refuse, `tokenSealActions.ts`'s.
 */
import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import type { LockReread } from "../../appLock";
import { heldToken, heldTokens } from "../../deviceToken";
import { browserKV, listHosts, realHosts } from "../../hosts";
import { isNativeShell } from "../../hostUrl";
import { Button, Row, RowSub, RowTitle } from "../../kit";
import { isDemo, plainHostRoute, useCore, usePref } from "../../sdk";
import { SetAction, SetLine, SetNote, SetSwitch, SetWarn } from "../../SettingsKit";
import { shellLinkMemoryTokens } from "../../shellLink";
import {
  forgetDoneWords, forgetLines, perDesktopTail, removedName, removedTail, SEAL_CONFIRM_TITLE, SEAL_FORGET_LABEL, SEAL_FORGET_NOTE, SEAL_FORGET_TITLE,
  SEAL_FORGET_TOAST, SEAL_NOT_OPENED, SEAL_OFF_TOAST, SEAL_OPEN_TOAST, SEAL_STRAY,
  sealFacts, sealKeyKind, sealOnToast, sealRowCant, sealRowMore, sealRowNote, tradeoffLines, type SealFacts,
} from "../../tokenSealWords";
import { appLockAdapter, clearSealLostNote, sealLostNote, sealTokens, unlockSignIns, unsealTokens } from "./actions";
import { forgetSignIns, sealCannotOpen } from "./tokenSealActions";

const LABEL = "lock the desktop sign-ins";

function Desktops({ facts, on, memory }: { facts: SealFacts; on: boolean; memory: boolean | null }) {
  return (
    <div className="seal-desktops">
      {facts.desktops.map((d) => (
        <Row key={d.id}><RowTitle>{d.name}</RowTitle><RowSub>{perDesktopTail(d, on, memory)}</RowSub></Row>
      ))}
      {facts.removed > 0 && <Row><RowTitle>{removedName(facts.removed)}</RowTitle><RowSub>{removedTail}</RowSub></Row>}
    </div>
  );
}

export function TokenSealSettings() {
  const core = useCore();
  const on = usePref("tokenSeal");
  const lockOn = usePref("appLock");
  const [read, setRead] = useState<LockReread | null>(null);
  const [memory, setMemory] = useState<boolean | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, redraw] = useState(0);
  const running = useRef(false);
  const shell = isNativeShell() && !isDemo();
  const path = appLockAdapter.path();

  useEffect(() => {
    if (!shell) return;
    let live = true;
    void shellLinkMemoryTokens().then((m) => { if (live) setMemory(m); });
    if (!on && path) void appLockAdapter.reread().then((r) => { if (live) setRead(r); });
    return () => { live = false; };
  }, [shell, on, path]);

  const kv = browserKV();
  if (!shell || !kv) return null; // a browser, the PWA, the demo: there is no key to seal under

  const open = core.conn.status === "open";
  const facts = sealFacts(kv, realHosts(listHosts()), open ? core.conn.info.auth : null, (id) => heldToken(id) !== null);
  const anyKey = memory === true; // no key yet: all a shell can say about the one it would make
  const kind = on ? sealKeyKind(kv) : anyKey ? "any" : "biometric";
  const cant = on ? null : sealRowCant(facts, { path, lockOn, routePlain: plainHostRoute(), read });
  const lost = sealLostNote();

  /** One tap at a time, however long the sheet stays up. */
  const once = async (fn: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setSaid(null);
    try { await fn(); } finally {
      running.current = false;
      setBusy(false);
      redraw((n) => n + 1);
    }
  };

  const turnOn = async () => {
    const mem = await shellLinkMemoryTokens();
    const yes = await core.say.confirm({
      title: SEAL_CONFIRM_TITLE, lines: tradeoffLines(facts, { anyKey: mem, memory: mem }),
      confirmLabel: "lock them", cancelLabel: "not now", tone: "info",
    });
    if (!yes) return;
    const r = await sealTokens();
    if (!r.ok) { setSaid(r.words); return; }
    core.say.track("action:tokenSeal.on");
    core.say.toast(sealOnToast(r.auth));
  };

  const turnOff = async () => {
    const r = await unsealTokens();
    if (r.ok) {
      core.say.track("action:tokenSeal.off");
      core.say.toast(SEAL_OFF_TOAST);
    } else if (r.why !== "lost") setSaid(r.words); // lost: `sealLostNote()` holds that sentence
  };

  const unlock = async () => {
    const why = await unlockSignIns();
    if (why) setSaid(why);
    else core.say.toast(SEAL_OPEN_TOAST);
  };

  /** The one way off with no sheet of the seal's own. The card says what goes; the flow checks again. */
  const forget = async () => {
    const yes = await core.say.confirm({
      title: SEAL_FORGET_TITLE, lines: forgetLines(facts), confirmLabel: "forget them", cancelLabel: "not now", tone: "warn",
    });
    if (!yes) return;
    const why = await forgetSignIns(forgetDoneWords(facts));
    if (why) { setSaid(why); return; }
    core.say.track("action:tokenSeal.forget");
    core.say.toast(SEAL_FORGET_TOAST);
  };

  const nothing = !on && facts.lockable === 0 && cant !== null && path !== null;
  const below = (
    <>
      {on && heldTokens() === null && (
        <SetLine>
          <SetNote as="span">{SEAL_NOT_OPENED}</SetNote>
          <Button onClick={() => void once(unlock)}>unlock</Button>
        </SetLine>
      )}
      {said && <SetNote className="oracle-warn">{said}</SetNote>}
      {sealCannotOpen() && (
        <SetLine>
          <SetNote as="span">{SEAL_FORGET_NOTE}</SetNote>
          <Button variant="danger" onClick={() => void once(forget)}>{SEAL_FORGET_LABEL}</Button>
        </SetLine>
      )}
      {lost && (
        <SetLine>
          <SetWarn>{lost}</SetWarn>
          <Button onClick={() => { clearSealLostNote(); redraw((n) => n + 1); }}>dismiss</Button>
        </SetLine>
      )}
      {!nothing && <Desktops facts={facts} on={on} memory={memory} />}
      {facts.stray && !nothing && <SetWarn tone="plain">{SEAL_STRAY}</SetWarn>}
    </>
  );

  if (cant) {
    return (
      <SetAction id="token-seal" label={LABEL} icon={KeyRound} cant={cant} onClick={() => {}} note={nothing ? undefined : sealRowNote(kind)} more={nothing ? undefined : <p>{sealRowMore(kind)}</p>}>
        {below}
      </SetAction>
    );
  }
  return (
    <SetSwitch
      id="token-seal" label={LABEL} icon={KeyRound} on={on} onChange={() => void once(on ? turnOff : turnOn)}
      state={busy ? "checking…" : undefined} note={sealRowNote(kind)} more={<p>{sealRowMore(kind)}</p>}
    >
      {below}
    </SetSwitch>
  );
}
