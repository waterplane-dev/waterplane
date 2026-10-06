/**
 * Dictation: the audio format both ends have to agree on, and the caps.
 *
 * ── Why the phone sends WAV and not what the microphone gives it ────────────
 *
 * `MediaRecorder` produces webm/opus, and nothing on the desktop side of this
 * feature can read that: `whisper.cpp` takes 16 kHz mono PCM and nothing else,
 * so a container would have to be transcoded on the host — which means ffmpeg,
 * a binary this daemon otherwise does not need and which was, on the machine
 * this was written on, BROKEN (`Library not loaded: libx265.216.dylib`) while
 * every other part of the desktop worked. A dictation path that dies because a
 * video codec was upgraded is not a dictation path.
 *
 * So the phone opens its capture graph at the sample rate whisper wants, takes
 * the raw floats, and writes the header itself. `pcm16ToWav` is that header.
 * The host then only has to CHECK the shape (`wavFacts`), which is 44 bytes of
 * arithmetic and cannot fail for an environmental reason.
 *
 * ── The caps are seconds, not bytes ─────────────────────────────────────────
 *
 * At 16 kHz mono 16-bit, audio is exactly 32,000 bytes per second, so the two
 * are the same fact — but a person dictating thinks in seconds, and the
 * sentence they get told has to as well. `DICTATE_MAX_SECONDS` is generous on
 * purpose: transcription is ~30× realtime on the machine that runs it, so five
 * minutes of speech is about ten seconds of waiting, and a cap that cuts a
 * long thought in half is worse than a wait somebody can see.
 */

/** What the capture graph is opened at, and the only rate whisper.cpp reads. */
export const DICTATE_RATE = 16_000;

/** The longest single dictation, in seconds. */
export const DICTATE_MAX_SECONDS = 300;

/** Bytes of PCM in one second at the rate above: 16-bit mono. */
export const DICTATE_BYTES_PER_SEC = DICTATE_RATE * 2;

/** The body cap, header included and rounded up — what the route refuses on. */
export const DICTATE_MAX_BYTES = DICTATE_MAX_SECONDS * DICTATE_BYTES_PER_SEC + 1024;

/** What a transcription attempt answers. A reason is an ANSWER, never a throw:
 *  "no model on this desktop" and "you said nothing" are both things to show. */
export type DictateAnswer =
  | { text: string; seconds: number; ms: number; engine: string; model?: string }
  | { error: string };

/** Whether this desktop can transcribe at all, asked before the mic opens so a
 *  button is never offered for a thing that will fail. Absent binary, absent
 *  model and switched off are three different sentences and stay that way. */
export interface DictateStatus {
  available: boolean;
  /** Why not, in words, when `available` is false. Never set when it is true. */
  reason?: string;
  /** The engine that would run — `whisper.cpp` today, a service tomorrow. */
  engine?: string;
  /** The model file's basename, for a person deciding whether to swap it. */
  model?: string;
}

/**
 * A mono 16-bit WAV around Int16 samples.
 *
 * Written by hand rather than through any library because it is 44 bytes and
 * this runs on a phone inside a WebView: a dependency here would be shipped in
 * every bundle for one header.
 */
