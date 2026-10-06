/**
 * The audio format both ends agree on.
 *
 * Everything here is about one failure mode: a clip that whisper cannot read,
 * discovered by whisper. The host validates the shape before it spawns
 * anything, so these are the cases that validation has to survive — a header
 * the phone wrote, a header with an extra chunk in it, a body the socket cut
 * off mid-upload, and the two lengths (nothing said, too much said) that are
 * refused in words rather than transcribed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DICTATE_AUTO,
  DICTATE_LANGS_DEFAULT,
  DICTATE_MAX_SECONDS,
  DICTATE_RATE,
  appendDictation,
  dictateLangChoices,
  dictateLangFace,
  dictateLangName,
  dictateLangOffered,
  dictateLangTitle,
  dictateRefusal,
  floatToPcm16,
  pcm16ToWav,
  wavFacts,
  whisperLang,
} from "../dist/dictate.js";

/** `seconds` of silence, as the phone would write it. */
function clip(seconds, rate = DICTATE_RATE) {
  return pcm16ToWav(new Int16Array(Math.round(seconds * rate)), rate);
}

test("a clip the phone wrote reads back as itself", () => {
  const facts = wavFacts(clip(2.5));
  assert.deepEqual(facts, { rate: DICTATE_RATE, channels: 1, bits: 16, format: 1, seconds: 2.5 });
});

test("float samples clamp rather than wrap", () => {
  // A wrap turns a loud syllable into the opposite waveform, which whisper
  // hears as a click; clipping is merely quieter.
  const pcm = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
  assert.equal(pcm[1], 32767);
  assert.equal(pcm[2], -32768);
  assert.equal(pcm[3], 32767);
  assert.equal(pcm[4], -32768);
  assert.ok(Math.abs(pcm[5] - 16383) <= 1);
});

test("a chunk between fmt and data does not hide the audio", () => {
  // Nothing this app writes emits a LIST chunk, but a recorder on some other
  // phone does, and assuming `data` at offset 36 would read it as "not audio".
  const base = clip(1);
  const extra = 12;                       // "LIST" + size + 4 bytes of payload
  const out = new Uint8Array(base.length + extra);
  out.set(base.subarray(0, 36), 0);
  out.set(new TextEncoder().encode("LIST"), 36);
  new DataView(out.buffer).setUint32(40, 4, true);
  out.set(base.subarray(36), 36 + extra);
  const facts = wavFacts(out);
  assert.equal(facts.rate, DICTATE_RATE);
  assert.equal(facts.seconds, 1);
});

test("a body the socket cut off is measured by what arrived", () => {
  // The length field still claims the whole recording. Trusting it would make
  // a half-uploaded clip look like a full one and the refusal ladder would
  // read the wrong duration back to the person.
  const full = clip(4);
  const cut = full.subarray(0, 44 + DICTATE_RATE * 2);   // one second of it
  const facts = wavFacts(cut);
  assert.equal(facts.seconds, 1);
});

test("what is not a WAV is refused in words, not transcribed", () => {
  assert.equal(wavFacts(new Uint8Array(10)), null);
  assert.equal(wavFacts(new Uint8Array(100)), null);
  assert.match(dictateRefusal(null), /not 16-bit PCM/);
});

test("the two lengths that are never sent to the transcriber", () => {
  assert.equal(dictateRefusal(wavFacts(clip(0.1))), "nothing was said");
  assert.match(dictateRefusal(wavFacts(clip(DICTATE_MAX_SECONDS + 5))), /the limit is 300s/);
  assert.equal(dictateRefusal(wavFacts(clip(30))), null);
});

/** The same clip with one `fmt ` field overwritten — a valid WAV of a shape
 *  this feature cannot read, which is precisely the case that used to get all
 *  the way to whisper. */
function reshaped(patch) {
  const buf = clip(2);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (patch.format !== undefined) view.setUint16(20, patch.format, true);
  if (patch.channels !== undefined) view.setUint16(22, patch.channels, true);
  if (patch.bits !== undefined) view.setUint16(34, patch.bits, true);
  return buf;
}

