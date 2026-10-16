/**
 * The real stream router: `createStreams` (`streams.ts`, pure) wired to the one socket, a fresh `reqId`
 * per open, and the real clock. Lazy, because nothing here may run before App has bound the core.
 * `useHostFrames` hands it every JSON frame (after App's own switch) and every binary one.
 */
import { logTag } from "@waterplane/shared";
import { core } from "./api.ts";
import { createStreams, type Streams } from "./streams.ts";

/** A `reqId` is not an ackId: it addresses one answer on one socket and is never retried, so it
 *  is minted here and not by the queue (`core/queue/queue.test.mjs` counts the ackId minters). */
let seq = 0;
const mintReqId = () => `st-${Date.now().toString(36)}-${(++seq).toString(36)}`;

let streams: Streams | null = null;
export function streamRouter(): Streams {
  return (streams ??= createStreams({
    trySend: (f) => core().conn.trySend(f),
    mintId: mintReqId,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    report: (what, e) => console.error(`${logTag} stream callback failed: ${what}`, e),
  }));
}
