/**
 * Which disks this desktop has, and which one a path is on. A person cleans up because ONE disk is
 * full (here: the internal Data volume at 99% while an external disk sat at 19%), so the sheet shows
 * every real disk and cuts its lists to the one picked.
 *
 * mac: the home folder's volume (the Data volume — "/" is the sealed system snapshot) plus every
 * local disk mounted under /Volumes, from `mount`. linux: the block-device filesystems in
 * /proc/mounts, minus /boot and snaps. wsl keeps its own two-disk reading (`engine.mts`) and is not
 * listed here.
 *
 * The key differs by system, because the device number means different things:
 *  - mac: `stat().dev`, so a path is matched by one `stat`, never by path prefix (firmlinks).
 *  - linux: the SOURCE device in /proc/mounts (`src:/dev/vdb1`). On btrfs every subvolume and bind
 *    mount has its own `stat().dev` — the wp-peer VM listed one 37 GB disk as four — so a path is
 *    matched to the deepest mount that holds its realpath, as `df` does, and keyed by that source.
 */
import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DiskVolume } from "../shared/wire.mjs";
import { run, volumeOf } from "./run.mjs";

/** `mount` (mac) as [device, mount point, fs type, options]. */
export function parseMacMounts(out: string): { dev: string; at: string; fs: string; opts: string[] }[] {
  const rows: { dev: string; at: string; fs: string; opts: string[] }[] = [];
  for (const line of out.split("\n")) {
    const m = /^(.+?) on (.+) \(([^,)]+)((?:, [^,)]+)*)\)$/.exec(line.trim());
    if (m) rows.push({ dev: m[1]!, at: m[2]!, fs: m[3]!, opts: m[4]!.split(",").map((s) => s.trim()).filter(Boolean) });
  }
  return rows;
}

const MAC_FS = new Set(["apfs", "hfs", "exfat", "msdos", "ntfs", "ufsd_NTFS", "fusefs"]);

/** The mac disks a person put data on: local, writable, under /Volumes (not a hidden or system one). */
export function macUserMounts(out: string): string[] {
  return parseMacMounts(out)
    .filter((m) => m.dev.startsWith("/dev/") && MAC_FS.has(m.fs) && m.opts.includes("local") && !m.opts.includes("read-only"))
    .map((m) => m.at)
    .filter((at) => at.startsWith("/Volumes/") && !basename(at).startsWith(".") && !/^\/Volumes\/(Recovery|Preboot|Update|VM)$/.test(at));
}

const LINUX_FS = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "jfs", "reiserfs", "ntfs", "ntfs3", "exfat", "vfat", "fuseblk"]);

export interface LinuxMount { src: string; at: string }

/** /proc/mounts' real disks (a /dev block device, a data filesystem) with their source, not /boot and not snaps. */
export function linuxDiskMounts(text: string): LinuxMount[] {
  const unescape = (s: string) => s.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  return text.split("\n").map((l) => l.split(" ")).filter((f) => f.length >= 3)
    .filter(([dev, , fs]) => (dev!.startsWith("/dev/") || fs === "zfs") && LINUX_FS.has(fs!))
    .map(([src, at]) => ({ src: unescape(src!), at: unescape(at!) }))
    .filter(({ at }) => !/^\/boot(\/|$)/.test(at) && !/^\/snap\//.test(at) && !/^\/(proc|sys|dev|run)(\/|$)/.test(at));
}

/** The mount points alone. */
export function linuxMounts(text: string): string[] {
  return linuxDiskMounts(text).map((m) => m.at);
}

/** The deepest mount holding `path` (already a realpath). */
export function mountHolding(path: string, mounts: readonly LinuxMount[]): LinuxMount | null {
  const inside = mounts.filter((m) => m.at === "/" || path === m.at || path.startsWith(`${m.at}/`));
  return inside.sort((a, b) => b.at.length - a.at.length)[0] ?? null;
}

export const keyOfSrc = (src: string): string => `src:${src}`;

/** The mac startup disk's own name ("Macintosh HD": the /Volumes entry that links to "/"). */
async function macStartupName(): Promise<string> {
  try {
    for (const n of await readdir("/Volumes")) {
      try { if ((await readlink(join("/Volumes", n))) === "/") return n; } catch { /* not a link */ }
    }
  } catch { /* no /Volumes */ }
  return "startup disk";
}

export const keyOfDev = (dev: number | bigint): string => `dev:${dev}`;

const procMounts = (): Promise<string> => readFile("/proc/mounts", "utf8").catch(() => "");

/**
 * Every real disk with its free space, the fullest (lowest free share) first; deduplicated by device.
 * `home` always comes first among equals and is labelled as the startup disk on a mac.
 */
export async function listVolumes(home: string, profile: "mac" | "linux"): Promise<DiskVolume[]> {
  const out: DiskVolume[] = [];
  if (profile === "mac") {
    const places = [{ path: home, label: await macStartupName() }];
    const m = await run("/sbin/mount", [], { timeoutMs: 5_000 });
    if (m.code === 0) for (const at of macUserMounts(m.stdout)) places.push({ path: at, label: basename(at) });
    const seen = new Set<string>();
    for (const p of places) {
      let key: string;
      try { key = keyOfDev((await stat(p.path)).dev); } catch { continue; }
      if (seen.has(key)) continue;
      const v = await volumeOf(p.path);
      if (!v) continue;
      seen.add(key);
      out.push({ ...v, key, label: p.label });
    }
  } else {
    const mounts = linuxDiskMounts(await procMounts());
    // The home disk first, named by the mount that holds home; then each other source once, by its shortest mount point.
    const homeMount = mountHolding(await realpath(home).catch(() => home), mounts);
    const bySrc = new Map<string, LinuxMount>();
    for (const m of [...mounts].sort((x, y) => x.at.length - y.at.length)) if (!bySrc.has(m.src)) bySrc.set(m.src, m);
    if (homeMount) bySrc.set(homeMount.src, homeMount);
    for (const [src, m] of bySrc) {
      const path = m === homeMount ? home : m.at;
      const v = await volumeOf(path);
      if (v) out.push({ ...v, key: keyOfSrc(src), label: m.at });
    }
  }
  return out.sort((a, b) => a.freeKb / a.totalKb - b.freeKb / b.totalKb);
}

/**
 * `path` → the key of the disk it is on, when that disk is one of `keys`; else undefined.
 * mac: by `stat().dev`. linux: by the source of the deepest mount holding its realpath.
 */
export function diskOf(profile: "mac" | "linux", keys: ReadonlySet<string>): (path: string) => Promise<string | undefined> {
  if (profile === "mac") {
    return async (path) => { try { const k = keyOfDev((await stat(path)).dev); return keys.has(k) ? k : undefined; } catch { return undefined; } };
  }
  let mounts: Promise<LinuxMount[]> | null = null;
  return async (path) => {
    mounts ??= procMounts().then(linuxDiskMounts);
    let real: string;
    try { real = await realpath(path); } catch { return undefined; }
    const m = mountHolding(real, await mounts);
    const k = m ? keyOfSrc(m.src) : undefined;
    return k && keys.has(k) ? k : undefined;
  };
}
