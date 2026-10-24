import { useEffect, useRef, useState } from "react";
import { DICTATE_MAX_SECONDS, DICTATE_MIN_SECONDS, DICTATE_RATE, appendDictation, applyDictateTerms, floatToPcm16, pcm16ToWav, type DictateStatus } from "@waterplane/shared";
import { api } from "./api";
import { dictateLang, dictateTerms, speechLang } from "./dictateLang";
import { claimDictation, dictationState, holdDictation, subscribeDictations } from "./dictateQueue";
import { linkSnapshot, subscribeLink } from "./link";
import { showToast } from "./toast";
import { mergeSpeechResults } from "./speechMerge";
import { dictateFallbackWhy } from "./dictateFallback";
import { CAP_WARN_SECONDS, captureStall, clock, stallToast } from "./dictateWatch";

/**
 * Push-to-talk dictation, with two engines and one button.
 *
 * ── Why there is a second engine ────────────────────────────────────────────
 *
 * The first one is the Web Speech API, which on Android Chrome is Google's
 * cloud recogniser — the same family as the Gboard microphone, and reported as
 * the reason dictation here was not worth using: it commits words as you say
 * them, punctuates badly, and mangles English identifiers inside German prose
 * because it never sees the end of the sentence before deciding the start.
 *
 * The desktop already has a better one. Measured on the machine that runs this
 * host (whisper.cpp `large-v3-turbo`, Metal): 28.6 s of German transcribed in
 * 0.95 s, punctuation and mixed-language technical words intact. So the phone
 * records, the desktop transcribes, and the words come back about a second
 * after you stop talking — over a tunnel that is already carrying the terminal.
 *
 * ── Which engine, decided once and never dimmed ─────────────────────────────
 *
 * `host` when the desktop says it can (`GET /api/host/dictate`) AND this
 * document may open a microphone at all; `browser` when only the Web Speech
 * API is there; and with neither, `supported` is false and the CALLER draws no
 * button (`Unavailable.tsx`'s rule — a greyed control explains nothing on a
 * phone, where a `title` never appears).
 *
 * **`getUserMedia` needs a secure context**, which a plain `http://100.x`
 * tunnel is not. So on the bare Tailscale IP this falls back to the browser
 * engine by construction, and the fix is the one the insecure-origin banner
 * already offers: `tailscale serve` in front of the daemon.
 *
 * ── A recording is not lost to the link ─────────────────────────────────────
 *
 * This module used to POST the WAV itself and show a toast if that failed,
 * which meant a minute of speech was destroyed by a tunnel that was merely
 * slow — the reported complaint, and the one thing a typed prompt on this app
 * has never done. It no longer transcribes anything: it RECORDS, hands the
 * bytes to `dictateQueue.ts`, and claims the words. The queue parks the audio
 * before the first attempt, retries for as long as it takes, and survives the
 * app being killed. What is left here is the microphone and the button's three
 * states — with `held` as the fourth thing a caller can say.
 *
 * ── Two behaviours that are not this module's to change ─────────────────────
 *
 *  - **Dictation APPENDS, onto what the box holds WHEN THE WORDS ARRIVE.** The
 *    box is read through `VoiceBox.read` at landing time, never snapshotted
 *    when the mic opened: with a held recording those two moments can be
 *    minutes and a paragraph apart, and `base + text` would delete every word
 *    typed in between (`shared/dictate.ts`'s `appendDictation`).
 *  - **The language is the dictation's, never the device's.** It is picked on
 *    the microphone and read at the STOP (`dictateLang.ts`), because whisper
 *    told a language translates every other one into it — the failure that
 *    made English spoken into a German phone arrive as German.
 *  - **A failure is a SENTENCE.** Every way this can fail — no model on the
 *    desktop, a refused microphone, silence — comes back as words in a toast,
 *    and nothing is appended. The one thing it must never do is put a guess in
 *    the box. A dead LINK is no longer one of those failures; it is a wait.
 */

// ── The browser engine ──────────────────────────────────────────────────────

/** Minimal typing for the vendor-prefixed Web Speech API. */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
}

/** The fallback sentence has been toasted on this page already. */
let fallbackSaid = false;

function getCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

// ── What the desktop said, asked once per page ──────────────────────────────

