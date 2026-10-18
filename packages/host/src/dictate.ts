/**
 * Dictation on the desktop: speech the phone recorded, words back.
 *
 * ── Why this is local and not a service ─────────────────────────────────────
 *
 * It was measured before it was written, on the machine that runs it (M4 Max,
 * `ggml-large-v3-turbo`, Metal): **15.1 s of English in 0.79–1.06 s, 28.6 s of
 * German in 0.95 s** — about 30× realtime, with punctuation and with mixed-
 * language technical words ("OpenAI", "GCP") intact. A hosted API cannot beat
 * that, because the round trip alone is most of a second and this path does not
 * pay one; it also cannot be cheaper than free, and it is the only version
 * where a prompt full of somebody's source code does not leave the desktop.
 *
 * The same reasoning as `ocrlocal.ts`' picture reader: it DECIDES nothing. The sentence it returns is shown to the person who
 * pressed the microphone, who edits or drops it before it can reach an agent.
 * There is no repo in this module, nothing is written anywhere, and the audio
 * exists only as a buffer and a file under `tmpdir()` that is removed in a
 * `finally`.
 *
 * ── Degrades to a reason, never to a guess ──────────────────────────────────
 *
 * No binary, no model, switched off, a clip that is not the format, a clip too
 * long, silence, a whisper run that failed and a whisper run that read no audio
 * out of the clip are EIGHT different sentences. None of them is a partial
 * transcription presented as a whole one, and none is a transport error — they
 * all come back as a 200 the phone shows, because "install whisper-cpp" is an
 * answer and not something to retry.
 *
 * The last of those is the one that is easy to get wrong, and was: whisper.cpp
 * reads its audio BEFORE it loads the model, and **exits 0 when it cannot read
 * it** — leaving nothing behind but the JSON it never wrote. Answering that
 * with the `readFile` failure sent the phone `ENOENT … /var/folders/…/out.json`
 * about a 61.4 s recording, after 250 ms: a temp path, for a file that was
 * never the problem, naming neither the cause nor anything to do about it.
 *
 * ── The artifacts are refused, not cleaned up ───────────────────────────────
 *
 * Handed audio with no speech in it, whisper emits its training corpus's
 * subtitle boilerplate ("Untertitelung des ZDF für funk, 2017"). Measured in
 * the Tiptoi service over a 501-clip book; it is stable, documented text rather
 * than a guess, so matching it needs no threshold. Only the unmistakable ones
 * are listed: "Vielen Dank." is also a perfectly ordinary thing to dictate.
 *
 * ── whisperd first, whisper-cli when it cannot answer ───────────────────────
 *
 * `whisper-cli` loads the 1.6 GB model on EVERY dictation. whisperd
 * (a local whisper server, 127.0.0.1:8777 by default) keeps one whisper-server per model resident,
 * shared with the Tiptoi service, and unloads it after ten idle minutes. Same
 * model, same decoding, same words; the load is paid once per idle period
 * instead of once per clip. It is an accelerator, never a dependency: not
 * running, busy, or failing, and the clip goes to `whisper-cli` exactly as
 * before. Only "that is not audio" (a 400) is final, because the CLI would
 * refuse the same bytes. `WATERPLANE_WHISPERD_URL=off` turns it off.
 *
 * ── Keeping dictations is opt-in, and off by default ────────────────────────
 *
 * `WATERPLANE_DICTATE_KEEP=1` saves each successful clip and the text returned for
 * it (`<ts>.wav` + `<ts>.json`) into `~/.local/share/waterplane/dictations`
 * (`WATERPLANE_DICTATE_KEEP_DIR`), outside every repo, so real samples accumulate for
 * re-running the model benchmark (whisperd/bench). It is the one exception to
 * "nothing is written anywhere", which is why it is a flag nobody sets by
 * accident, and why the log line still never carries the words.
 */

import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { 
  applyDictateTerms, dictatePrompt, dictateRefusal, isPromptEcho,
  parseDictateTerms, wavFacts, whisperLang,
  type DictateAnswer, type DictateStatus, logTag, BRAND, envName } from "@waterplane/shared";
