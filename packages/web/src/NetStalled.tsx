/**
 * A piece of work STALLED on the API (R-connection-024): its row is `running`,
 * its prompt was delivered, and the session it runs in gave up retrying a
 * transient API error (`SessionInfo.netRetry` `gaveup`). Drawn ON THE ITEM —
 * the backlog row (`backlog/BacklogRow.tsx`) and the Activity row
 * (`activity/ActivityRowCard.tsx`) — off shared `netStalledOf`, the one
 * derivation: nothing about the stall is stored on the row.
 *
 * The note ("Stalled — API unreachable, 8 retries used"), the CLI's own error
 * line, and the two controls that act on it: **retry now** (`session.netRetryNow`
 * — the host types `continue` the way its automatic retry does) and the host's
 * auto-retry switch (`NetRetrySwitch`, the Settings row's own component, the
 * same setting). The row completes the ordinary way on the next real turn end.
 * A row whose session is SIGNED OUT wears `SIGNED_OUT_STALL_TEXT` instead
 * (`signedOutStall.ts`): words, no verb.
 *
 * The note says when the host's next stall probe runs ("next try in 23m"), on
 * the phone's clock, ticking once a minute.
 */
import type { ReactNode } from "react";
import { KeyRound, PlugZap, WifiOff } from "lucide-react";
import { NET_RETRY_NOW_NOTE, netStalledOf, netStalledText, type SessionInfo, type SessionNetRetry } from "@waterplane/shared";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";
import { NetRetrySwitch } from "./NetRetrySwitch";
import { netRetryNow } from "./netRetryCfg";
import { useNow } from "./useNow";
import { signedOutStallText } from "./signedOutStall";

export function NetStalled({ state, sessionId, sessions }: {
  state: string;
  sessionId?: string | null;
  sessions: readonly SessionInfo[];
}): ReactNode {
  const n = netStalledOf({ state, sessionId }, sessions);
  if (n && sessionId) return <StalledNote n={n} sessionId={sessionId} />;
  // The other hold on a running row: its session is signed out (`signedOutStall.ts`).
  // Words only — the way on is the Blocked sheet's sign-in card, not a button per row.
  const signed = signedOutStallText({ state, sessionId }, sessions);
  if (!signed) return null;
  return (
    <div className="net-stalled" role="status">
      <span className="netretry-line"><KeyRound size={14} aria-hidden="true" /> {signed}</span>
    </div>
  );
}

function StalledNote({ n, sessionId }: { n: SessionNetRetry; sessionId: string }): ReactNode {
  const now = useNow(30_000);
  return (
    <div className="net-stalled" role="status">
      <span className="netretry-line"><WifiOff size={14} aria-hidden="true" /> {netStalledText(n, now)}</span>
      <Hint>{n.error}</Hint>
      <div className="net-stalled-verbs">
        <Button title={NET_RETRY_NOW_NOTE} onClick={() => netRetryNow(sessionId)}>
          <PlugZap size={14} aria-hidden="true" /> retry now
        </Button>
      </div>
      <NetRetrySwitch label="auto-retry"
        note="The desktop's own switch (Settings › Sessions): on, it retries the next give-up by itself and tries this stalled one again on a slow clock (the note says when); off, this row waits for retry now or your typing." />
    </div>
  );
}
