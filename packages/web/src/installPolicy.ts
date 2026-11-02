/**
 * **Whether a downloaded APK may install itself, and what the row says about
 * it** — the pure half, so every sentence on this subject is decided in one
 * file and pinned by a test.
 *
 * The transport already ends with a fresh build sitting on the phone minutes
 * after the desktop finished writing it. What was left was a person finding the
 * file and tapping through a file manager, on every build, for every app. The
 * allow-list is the answer: a package on it installs itself at the end of the
 * download, with nobody watching.
 *
 * **Three refusals that are the platform's and not this app's**, all of them
 * worded rather than drawn as a dead button (`Unavailable.tsx`):
 *
 *  - **A browser cannot install anything.** No sentence either — a phone
 *    reading the app over the tunnel is not being told about a capability the
 *    APK has.
 *  - **"Install unknown apps" is a special access** only the person can grant.
 *    It is offered with the Settings screen beside it, never demanded.
 *  - **The FIRST install of a package always shows the system dialog.** No flag
 *    removes it, so the row says so in advance rather than promising silence it
 *    cannot deliver. Every build after that is quiet — that is the whole shape
 *    of the feature: one dialog per app, ever.
 *
 * **The list is packages, never file names.** Three repos on this desktop all
 * build `app-debug.apk`; the package name is read out of the archive itself
 * (`Installs.read`), and a row that could not be read offers the tap and
 * promises nothing.
 */

// The row half lives in `@waterplane/shared` (`installrow.ts`); re-exported so every
// importer of this module reads the same names it always did.
export {
  NO_INSTALL,
  shellDistribution,
  isPlayBuild,
  isApkRow,
  appLabel,
  isAllowed,
  toggleAllow,
  installOffer,
  installVerbText,
  installStatusText,
  repeatedVersionText,
  autoInstallText,
  allowToggle,
  installIntroText,
  cleanedText,
} from "@waterplane/shared";
export type { InstallCaps } from "@waterplane/shared";

// The apps screen's half (`appRows`, `readyApps`, the quiet-update words) moved into the android-apps
// extension (`packages/extensions/android-apps/web/appRows.ts`); only the shape the shell reports
// stays, because core's install hooks (`useInstallCaps.ts`, `sdk/install.ts`) hand it over.

/** What the phone records about who installed each package (`Installs.source`
 *  on the shell). `byPkg` leaves out a package it could not read. */
export interface InstallSources {
  /** waterplane's own package — the name an owner is compared against. */
  self: string;
  sdk?: number;
  byPkg: Record<string, { installer?: string; updateOwner?: string }>;
}
