/**
 * What the cliHealth feature does, as plain functions: the frame handler, the
 * promise the sheet reads through, and opening the sheet (optionally filtered).
 */
import { TimeoutError, type HealthVerdict, type HostMessage } from "@waterplane/shared";
import { core } from "../../sdk";
import type { CliHealthDoc } from "../../CliHealthSheet";
import { saveCliHealthSnap } from "../../localState";
import { worsened } from "./logic";
import { filter, rollup } from "./store";

/** The worst rollup this page has SEEN. The toast fires on a worsening, and
 *  only ever on a change — the first frame of a session sets the baseline
 *  without saying anything, because a cold start onto a degraded CLI is what
 *  the chip is for and a toast on every launch is noise nobody reads. */
const seen: { current: HealthVerdict | null } = { current: null };

/** Resolvers waiting on a `clihealth` frame — see `requestCliHealth`. */
const waiters: { current: ((doc: CliHealthDoc) => void)[] } = { current: [] };

/** How long `requestCliHealth` waits for the host's answer before calling the
 *  link dead. The host answers off an in-memory store, so anything past a
 *  couple of seconds is the tunnel and not the daemon. */
export const CLI_HEALTH_WAIT_MS = 6000;

/**
 * `clihealth.get`, as a promise — what `CliHealthSheet` hands to
 * `useRemoteResource`.
 *
 * The health board is the one host READ in this app that does not travel over
 * HTTP, so there is no `api.*` call to wrap. The hook's contract is worth
 * honouring anyway (cache first, then the live read, with `error` and
 * `offline` never collapsed), and the only thing it needs is a promise that
 * REJECTS the way a fetch would — hence the `TimeoutError`, which is exactly
 * what `isOffline` recognises. A frame that arrives for any other reason (the
 * host's own change broadcast, another tab's `hello`) resolves this too:
 * every `clihealth` frame carries the whole board, so there is no such thing
 * as the wrong one.
 */
export function requestCliHealth(): Promise<CliHealthDoc> {
  return new Promise<CliHealthDoc>((resolve, reject) => {
    const c = core();
    if (c.conn.status !== "open") { reject(new TimeoutError("clihealth", 0)); return; }
    const timer = setTimeout(() => {
      waiters.current = waiters.current.filter((f) => f !== settle);
      reject(new TimeoutError("clihealth", CLI_HEALTH_WAIT_MS));
    }, CLI_HEALTH_WAIT_MS);
    const settle = (doc: CliHealthDoc) => { clearTimeout(timer); resolve(doc); };
    waiters.current.push(settle);
    c.conn.send({ t: "clihealth.get" });
  });
}

/**
 * The CLI integration's own health — unprompted on `hello`, and again whenever
 * a verdict moves (the host debounces that broadcast ~5 s, so this is not a
 * frame source).
 *
 * Three things happen here and they are deliberately separate. The SNAPSHOT is
 * what makes the sheet paint offline. The ROLLUP is what the launcher's chip
 * renders — "loud means on the phone, unprompted", and a readout you have to go
 * looking for is not a readout. The TOAST is the third: loud for someone
 * already holding the phone, where the notification kind is loud for a phone
 * in a pocket. It fires only on a WORSENING, because a board that is degraded
 * and stays degraded is not news, and a sentence repeated every five seconds
 * is one nobody reads.
 */
export function onCliHealth(msg: Extract<HostMessage, { t: "clihealth" }>): void {
  saveCliHealthSnap({ health: msg.health, rollup: msg.rollup });
  rollup.set(msg.rollup);
  for (const resolve of waiters.current.splice(0)) resolve({ health: msg.health, rollup: msg.rollup });
  const prev = seen.current;
  seen.current = msg.rollup.verdict;
  if (worsened(prev, msg.rollup.verdict)) {
    // The host's push says these same words for the same signal. One
    // sentence, generated once, in `@waterplane/shared`.
    const line = msg.rollup.lines[0];
    if (line) core().say.toast(line);
  }
}

/** Open the board — whole (`null`, Settings' door) or cut to the verdicts a
 *  count named (the topbar chip). The caller tracks. */
export function openCliHealth(verdicts: HealthVerdict[] | null = null): void {
  filter.set(verdicts);
  core().nav.open("clihealth");
}