/**
 * One in-flight read for every hook that mounts.
 *
 * Two components call `useVoice` (the compose bar and the action bar), and on
 * some screens both are mounted at once. A status read per hook per mount is
 * two requests for one unchanging fact, so the promise is the memo — the answer
 * itself is deliberately not re-read after that: installing whisper is not a
 * thing that happens while a phone screen is open, and a stale "yes" fails as
 * a sentence on the next recording rather than as a wrong button.
 */
let statusPromise: Promise<DictateStatus> | null = null;
function hostStatus(): Promise<DictateStatus> {
  if (!statusPromise) {
    const p = api.dictateStatus();
    statusPromise = p;
    // A "no" is not memoised: the likeliest one is an unreachable host at page
    // load, and holding it would leave every later mount on the phone's
    // recogniser — and saying so — until a reload.
    void p.then((s) => { if (!s.available && statusPromise === p) statusPromise = null; });
  }
  return statusPromise;
}

/** Whether this document may open a microphone at all. False on an insecure
 *  origin, which is what a bare `http://100.x` tunnel is. */
function canRecord(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined";
}

/** What one open microphone owns, so stopping it cannot leave a track live —
 *  a phone with a hot microphone icon after a failed send is its own bug. */
interface Capture {
  ctx: AudioContext;
  stream: MediaStream;
  node: ScriptProcessorNode;
  chunks: Float32Array[];
  frames: number;
  /** When the microphone opened, and when audio last arrived — the watchdog's
   *  two clocks (`dictateWatch.ts`). */
  openedAt: number;
  lastFrameAt: number;
}

/**
 * The capture graph.
 *
 * `AudioContext({ sampleRate })` asks the browser to resample for us, which is
 * the whole reason the desktop needs no transcoder: whisper.cpp reads 16 kHz
 * mono PCM and nothing else, and the alternative — `MediaRecorder`'s webm/opus
 * — would need ffmpeg on the host, a binary this daemon otherwise does not
 * depend on and which was broken on the machine this was written on while
 * everything else worked.
 *
 * `ScriptProcessorNode` is deprecated and used anyway: an `AudioWorklet` needs
 * a separate module URL, which inside the Capacitor WebView means a blob URL
 * and a second thing that can be blocked. This runs at 16 kHz mono, where the
 * main-thread cost of a 4096-frame callback is nothing.
 */
async function openCapture(): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: DICTATE_RATE });
  if (ctx.state === "suspended") await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const cap: Capture = { ctx, stream, node, chunks: [], frames: 0, openedAt: Date.now(), lastFrameAt: Date.now() };
  node.onaudioprocess = (e) => {
    // `getChannelData` hands back a view onto a buffer the graph reuses, so a
    // copy is not an optimisation to skip — without it every chunk ends up
    // holding whatever the last callback wrote.
    cap.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    cap.frames += e.inputBuffer.length;
    cap.lastFrameAt = Date.now();
  };
  source.connect(node);
  // A ScriptProcessor only fires while it is connected to a destination. The
  // gain is zeroed so the phone does not play its own microphone back.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);
  return cap;
}

function closeCapture(cap: Capture) {
  try { cap.node.onaudioprocess = null; cap.node.disconnect(); } catch { /* already torn down */ }
  for (const t of cap.stream.getTracks()) { try { t.stop(); } catch { /* already stopped */ } }
  void cap.ctx.close().catch(() => {});
}

function wavFrom(cap: Capture): Blob {
  const all = new Float32Array(cap.frames);
  let at = 0;
  for (const c of cap.chunks) { all.set(c, at); at += c.length; }
  // `.buffer` rather than the view: `Uint8Array<ArrayBufferLike>` is not a
  // `BlobPart` under this TS lib, and the header writer already owns a fresh
  // buffer of exactly the right length.
  return new Blob([pcm16ToWav(floatToPcm16(all), cap.ctx.sampleRate).buffer as ArrayBuffer], { type: "audio/wav" });
}

/** A short double pulse: a stopped microphone is felt, not only read — the
 *  phone is usually in a hand, screen unwatched, while somebody talks. */
function buzz() {
  try { navigator.vibrate?.([120, 80, 120]); } catch { /* no vibrator */ }
}

// ── The hook ────────────────────────────────────────────────────────────────

