import { fmtBytes, TimeoutError } from "@waterplane/shared";

/**
 * A response body read with a STALL fuse and byte progress. `timedFetch` stops
 * guarding once headers land, so a bare `.blob()` on a body that stops arriving
 * waits for ever — "loading…" with nothing to say. This rejects after
 * `stallMs` without a single new byte, saying how far it got — as a
 * `TimeoutError`, so every caller's `isOffline` reads a stall as the dead link
 * it is.
 */
export async function readBodyFused(r: Response, stallMs: number, onProgress?: (got: number, total: number) => void): Promise<Blob> {
  if (!r.body) return r.blob();
  const total = Number(r.headers.get("content-length") || 0);
  const reader = r.body.getReader();
  const parts: BlobPart[] = [];
  let got = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<never>((_, no) => {
      timer = setTimeout(() => {
        const e = new TimeoutError(r.url, stallMs);
        e.message = `stalled — no bytes for ${Math.round(stallMs / 1000)}s after ${fmtBytes(got)}${total ? ` of ${fmtBytes(total)}` : ""}`;
        // Reject BEFORE cancelling: cancel settles the pending read as `done`,
        // and a read that won the race would hand back a truncated body as whole.
        no(e);
        void reader.cancel().catch(() => {});
      }, stallMs);
    });
    try {
      const { done, value } = await Promise.race([reader.read(), stall]);
      if (done) break;
      parts.push(value);
      got += value.byteLength;
      onProgress?.(got, total);
    } finally {
      clearTimeout(timer);
    }
  }
  return new Blob(parts, { type: r.headers.get("content-type") || "" });
}

/** JSON under the same stall fuse. For the reader's reads: a transcript is
 *  megabytes, so a whole-body deadline would refuse a slow-but-alive tunnel,
 *  while a bare `r.json()` waited for ever on a stalled one — the reader then
 *  sat on "cached copy — still asking the host" over a turn's missing answer,
 *  every poll stacking another pending read behind the first. */
export async function readJsonFused<T>(r: Response, stallMs: number): Promise<T> {
  return JSON.parse(await (await readBodyFused(r, stallMs)).text()) as T;
}
