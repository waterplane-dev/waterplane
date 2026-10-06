/**
 * The in-UI logo. The artwork is `brand/*.svg`, bundled (`?raw` through the
 * `@brand` alias) and handed to an `<img>` as a data: URI — not a fetched file, so a
 * rebrand is `npm run brand:assets` plus a rebuild, and the APK's local server never
 * has to name an `.svg` (a fetched one came back as a broken image there).
 *
 * `<Logo size>` picks the simplified mark below the 64 px cut. `<Wordmark />`
 * is the lowercase monospace lockup `waterplane_`, the underscore in Amber.
 */
import iconSvg from "@brand/icon.svg?raw";
import iconSmallSvg from "@brand/icon-small.svg?raw";
import { useSmallMark } from "./logoMark";
import { appName } from "../themeOverlay";

// A logo in a page is a still picture: drop the kit's blinking-cursor animation.
const still = (svg: string) => svg.replace(/<\?xml[^>]*\?>/, "").replace(/<animate\b[^>]*\/>/g, "").replace(/<(animate)\b[^>]*>[\s\S]*?<\/\1>/g, "");
const FULL = still(iconSvg);
const SMALL = still(iconSmallSvg);

const uri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const FULL_URI = uri(FULL);
const SMALL_URI = uri(SMALL);

export function Logo({ size = 32, label = appName() }: { size?: number; label?: string }) {
  // An empty label marks it decorative: a neighbouring text already names it.
  return (
    <img
      className="logo"
      src={useSmallMark(size) ? SMALL_URI : FULL_URI}
      alt={label}
      width={size}
      height={size}
      style={{ display: "block", width: size, height: size, flex: "0 0 auto" }}
    />
  );
}

export function Wordmark() {
  return (
    <span className="wordmark" style={{ fontFamily: "var(--mono, ui-monospace, Menlo, monospace)", fontWeight: 800, letterSpacing: "-0.02em" }}>
      {appName()}<span style={{ color: "#F5A93F" }}>_</span>
    </span>
  );
}
