/**
 * The links extension's process plumbing: async `execFile` with a hard time bound, no shell, and a
 * small concurrency pool. Nothing here blocks the loop that pumps every PTY.
 */
import { execFile } from "node:child_process";

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }
export type Runner = (bin: string, argv: string[], opts: { timeoutMs: number; cwd?: string }) => Promise<RunResult>;

/** Run `bin argv` with no shell, killed (SIGKILL) after `timeoutMs`. Resolves, never rejects. */
export const run: Runner = (bin, argv, opts) => new Promise((resolve) => {
  execFile(bin, argv, { timeout: opts.timeoutMs, killSignal: "SIGKILL", cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
    (err, stdout, stderr) => {
      if (!err) { resolve({ code: 0, stdout, stderr, timedOut: false }); return; }
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
      const timedOut = e.killed === true && e.signal === "SIGKILL";
      const code = typeof e.code === "number" ? e.code : null;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", timedOut, error: typeof e.code === "string" ? `${e.code}` : e.message });
    });
});

/** Map `items` through `fn` with at most `limit` in flight. Order kept. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]!); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