import { env } from "./env.js";
import { expandHome } from "./pathx.js";

const DEFAULT_BIN = "whisper-cli";

/** Where a model lives when nobody said. XDG, because a 1.6 GB weights file is
 *  machine state and not repo state — nothing under `.waterplane/` is the right home
 *  for it, and a second copy per repo is 1.6 GB per repo. */
function modelDir(): string {
  const xdg = (process.env.XDG_DATA_HOME || "").trim();
  return xdg ? join(resolve(xdg), BRAND.configDirName, "models") : join(homedir(), ".local", "share", BRAND.configDirName, "models");
}

function binary(): string {
  return (env("WHISPER_BIN") || "").trim() || DEFAULT_BIN;
}

/** The model file, or null. An explicit `WATERPLANE_WHISPER_MODEL` is taken as said —
 *  including its absence, which is a misconfiguration worth naming rather than
 *  papering over with a scan that finds something else. */
export function modelPath(): string | null {
  const named = (env("WHISPER_MODEL") || "").trim();
  if (named) {
    const p = named.startsWith("~/") ? expandHome(named) : resolve(named);
    return existsSync(p) ? p : null;
  }
  let names: string[];
  try { names = readdirSync(modelDir()); } catch { return null; }
  const ggml = names.filter((n) => n.startsWith("ggml-") && n.endsWith(".bin")).sort();
  if (!ggml.length) return null;
  // Prefer turbo, and the unquantized one of those: on a desktop the quality
  // difference is free (both run in about a second) and this is the file a
  // person dictating a paragraph of mixed German and English notices.
  const turbo = ggml.filter((n) => n.includes("turbo"));
  const pick = turbo.find((n) => !/q\d/.test(n)) || turbo[0] || ggml[0];
  return join(modelDir(), pick);
}

let whichCache: { bin: string; found: boolean } | null = null;
function onPath(bin: string): boolean {
  if (whichCache && whichCache.bin === bin) return whichCache.found;
  // The OS's own lookup rather than a PATH walk: it honours the shell's rules,
  // and this runs once per status read, not per dictation. `where` on Windows
  // — `which` is not a program there, so asking for it would report every
  // Windows desktop as having no transcriber whether or not it has one.
  let found = false;
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: ["ignore", "ignore", "ignore"] });
    found = true;
  } catch { found = false; }
  whichCache = { bin, found };
  return found;
}

/** What to say about a missing engine: brew on macOS, a generic line elsewhere. */
export function whisperInstallHint(platform: string = process.platform): string {
  return platform === "darwin"
    ? " (brew install whisper-cpp)"
    : " (install whisper.cpp, the whisper-cli binary, and put it on PATH)";
}

/**
 * Whether this desktop can transcribe, asked BEFORE the microphone is opened.
 *
 * The phone draws no button where the answer is no (`Unavailable.tsx`'s rule —
 * a dimmed control explains nothing on a phone), so the reason has to be a
 * sentence somebody can act on, naming the thing to install.
 */
export function dictateStatus(): DictateStatus {
  if (env("DICTATE") === "0") {
    return { available: false, reason: `dictation is off on this host (${envName("DICTATE")}=0)` };
  }
  const bin = binary();
  if (!onPath(bin)) {
    return { available: false, reason: `${bin} is not on this desktop's PATH${whisperInstallHint()}` };
  }
  const model = modelPath();
  if (!model) {
    const named = (env("WHISPER_MODEL") || "").trim();
    return {
      available: false,
      reason: named
        ? `${envName("WHISPER_MODEL")} points at ${named}, which does not exist`
        : `no whisper model in ${modelDir()} — put a ggml-*.bin there or set ${envName("WHISPER_MODEL")}`,
    };
  }
  return { available: true, engine: "whisper.cpp", model: model.split("/").pop() };
}

/** Threads for one run. One core is left for the daemon, which is pumping every
 *  PTY while this runs; below two threads the decode is slower than the upload. */