/**
 * The box being dictated into, as three functions rather than a value.
 *
 * `read` is called TWICE — when the microphone opens (the browser engine
 * rewrites its whole transcript on every interim result, so it needs a base)
 * and again when transcribed words arrive. The second call is the one that
 * matters: a held recording lands minutes later, and appending to what the box
 * held back then would delete whatever has been typed since.
 *
 * `key` is WHICH box this is — the session the compose bar is showing, the turn
 * of a prompt chain the caret was in. Read at the same two moments, and if it
 * has changed the words are NOT written here: they go to the pad with a
 * sentence saying so. Writing them anyway would put a sentence about one
 * session into a different session's draft.
 */
export interface VoiceBox {
  read: () => string;
  write: (next: string) => void;
  key?: () => string;
}

export interface Voice {
  /** Whether to draw a microphone at all. False ⇒ no button, no explanation
   *  needed: this phone has no way to dictate. */
  supported: boolean;
  /** The microphone is open. */
  listening: boolean;
  /** While listening: how long it has HEARD, as `m:ss`. On the host engine this
   *  is the capture's own frame count, so it freezes when the microphone does —
   *  the clock on the button is the indication that it is still listening. */
  heard: string | null;
  /** A recording is on the wire to the desktop right now. Held apart from
   *  `listening` because they are two different waits and one of them has an
   *  end nobody controls. */
  transcribing: boolean;
  /** Recordings parked and not yet read — a link that was down when somebody
   *  stopped talking. Nothing is lost; the words arrive when it is back. */
  held: number;
  /** Which engine a tap would use, for a caller that words its own title. */
  engine: "host" | "browser" | null;
  /** Why a tap goes to the PHONE's recogniser instead of the desktop's
   *  whisper, as a sentence (`dictateFallback.ts`); null when whisper is the
   *  engine or the desktop has not answered yet. */
  fallback: string | null;
  /** Start or stop. */
  toggle(): void;
}

