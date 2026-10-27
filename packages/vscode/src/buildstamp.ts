// Which build of this extension is running — the identifier the repo's build list shows for the
// same build (`@waterplane/shared` buildstamp.ts). esbuild defines `__WP_BUILD__`; a bundle built
// without it (a test loading the source) has no stamp and says nothing rather than a guess.
import { buildStampText, cleanBuildStamp } from "@waterplane/shared";

declare const __WP_BUILD__: unknown;

const stamp = typeof __WP_BUILD__ === "undefined" ? null : cleanBuildStamp(__WP_BUILD__);

/** `0.7.0 · a1b2c3d · 27 Oct 08:42`, or null when this bundle was not stamped. */
export const buildText: string | null = stamp ? buildStampText(stamp) : null;