function threads(): number {
  const override = Number((env("WHISPER_THREADS") || "").trim());
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);
  const cores = Math.max(1, (cpus()?.length || 4) - 1);
  return Math.max(2, Math.min(cores, 8));
}

/** Whisper's subtitle-corpus artifacts, matched as a PREFIX because each
 *  carries a varying tail (a year, a channel) and none occurs in real speech. */
const BOILERPLATE_PREFIX = [
  "untertitelung des zdf",
  "untertitel der amara.org-community",
  "untertitel im auftrag des zdf",
  "untertitelung im auftrag des zdf",
  "copyright wdr",
  "amara.org",
  "subtitles by the amara.org community",
];

function isArtifact(text: string): boolean {
  const line = text.trim().toLowerCase().replace(/^[\s."'!?,-]+|[\s."'!?,-]+$/g, "");
  return BOILERPLATE_PREFIX.some((p) => line.startsWith(p));
}

/**
 * What whisper complained about, as one line fit to show somebody.
 *
 * Its `error:` line names its subject in quotes, and that subject is sometimes
 * the input PATH — a temp file this module made and is about to remove, of no
 * use to anybody reading a toast on a phone. So a quoted PATH is replaced and
 * everything else quoted is kept: `unknown language 'de-de'` is the whole
 * diagnosis, and scrubbing every quoted run turned it into "unknown language
 * the clip", which names nothing and was its own small bug.
 */
export function whisperSaid(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => l.startsWith("error:")) || lines.find((l) => /fail|error|invalid/i.test(l)) || "";
  return line
    .replace(/^error:\s*/, "")
    .replace(/'[^']*\/[^']*'/g, "the clip")
    .slice(0, 160);
}

/** Where whisperd listens, or null when it is switched off. Loopback by
 *  default: whisperd refuses every other interface, and so should this. */
export function whisperdUrl(): string | null {
  const raw = env("WHISPERD_URL");
  if (raw === undefined) return "http://127.0.0.1:8777";
  const v = raw.trim();
  return !v || /^(0|off|none|false|no)$/i.test(v) ? null : v.replace(/\/+$/, "");
}

/** The whisperd model a dictation asks for (`turbo`, `small`, …). */
export function whisperdModel(): string {
  return (env("WHISPERD_MODEL") || "").trim() || "turbo";
}

/** What whisperd said, reduced to what this module needs — or null when the
 *  clip should go to `whisper-cli` instead (unreachable, busy, failing). */
type DaemonAnswer = { text: string; model: string; noSpeech: boolean } | { error: string };

export async function viaWhisperd(
  wav: Buffer, opts: { lang: string; prompt: string; seconds: number },
): Promise<DaemonAnswer | null> {
  const base = whisperdUrl();
  if (!base) return null;
  const q = new URLSearchParams({ model: whisperdModel(), lang: opts.lang });
  if (opts.prompt) q.set("prompt", opts.prompt);
  let res: Response;
  try {
    res = await fetch(`${base}/v1/transcribe?${q}`, {
      method: "POST",
      body: wav,
      headers: { "content-type": "audio/wav" },
      // The CLI's own ceiling, so the daemon is never allowed longer than the
      // path it replaces.
      signal: AbortSignal.timeout(Math.round(20_000 + opts.seconds * 4_000)),
    });
  } catch {
    return null; // not running, restarting, or too slow: the CLI answers.
  }
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.ok && body && typeof body.text === "string") {
    return {
      text: body.text,
      model: typeof body.model_file === "string" ? body.model_file : `whisperd:${whisperdModel()}`,
      noSpeech: body.heard_no_speech === true,
    };
  }
  // About the audio itself: whisper-cli would refuse the same bytes.
  if (res.status === 400 || res.status === 413) {
    return { error: `the transcriber read no audio out of that recording — ${String(body?.message || res.status).slice(0, 160)}` };
  }
  console.log(`${logTag} dictate: whisperd answered ${res.status} (${String(body?.error || "no reason")}); using whisper-cli`);
  return null;
}

