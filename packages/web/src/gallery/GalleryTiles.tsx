import { useEffect } from "react";
import { ImageOff } from "lucide-react";
import { cacheThumb } from "../thumbCache";
import { useThumbSrc } from "../thumbSrc";

/**
 * The picture in a grid tile, resolved against this device's thumbnail cache
 * BEFORE the network.
 *
 * Order matters both ways. Cache-first means an offline grid paints without a
 * request that can only fail, and a re-opened gallery costs nothing at all; it
 * also means the <img> is pointed at its final source exactly once, instead of
 * loading over the network and being swapped for the stored copy a moment later
 * (two decodes and a visible flash per tile). While the (local, sub-millisecond)
 * lookup is in flight the tile draws its name and date with an empty picture
 * area — the same thing it shows for a document.
 *
 * `loading="lazy"` is kept: only what scrolls into view is fetched. What that
 * leaves uncached is handled by THUMB_WARM, not by loading the whole page eagerly.
 */
export function GridThumb({ url, name, missing, onMissing }: {
  url: string; name: string; missing: boolean; onMissing: () => void;
}) {
  const { src, live } = useThumbSrc(url);
  if (missing) {
    return <span className="img-missing"><ImageOff size={18} /><span className="img-missing-name">{name}</span></span>;
  }
  if (!src) return <span className="thumb-blank" />;
  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      decoding="async"
      // It drew, so the bytes are in the browser's own HTTP cache and the host
      // marked them immutable — remembering them is a local read, not a second
      // trip over Tailscale (thumbCache.ts).
      onLoad={() => { if (live) cacheThumb(url); }}
      onError={onMissing}
    />
  );
}

/** Same resolution for a video's poster frame. A video row can't report when its
 *  poster painted, so the warm is started from the effect instead. */
export function GridVideo({ src, poster, name }: { src: string; poster: string; name: string }) {
  const { src: posterSrc, live } = useThumbSrc(poster);
  useEffect(() => { if (live) cacheThumb(poster); }, [live, poster]);
  return (
    // preload="none" + a server-extracted poster frame: the grid no longer pulls
    // video metadata (and on some browsers a chunk of the file) for every row.
    <video src={src} poster={posterSrc ?? undefined} title={name} muted playsInline preload="none" />
  );
}

