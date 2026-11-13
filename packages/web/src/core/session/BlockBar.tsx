import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, LogIn, PlugZap, ToggleLeft, WifiOff, X } from "lucide-react";
import { NET_RETRY_NOW_NOTE, blockOf, netRetryLine, type SessionInfo, type SessionLogin, type SessionNetRetry } from "@waterplane/shared";
import { ago } from "../../format";
import { Stowable, StowButton } from "../../Stowable";
import { LinkActions } from "../../LinkActions";
import { copyLink, openLink } from "../../features/clipboard";
import { pasteLoginCode } from "../../features/hostTools";
import { netRetryCancel, netRetryNow, netRetryTurnOff } from "../../netRetryCfg";

/**
 * What the session is blocked on, as the ONE card above the prompt bar
 * (`blockOf`, shared — the same derivation the launcher chip and the blocked
 * sheet ask). The renderer is picked by the block's KIND:
 *
 *  - `auth` — the claude sign-in: with a link on screen the link card
 *    (open / copy / paste code / url, `LinkActions`); signed out with no link
 *    yet, the card that sends `/login`.
 *  - `net` — the desktop retrying a turn the CLI gave up on a network error
 *    (R-connection-024): the countdown line, retry now, cancel / dismiss, and
 *    the host-wide turn off.
 *  - `limit` / `spend` — nothing here, on purpose: a wall has one session-level
 *    surface, the toolbar's limit control, and a second would be a second place
 *    to learn the same wall.
 *
 * Above the prompt bar because a session showing a login screen is not showing a
 * choice box, and a sign-in blocks everything else. One block per session
 * (`blockOf`'s precedence): while signed out, a network retry's line waits.
 * A shell session's links are NOT a block and stay `ShellLinksBar`.
 */
export function BlockBar({ session, onSendLogin }: {
  session: SessionInfo;
  /** `/login` through the queue, like a header command (`compose.runHeaderCmd`). */
  onSendLogin: () => void;
}): ReactNode {
  const kind = blockOf(session)?.kind;
  if (kind === "auth") {
    if (session.login) return <LoginCard login={session.login} id={session.id} />;
    if (session.signedOut && session.running) return <SignedOutCard onSendLogin={onSendLogin} />;
    return null;
  }
  if (kind === "net" && session.netRetry && session.running) {
    return <NetRetryCard id={session.id} retry={session.netRetry} />;
  }
  return null;
}

/**
 * Signing in, from a phone: `/login` is the one flow in this app that cannot be
 * finished inside it. The CLI prints a 300+ character OAuth URL the GRID breaks
 * across six rows (untappable, unselectable), a browser has to visit it, and the
 * code it hands back has to get into the CLI's own input. The host rejoins the
 * link and publishes it (`host/login.ts`); this is the button.
 *
 * **The code goes in on the RAW, undurable path** (`pasteLoginCode`): a login
 * starts no turn, so the verified path would press Return into whatever came next.
 */
function LoginCard({ login, id }: { login: SessionLogin; id: string }) {
  return (
    <Stowable slot="login" stowKey={`${login.url}\n${login.awaitingCode ? "await" : ""}`} label="sign-in link" icon={KeyRound}>
    <div className="approve login">
      <div className="login-head">
        <span className="login-title"><KeyRound size={14} /> sign-in link</span>
        {/* A login URL expires. "Nine minutes ago" is the difference between a
            page that signs you in and one that refuses for no stated reason. */}
        <span className="login-age" title="when the CLI printed this link">{ago(login.at)}</span>
        <StowButton />
      </div>
      <LinkActions
        url={login.url}
        openLabel="Open sign-in page"
        onOpen={openLink}
        onCopy={(u) => void copyLink(u)}
        onPasteCode={login.awaitingCode ? () => void pasteLoginCode(id) : undefined}
      >
        {login.awaitingCode && (
          <div className="approve-hint">
            the CLI is waiting for the code — sign in, then <b>paste code</b> (or type it in the compose bar)
          </div>
        )}
      </LinkActions>
    </div>
    </Stowable>
  );
}

