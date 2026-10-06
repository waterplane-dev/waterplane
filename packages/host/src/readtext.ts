import { env } from "./env.js";
import { envName } from "@waterplane/shared";
/**
 * The highlighter's text reader: one Gemini call that reads the words inside a
 * marked band of an image (`readImageText`), and the transport it rides
 * (`postGemini`). Kept in core when the decision oracle moved out to a plugin
 * (docs/notes/plugins.md) — it spends the same `GEMINI_API_KEY`, is metered as
 * kind `ocr`, and `WATERPLANE_OCR=0` turns it off.
 */

const REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_MODEL = "gemini-2.5-flash";

/** Whether a GEMINI_API_KEY is present at all. Read live (a secret set from the phone applies at once). */
function cfg() {
  return { key: process.env.GEMINI_API_KEY || "", configured: !!process.env.GEMINI_API_KEY };
}

/** Reported after each Gemini call so the meter can track tokens + cost. */
export type UsageReporter = (u: { model: string; inTok: number; outTok: number }) => void;

/**
 * The ONE call this host makes to Gemini: POST with a timeout and a small
 * backoff on 429/5xx and transient network errors.
 *
 * Exported so the transport's retry policy, timeout and "what did the provider
 * actually say" error stay single-sourced (it was the decision oracle's, which
 * is now a plugin outside this repo).
 *
 * Answers the parsed body or the reason there isn't one — never throws.
 */
export async function postGemini(url: string, body: unknown): Promise<{ data: any | null; error: string | null }> {
  const delays = [0, 600, 1800];
  let error: string | null = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (r.ok) return { data: await r.json(), error: null };
      if (r.status === 429 || r.status >= 500) { error = `HTTP ${r.status}`; continue; } // transient → retry
      // 4xx (bad key/request) → capture the provider message and don't retry.
      const data: any = await r.json().catch(() => null);
      return { data: null, error: data?.error?.message || `HTTP ${r.status}` };
    } catch (e: any) {
      error = e?.name === "TimeoutError" ? "Request timed out." : "Network error reaching Gemini.";
      // network/timeout → retry
    }
  }
  return { data: null, error: error || "Gemini did not answer." };
}

/**
 * The words inside one highlighted band of an image, read back verbatim.
 *
 * Why this exists: a phone marks a screenshot and the marked copy is re-encoded
 * DOWN to the link's width on the way up (`web/src/uploadScale.ts`). The band a
 * person drew round an error message survives that; the eight-pixel text inside
 * it frequently does not, so the agent receives a picture of a sentence it
 * cannot read and a note saying only where the sentence is. Reading the crop
 * HERE, at the resolution the phone still holds, turns that into the sentence
 * itself — which is both fewer tokens than an image the model must squint at and
 * the one thing that cannot be misread.
 *
 * It DECIDES nothing (the decision oracle that shared its key is now a plugin):
 *  - it DECIDES nothing, so no blocklist, no confidence, no caps, no autofire —
 *    the sentence it returns is shown to the person who asked for it, who can
 *    edit it or drop it before anything is sent anywhere;
 *  - it is asked for by hand, once per mark, so the per-session budgets that
 *    exist to stop an unattended spender do not apply;
 *  - it is off entirely without `GEMINI_API_KEY`, and says so in words rather
 *    than leaving a reader spinning (`WATERPLANE_OCR=0` turns it off with a key set).
 *
 * Degrades to a REASON, never to a guess: an empty answer, a refusal, a dead
 * network and a missing key are four different sentences, and none of them is a
 * partial transcription presented as a full one.
 */
export async function readImageText(
  image: { mime: string; dataB64: string },
  onUsage?: UsageReporter,
): Promise<{ text: string } | { error: string }> {
  if (env("OCR") === "0") return { error: `text reading is off on this host (${envName("OCR")}=0)` };
  const { key, configured } = cfg();
  if (!configured) return { error: "no GEMINI_API_KEY on the host — nothing here can read an image" };
  const model = env("OCR_MODEL") || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: OCR_CONTRACT }] },
    contents: [{
      role: "user",
      parts: [
        { text: "Transcribe the text in this image crop." },
        { inline_data: { mime_type: image.mime, data: image.dataB64 } },
      ],
    }],
    // Zero temperature: this is a reading, not a rewrite. The cap is generous
    // enough for a stack frame and small enough that a model which starts
    // describing the picture instead of reading it cannot run away with it.
    generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 600 },
  };
  const { data, error } = await postGemini(url, body);
  if (!data) return { error: error || "Gemini did not answer." };
  const meta = data?.usageMetadata ?? {};
  const inTok = Number(meta.promptTokenCount) || 0;
  const outTok = Number(meta.candidatesTokenCount ?? meta.totalTokenCount) || 0;
  onUsage?.({ model, inTok, outTok });
  const raw: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ?? "";
  let parsed: { text?: unknown } | null = null;
  try { parsed = JSON.parse(raw); } catch {
    const m = /\{[\s\S]*\}/.exec(raw);
    try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
  }
  const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
  if (!text) return { error: "no readable text in that area" };
  // One band of a screenshot is a line or two. A longer answer means the model
  // started describing rather than reading, and a description quoted as a
  // transcription is the one wrong answer this must never give.
  if (text.length > 600) return { error: "that area held more text than a mark can carry" };
  return { text };
}

/** What the reader is allowed to answer. Transcription only: no summary, no
 *  correction, no description of the picture, and an explicit empty string when
 *  there are no words — "" is a verdict, and inventing one is the failure. */
const OCR_CONTRACT =
  "You transcribe text from a small crop of a screenshot or photo. Return EXACTLY the characters visible in the " +
  "crop, preserving spelling, punctuation, case and symbols, including code and error text. Do not translate, " +
  "correct, summarise, explain or describe the image. Do not add quotes or commentary. Join wrapped lines with a " +
  'single space. If the crop contains no legible text, return an empty string. Respond with ONLY minified JSON: ' +
  '{"text": "<verbatim text or empty string>"}';