export function useVoice(box: VoiceBox): Voice {
  const [listening, setListening] = useState(false);
  const [engine, setEngine] = useState<"host" | "browser" | null>(getCtor() ? "browser" : null);
  const [hold, setHold] = useState(dictationState);
  const [fallback, setFallback] = useState<string | null>(() =>
    dictateFallbackWhy({ secure: typeof window !== "undefined" && window.isSecureContext, canRecord: canRecord() }));
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const capRef = useRef<Capture | null>(null);
  /** The watchdog's interval: the clock, the stall check and the cap. */
  const stopAtRef = useRef<number | null>(null);
  const startedRef = useRef(0);
  const [heard, setHeard] = useState(0);
  /** The screen kept on while recording — a screen timing out is the usual way
   *  a long dictation stopped hearing anything, silently. */
  const wakeRef = useRef<{ release(): Promise<void> } | null>(null);
  /** The browser recogniser was stopped by a tap (or a box change), so its
   *  `onend` is expected rather than a microphone that stopped by itself. */
  const meantStopRef = useRef(false);
  const baseRef = useRef("");
  /** The box, by ref: a claim outlives the render that made it. */
  const boxRef = useRef(box);
  boxRef.current = box;
  /** Claims on recordings this hook made, released together on unmount so the
   *  words go to the pad rather than into a component that has gone. */
  const claims = useRef<(() => void)[]>([]);

  useEffect(() => {
    let live = true;
    let isHost = false;
    const ask = () => {
      if (!canRecord() || isHost) return;
      void hostStatus().then((s) => {
        if (!live) return;
        if (s.available) { isHost = true; setEngine("host"); }
        setFallback(dictateFallbackWhy({ secure: window.isSecureContext, canRecord: true, status: s }));
      });
    };
    ask();
    // A "no" asked while the desktop was down (a reboot, a host restart) is
    // asked again when the link comes back — otherwise the phone's recogniser
    // stays the engine until a reload, which is how it was found.
    let wasOpen = linkSnapshot().status === "open";
    const offLink = subscribeLink((l) => {
      const open = l.status === "open";
      if (open && !wasOpen) ask();
      wasOpen = open;
    });
    const off = subscribeDictations(() => setHold(dictationState()));
    return () => {
      live = false;
      offLink();
      off();
      meantStopRef.current = true;
      recRef.current?.stop();
      if (capRef.current) { closeCapture(capRef.current); capRef.current = null; }
      if (stopAtRef.current) window.clearInterval(stopAtRef.current);
      releaseWake();
      for (const release of claims.current) release();
      claims.current = [];
    };
  }, []);

  async function startHost() {
    let cap: Capture;
    try {
      cap = await openCapture();
    } catch (e: any) {
      // A refused permission and an absent microphone are the same sentence to
      // the person holding the phone: nothing was recorded, and why.
      showToast(e?.name === "NotAllowedError"
        ? "this app has no permission to use the microphone"
        : "no microphone this app can open");
      // A roll-over that could not reopen the microphone leaves no open one
      // behind a button still saying listening.
      setListening(false);
      releaseWake();
      return;
    }
    capRef.current = cap;
    startedRef.current = Date.now();
    setHeard(0);
    setListening(true);
    void holdWake();
    let warned = false;
    stopAtRef.current = window.setInterval(() => {
      if (capRef.current !== cap) return;
      const seconds = cap.frames / cap.ctx.sampleRate;
      setHeard(seconds);
      // The microphone stopped hearing while the button still said listening:
      // the reported defect. Stop, hand over what WAS heard, and say when.
      const why = captureStall({
        now: Date.now(), startedAt: cap.openedAt, heardSeconds: seconds, lastFrameAt: cap.lastFrameAt,
        track: cap.stream.getAudioTracks()[0]?.readyState ?? "ended", ctx: cap.ctx.state,
        visible: document.visibilityState === "visible",
      });
      if (why) {
        buzz();
        showToast(stallToast(seconds, why));
        void stopHost();
        return;
      }
      // The cap is the host's too, but a clip cut HERE is the one that was made
      // rather than a 413 — and the next one starts at once, so a long
      // dictation is several clips landing in order, never a microphone that
      // quietly closed at five minutes.
      if (!warned && seconds >= DICTATE_MAX_SECONDS - CAP_WARN_SECONDS) {
        warned = true;
        showToast(`at ${clock(DICTATE_MAX_SECONDS)} this part goes to the desktop and a new one starts — keep talking`);
      }
      if (seconds >= DICTATE_MAX_SECONDS) {
        buzz();
        void stopHost({ rollOver: true }).then(() => startHost());
      }
    }, 500);
  }

  /**
   * Stop recording and hand the audio over. Nothing is transcribed here and
   * nothing is awaited: the queue owns the attempt, the retries and the words,
   * so a tunnel that dies between this line and the desktop costs a wait rather
   * than a minute of speech.
   */
  async function stopHost(opts: { rollOver?: boolean } = {}) {
    const cap = capRef.current;
    capRef.current = null;
    if (stopAtRef.current) { window.clearInterval(stopAtRef.current); stopAtRef.current = null; }
    if (!cap) return;
    if (!opts.rollOver) { setListening(false); releaseWake(); }
    const seconds = cap.frames / cap.ctx.sampleRate;
    const wav = wavFrom(cap);
    closeCapture(cap);
    // A mis-tap is answered HERE rather than parked. The host refuses it in the
    // same words (`dictateRefusal`), but only after a round trip — and with the
    // tunnel down that round trip does not happen, so half a second of silence
    // would sit in the hold looking like words somebody is waiting for.
    if (seconds < DICTATE_MIN_SECONDS) { showToast("nothing was said"); return; }
    // The language is the DICTATION's, not the phone's. It used to be
    // `navigator.language` — the system language, which is not the language
    // being spoken into the phone — and whisper, told a language, translates
    // every other one into it rather than transcribing them: English said into
    // a German phone came back as German prose. Read HERE, at the stop, so the
    // tag travels with the clip and a held recording keeps the language it was
    // made in (`dictateLang.ts`, `DictateLangPill.tsx`).
    const held = await holdDictation(wav, { seconds, lang: dictateLang() });
    if ("error" in held) { showToast(held.error); return; }
    // WHICH box these words belong to, decided now and checked again when they
    // arrive. A different session, or a different turn of a chain, is not this
    // box — the pad takes them instead (`dictateQueue.ts`).
    const mine = boxRef.current.key?.();
    claims.current.push(claimDictation(held.id, (text) => {
      const b = boxRef.current;
      if (b.key?.() !== mine) return false;
      b.write(appendDictation(b.read(), text));
      return true;
    }));
  }

  function startBrowser() {
    const Ctor = getCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    // Web Speech has no auto-detect, so `auto` here can only be the device's
    // own language — `speechLang` is that one question, answered in one place.
    rec.lang = speechLang();
    rec.continuous = true;
    rec.interimResults = true;
    // The browser engine rewrites its WHOLE transcript on every result, so this
    // one is base-plus-everything by construction — there is no landing moment
    // to re-read the box at, and the words are already in it as they are said.
    // No prompt to bias this engine with, so the person's vocabulary is only
    // the corrections half (`shared/dictateterms.ts`), read once per recording.
    const terms = dictateTerms();
    // WHICH box this recording writes into, fixed at the start. Every result
    // REPLACES the box with base + transcript, so a session switched mid-
    // sentence would get this box's base and words over its own draft — the
    // host engine checks its key twice; this one stops at the first mismatch.
    const keyAtStart = boxRef.current.key?.();
    let moved = false;
    rec.onresult = (e: any) => {
      if (boxRef.current.key?.() !== keyAtStart) {
        if (!moved) {
          moved = true;
          meantStopRef.current = true;
          rec.stop();
          showToast("dictation stopped — you left the box it was writing into; what was recognised is still there");
        }
        return;
      }
      const parts: string[] = [];
      for (let i = 0; i < e.results.length; i++) parts.push(e.results[i][0].transcript);
      boxRef.current.write(baseRef.current + applyDictateTerms(mergeSpeechResults(parts), terms));
    };
    // The browser engine has no audio to hold — the words are recognised in
    // Google's cloud as they are said and there is no recording on this device
    // to retry. So a failure here is at least SAID, rather than the microphone
    // quietly going back to idle mid-sentence. `no-speech` and an abort are
    // ordinary endings and are not worth a sentence.
    rec.onerror = (e: any) => {
      setListening(false);
      const why = e?.error;
      if (why && why !== "no-speech" && why !== "aborted") {
        meantStopRef.current = true; // said here; `onend` must not say it twice
        buzz();
        showToast("dictation stopped — this browser's recogniser could not finish. What was already recognised is in the box.");
      }
    };
    rec.onend = () => {
      setListening(false);
      if (stopAtRef.current) { window.clearInterval(stopAtRef.current); stopAtRef.current = null; }
      releaseWake();
      if (recRef.current === rec) recRef.current = null;
      // Android's recogniser ends a "continuous" session by itself — after a
      // pause, or a minute — and the button went back to idle mid-sentence
      // with nothing else said. An end nobody asked for is SAID, and felt.
      if (!meantStopRef.current && !moved) {
        buzz();
        showToast(`the phone's recogniser stopped listening at ${clock((Date.now() - startedRef.current) / 1000)} — what it heard is in the box; tap the mic to go on`);
      }
    };
    recRef.current = rec;
    meantStopRef.current = false;
    // Said once per page, at the first recording that uses it: the pill beside
    // the mic carries it afterwards, and a toast on every tap is noise.
    if (fallback && !fallbackSaid) { fallbackSaid = true; showToast(fallback); }
    rec.start();
    startedRef.current = Date.now();
    setHeard(0);
    setListening(true);
    void holdWake();
    // Wall clock: this engine hands back no audio to count.
    stopAtRef.current = window.setInterval(() => setHeard((Date.now() - startedRef.current) / 1000), 500);
  }

  async function holdWake() {
    try { wakeRef.current = await (navigator as any).wakeLock?.request("screen") ?? null; } catch { wakeRef.current = null; }
  }
  function releaseWake() {
    void wakeRef.current?.release().catch(() => {});
    wakeRef.current = null;
  }

  function toggle() {
    if (listening) {
      if (capRef.current) void stopHost();
      else { meantStopRef.current = true; recRef.current?.stop(); }
      return;
    }
    // Recording is never blocked by work already waiting: a link that is down
    // is exactly when somebody goes on talking, and the hold is what that is
    // for. The queue refuses in words at its own cap (`holdRefusal`).
    const now = boxRef.current.read();
    baseRef.current = now ? now.replace(/\s*$/, "") + " " : "";
    if (engine === "host") void startHost();
    else startBrowser();
  }

  return {
    supported: engine !== null,
    listening,
    heard: listening ? clock(heard) : null,
    transcribing: hold.sending,
    held: hold.held,
    engine,
    fallback: engine === "browser" ? fallback : null,
    toggle,
  };
}
