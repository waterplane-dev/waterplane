/**
 * The disk-space engine: one scan at a time, one large-file find at a time, deletes in a serial
 * queue, the last result kept in memory with its timestamp. No poller — everything here starts from
 * a call. Every change ends in `notify()` (the `changed` push); the phone reads `state()` again.
 *
 * A delete takes an ID, never a path. Two gates: the id must be a temp/model entry of the LAST
 * scan (a fast refusal in words), and the job then RE-RESOLVES that category freshly, finds the id
 * there, and runs `safeToRemove` before `rm`. A show-only id, a large file, an unknown id or a
 * path-shaped string never reaches either.
 */
import { lstat, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CANDIDATE_ID_RE, type CodeWalk, type DiskDeleteResult, type DiskEntry, type DiskScan, type DiskSide, type DiskState, type DiskVolume, type LargeScan } from "../shared/wire.mjs";
import {
  buildCandidates, codeOnTap, driveForm, nodeModulesEntries, ollamaSizeKb, OLLAMA_NAME_RE, onWindowsDrive, profileOf, recheckBuild, resolveCaches, resolveHf, resolveOllama, resolveTmp, resolveWinCaches,
  resolveWinTemp, safeToRemove, showOnly, sideOfPath, tilde, walkRoot, winHomeOf, type Candidate, type Category, type Roots,
} from "./candidates.mjs";
import { findLarge } from "./large.mjs";
import { measure, measureWindows, pool, run, volumeOf, windowsVolume, type Measured } from "./run.mjs";

/** What `rm` says when Windows holds a file open (drvfs maps a sharing violation to one of these). */
const IN_USE = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
const INSIDE_WSL = "inside WSL";

/**
 * Remove a file or folder tree bottom-up, counting what actually went. `rm(recursive)` hides this:
 * when a file inside is held it throws after unlinking the rest, and the caller could only say
 * "nothing removed". On a throw, `done.n > 0` means the entry was left partly cleared.
 */