test("a valid WAV of a shape the transcriber cannot read is refused BY SHAPE", () => {
  // whisper.cpp reads its audio before it loads the model and exits 0 when it
  // cannot — so a shape that reaches it comes back as the JSON it never wrote,
  // which the phone once showed as `ENOENT … /var/folders/…/out.json`. Every
  // one of these is knowable from 44 bytes of header, so it is said here.
  assert.match(dictateRefusal(wavFacts(reshaped({ format: 3 }))), /format 3/);
  assert.match(dictateRefusal(wavFacts(reshaped({ bits: 32 }))), /32-bit/);
  assert.match(dictateRefusal(wavFacts(reshaped({ channels: 6 }))), /6 channels/);
  // Mono and stereo both pass: the transcriber downmixes, and refusing a
  // stereo clip would be this rule inventing a limit that is not there.
  assert.equal(dictateRefusal(wavFacts(reshaped({ channels: 2 }))), null);
  assert.equal(dictateRefusal(wavFacts(clip(2))), null);
});

test("transcribed words are APPENDED to what the box holds now", () => {
  assert.equal(appendDictation("", "hello there"), "hello there");
  assert.equal(appendDictation("first line", "second"), "first line second");
  // The trailing whitespace of the box is the box's, not a separator to keep.
  assert.equal(appendDictation("first line  \n", "second"), "first line second");
  assert.equal(appendDictation("kept", "   padded   "), "kept padded");
});

test("silence appends nothing at all — never a trailing space", () => {
  assert.equal(appendDictation("kept words", "   "), "kept words");
  assert.equal(appendDictation("kept words", ""), "kept words");
});

test("the base is whatever is passed — which is why the caller reads it LATE", () => {
  // The failure this shape exists to stop: a recording held while the tunnel
  // was down lands minutes later, and `base` captured when the microphone
  // opened would overwrite everything typed since. Nothing here can enforce
  // that, but the signature makes the late read the natural call.
  const typedSince = "first line and a paragraph written while the tunnel was down";
  assert.equal(appendDictation(typedSince, "the spoken bit"), `${typedSince} the spoken bit`);
});

test("a browser locale becomes a language the transcriber knows", () => {
  // The measured failure: the phone sends `navigator.language`, whisper takes
  // ISO-639-1, and `de-DE` is refused — before the model loads, with exit 0 and
  // no transcript. Every dictation from a phone with a regional locale, which
  // is most phones, died with nothing to show for it.
  assert.equal(whisperLang("de-DE"), "de");
  assert.equal(whisperLang("en-US"), "en");
  assert.equal(whisperLang("zh-Hant-TW"), "zh");
  assert.equal(whisperLang("pt_BR"), "pt");
  assert.equal(whisperLang("de"), "de");
});

test("a language this engine does not have degrades to auto, never to a refusal", () => {
  // auto-detect transcribes; an unknown code transcribes nothing. The point of
  // the whole list is that the second outcome is never chosen for somebody.
  assert.equal(whisperLang("qq-ZZ"), "auto");
  assert.equal(whisperLang("klingon"), "auto");
  assert.equal(whisperLang(""), "auto");
  assert.equal(whisperLang(undefined), "auto");
  assert.equal(whisperLang("auto"), "auto");
});

test("the spellings whisper uses, not the ones the browser does", () => {
  // Bokmål is the one worth an alias: Android reports `nb`, whisper has only
  // the macrolanguage — and `auto` on Norwegian speech is a worse answer than
  // the language the person is actually speaking.
  assert.equal(whisperLang("nb-NO"), "no");
  assert.equal(whisperLang("iw"), "he");
  assert.equal(whisperLang("in-ID"), "id");
  assert.equal(whisperLang("fil-PH"), "tl");
});

// ── Which language the microphone is read as ───────────────────────────────
//
// The bug these pin: the phone sent its SYSTEM language, and whisper told a
// language translates every other one into it — so English dictated into a
// German phone came back as German prose. Every code this picker can put on the
// wire therefore has to survive `whisperLang` unchanged, or the pick silently
// degrades to auto-detect and the control is a lie.

