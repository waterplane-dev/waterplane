/**
 * The repo-health worker: the engine (`tools/repohealth.mjs`, bundled as it is) run in a
 * worker_threads Worker. The step and `--root=` arrive as the Worker's `argv`. Its stdout/stderr are
 * relayed to the extension as messages, and every way it can end posts `{ t: "exit", code }` first,
 * so the extension never has to guess an exit code from a vanished thread.
 *
 * The only program this file can start is `git` (the engine's `git.mjs`); `judge.mjs`, the one
 * engine module that would spend tokens, is swapped for a throwing shim at bundle time.
 */
import { parentPort } from "node:worker_threads";

type Msg = { t: "out" | "err"; s: string } | { t: "exit"; code: number };

if (parentPort) {
  const pp = parentPort;
  let ended = false;
  const post = (m: Msg): void => {
    if (ended) return;
    if (m.t === "exit") ended = true;
    pp.postMessage(m);
  };
  const relay = (k: "out" | "err") => (chunk: unknown, ...rest: unknown[]): boolean => {
    post({ t: k, s: typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk) });
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    cb?.();
    return true;
  };
  process.stdout.write = relay("out") as never;
  process.stderr.write = relay("err") as never;
  const realExit = process.exit.bind(process);
  process.exit = ((code?: number) => {
    post({ t: "exit", code: Number(code ?? process.exitCode ?? 0) });
    return realExit(code);
  }) as never;
  try {
    // @ts-expect-error -- the engine is plain JS with no declarations; esbuild bundles it.
    await import("../../../tools/repohealth.mjs");
    post({ t: "exit", code: Number(process.exitCode ?? 0) });
  } catch (err) {
    // A throw at the engine's module scope (`--root=` that is not a directory) is not inside its
    // own try: say it the way the engine says its other failures, and exit 1 like they do.
    post({ t: "err", s: `repohealth: ${err instanceof Error ? err.message : String(err)}\n` });
    post({ t: "exit", code: 1 });
  }
} else {
  // @ts-expect-error -- as above.
  await import("../../../tools/repohealth.mjs");
}