/** Where kept dictations go (`WATERPLANE_DICTATE_KEEP=1`). XDG, outside every repo. */
export function keepDir(): string {
  const named = (env("DICTATE_KEEP_DIR") || "").trim();
  if (named) return named.startsWith("~/") ? expandHome(named) : resolve(named);
  const xdg = (process.env.XDG_DATA_HOME || "").trim();
  return xdg ? join(resolve(xdg), BRAND.configDirName, "dictations") : join(homedir(), ".local", "share", BRAND.configDirName, "dictations");
}

/** Save one clip and what it was heard as, when the person opted in. Never
 *  fatal: a disk that is full must not turn a transcript into an error. */
export async function keepDictation(wav: Buffer, answer: { text: string; ms: number; model?: string; via: string; lang: string }): Promise<string | null> {
  if (env("DICTATE_KEEP") !== "1") return null;
  try {
    const dir = keepDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask and ignored for a directory that
    // already exists: somebody's voice is kept owner-only regardless.
    await chmod(dir, 0o700);
    const stem = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(join(dir, `${stem}.wav`), wav, { mode: 0o600 });
    await writeFile(join(dir, `${stem}.json`), JSON.stringify({ ...answer, at: new Date().toISOString() }, null, 1), { mode: 0o600 });
    return join(dir, stem);
  } catch (e: any) {
    console.log(`${logTag} dictate: could not keep the clip: ${String(e?.message || e).slice(0, 120)}`);
    return null;
  }
}

/**
 * Whether dictation can run, for the GET the phone asks before opening the
 * microphone: `dictateStatus()`, except that a running whisperd with no
 * `whisper-cli` model on disk is still a yes. Separate and async because the
 * health probe is a request, and `doctor.ts` needs the synchronous answer.
 */
export async function dictateStatusLive(): Promise<DictateStatus> {
  const s = dictateStatus();
  if (s.available || env("DICTATE") === "0") return s;
  const base = whisperdUrl();
  if (!base) return s;
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
    if (r.ok) return { available: true, engine: "whisper.cpp", model: `whisperd:${whisperdModel()}` };
  } catch { /* not running: the CLI's own reason stands */ }
  return s;
}

/**
 * One clip in, one answer out.
 *
 * `lang` is `auto` unless told otherwise: this is dictated in German and
 * English in the same breath, and pinning a language makes whisper translate
 * the other one rather than transcribe it.
 *
 * `terms` is the person's vocabulary as Settings holds it (`shared/dictateterms.ts`):
 * handed to whisper as its initial prompt, which is what moves the spelling,
 * then put back into whatever still came out wrong.
 */
