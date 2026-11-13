/**
 * The disk-space extension's process plumbing: async `execFile` with a hard time bound, `du -sk`
 * read honestly, a concurrency pool and the volume reading. Nothing here blocks the loop that pumps
 * every PTY: no `*Sync` call, no shell.
 */
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }

/** Run `bin argv` with no shell, killed (SIGKILL) after `timeoutMs`. Resolves, never rejects. */
export function run(bin: string, argv: string[], opts: { timeoutMs: number; cwd?: string; maxBuffer?: number; input?: string }): Promise<RunResult> {
  return new Promise((resolve) => {
    const cp = execFile(bin, argv, { timeout: opts.timeoutMs, killSignal: "SIGKILL", cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) { resolve({ code: 0, stdout, stderr, timedOut: false }); return; }
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
        const timedOut = e.killed === true && e.signal === "SIGKILL";
        const code = typeof e.code === "number" ? e.code : null;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", timedOut, error: typeof e.code === "string" ? `${e.code}` : e.message });
      });
    // stdin: the input when there is one, else closed at once (a program reading it must not wait for ever).
    cp.stdin?.on("error", () => undefined);
    cp.stdin?.end(opts.input ?? "");
  });
}

export type Runner = typeof run;

export interface Measured { sizeKb: number | null; partial?: boolean; sizeNote?: string }

/**
 * `du -skx -- path`. A timeout or no number is UNKNOWN with the reason, never 0. A number with a
 * non-zero exit (unreadable files inside) is a FLOOR, said as such.
 */
export async function measure(path: string, o: { duBin: string; timeoutMs: number }): Promise<Measured> {
  const r = await run(o.duBin, ["-skx", "--", path], { timeoutMs: o.timeoutMs });
  if (r.timedOut) return { sizeKb: null, sizeNote: `size unknown — du did not finish within ${Math.round(o.timeoutMs / 1000)} s` };
  const m = /^(\d+)\s/.exec(r.stdout.split("\n").filter(Boolean).at(-1) ?? "");
  if (!m) return { sizeKb: null, sizeNote: `size unknown — du gave no number${r.error ? ` (${r.error})` : ""}` };
  const kb = Number(m[1]);
  if (r.code === 0) return { sizeKb: kb };
  return { sizeKb: kb, partial: true, sizeNote: "some files inside could not be read — at least this much" };
}

/** Map `items` through `fn` with at most `limit` in flight. Order kept. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]!); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Free and total of the volume holding `path`, or null when statfs could not say. */
export async function volumeOf(path: string): Promise<{ path: string; freeKb: number; totalKb: number } | null> {
  try {
    const s = await statfs(path);
    const freeKb = Math.floor((Number(s.bavail) * Number(s.bsize)) / 1024);
    const totalKb = Math.floor((Number(s.blocks) * Number(s.bsize)) / 1024);
    if (!Number.isFinite(freeKb) || !Number.isFinite(totalKb) || totalKb <= 0) return null;
    return { path, freeKb, totalKb };
  } catch { return null; }
}

/** Let the event loop breathe during a long walk. */
export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** `powershell.exe … "<free> <used>"` (bytes) as KiB; null when it is not two whole numbers. */
export function parsePsDrive(out: string): { freeKb: number; totalKb: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(out);
  if (!m) return null;
  const free = Number(m[1]), used = Number(m[2]);
  if (!Number.isSafeInteger(free) || !Number.isSafeInteger(used) || free + used <= 0) return null;
  return { freeKb: Math.floor(free / 1024), totalKb: Math.floor((free + used) / 1024) };
}

/**
 * The Windows drive `winHome` is on (wsl), as `C:`: statfs of the /mnt mount first (WSL2's drvfs
 * answers it with the drive's own figures), and when that fails or says something impossible,
 * PowerShell's `Get-PSDrive` with a time bound. Neither: null and the sentence why — never a guess.
 */
export async function windowsVolume(winHome: string, psBin: string | null | undefined): Promise<{ volume: DiskVolumeLike | null; note?: string }> {
  const letter = /^\/mnt\/([a-z])(\/|$)/.exec(winHome)?.[1]?.toUpperCase() ?? "C";
  const label = `${letter}:`;
  const v = await volumeOf(winHome);
  if (v && v.freeKb <= v.totalKb) return { volume: { ...v, label } };
  if (psBin) {
    const r = await run(psBin, ["-NoProfile", "-NonInteractive", "-Command", `$d = Get-PSDrive -Name ${letter}; "$($d.Free) $($d.Used)"`], { timeoutMs: 15_000 });
    const got = r.code === 0 ? parsePsDrive(r.stdout) : null;
    if (got) return { volume: { path: winHome, ...got, label } };
    return { volume: null, note: `Free space on ${label} could not be read: statfs on ${winHome} gave no usable figure, and PowerShell ${r.timedOut ? "did not answer within 15 s" : "gave no number"}.` };
  }
  return { volume: null, note: `Free space on ${label} could not be read: statfs on ${winHome} gave no usable figure, and powershell.exe is not reachable from WSL.` };
}

export interface DiskVolumeLike { path: string; freeKb: number; totalKb: number; label?: string }

// ── Windows-side sizes on wsl: one PowerShell call for a list of folders ──────────────────────

