/**
 * The reader: one tesseract worker, started from BLOB URLs of the verified downloads — never a
 * network URL, never the service worker (the APK has none, plain http has none), so it starts the
 * same in a secure browser, the Android shell and a plain-http page.
 *
 * A tiny client over tesseract.js 7's own worker script (`worker.min.js`) rather than its
 * `createWorker`: the package's client would have to be in the OTA bundle (and its
 * `{ code, data }` language form is broken in 7.0.0's `initialize`), while the worker's message
 * protocol is five actions — `load`, `loadLanguage`, `FS`, `initialize`, `recognize` — each answered
 * `{ jobId, action, status: resolve|reject|progress, data }`. Exact versions are pinned in the root
 * package.json and the protocol is exercised end to end in Chromium by `scripts/browser-check.mjs`.
 *
 * - The core: a blob boot script `importScripts`es the SIMD-or-plain LSTM core (wasm embedded,
 *   one file) BEFORE the worker script, so the worker's `getCore` finds `TesseractCore` defined
 *   and never builds a URL of its own.
 * - The language data: gunzipped HERE (`DecompressionStream`) and written straight into the
 *   worker's file system with the `FS` action, so `loadLanguage` (run with no languages, cache
 *   off) never fetches. Then `initialize("eng+deu", LSTM only)`.
 * - Lazy: started by the first read, kept warm `WARM_MS` after the last one, then terminated.
 *   Reads run one at a time; an aborted read is answered null at once (its job still finishes
 *   in the worker, and the next waits for it).
 */
import { cleanText, wordsOf, WARM_MS } from "./logic.ts";

export interface EngineFiles { worker: Blob; core: Blob; langs: { code: string; data: Blob }[] }

type Reply = { jobId: string; action: string; status: "resolve" | "reject" | "progress"; data: unknown };

/** How long starting the engine may take before it is given up (a phone loading 4 MB of wasm). */
const START_MS = 45_000;
const OEM_LSTM_ONLY = 1;

async function gunzip(b: Blob): Promise<Uint8Array> {
  const head = new Uint8Array(await b.slice(0, 2).arrayBuffer());
  if (!(head[0] === 0x1f && head[1] === 0x8b)) return new Uint8Array(await b.arrayBuffer());
  if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot unpack the language data");
  const out = b.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

interface Session { call(action: string, payload: unknown, ms?: number): Promise<unknown>; end(): void }

function open(worker: Worker): Session {
  let n = 0;
  const waiting = new Map<string, { ok: (v: unknown) => void; no: (e: Error) => void; t: ReturnType<typeof setTimeout> }>();
  const failAll = (e: Error) => { for (const [k, w] of waiting) { clearTimeout(w.t); w.no(e); waiting.delete(k); } };
  worker.onmessage = ({ data }: MessageEvent<Reply>) => {
    const w = waiting.get(`${data?.action}-${data?.jobId}`);
    if (!w || data.status === "progress") return;
    clearTimeout(w.t);
    waiting.delete(`${data.action}-${data.jobId}`);
    if (data.status === "resolve") w.ok(data.data); else w.no(new Error(String(data.data)));
  };
  worker.onerror = (ev) => { ev.preventDefault?.(); failAll(new Error(ev.message || "the reader stopped")); };
  return {
    call(action, payload, ms = START_MS) {
      const jobId = `j${++n}`;
      return new Promise((ok, no) => {
        const t = setTimeout(() => { waiting.delete(`${action}-${jobId}`); no(new Error(`${action} took too long`)); }, ms);
        waiting.set(`${action}-${jobId}`, { ok, no, t });
        worker.postMessage({ workerId: "wp-ocr", jobId, action, payload });
      });
    },
    end() { failAll(new Error("the reader was stopped")); worker.terminate(); },
  };
}

async function start(files: EngineFiles): Promise<Session> {
  const coreUrl = URL.createObjectURL(files.core);
  const workerUrl = URL.createObjectURL(files.worker);
  const bootUrl = URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(coreUrl)});\nimportScripts(${JSON.stringify(workerUrl)});\n`], { type: "text/javascript" }));
  let s: Session | null = null;
  try {
    s = open(new Worker(bootUrl));
    await s.call("load", { options: { lstmOnly: true, corePath: coreUrl, logging: false } });
    await s.call("loadLanguage", { langs: [], options: { cacheMethod: "none", gzip: true, lstmOnly: true } });
    for (const l of files.langs) await s.call("FS", { method: "writeFile", args: [`./${l.code}.traineddata`, await gunzip(l.data)] });
    await s.call("initialize", { langs: files.langs.map((l) => l.code).join("+"), oem: OEM_LSTM_ONLY, config: {} });
    // A mark is one block of text, not a page: tesseract's own page layout finds nothing in a
    // tight crop more often than not.
    await s.call("setParameters", { params: { tessedit_pageseg_mode: "6", user_defined_dpi: "300" } });
    return s;
  } catch (e) {
    s?.end();
    throw e;
  } finally {
    URL.revokeObjectURL(bootUrl);
    URL.revokeObjectURL(workerUrl);
    URL.revokeObjectURL(coreUrl);
  }
}

export interface Engine {
  /** The words in `crop`, cleaned (`cleanText`); null on nothing, abort, failure or timeout. */
  read(crop: Blob, signal: AbortSignal, ms?: number): Promise<string | null>;
  /** Stop the worker now (switched off, download deleted). The next read starts it again. */
  stop(): void;
  /** Whether a worker is running right now (tests, the row). */
  warm(): boolean;
}

/** `files` is asked on every cold start — null means "not downloaded", and the read is null. */
export function createEngine(files: () => Promise<EngineFiles | null>, warmMs = WARM_MS): Engine {
  let session: Promise<Session> | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let gen = 0;

  const stop = () => {
    gen++;
    if (idle) { clearTimeout(idle); idle = null; }
    const s = session;
    session = null;
    void s?.then((x) => x.end(), () => { /* never started */ });
  };
  const session$ = (): Promise<Session> => {
    if (!session) {
      const mine = gen;
      session = files().then((f) => {
        if (!f) throw new Error("the reader is not downloaded");
        return start(f);
      });
      // A start that failed is forgotten, so the next read tries again.
      session.catch(() => { if (gen === mine) session = null; });
    }
    return session;
  };
  const arm = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(stop, warmMs);
  };

  return {
    async read(crop, signal, ms = 20_000) {
      if (signal.aborted) return null;
      if (idle) { clearTimeout(idle); idle = null; }
      const run = chain.then(async () => {
        if (signal.aborted) return null;
        const s = await session$();
        if (signal.aborted) return null;
        const image = new Uint8Array(await crop.arrayBuffer());
        try {
          const r = await s.call("recognize", { image, options: {}, output: { text: false, blocks: true } }, ms) as { blocks?: unknown } | null;
          return cleanText(wordsOf(r?.blocks));
        } catch (e) {
          // A worker that failed or hung a read is not trusted with the next one.
          stop();
          throw e;
        }
      });
      chain = run.catch(() => null);
      const aborted = new Promise<null>((ok) => signal.addEventListener("abort", () => ok(null), { once: true }));
      try {
        return await Promise.race([run, aborted]);
      } catch {
        return null;
      } finally {
        void chain.then(arm);
      }
    },
    stop,
    warm: () => session !== null,
  };
}