export function pcm16ToWav(samples: Int16Array, rate = DICTATE_RATE): Uint8Array {
  const bytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const view = new DataView(buf);
  const tag = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  tag(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // format 1 = PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);    // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  tag(36, "data");
  view.setUint32(40, bytes, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}

/** Float samples in [-1, 1] as Int16, clamped. A clip is quieter than a wrap. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** What a WAV body IS, or `null` if it is not one this feature can use. Read on
 *  the host before anything is spawned: a sentence about the format beats a
 *  whisper run that fails for a reason nobody can see. */
export function wavFacts(buf: Uint8Array): { rate: number; channels: number; bits: number; seconds: number; format: number } | null {
  if (buf.length < 44) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const str = (off: number, n: number) => String.fromCharCode(...buf.subarray(off, off + n));
  if (str(0, 4) !== "RIFF" || str(8, 4) !== "WAVE") return null;
  // Walk the chunks rather than assuming `fmt ` at 12 and `data` at 36: a
  // recorder that writes a LIST chunk is still writing a valid WAV.
  let off = 12;
  let rate = 0, channels = 0, bits = 0, dataBytes = 0, format = 0;
  while (off + 8 <= buf.length) {
    const id = str(off, 4);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt " && off + 8 + 16 <= buf.length) {
      format = view.getUint16(off + 8, true);
      channels = view.getUint16(off + 10, true);
      rate = view.getUint32(off + 12, true);
      bits = view.getUint16(off + 22, true);
    } else if (id === "data") {
      // A truncated body is common (the socket died mid-upload); trust the
      // bytes that ARRIVED over a length field describing bytes that did not.
      dataBytes = Math.min(size, buf.length - off - 8);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!rate || !channels || !bits || !dataBytes) return null;
  return { rate, channels, bits, format, seconds: dataBytes / (rate * channels * (bits / 8)) };
}

/** Whether a clip is worth spawning a transcription for. Below this it is a
 *  mis-tap, and whisper answers a subtitle-corpus artifact for silence. */
export const DICTATE_MIN_SECONDS = 0.25;

/** The `fmt ` tag of uncompressed integer PCM — the only thing `pcm16ToWav`
 *  writes, and the only thing the transcriber is asked to read. */
const WAVE_FORMAT_PCM = 1;

/**
 * The one wording for a refused clip, so the host and the phone say the same
 * thing about the same audio.
 *
 * **The SHAPE checks are not decoration.** `wavFacts` walks a header and will
 * happily report a float32 or ADPCM clip's rate and duration — they are valid
 * WAVs — and whisper.cpp then refuses to decode it. That refusal used to reach
 * the phone as `ENOENT … /var/folders/…/out.json`, because the transcriber
 * reads its audio BEFORE it loads the model and **exits 0 when it cannot**, so
 * the only trace on this side was the JSON it never wrote. A shape this feature
 * cannot read is a fact 44 bytes of arithmetic already knows; it is said here,
 * by name, before anything is spawned.
 */
export function dictateRefusal(facts: ReturnType<typeof wavFacts>): string | null {
  if (!facts) return "that recording is not 16-bit PCM audio this desktop can read";
  if (facts.format !== WAVE_FORMAT_PCM) {
    return `that recording is WAV format ${facts.format}, not uncompressed PCM — this desktop reads PCM only`;
  }
  if (facts.bits !== 16) return `that recording is ${facts.bits}-bit audio — this desktop reads 16-bit PCM only`;
  if (facts.channels > 2) return `that recording has ${facts.channels} channels — this desktop reads mono or stereo`;
  if (facts.seconds < DICTATE_MIN_SECONDS) return "nothing was said";
  if (facts.seconds > DICTATE_MAX_SECONDS) {
    return `that is ${Math.round(facts.seconds)}s of audio — the limit is ${DICTATE_MAX_SECONDS}s in one go`;
  }
  return null;
}

/**
 * Every language code whisper.cpp knows, and nothing else.
 *
 * This list exists because of the bug it fixes. The phone sends what the
 * browser knows it is set to — `navigator.language`, which is a BCP-47 tag like
 * `de-DE` — and whisper takes ISO-639-1 and **refuses anything else**:
 *
 *   whisper_lang_id: unknown language 'de-de'
 *   error: unknown language 'de-de'
 *
 * It then EXITS 0, having written no transcript, because it validates the
 * language before it loads the model. So every dictation from a phone whose
 * locale carries a region — which is most phones — died silently, and the host
 * could only report the JSON that was never written. A region subtag is not a
 * different language, and it is not this feature's job to make somebody set
 * their phone to plain `de`.
 *
 * Kept as a set rather than trusting the primary subtag, because an unknown
 * code is the exact failure being fixed: `auto` is a worse answer than a named
 * language and a far better one than no answer at all.
 */
const WHISPER_LANGS = new Set([
  "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs", "ca", "cs", "cy", "da",
  "de", "el", "en", "es", "et", "eu", "fa", "fi", "fo", "fr", "gl", "gu", "ha", "haw", "he", "hi",
  "hr", "ht", "hu", "hy", "id", "is", "it", "ja", "jw", "ka", "kk", "km", "kn", "ko", "la", "lb",
  "ln", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my", "ne", "nl", "nn",
  "no", "oc", "pa", "pl", "ps", "pt", "ro", "ru", "sa", "sd", "si", "sk", "sl", "sn", "so", "sq",
  "sr", "su", "sv", "sw", "ta", "te", "tg", "th", "tk", "tl", "tr", "tt", "uk", "ur", "uz", "vi",
  "yi", "yo", "yue", "zh",
]);

/** Tags a browser reports that whisper spells differently, or not at all.
 *  `nb` (Bokmål) is the one that matters: Android reports it, whisper has only
 *  the macrolanguage `no`, and dropping to `auto` for it would be a worse
 *  transcription than the language the person is actually speaking. The rest
 *  are the legacy ISO codes some WebViews still emit. */
const LANG_ALIASES: Record<string, string> = {
  nb: "no", jv: "jw", iw: "he", in: "id", ji: "yi", fil: "tl", cmn: "zh", mo: "ro",
};

/**
 * The language to ask the transcriber for, given what the phone knows.
 *
 * `auto` in, `auto` out — and `auto` for anything this engine does not have,
 * because auto-detect transcribes and an unknown code transcribes NOTHING.
 * Region and script subtags are dropped (`de-DE` → `de`, `zh-Hant` → `zh`):
 * whisper's model is per language, not per locale.
 */
export function whisperLang(tag: string | undefined): string {
  const raw = (tag || "").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  const primary = raw.split(/[-_]/)[0];
  const mapped = LANG_ALIASES[primary] || primary;
  return WHISPER_LANGS.has(mapped) ? mapped : "auto";
}

/** The tag that means "let the transcriber decide", which is what whisper's
 *  own `-l auto` is and what this app dictates in by default. */
export const DICTATE_AUTO = "auto";

/**
 * The languages the microphone OFFERS, and why the phone's locale is not one of
 * them by itself.
 *
 * The phone used to send `navigator.language` and nothing else, so a German
 * phone asked whisper for `de` on every clip — and whisper, told a language,
 * does not transcribe another one: it TRANSLATES it. English dictated into a
 * German phone came back as German prose, which is the reported bug and the
 * worst possible failure for this feature, because the words in the box are
 * fluent, plausible and not what anybody said.
 *
 * A person who dictates in two languages cannot be described by one device
 * setting, and changing the phone's system language to pick a transcriber is
 * not a thing to ask of anybody. So the language is the DICTATION's, chosen on
 * the microphone and remembered, with `auto` the default: auto-detect reads
 * either language correctly, and a pinned one is there for the short clip or
 * the technical sentence where detection is the part that wobbles.
 *
 * The list is curated rather than the whole of `WHISPER_LANGS`: a hundred-row
 * picker on a phone is a worse control than a dozen, and any language missing
 * from it is one `whisperLang` still accepts — `dictateLangChoices` adds the
 * device's own so no phone is offered a list without its language in it.
 */
const DICTATE_LANG_NAMES: Record<string, string> = {
  en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian",
  nl: "Dutch", pt: "Portuguese", pl: "Polish", ru: "Russian", uk: "Ukrainian",
  cs: "Czech", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish",
  tr: "Turkish", el: "Greek", he: "Hebrew", ar: "Arabic", hi: "Hindi",
  ja: "Japanese", ko: "Korean", zh: "Chinese",
};

/** The two this app is dictated in, first — the rest follow in the order above,
 *  which is roughly how likely they are here and not an opinion worth a sort. */
const DICTATE_LANG_FIRST = ["en", "de"];

/** A language's name, or its bare code when it is one only `whisperLang` knows.
 *  `auto` is a CHOICE and is named like one, never left as a bare tag. */
export function dictateLangName(code: string): string {
  if (code === DICTATE_AUTO) return "auto — whichever is spoken";
  return DICTATE_LANG_NAMES[code] || code;
}

/** What the control shows when it is not open: short, because it sits in a row
 *  of 42px circles. `auto` stays a word; a language is its code, upper-cased. */
export function dictateLangFace(code: string): string {
  return code === DICTATE_AUTO ? "auto" : code.toUpperCase();
}

/** What the control says it will do, as a sentence — the one place this is
 *  worded, so the pill, its title and any future settings row agree. */
export function dictateLangTitle(code: string): string {
  return code === DICTATE_AUTO
    ? "dictation is read as whichever language is spoken — pick one to pin it"
    : `dictation is read as ${dictateLangName(code)} — anything else spoken is TRANSLATED into it`;
}

/**
 * The languages to offer, given what the device says it is set to.
 *
 * `auto` always first: it is the default and the answer for a person who
 * switches language mid-sentence. Then the two this app is dictated in, then
 * the curated rest, then — only if it is not already there — the device's own
 * language, so no phone is handed a list that cannot express what it speaks.
 * A device tag `whisperLang` cannot place adds nothing: an unknown code
 * transcribes NOTHING, and `auto` is already at the top.
 */
export function dictateLangChoices(deviceTag?: string): { code: string; label: string }[] {
  const rest = Object.keys(DICTATE_LANG_NAMES).filter((c) => !DICTATE_LANG_FIRST.includes(c));
  const codes = [DICTATE_AUTO, ...DICTATE_LANG_FIRST, ...rest];
  const device = whisperLang(deviceTag);
  if (device !== DICTATE_AUTO && !codes.includes(device)) codes.push(device);
  return codes.map((code) => ({ code, label: dictateLangName(code) }));
}

/**
 * The languages a microphone offers until somebody says otherwise.
 *
 * Three, not the whole catalogue: the picker opens WHILE a recording is
 * running, which is a one-handed tap between two sentences, and a 25-row list
 * scrolled at that moment is the control failing at the one job it has. The
 * catalogue is what Settings offers to add from.
 */
export const DICTATE_LANGS_DEFAULT: readonly string[] = [DICTATE_AUTO, "en", "de"];

/**
 * The languages the pill actually lists, given what Settings holds.
 *
 * Two rules, both about never showing a control that cannot express the state
 * it is in:
 *
 *  - **An empty or unusable pick is the DEFAULT, never an empty list.** A
 *    picker with nothing in it is a dead tap; a phone whose stored list was
 *    written by an older build, or hand-edited, still gets a working mic.
 *  - **The ACTIVE language is always in the list.** It is what the control
 *    displays, and a `<select>` whose value matches no option renders as the
 *    first one — which would silently re-aim the transcriber at a language
 *    nobody picked, in the same control that is supposed to say which one is
 *    in use.
 *
 * Order is the catalogue's, so a language keeps its place in the list however
 * it got in.
 */
export function dictateLangOffered(
  picked: readonly string[] | undefined,
  active: string,
  deviceTag?: string,
): { code: string; label: string }[] {
  const catalogue = dictateLangChoices(deviceTag);
  const known = new Set(catalogue.map((c) => c.code));
  // An unknown stored code DROPS OUT rather than collapsing into `auto`:
  // `whisperLang` answers `auto` for anything it cannot place, which is right
  // for a clip about to be transcribed and wrong here — a list of two codes an
  // older build wrote would silently become a picker offering auto-detect and
  // nothing else.
  const want = new Set(
    (picked || [])
      .map((c) => {
        const norm = whisperLang(c);
        return norm === DICTATE_AUTO && c.trim().toLowerCase() !== DICTATE_AUTO ? "" : norm;
      })
      .filter((c) => known.has(c)),
  );
  if (!want.size) for (const c of DICTATE_LANGS_DEFAULT) if (known.has(c)) want.add(c);
  const live = whisperLang(active);
  if (known.has(live)) want.add(live);
  return catalogue.filter((c) => want.has(c.code));
}

/**
 * Where transcribed words go: onto whatever is in the box **at the moment they
 * arrive**, never onto a snapshot taken when the microphone opened.
 *
 * The distinction did not matter while a transcription was one HTTP request
 * that either answered in a second or died: nobody types in that second. It
 * matters the moment a recording can be HELD — the desktop unreachable, the
 * words read minutes later — because by then the person has very likely gone on
 * writing, and `base + text` with a stale `base` would overwrite every word
 * they typed in between. That is `local/no-draft-clobber`'s failure with a
 * different lever: a draft is the last copy of itself, and dictation is not
 * allowed to be the thing that deletes one.
 *
 * So the caller reads its box HERE, at landing time, and this joins the two.
 * Silence appends nothing at all rather than a trailing space.
 */
export function appendDictation(base: string, text: string): string {
  const said = text.trim();
  if (!said) return base;
  const head = base.replace(/\s*$/, "");
  return head ? `${head} ${said}` : said;
}
