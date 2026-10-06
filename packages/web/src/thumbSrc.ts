/**
 * Point an `<img>` at this device's stored thumbnail before the host.
 *
 * The one resolution rule for every picture in the app — the gallery grid, a
 * video's poster frame, and the inline thumbnail the reader draws for a file
 * mentioned in a transcript (`Markdown.tsx`). It lives here rather than in the
 * gallery because two copies would drift into two answers to "may this picture
 * come from the phone", which is exactly the difference between a grid that
 * paints offline and a reader that doesn't.
 *
 * Order matters both ways. Cache-first means an offline view paints without a
 * request that can only fail, and a re-opened one costs nothing at all; it also
 * means the `<img>` is pointed at its final source exactly once, instead of
 * loading over the network and being swapped for the stored copy a moment later
 * (two decodes and a visible flash per tile). While the (local, sub-millisecond)
 * lookup is in flight the caller draws its placeholder.
 *
 * The object URL is created per mount and revoked on unmount, so a long scroll
 * through hundreds of tiles cannot leak blobs the page never releases.
 */
import { useEffect, useState } from "react";
import { getThumbBlob } from "./thumbCache";

/** `src` = what to draw (null while the lookup runs), `live` = it came from the
 *  host, so a successful load is worth remembering (`cacheThumb`). */
export function useThumbSrc(url: string | null): { src: string | null; live: boolean } {
  const [state, setState] = useState<{ src: string | null; live: boolean }>({ src: null, live: false });
  useEffect(() => {
    let dead = false;
    let made: string | null = null;
    setState({ src: null, live: false });
    if (!url) return () => { dead = true; };
    void getThumbBlob(url).then((blob) => {
      if (dead) return;
      if (blob) {
        made = URL.createObjectURL(blob);
        setState({ src: made, live: false });
      } else {
        setState({ src: url, live: true });
      }
    });
    return () => { dead = true; if (made) URL.revokeObjectURL(made); };
  }, [url]);
  return state;
}
