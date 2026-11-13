/**
 * The links extension's wire: what the phone may ask the host half, typed once for both ends.
 * Pure, no node imports — the host compiles it (`tsconfig.extensions.json`), the phone bundles it.
 *
 * Transport: the generic plugin channel on the one socket. Phone → host is `plugin.call`; host →
 * phone is ONE tiny push, `changed` (`{ at }`), after which the phone reads `state` again.
 *
 * Two lists, kept apart on purpose: what the host FOUND (listening ports under the code root,
 * `tailscale serve` front doors, Cloud Run services, Firebase Hosting sites) and what a person
 * PINNED. Nothing found is ever pinned by itself — a pin is a tap.
 */

export type LinkEnv = "dev" | "staging" | "prod";
export const LINK_ENVS: readonly LinkEnv[] = ["dev", "staging", "prod"];

/** Where a found link came from. */
export type FoundKind = "local" | "cloudrun" | "function" | "firebase";

export interface FoundLink {
  /** Stable across discoveries: `local:<port>`, `run:<project>/<service>`, `fb:<site>`. */
  key: string;
  kind: FoundKind;
  /** The repo folder name under the code root, or null when nothing ties it to one. */
  repo: string | null;
  label: string;
  /** What the phone can open, or null (a port bound to loopback with no serve front door). */
  url: string | null;
  /** local: the port on this desktop. */
  port?: number;
  /** local: the process name, as lsof prints it. */
  proc?: string;
  /** cloud: the GCP project. */
  project?: string;
  /** A guess from the name (`-stg`, `staging`) — a pin can change it. */
  env: LinkEnv;
  /** Hidden by default: a Cloud Function behind Cloud Run, an emulator port. Said, never dropped. */
  hidden: boolean;
  /** Why it is hidden, or why it cannot be opened from the phone. */
  note?: string;
  /** local, loopback only: the command that would put a front door on it. Shown, never run. */
  serveCmd?: string;
}

export interface PinnedLink {
  /** `p:<12 hex>` — host-made. */
  id: string;
  repo: string | null;
  label: string;
  env: LinkEnv;
  /** A fixed URL (cloud, hand-added). Absent for a local pin, whose URL is resolved per state. */
  url?: string;
  /** A local pin: the port. Its phone URL is the current serve front door for it. */
  port?: number;
  /** The found key it was pinned from, so the found list can say "pinned". */
  from?: string;
}

export interface Probe {
  at: number;
  /** "up" = answered (any status below 500, a 401 included); "down" = refused, timed out, 5xx. */
  state: "up" | "down";
  status?: number;
  ms?: number;
  error?: string;
}

/** A pin as the phone draws it: the stored pin plus what it resolves to right now. */
export interface PinnedView extends PinnedLink {
  /** What a tap opens, or null with `why`. */
  openUrl: string | null;
  why?: string;
  /** local: whether something listens on the port at the last discovery (null = not looked yet). */
  listening?: boolean | null;
  probe: Probe | null;
}

export interface LinksState {
  pinned: PinnedView[];
  found: FoundLink[];
  /** When each half of the discovery last finished (null = not yet since the host started). */
  localAt: number | null;
  cloudAt: number | null;
  discovering: { local: boolean; cloud: boolean };
  /** Sentences about what discovery could not do (gcloud missing, a project refused). */
  notes: string[];
  /** Where pins are kept, for the README line on the sheet. */
  file: string;
}

/** Cloud discovery is slow (a gcloud call per project); its result is reused this long. */
export const CLOUD_FRESH_MS = 10 * 60_000;
/** Local discovery is cheap; reused this long. */
export const LOCAL_FRESH_MS = 20_000;
export const PUSH_CHANGED = "changed";

export const PIN_ID_RE = /^p:[0-9a-f]{12}$/;
export const isHttpUrl = (u: unknown): u is string => typeof u === "string" && u.length <= 2048 && /^https?:\/\/[^\s]+$/i.test(u);

export type LinksMethods = {
  state: { args: Record<string, never>; result: LinksState };
  /** Start discovery (joins a running one). `cloud: true` forces the slow half past its cache. */
  discover: { args: { cloud?: boolean }; result: LinksState };
  /** Probe every pin once. */
  probe: { args: Record<string, never>; result: LinksState };
  /** Pin a found link by its key — the host takes the URL and port from its own discovery. */
  pin: { args: { key: string }; result: LinksState };
  /** Pin a link typed by hand. */
  add: { args: { label: string; url: string; repo?: string | null; env?: LinkEnv }; result: LinksState };
  edit: { args: { id: string; label?: string; env?: LinkEnv; repo?: string | null }; result: LinksState };
  unpin: { args: { id: string }; result: LinksState };
};