/**
 * The PowerShell that sums file lengths for each path it is handed. The paths arrive on STDIN as
 * JSON (`{"p":[...]}`, ASCII-only with `\u` escapes, so the console code page cannot mangle a name)
 * and are never part of this text: nothing a folder is called can become a command. It prints one
 * line per path as soon as that path is done (`{"i","bytes","bad","found"}`, numbers only), so a
 * run stopped by its time bound still answers for the paths it finished. Folder links (junctions,
 * symlinks) are not followed, as `du -x` would not; `bad` counts what could not be read.
 */
export const PS_SIZES = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$ps=@(([Console]::In.ReadToEnd() | ConvertFrom-Json).p)",
  "for($i=0;$i -lt $ps.Count;$i++){",
  " $n=[int64]0;$bad=0;$found=1",
  " $it=Get-Item -LiteralPath $ps[$i] -Force",
  " if($null -eq $it){$found=0}",
  " elseif(-not $it.PSIsContainer){$n=[int64]$it.Length}",
  " else{",
  "  $st=New-Object System.Collections.Stack;$st.Push($it.FullName)",
  "  while($st.Count -gt 0){",
  "   $d=$st.Pop();$ev=$null",
  "   $cs=Get-ChildItem -LiteralPath $d -Force -ErrorVariable ev",
  "   if($ev){$bad+=@($ev).Count}",
  "   foreach($c in $cs){",
  "    if($c.PSIsContainer){if(-not ($c.Attributes -band [IO.FileAttributes]::ReparsePoint)){$st.Push($c.FullName)}}",
  "    else{$n+=[int64]$c.Length}",
  "   }",
  "  }",
  " }",
  " [Console]::Out.WriteLine('{\"i\":'+$i+',\"bytes\":'+$n+',\"bad\":'+$bad+',\"found\":'+$found+'}')",
  "}",
].join("\n");

/** JSON with every non-ASCII character as a `\u` escape: what goes to PowerShell's stdin. */
export const asciiJson = (v: unknown): string => JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export interface PsLine { bytes: number; bad: number; found: boolean }

/** PowerShell's lines for `n` paths, by index. A line that is not exactly that shape is ignored — never read as 0. */
export function parsePsSizes(out: string, n: number): Map<number, PsLine> {
  const got = new Map<number, PsLine>();
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: unknown;
    try { o = JSON.parse(t); } catch { continue; }
    const { i, bytes, bad, found } = (o ?? {}) as Record<string, unknown>;
    if (!Number.isSafeInteger(i) || (i as number) < 0 || (i as number) >= n) continue;
    if (!Number.isSafeInteger(bytes) || (bytes as number) < 0 || !Number.isSafeInteger(bad) || (bad as number) < 0 || (found !== 0 && found !== 1)) continue;
    got.set(i as number, { bytes: bytes as number, bad: bad as number, found: found === 1 });
  }
  return got;
}

/** `/mnt/c/Users/me/x` as Windows names it (`C:\Users\me\x`); null for any other path. What `wslpath -w` answers under the default /mnt automount. */
export function winPathOf(p: string): string | null {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
  if (!m) return null;
  let rest = m[2] ?? "";
  while (rest.endsWith("/")) rest = rest.slice(0, -1);
  return `${m[1]!.toUpperCase()}:${rest ? rest.replace(/\//g, "\\") : "\\"}`;
}

/**
 * Sizes of Windows-side paths from ONE `powershell.exe` call. `fallback` (with the reason) when
 * PowerShell is missing, a path has no Windows form, or it answered nothing usable: the caller then
 * measures with `du` as before. Otherwise every path has a reading — a path PowerShell did not reach
 * before its time bound is UNKNOWN with that reason, never 0.
 */
export async function measureWindows(paths: readonly string[], o: { psBin: string | null | undefined; timeoutMs: number; run?: Runner; winPath?: (p: string) => string | null }): Promise<{ byPath: Map<string, Measured> } | { fallback: string }> {
  if (!o.psBin) return { fallback: "powershell.exe is not reachable from WSL" };
  const conv = o.winPath ?? winPathOf;
  const wins = paths.map(conv);
  const bad = paths.find((_, i) => wins[i] == null);
  if (bad) return { fallback: `${bad} has no Windows path` };
  const res = await (o.run ?? run)(o.psBin, ["-NoProfile", "-NonInteractive", "-Command", PS_SIZES], { timeoutMs: o.timeoutMs, input: asciiJson({ p: wins }), cwd: undefined });
  const got = parsePsSizes(res.stdout, paths.length);
  if (!got.size && !res.timedOut) return { fallback: `PowerShell gave no sizes (${res.error ?? `exit ${res.code}`})` };
  const byPath = new Map<string, Measured>();
  paths.forEach((p, i) => {
    const g = got.get(i);
    if (!g) byPath.set(p, { sizeKb: null, sizeNote: res.timedOut ? `size unknown — PowerShell did not finish within ${Math.round(o.timeoutMs / 1000)} s` : "size unknown — PowerShell gave no number for it" });
    else if (!g.found) byPath.set(p, { sizeKb: null, sizeNote: "size unknown — Windows did not find it" });
    else if (g.bad > 0) byPath.set(p, { sizeKb: Math.ceil(g.bytes / 1024), partial: true, sizeNote: "some files inside could not be read — at least this much" });
    else byPath.set(p, { sizeKb: Math.ceil(g.bytes / 1024) });
  });
  return { byPath };
}
