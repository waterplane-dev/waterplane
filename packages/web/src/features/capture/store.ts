/**
 * What the capture feature holds, and every writer of it — the build feature's
 * arrangement, for the build feature's reasons (`sdk/repoRun.ts`: they are the
 * same feature typed twice). One writer per store: `actions.ts`, which the wire
 * handlers in `index.ts` and the sheet call; the sheet itself only reads.
 *
 * Targets are per repo, keyed by worktree path and seeded from the device
 * cache (an empty list is a CLAIM, and this sheet is opened from away from the
 * desk), with the age the host last confirmed each one.
 */
import type { CaptureBackendInfo, CaptureRun, CaptureTarget, RepoTarget } from "@waterplane/shared";
import { createStore, repoRunStore } from "../../sdk";
import { loadCaptureSnap, saveCaptureSnap } from "../../localState";

export const captures = repoRunStore<CaptureTarget, CaptureRun>({ load: loadCaptureSnap, save: saveCaptureSnap });

/** The repo whose CaptureSheet is open, which a reconnect re-asks for. */
export const captureRepo = createStore<RepoTarget | null>(null);

/**
 * What this DESKTOP can drive right now, per repo. NOT cached, deliberately:
 * whether Playwright is installed, whether adb sees a phone — a remembered
 * "web is unavailable" would keep saying so for weeks after somebody installed
 * it. An empty entry means nobody has said, which the sheet renders
 * differently from "said no" (`backendOf`).
 */
export const captureBackends = createStore<ReadonlyMap<string, CaptureBackendInfo[]>>(new Map());
