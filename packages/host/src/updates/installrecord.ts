/**
 * What marks a plugin as installed BY THE MANAGER: `<plugins dir>/<id>/.waterplane-install.json`.
 * Without it a plugin is `local` — a dir the person put there by hand (or a `plugin-paths.json`
 * dev checkout): listed, never updated by the manager.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";
import type { InstalledPlugin } from "@waterplane/shared";
import { writeJsonAtomic } from "../jsonstore.js";

export const INSTALL_RECORD = `.${BRAND.slug}-install.json`;

export interface InstallRecord {
  /** The repo URL it was cloned from. */
  url: string;
  kind: "tag" | "branch";
  ref: string;
  commit?: string;
  installedAt: number;
}

/** The record in `dir`, or null (absent, unreadable or malformed ⇒ the plugin is `local`). */
export function readInstallRecord(dir: string): InstallRecord | null {
  try {
    const p = join(dir, INSTALL_RECORD);
    if (!existsSync(p)) return null;
    const o = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    if (typeof o.url !== "string" || typeof o.ref !== "string" || (o.kind !== "tag" && o.kind !== "branch")) return null;
    return { url: o.url, kind: o.kind, ref: o.ref, commit: typeof o.commit === "string" ? o.commit : undefined, installedAt: typeof o.installedAt === "number" ? o.installedAt : 0 };
  } catch { return null; }
}

export function writeInstallRecord(dir: string, rec: InstallRecord): void {
  writeJsonAtomic(join(dir, INSTALL_RECORD), rec);
}

/** An installed plugin plus the repo URL its record names (the join key when the manifest is gone). */
export type InstalledWithUrl = InstalledPlugin & { url?: string };

/** The registry's loaded external plugins as `InstalledPlugin`s. Built-ins are not installs. */
export function installedFrom(entries: readonly { dir: string; builtin?: boolean; manifest: { id: string; version?: string } }[]): InstalledWithUrl[] {
  const out: InstalledWithUrl[] = [];
  for (const e of entries) {
    if (e.builtin) continue;
    const rec = readInstallRecord(e.dir);
    out.push(rec
      ? { id: e.manifest.id, version: String(e.manifest.version ?? ""), source: "manager", ref: rec.ref, commit: rec.commit, dir: e.dir, url: rec.url }
      : { id: e.manifest.id, version: String(e.manifest.version ?? ""), source: "local", dir: e.dir });
  }
  return out;
}
