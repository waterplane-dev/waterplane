/**
 * The disk-space sheet's state and its ONE writer. Every host answer comes through `client`
 * (`plugin.call` on the one socket — never a second transport); the store is written only by the
 * actions here, never by a component.
 *
 * The host keeps the last scan in memory with its timestamp; this store keeps the last ANSWER and
 * when it arrived. The host's one push, `changed`, means "read `state` again".
 */
import { core, createStore, featureSheetId, pluginClient, type PluginCallResult } from "@waterplane/sdk";
import { askConfirm, ago } from "@waterplane/kit";
import type { DiskEntry, DiskMethods, DiskState } from "../shared/wire.mts";
import { cleanAllAsk, deleteAsk } from "./logic.ts";

export const DISK_SHEET = featureSheetId("diskspace", "main");
const client = pluginClient<DiskMethods>("diskspace");

export interface DiskView { res: PluginCallResult<DiskState> | null; at: number | null }
export const disk = createStore<DiskView>({ res: null, at: null });

/** A scan that finished this recently is not re-run just because the sheet opened. */
const FRESH_MS = 2 * 60_000;

const take = (res: PluginCallResult<DiskState>) => disk.set({ res, at: Date.now() });

export async function readState(): Promise<void> {
  if (core().conn.status !== "open") return;
  take(await client.read("state", {}));
}

/** Start a scan (the host joins one already running) — the refresh button. */
export async function rescan(): Promise<void> {
  const res = await client.read("scan", {});
  take(res);
  if (!res.ok) core().say.toast(`the scan did not start: ${res.error}`);
}

/** Opening the sheet scans, unless a scan is running or finished within FRESH_MS. */
export async function scanOnOpen(): Promise<void> {
  if (core().conn.status !== "open") return;
  const res = await client.read("state", {});
  take(res);
  if (!res.ok || res.result.scanning) return;
  const at = res.result.scan?.at;
  if (at == null || Date.now() - at > FRESH_MS) await rescan();
}

/** Look for build output and node_modules now (on wsl with the code root on the Windows drive, the only way it runs). */
export async function scanCode(): Promise<void> {
  const res = await client.read("scanCode", {});
  take(res);
  core().say.toast(res.ok ? "looking for build output and node_modules on the desktop…" : `the search did not start: ${res.error}`);
}

export async function scanLarge(): Promise<void> {
  const res = await client.read("scanLarge", {});
  take(res);
  if (!res.ok) core().say.toast(`the large-file search did not start: ${res.error}`);
}

/** Ask (askConfirm — never window.confirm), then hand the host the row's ID. Never a path. */
export async function removeEntry(e: DiskEntry, scannedAt: number | null): Promise<void> {
  const q = deleteAsk(e, scannedAt, ago);
  if (!(await askConfirm({ ...q, tone: "warn" }))) return;
  const res = await client.call("remove", { id: e.id });
  core().say.toast(res.ok ? `deleting ${res.result.label} on the desktop…` : `not deleted: ${res.error}`);
  await readState();
}

export async function cleanAll(rows: readonly DiskEntry[]): Promise<void> {
  if (!rows.length) return;
  if (!(await askConfirm({ ...cleanAllAsk(rows), tone: "warn" }))) return;
  const res = await client.call("cleanTemp", {});
  core().say.toast(res.ok ? `deleting ${res.result.accepted} temporary folder${res.result.accepted === 1 ? "" : "s"} on the desktop…` : `nothing deleted: ${res.error}`);
  await readState();
}

export function openDisk(): void {
  core().nav.open(DISK_SHEET);
}

export function closeDisk(): void {
  core().nav.close(DISK_SHEET);
}

/** The host's `changed` push. */
export function onChanged(): void {
  void readState();
}