/**
 * Signed out, and nothing on screen to tap yet: the step BEFORE the link card. A
 * turn just ended because the CLI is not signed in (`SessionInfo.signedOut`). The
 * terminal says "run /login" in the CLI's vocabulary, so this says it in plain
 * words and offers the one tap that does it — through the queue, never a second
 * send path. Once the CLI prints its link the link card takes over.
 */
function SignedOutCard({ onSendLogin }: { onSendLogin: () => void }) {
  return (
    <Stowable slot="login" stowKey="signed-out" label="signed out" icon={LogIn}>
    <div className="approve login">
      <div className="login-head">
        <span className="login-title"><LogIn size={14} /> Claude is signed out on this desktop</span>
        <StowButton />
      </div>
      <div className="approve-hint">
        Your message was not sent to Claude. Sign in first: tap <b>Sign in</b> below, or type <b>/login</b> in the
        message box and send it. Claude then shows a sign-in link here — open it, sign in, and paste the code back.
      </div>
      <div className="approve-opts">
        <button className="approve-btn primary" onClick={onSendLogin}>
          <LogIn size={14} /> Sign in (sends /login)
        </button>
      </div>
    </div>
    </Stowable>
  );
}

/**
 * The desktop retrying a turn the CLI gave up on a transient API error
 * (`SessionInfo.netRetry`, host `sessions/apiretry.ts`): one line — "Network
 * error — retrying in 40s (2/8)" — and the verbs that call it off. The wording
 * is shared's `netRetryLine`, so the host's log and this line say the same thing.
 * The countdown ticks on the PHONE's clock, and only while a retry is waiting.
 *
 * `cancel` while it is waiting or sent; `dismiss` once it gave up (one message,
 * `netRetryCancel`, also the blocked sheet's). A dismissed gave-up line is only
 * HIDDEN (`retry.dismissed`): work waiting on the session stays stalled and keeps
 * its note on its own row. `turn off` is the host-wide switch (Settings ›
 * Sessions › retry on network errors), offered only while a retry is pending.
 * `retry now` while waiting or gave up (not while a retry's turn is running):
 * `session.netRetryNow` — the host fires a waiting rung early, a gave-up one
 * restarts at try 1.
 */
function NetRetryCard({ id, retry }: { id: string; retry: SessionNetRetry }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  const ticking = retry.nextAt != null && !retry.dismissed;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const line = netRetryLine(retry, now);
  if (!line || retry.dismissed) return null;
  const gaveUp = retry.state === "gaveup";
  const sent = retry.state === "sent";
  // The line and the error read as one block ABOVE the verbs: squeezed beside
  // three tiles it wrapped word by word and the error ran under the buttons.
  return (
    <div className="approve netretry" role="status">
      <div className="netretry-line">
        <WifiOff size={14} aria-hidden="true" /> {line}
      </div>
      <div className="approve-hint netretry-error">{retry.error}</div>
      <div className="approve-opts netretry-opts">
        {!sent && (
          <button className="approve-btn primary" onClick={() => netRetryNow(id)} title={NET_RETRY_NOW_NOTE}>
            <PlugZap size={14} aria-hidden="true" /> retry now
          </button>
        )}
        <button className="approve-btn" onClick={() => netRetryCancel(id, gaveUp)}
          title={gaveUp ? "hide this line — work waiting on this session stays stalled, with its note on its own row" : "stop the desktop retrying this turn — it types nothing"}>
          <X size={14} aria-hidden="true" /> {gaveUp ? "dismiss" : "cancel"}
        </button>
        {!gaveUp && (
          <button className="approve-btn" onClick={netRetryTurnOff}
            title="stop the desktop retrying network errors in every session — Settings › Sessions brings it back">
            <ToggleLeft size={14} aria-hidden="true" /> turn off
          </button>
        )}
      </div>
    </div>
  );
}