async function rmCounted(p: string, done: { n: number }): Promise<void> {
  let st;
  try { st = await lstat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  if (st.isDirectory()) {
    for (const e of await readdir(p)) await rmCounted(join(p, e), done);
    await rmdir(p);
  } else await unlink(p);
  done.n++;
}

const RESULTS_MAX = 20;
/** How many node_modules folders are listed (the biggest). */
export const NODE_MODULES_TOP = 15;

export interface Engine {
  state(): DiskState;
  scan(): DiskState;
  scanLarge(): DiskState;
  /** Look for build output and node_modules now (the only way it runs when `codeOnTap`). */
  scanCode(): DiskState;
  remove(id: string): { accepted: true; label: string };
  cleanTemp(): { accepted: number };
  /** Resolves when no scan, find or delete is running (tests). */
  idle(): Promise<void>;
}

/** How a candidate's paths were measured beforehand (Windows-side paths by PowerShell), and why not when PowerShell could not. */
interface Pre { byPath: Map<string, Measured>; duNote: string | null }

/** A measured candidate, ready for the wire. A path in `pre.byPath` is taken from there; the rest are `du`'d. */
async function measured(c: Candidate, r: Roots, pre?: Pre): Promise<DiskEntry> {
  const base: DiskEntry = { id: c.id, kind: c.kind, group: c.group, label: c.label, sizeKb: null, regen: c.regen, mtime: c.mtime ?? null, ...(c.note ? { note: c.note } : {}), ...(c.ollamaId ? { copy: c.ollamaId } : {}), ...(c.side ? { side: c.side } : {}) };
  if (c.category === "ollama") {
    const kb = c.sizeText ? ollamaSizeKb(c.sizeText) : null;
    return { ...base, sizeKb: kb, sizeNote: kb == null ? `size unknown — ollama said "${c.sizeText ?? ""}"` : "as ollama reports it, rounded" };
  }
  const paths = c.members ?? (c.path ? [c.path] : []);
  // A Windows-side row PowerShell could not size is measured with du as before — and says so.
  if (pre?.duNote && paths.some((p) => onWindowsDrive(r, p))) base.note = base.note ? `${base.note} · ${pre.duNote}` : pre.duNote;
  const ms: Measured[] = await pool(paths, r.concurrency, (p) => Promise.resolve(pre?.byPath.get(p) ?? measure(p, { duBin: r.duBin, timeoutMs: r.duTimeoutMs })));
  const known = ms.filter((m) => m.sizeKb != null);
  if (!known.length) return { ...base, sizeNote: ms[0]?.sizeNote ?? "size unknown" };
  const sizeKb = known.reduce((s, m) => s + m.sizeKb!, 0);
  const unknown = ms.length - known.length;
  const partial = unknown > 0 || ms.some((m) => m.partial);
  if (!partial) return { ...base, sizeKb };
  const note = ms.length === 1 ? ms[0]!.sizeNote : `at least this much — ${unknown ? `${unknown} of ${ms.length} folders could not be measured` : "some files could not be read"}`;
  return { ...base, sizeKb, partial: true, ...(note ? { sizeNote: note } : {}) };
}

/**
 * Measure a list of candidates: on wsl every Windows-side path in it goes to ONE PowerShell call
 * (du over drvfs took over 120 s per cache folder), the rest to `du` as before. PowerShell missing
 * or answering nothing usable: du for those too, with the reason on each row.
 */
async function measureAll(list: readonly Candidate[], r: Roots): Promise<DiskEntry[]> {
  const win = [...new Set(list.filter((c) => c.category !== "ollama").flatMap((c) => c.members ?? (c.path ? [c.path] : [])).filter((p) => onWindowsDrive(r, p)))];
  let pre: Pre | undefined;
  if (win.length) {
    const got = await measureWindows(win, { psBin: r.psBin, timeoutMs: r.psTimeoutMs ?? r.duTimeoutMs, run: r.psRun, winPath: r.winPath });
    pre = "byPath" in got ? { byPath: got.byPath, duNote: null } : { byPath: new Map(), duNote: `measured with du from inside WSL (slow): ${got.fallback}` };
  }
  return pool(list, 2, (c) => measured(c, r, pre));
}

const isBuild = (e: DiskEntry) => e.id.startsWith("build:");
const isNm = (e: DiskEntry) => e.id.startsWith("nm:");
const bySize = (a: DiskEntry, b: DiskEntry) => (b.sizeKb ?? -1) - (a.sizeKb ?? -1);

export function createEngine(r: Roots, notify: () => void): Engine {
  let scanning: Promise<void> | null = null;
  let scanStartedAt: number | null = null;
  let last: DiskScan | null = null;
  let large: LargeScan | null = null;
  let finding: Promise<void> | null = null;
  const deleting: { id: string; label: string; since: number }[] = [];
  const results: DiskDeleteResult[] = [];
  let queue: Promise<void> = Promise.resolve();
  /** Which part of the running scan; null when none runs. */
  let phase: "fast" | "code" | null = null;
  /** The running scan will (or does) walk the code root. */
  let codeWanted = false;
  let codeStartedAt: number | null = null;
  /** The last walk of the code root: when, how long, what it could not do. */
  let codeAt: number | null = null, codeTookMs: number | null = null, codeNotes: string[] = [];
  /** id → path of the build output the last walk found: the HOST's own, so a delete never takes a path from the phone. */
  let buildPaths = new Map<string, string>();
  /** Build rows deleted while a walk runs: the walk listed them before the delete, so its result must not bring them back. */
  const goneDuringWalk = new Set<string>();
  const onTap = codeOnTap(r);

  const prof = profileOf(r);
  /** Which disk a category's bytes are on (wsl only). */
  const sideOf = (cat: Category): DiskSide | undefined => (prof !== "wsl" ? undefined : cat === "wcache" || cat === "wtemp" ? "windows" : "wsl");

  /** Free space on the disk `side` names: the Windows drive, or the home folder's volume. */
  async function freeOn(side: DiskSide | undefined, drive?: string): Promise<DiskVolume | null> {
    if (side === "windows") { const w = drive ?? winHomeOf(r); return w ? (await windowsVolume(w, r.psBin)).volume : null; }
    const v = await volumeOf(r.home);
    return v && prof === "wsl" ? { ...v, label: INSIDE_WSL } : v;
  }

  /** The header disk and, on wsl, the second line. */
  async function readVolumes(notes: string[]): Promise<Pick<DiskScan, "volume" | "wslVolume">> {
    if (prof !== "wsl") {
      const v = await volumeOf(r.home);
      if (!v) notes.push("Free space could not be read (statfs failed).");
      return { volume: v };
    }
    const inside = await freeOn("wsl");
    const win = winHomeOf(r);
    if (!win) {
      if (!inside) notes.push("Free space inside WSL could not be read (statfs failed).");
      return { volume: inside };
    }
    const w = await windowsVolume(win, r.psBin);
    if (w.note) notes.push(w.note);
    if (!inside) notes.push("Free space inside WSL could not be read (statfs failed).");
    return { volume: w.volume, wslVolume: inside };
  }

  /** Put a fresh reading of the disk `side` names into the last scan. */
  const keepVolume = (side: DiskSide | undefined, v: DiskVolume) => {
    if (!last) return;
    if (side === "wsl" && winHomeOf(r)) last = { ...last, wslVolume: v };
    // A row on another Windows drive than the header's must not overwrite the header with that drive.
    else if (side !== "windows" || !last.volume?.label || last.volume.label === v.label) last = { ...last, volume: v };
  };

  const code = (): CodeWalk => ({
    root: sideOfPath(r.root) === "windows" && prof === "wsl" ? driveForm(r.root) : tilde(r.root, r.home), onTap,
    running: scanning != null && codeWanted, startedAt: phase === "code" ? codeStartedAt : null, at: codeAt, tookMs: codeTookMs, notes: codeNotes.slice(),
  });

  const state = (): DiskState => ({
    scanning: scanning != null, phase, code: code(), scanStartedAt, scan: last, large, deleting: deleting.map((d) => ({ ...d })), results: results.slice(),
  });

  /** Fresh candidates of one deletable category. */
  async function resolve(cat: Category): Promise<{ list: Candidate[]; notes: string[] }> {
    switch (cat) {
      case "cache": return { list: await resolveCaches(r), notes: [] };
      case "hf": return { list: await resolveHf(r), notes: [] };
      case "tmp": return { list: await resolveTmp(r), notes: [] };
      case "wcache": return { list: await resolveWinCaches(r), notes: [] };
      case "wtemp": return { list: await resolveWinTemp(r), notes: [] };
      case "ollama": { const o = await resolveOllama(r); return { list: o.list, notes: o.note ? [o.note] : [] }; }
      // "build" is never re-walked: a delete re-checks its one path (`recheckBuild`).
      default: return { list: [], notes: [] };
    }
  }

  /** Drop what fails the containment check, each with its sentence. */
  async function vetted(list: Candidate[], notes: string[]): Promise<Candidate[]> {
    const ok: Candidate[] = [];
    for (const c of list) {
      if (c.category === "ollama") { ok.push(c); continue; }
      const why = (await Promise.all((c.members ?? [c.path!]).map((p) => safeToRemove(c, r, p)))).find((w) => w != null);
      if (why) notes.push(`Not offered: ${why}.`); else ok.push(c);
    }
    return ok;
  }

  /** Everything but the code root: volumes, the fixed caches on both sides, temp, scratchpads, models, show-only. */
  async function doFast(): Promise<void> {
    const t0 = Date.now();
    const notes: string[] = [];
    if (r.profileNote) notes.push(r.profileNote);
    const volumes = await readVolumes(notes);
    const ollama = await resolveOllama(r);
    if (ollama.note) notes.push(ollama.note);
    const temp = await vetted([...(await resolveCaches(r)), ...(await resolveTmp(r)), ...(await resolveWinCaches(r)), ...(await resolveWinTemp(r))], notes);
    const models = await vetted([...(await resolveHf(r)), ...ollama.list], notes);
    const show = await showOnly(r);
    const all = await measureAll([...temp, ...models, ...show], r);
    const tempE = all.slice(0, temp.length), modelsE = all.slice(temp.length, temp.length + models.length), showE = all.slice(temp.length + models.length);
    // The last walk's rows stay until the next walk replaces them (`code.at` says how old they are).
    last = {
      at: Date.now(), tookMs: Date.now() - t0, ...volumes, profile: prof,
      temp: [...tempE, ...(last?.temp.filter(isBuild) ?? [])],
      models: modelsE,
      show: [...showE, ...(last?.show.filter(isNm) ?? [])],
      notes,
    };
  }

  /** The code-root walk: build output (deletable) and the biggest node_modules (show-only). */
  async function doCode(): Promise<void> {
    const t0 = Date.now();
    const notes: string[] = [];
    goneDuringWalk.clear();
    const walk = await walkRoot(r);
    if (walk.stopped) notes.push(`The walk of ${r.root} stopped after ${r.walkBudget} folders — build output and node_modules past that are not listed.`);
    if (walk.outsideGit) notes.push(`${walk.outsideGit} folder${walk.outsideGit === 1 ? "" : "s"} named like build output ${walk.outsideGit === 1 ? "is" : "are"} not ignored by git (or not in a repo), so ${walk.outsideGit === 1 ? "it is" : "they are"} not offered.`);
    const builds = await vetted(buildCandidates(r, walk), notes);
    const nms = nodeModulesEntries(r, walk);
    const all = await measureAll([...builds, ...nms], r);
    const kept = builds.map((c, i) => ({ c, e: all[i]! })).filter((x) => !goneDuringWalk.has(x.c.id));
    const buildE = kept.map((x) => x.e).sort(bySize);
    const nm = all.slice(builds.length).sort(bySize);
    if (nm.length > NODE_MODULES_TOP) {
      const unmeasured = nm.filter((e) => e.sizeKb == null).length;
      const total = kbText(nm.reduce((s, e) => s + (e.sizeKb ?? 0), 0));
      // A folder never sized sorts last, so with any unknown the cut is not "the biggest" — say so.
      notes.push(unmeasured
        ? `node_modules: ${NODE_MODULES_TOP} of ${nm.length} folders are listed, but ${unmeasured} could not be measured, so these may not be the biggest (${total} measured in all).`
        : `node_modules: the biggest ${NODE_MODULES_TOP} of ${nm.length} folders are listed (${total} measured in all).`);
    }
    buildPaths = new Map(kept.map((x) => [x.c.id, x.c.path!]));
    goneDuringWalk.clear();
    codeAt = Date.now(); codeTookMs = codeAt - t0; codeNotes = notes;
    if (last) last = { ...last, temp: [...last.temp.filter((e) => !isBuild(e)), ...buildE], show: [...last.show.filter((e) => !isNm(e)), ...nm.slice(0, NODE_MODULES_TOP)] };
  }

  /**
   * One scan at a time. The fast part is measured and PUSHED first, so the phone shows those rows
   * while the code root is still being walked. `withFast` false: only the walk (a tap on "look for
   * them" with a scan already listed).
   */
  function start(withFast: boolean, withCode: boolean): void {
    if (scanning) { if (withCode) codeWanted = true; return; }
    codeWanted = withCode;
    scanStartedAt = Date.now();
    scanning = (async () => {
      if (withFast || !last) {
        phase = "fast";
        try { await doFast(); } catch (e) { last = last ? { ...last, notes: [...last.notes, `The last scan failed: ${(e as Error).message}`] } : null; }
        if (codeWanted) notify();
      }
      if (codeWanted && last) {
        phase = "code";
        codeStartedAt = Date.now();
        notify();
        try { await doCode(); } catch (e) { codeNotes = [`The walk of ${r.root} failed: ${(e as Error).message}`]; }
      }
    })().finally(() => { scanning = null; scanStartedAt = null; phase = null; codeWanted = false; codeStartedAt = null; notify(); });
    notify();
  }

  function scan(): DiskState {
    start(true, !onTap);
    return state();
  }

  function scanCode(): DiskState {
    start(false, true);
    return state();
  }

  function scanLarge(): DiskState {
    if (!finding) {
      large = { at: Date.now(), running: true, tookMs: null, stoppedAfterS: null, found: large?.found ?? 0, items: large?.items ?? [] };
      finding = findLarge(r)
        .then((o) => {
          const note = prof === "wsl" ? "Only the Linux side was searched. The Windows drive was not: a search over it from inside WSL is too slow to finish in time — use Windows' own Settings › System › Storage there." : undefined;
          large = { at: Date.now(), running: false, tookMs: o.tookMs, stoppedAfterS: o.stoppedAfterS, found: o.found, items: o.items, ...(o.error ? { error: o.error } : {}), ...(note ? { note } : {}) };
        })
        .catch((e) => { large = { at: Date.now(), running: false, tookMs: null, stoppedAfterS: null, found: 0, items: [], error: (e as Error).message }; })
        .finally(() => { finding = null; notify(); });
      notify();
    }
    return state();
  }

  /** One queued delete: re-resolve, re-check, remove, re-measure. */
  async function doRemove(id: string, label: string, sizeKb: number | null): Promise<void> {
    const cat = id.split(":")[0] as Category;
    // Free space is read on the disk this delete touches — inside WSL for a Linux-side row, the
    // Windows drive for a Windows-side one — so a WSL delete never reads as the Windows drive rising.
    let side = sideOf(cat);
    let before = await freeOn(side);
    let drive: string | undefined;
    const record = async (ok: boolean, error?: string, counts?: { removed: number; skipped: number }) => {
      const after = await freeOn(side, drive);
      results.unshift({
        id, label, at: Date.now(), ok, sizeKb, freeDeltaKb: before && after ? after.freeKb - before.freeKb : null,
        ...(error ? { error } : {}), ...(side ? { side } : {}), ...(counts ?? {}),
      });
      results.length = Math.min(results.length, RESULTS_MAX);
      if (after) keepVolume(side, after);
    };
    let c: Candidate | undefined;
    if (cat === "build") {
      // One path re-checked, never a re-walk of the code root (that took 29 min on a Windows-drive root).
      const p = buildPaths.get(id);
      const got = p ? await recheckBuild(r, p) : null;
      c = got?.c && got.c.id === id ? got.c : undefined;
    } else c = (await resolve(cat)).list.find((x) => x.id === id);
    // A row's disk follows its PATH (build output under /mnt/c is on C:), which only the fresh candidate knows.
    if (c && prof === "wsl" && c.side && c.side !== side) {
      side = c.side;
      drive = /^\/mnt\/[a-z](?=\/|$)/.exec(c.path ?? "")?.[0];
      before = await freeOn(side, drive);
    }
    if (!c) { await record(false, `${label} is no longer a candidate (gone, or it no longer qualifies) — nothing was deleted`); return; }
    try {
      if (c.category === "ollama") {
        const name = c.ollamaName ?? "";
        if (!OLLAMA_NAME_RE.test(name) || !r.ollamaBin) throw new Error(`refusing to pass "${name}" to ollama`);
        const res = await run(r.ollamaBin, ["rm", name], { timeoutMs: 60_000 });
        if (res.code !== 0) throw new Error(`ollama rm failed: ${res.stderr.trim() || res.error || `exit ${res.code}`}`);
      } else if (c.category === "wtemp") {
        // One entry at a time, each checked right before its own rm. A file Windows holds open is
        // SKIPPED and counted — never forced, never reported as freed.
        let removed = 0, skipped = 0, partial = 0;
        const refused: string[] = [];
        for (const p of c.members ?? []) {
          const why = await safeToRemove(c, r, p);
          if (why) { refused.push(why); continue; }
          const done = { n: 0 };
          try { await rmCounted(p, done); removed++; } catch (e) {
            const code = (e as NodeJS.ErrnoException).code ?? "";
            // A folder with a held file inside goes file by file: what was unlinked before the hold is gone, and is said.
            if (IN_USE.has(code)) { skipped++; if (done.n > 0) partial++; } else refused.push(`${p}: ${(e as Error).message}`);
          }
        }
        const counts = { removed, skipped, ...(partial ? { partial } : {}) };
        if (refused.length) await record(false, `${refused.length} not deleted — ${refused.slice(0, 3).join("; ")}${refused.length > 3 ? "; …" : ""}`, counts);
        else if (!removed && skipped && partial) await record(false, `${skipped} in use by a running program — ${partial} of them partly cleared before the held file stopped it, the rest untouched`, counts);
        else if (!removed && skipped) await record(false, `all ${skipped} in use by a running program — nothing removed`, counts);
        else await record(true, undefined, counts);
        await refreshRow(c);
        return;
      } else {
        for (const p of c.members ?? [c.path!]) {
          const why = await safeToRemove(c, r, p);
          if (why) throw new Error(why);
        }
        // `c` is FRESH: for the scratchpads that means the age gate was applied again just now.
        for (const p of c.members ?? [c.path!]) {
          // Again right before its own delete: the window since the first check can be as long as the earlier deletes take.
          const why = await safeToRemove(c, r, p);
          if (why) throw new Error(why);
          await rm(p, { recursive: true, force: false });
        }
      }
      await record(true);
    } catch (e) {
      await record(false, (e as Error).message);
    }
    await refreshRow(c);
  }

  /** After a delete: that row again (gone, or re-measured), never a whole rescan. */
  async function refreshRow(c: Candidate): Promise<void> {
    if (!last) return;
    const { list } = c.category === "build" ? { list: [] as Candidate[] } : await resolve(c.category);
    let fresh: DiskEntry[] = [];
    if (c.category === "build") {
      const still = c.path ? (await safeToRemove(c, r, c.path)) == null : false;
      fresh = still ? await measureAll([c], r) : [];
      if (!still) { buildPaths.delete(c.id); if (phase === "code") goneDuringWalk.add(c.id); }
    } else {
      const same = c.category === "ollama" ? list : list.filter((x) => x.id === c.id);
      fresh = await measureAll(same, r);
    }
    const swap = (rows: DiskEntry[]) => {
      if (c.category === "ollama") {
        const at = rows.findIndex((e) => e.id.startsWith("ollama:"));
        const rest = rows.filter((e) => !e.id.startsWith("ollama:"));
        return at < 0 ? [...rest, ...fresh] : [...rest.slice(0, at), ...fresh, ...rest.slice(at)];
      }
      const i = rows.findIndex((e) => e.id === c.id);
      if (i < 0) return rows;
      return [...rows.slice(0, i), ...fresh, ...rows.slice(i + 1)];
    };
    last = { ...last, temp: swap(last.temp), models: swap(last.models) };
  }

  function enqueue(e: DiskEntry): void {
    deleting.push({ id: e.id, label: e.label, since: Date.now() });
    queue = queue.then(() => doRemove(e.id, e.label, e.sizeKb)).catch(() => undefined).finally(() => {
      const i = deleting.findIndex((d) => d.id === e.id);
      if (i >= 0) deleting.splice(i, 1);
      notify();
    });
  }

  function remove(id: string): { accepted: true; label: string } {
    if (typeof id !== "string" || !CANDIDATE_ID_RE.test(id)) throw new Error("not a deletable candidate id — deletes name a candidate from the last scan, never a path");
    const e = [...(last?.temp ?? []), ...(last?.models ?? [])].find((x) => x.id === id);
    if (!e) throw new Error("that id is not a candidate of the last scan — scan again");
    if (deleting.some((d) => d.id === id)) return { accepted: true, label: e.label };
    enqueue(e);
    notify();
    return { accepted: true, label: e.label };
  }

  function cleanTemp(): { accepted: number } {
    const todo = (last?.temp ?? []).filter((e) => !deleting.some((d) => d.id === e.id));
    for (const e of todo) enqueue(e);
    if (todo.length) notify();
    return { accepted: todo.length };
  }

  return {
    state, scan, scanLarge, scanCode, remove, cleanTemp,
    async idle() {
      for (;;) {
        const s = scanning, f = finding, q = queue;
        await Promise.all([s, f, q]);
        if (s === scanning && f === finding && q === queue && !deleting.length) return;
      }
    },
  };
}

function kbText(kb: number): string {
  const u = ["KB", "MB", "GB", "TB"];
  let v = kb, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
