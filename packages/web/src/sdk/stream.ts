/**
 * `openStream`: a plugin's live stream (its host half's `api.stream(name, …)`), on the ONE socket.
 * The SDK owns the socket, so the extension never sees it (`local/no-second-socket`,
 * `local/extension-boundary`).
 *
 * **Why a stream is never queued offline, never ackId'd and never retried:** it is live by nature.
 * An open delivered an hour late is for a screen nobody is watching any more, and an input event
 * delivered late — a click, a key — lands on whatever is on the desktop's screen by then, which is
 * not what the person aimed at (`intent.cancel`'s reasoning). So every frame goes out NOW or not at
 * all, through the same write-now-or-never path `plugin.call` uses (`trySend`, never the socket's
 * RAM queue that replays on the next open), and `input()` while the stream is not open is DROPPED —
 * the false it returns is the whole answer. That is what makes input at-most-once.
 *
 * What does survive a dropped link is the view's wish to see the stream: the handle reopens it on
 * the next connection with the LATEST params (a new `streamId`, told through `onOpened`), so an
 * extension holds one handle for as long as its view is on screen and calls `close()` when it goes.
 *
 * Contract: `shared/stream.ts`. Mechanics and tests: `core/streams.ts`, `core/streams.test.mjs`.
 */
import { streamRouter } from "../core/streamRouter.ts";
import type { StreamCallbacks, StreamHandle } from "../core/streams.ts";

export type { StreamCallbacks, StreamHandle, StreamState, StreamStats, StreamStopCause } from "../core/streams.ts";

/** Open `pluginId`'s stream `name` with `params`. Returns at once: `stats().state` is `opening`
 *  until the desktop answers (`onOpened`), `refused` or `ended` once it is over (`onEnded`, with the
 *  sentence to show). Opened while the link is down, it opens when the link comes back. */
export function openStream(pluginId: string, name: string, params: unknown, cb: StreamCallbacks): StreamHandle {
  return streamRouter().open(pluginId, name, params, cb);
}