export async function transcribe(wav: Buffer, opts: { lang?: string; terms?: string } = {}): Promise<DictateAnswer> {
  if (env("DICTATE") === "0") {
    return { error: `dictation is off on this host (${envName("DICTATE")}=0)` };
  }
  const facts = wavFacts(wav);
  const refusal = dictateRefusal(facts);
  if (refusal) return { error: refusal };
  const seconds = facts!.seconds;

  // NORMALISED, never passed through. The phone sends `navigator.language`,
  // which is a BCP-47 tag (`de-DE`); whisper takes ISO-639-1, refuses anything
  // else, and — having checked the language before it loads the model — exits 0
  // with no transcript. That is what made every dictation from a phone with a
  // regional locale fail, invisibly (`shared/dictate.ts`'s `whisperLang`).
  const lang = whisperLang(opts.lang || env("WHISPER_LANG"));
  const terms = parseDictateTerms(opts.terms);
  const prompt = dictatePrompt(terms);
  const t0 = Date.now();

  // whisperd first: a resident model, no load per clip. null = use the CLI.
  const daemon = await viaWhisperd(wav, { lang, prompt, seconds });
  if (daemon && "error" in daemon) return daemon;
  if (daemon) {
    const text = daemon.text.replace(/\s+/g, " ").trim();
    if (!text) return { error: "nothing was said" };
    if (daemon.noSpeech || isArtifact(text) || isPromptEcho(text, terms)) return { error: "no speech in that recording" };
    const answer = { text: applyDictateTerms(text, terms), seconds: Math.round(seconds * 10) / 10, ms: Date.now() - t0, engine: "whisper.cpp", model: daemon.model };
    await keepDictation(wav, { text: answer.text, ms: answer.ms, model: answer.model, via: "whisperd", lang });
    return answer;
  }

  const status = dictateStatus();
  if (!status.available) return { error: status.reason || "dictation is not available on this host" };
  const model = modelPath()!;
  const dir = await mkdtemp(join(tmpdir(), `${BRAND.slug}-dictate-`));
  try {
    const input = join(dir, "clip.wav");
    const stem = join(dir, "out");
    await writeFile(input, wav);
    // A run is ~1 s for 30 s of speech. The ceiling is four times realtime plus
    // a floor, which is CPU-only territory on a machine with no GPU — slow
    // enough to be worth saying, not slow enough to be a hang.
    const timeout = Math.round(20_000 + seconds * 4_000);
    // stderr is KEPT, because a clean exit is not a transcription. whisper.cpp
    // reads its audio before it loads the model and **exits 0 when it cannot
    // read it** — the only trace is the JSON it then never writes. Answering
    // that with the `readFile` error handed the phone
    // `ENOENT … /var/folders/…/out.json`: a temp path nobody can act on, about
    // a file that was never the problem. What whisper SAID is the answer.
    const said = await new Promise<string>((ok, fail) => {
      const child = execFile(binary(), [
        "-m", model,
        "-l", lang,
        "-t", String(threads()),
        "-oj", "-of", stem,
        "-np", "-nt",
        ...(prompt ? ["--prompt", prompt] : []),
        input,
      ], { timeout, killSignal: "SIGKILL", maxBuffer: 4 << 20 },
        (err, _out, errOut) => (err ? fail(err) : ok(String(errOut || ""))));
      child.on("error", fail);
    });
    let raw: string;
    try {
      raw = await readFile(`${stem}.json`, "utf8");
    } catch {
      // Never the tmp path: it names a directory this function is about to
      // delete, and the reader has no use for it. The facts DO go to the log —
      // shape and duration, never the audio and never the words — because a
      // clip the transcriber refuses is diagnosable from its header alone.
      console.log(`${logTag} dictate: no transcript for ${seconds.toFixed(1)}s of ${facts!.rate}Hz ${facts!.channels}ch ${facts!.bits}-bit fmt${facts!.format} audio (${wav.length}B): ${whisperSaid(said) || "no reason given"}`);
      return { error: `the transcriber read no audio out of that recording — ${whisperSaid(said) || `${binary()} exited without writing a transcript`}` };
    }
    const payload = JSON.parse(raw) as { transcription?: { text?: unknown }[] };
    const text = (payload.transcription || [])
      .map((s) => (typeof s.text === "string" ? s.text : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return { error: "nothing was said" };
    if (isArtifact(text) || isPromptEcho(text, terms)) return { error: "no speech in that recording" };
    const answer = { text: applyDictateTerms(text, terms), seconds: Math.round(seconds * 10) / 10, ms: Date.now() - t0, engine: "whisper.cpp", model: model.split("/").pop() };
    await keepDictation(wav, { text: answer.text, ms: answer.ms, model: answer.model, via: "whisper-cli", lang });
    return answer;
  } catch (e: any) {
    const why = String(e?.killed ? `it took longer than ${Math.round((20_000 + seconds * 4_000) / 1000)}s` : (e?.message || e));
    // Never the transcript, never the audio: this is the one place a log line
    // could carry what somebody said out of the process that heard it.
    console.log(`${logTag} dictate failed after ${Date.now() - t0}ms on ${seconds.toFixed(1)}s of audio: ${why.slice(0, 200)}`);
    return { error: `the transcriber failed — ${why.slice(0, 160)}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
