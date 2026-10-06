import type { AutoPullConfig } from "@waterplane/shared";
import { core, mapWith } from "../../sdk";
import { pulls } from "../../pull";
import { OPEN_DOWNLOADS_EVENT } from "../../download";
import { cfgs, records, rulesFor } from "./store";

export function putCfg(repoDir: string, config: AutoPullConfig): void {
  cfgs.set((prev) => mapWith(prev, repoDir, config));
}

/** Open Downloads on the RULES pane for this repo. */
export function openPullRules(repoDir: string): void {
  rulesFor.set(repoDir);
  core().nav.open("pull");
}

export function clearRules(): void {
  rulesFor.set(null);
}

/**
 * Start the transfer manager once and mirror its state for rendering. It owns
 * retries, resume offsets and the Background Fetch handoff — the screens only
 * show what it reports. Returns the cleanup.
 */
export function bootPull(): () => void {
  pulls.start();
  const off = pulls.subscribe((list) => records.set(list));
  // "see Downloads" is a tap as well as a word: `download.ts` fires this from
  // a toast, a gallery button, anywhere — one listener.
  const open = () => core().nav.open("pull");
  window.addEventListener(OPEN_DOWNLOADS_EVENT, open);
  return () => { off(); window.removeEventListener(OPEN_DOWNLOADS_EVENT, open); };
}