test("every offered language is one the transcriber accepts, unchanged", () => {
  for (const { code } of dictateLangChoices("de-DE")) {
    assert.equal(whisperLang(code), code, `${code} is not a tag whisper takes`);
  }
});

test("auto is first, and the two this app is dictated in follow it", () => {
  const codes = dictateLangChoices("de-DE").map((c) => c.code);
  assert.deepEqual(codes.slice(0, 3), [DICTATE_AUTO, "en", "de"]);
});

test("a device language outside the curated list is still offerable", () => {
  // Nobody is asked to change their phone's system language to dictate, and
  // nobody is offered a list that cannot express what they speak.
  const codes = dictateLangChoices("sw-KE").map((c) => c.code);
  assert.ok(codes.includes("sw"));
  // Once only, and where it already exists it is not repeated.
  const de = dictateLangChoices("de-AT").map((c) => c.code).filter((c) => c === "de");
  assert.equal(de.length, 1);
});

test("a device tag the transcriber does not know adds nothing", () => {
  // An unknown code transcribes NOTHING, and `auto` is already at the top —
  // offering the tag would be offering a silent failure.
  const codes = dictateLangChoices("zz-ZZ").map((c) => c.code);
  assert.deepEqual(codes, dictateLangChoices(undefined).map((c) => c.code));
});

test("the face is short and the name is not", () => {
  assert.equal(dictateLangFace(DICTATE_AUTO), "auto");
  assert.equal(dictateLangFace("de"), "DE");
  assert.equal(dictateLangName("de"), "German");
  assert.match(dictateLangName(DICTATE_AUTO), /whichever/);
});

test("a pinned language SAYS that everything else is translated into it", () => {
  // The whole failure in one sentence: this is what the control owes a person
  // who dictates in two languages, and what the old silent behaviour never said.
  assert.match(dictateLangTitle("de"), /TRANSLATED/);
  assert.match(dictateLangTitle(DICTATE_AUTO), /whichever language is spoken/);
});

// ── Which of them the pill lists ───────────────────────────────────────────
//
// The picker opens while a recording is RUNNING, so the list is short by
// default and configured in Settings. These pin the two ways a short list can
// break a control: being empty, and not containing the thing the control is
// currently displaying.

test("nothing picked is the default three, not an empty picker", () => {
  const codes = dictateLangOffered(undefined, DICTATE_AUTO, "de-DE").map((c) => c.code);
  assert.deepEqual(codes, [...DICTATE_LANGS_DEFAULT]);
  assert.deepEqual(dictateLangOffered([], DICTATE_AUTO, "de-DE").map((c) => c.code), [...DICTATE_LANGS_DEFAULT]);
});

test("a pick nothing in the catalogue answers falls back rather than emptying", () => {
  const codes = dictateLangOffered(["zz", "qq"], DICTATE_AUTO, "de-DE").map((c) => c.code);
  assert.deepEqual(codes, [...DICTATE_LANGS_DEFAULT]);
});

test("the language in use is always in the list it is displayed in", () => {
  // A `<select>` whose value matches no option renders as the FIRST one, which
  // would re-aim the transcriber at a language nobody picked.
  const codes = dictateLangOffered(["en"], "fr", "de-DE").map((c) => c.code);
  assert.ok(codes.includes("fr"));
  assert.ok(codes.includes("en"));
});

test("the picked list keeps the catalogue's order, not the order it was written", () => {
  const codes = dictateLangOffered(["fr", "auto", "de"], DICTATE_AUTO, "de-DE").map((c) => c.code);
  assert.deepEqual(codes, [DICTATE_AUTO, "de", "fr"]);
});

test("a picked list is honoured as the whole list", () => {
  // Including dropping `auto`: somebody who dictates in one language should
  // not have to scroll past a detector they never want.
  const codes = dictateLangOffered(["en", "de"], "en", "de-DE").map((c) => c.code);
  assert.deepEqual(codes, ["en", "de"]);
});
