/**
 * The annotator's types and tables: a mark, what the sheet is handed, the colour and read constants.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 */

import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import type { Mark } from "../annNote";
import type { Knob } from "../annKnobs";

export type Tool = "circle" | "rect" | "arrow" | "line" | "text" | "blur" | "marker";

export interface Shape extends Mark {
  tool: Tool;
  factor: number; // stroke/text scale multiplier
  /** Stable from the moment the mark is placed. The array index is NOT: undo,
   *  delete and clear all renumber it, and words typed onto a band land after
   *  it — landing them by index puts one mark's sentence on another. */
  id: number;
  /** Why a band carries no words (dropped, or typed empty) — SAID, never silently absent. */
  readErr?: string;
}

/** Source can be a freshly-picked File or an existing image fetched by URL. */
export type AnnSource = File | { url: string; name: string };

/** What happens to the compose draft once the upload lands: nothing (`none` —
 *  refs just drop into the box), submit it into the live session (`run`), or
 *  queue it as an auto-fire backlog item for that session (`queue`). */
export type AnnSend = "none" | "run" | "queue";

/**
 * One flattened image on its way to the queue.
 *
 * `note` is a PROMISE as readily as a string, for the same reason `blob` is: the
 * sheet hands everything over on the tap and closes, and a band whose words are
 * still being read on the host would otherwise have to either block the tap or
 * lose the quote. `size` is the flattened canvas — the upload re-encodes it and
 * knows better, so this is the fallback, not the answer.
 */
export interface AnnDispatch {
  blob: Blob | Promise<Blob>;
  name: string;
  note?: string | Promise<string | undefined>;
  size?: { w: number; h: number };
}

export interface AnnotatorProps {
  source: AnnSource;
  repoId: string;
  /** 1-based position in a batch (multi-select). Omit/1 for a single image. */
  index?: number;
  /** Total images in the batch. */
  total?: number;
  /** What the image IS, in the words the agent will read — today the collage
   *  arrangement, which the combined picture states only in pixels. Rides in
   *  the same `(marked: …)` clause as the marks. */
  facts?: string;
  /** note: short human-readable summary of the marks added (undefined if none). */
  onUploaded: (relPath: string, note?: string) => void;
  /** Session flow: hand the flattened image to the parent, which uploads it in the
   *  BACKGROUND and advances immediately — so the next image can be annotated while
   *  this one uploads. `mode` decides what the batch does once every upload lands
   *  (send it, queue it, or neither). When provided, the send buttons use this
   *  instead of awaiting. */
  onDispatch?: (cur: AnnDispatch, mode: AnnSend) => void;
  /**
   * No tunnel (or the POST died mid-flight): park the bytes in the send queue
   * instead of losing them, and answer with the repo-relative path the file WILL
   * have, so the caller can reference it right now. Null ⇒ couldn't be parked.
   * Only used by the flows that upload inline here (backlog, gallery); the
   * session flow hands everything to `onDispatch`, which parks on its own.
   */
  onPark?: (blob: Blob, name: string) => Promise<string | null>;
  /** Skip this image without uploading (batch only). */
  onSkip?: () => void;
  /** Batch only: send the current (flattened) image plus every remaining one
   *  raw/as-is, no more annotating. `mode` applies once all uploads finish. */
  onSendAll?: (cur: AnnDispatch, mode: AnnSend) => void;
  /** "Text only": the words the desktop read off this picture, as edited, sent
   *  INSTEAD of the picture (annOcr.ts). Absent ⇒ the verb is not offered. */
  onText?: (text: string) => void;
  prompt?: { value: string; onChange: (next: string) => void }; // the session's own draft, when it is not on screen (AnnPrompt)
  onClose: () => void;
}

export const COLORS = ["#ff2d2d", "#ffd400", "#3fb950", "#4c9aff", "#ffffff"];
/** The highlighter multiplies its ink INTO the picture, so white is a no-op and
 *  the tool would look broken. Yellow is what a highlighter is. */
export const MARKER_DEFAULT = "#ffd400";

export const THICKS: { label: string; factor: number }[] = [
  { label: "S", factor: 0.6 },
  { label: "M", factor: 1 },
  { label: "L", factor: 1.8 },
];

export function sourceName(s: AnnSource): string {
  return s instanceof File ? s.name : s.name;
}

/** A live drag of an existing shape, held OUT of state (see `useAnnotator`). */
export interface MoveDrag { i: number; base: Shape; live: Shape; gx: number; gy: number; handle: 0 | 1 | null; sx: number; sy: number; fromEmpty: boolean; knob?: Knob; idle?: boolean }

export interface AnnView { k: number; tx: number; ty: number }
export interface AnnRect { x: number; y: number; w: number; h: number }
type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = MutableRefObject<T>;

/**
 * Everything the handler factories (`annEdit`, `annPointer`, `annRead`, `annSend`) close over —
 * the hook's refs, its render-time state and setters, and `redraw`. A factory destructures what it
 * uses at its top and its function bodies are the ones that were closures in the component, so what a
 * callback reads (a ref's current value vs the value of the render that made it) is unchanged.
 */
export interface AnnCtx {
  source: AnnSource; repoId: string; facts: string | undefined;
  onUploaded: AnnotatorProps["onUploaded"]; onDispatch: AnnotatorProps["onDispatch"];
  onPark: AnnotatorProps["onPark"]; onSendAll: AnnotatorProps["onSendAll"];
  canvasRef: RefObject<HTMLCanvasElement>; wrapRef: RefObject<HTMLDivElement>;
  imgRef: Ref<ImageBitmap | HTMLImageElement | HTMLCanvasElement | null>;
  tool: Tool; setTool: Setter<Tool>;
  color: string; setColor: Setter<string>;
  factor: number;
  shapes: Shape[]; setShapes: Setter<Shape[]>; shapesRef: Ref<Shape[]>;
  dragRef: Ref<Shape | null>;
  moveMode: boolean; setMoveMode: Setter<boolean>;
  selected: number | null; setSelected: Setter<number | null>; selectedRef: Ref<number | null>;
  target: 0 | 1 | null; setTarget: Setter<0 | 1 | null>; targetRef: Ref<0 | 1 | null>;
  setMoveNote: Setter<string | null>;
  setKnobs: Setter<boolean>; knobsRef: Ref<boolean>;
  moveRef: Ref<MoveDrag | null>;
  busy: boolean; setBusy: Setter<boolean>; setErr: Setter<string | null>;
  cropMode: boolean; setCropMode: Setter<boolean>;
  pendingCrop: AnnRect | null; setPendingCrop: Setter<AnnRect | null>;
  cropDrag: Ref<{ x0: number; y0: number; x1: number; y1: number } | null>;
  pendingText: { x: number; y: number } | null; setPendingText: Setter<{ x: number; y: number } | null>;
  textDraft: string; setTextDraft: Setter<string>; textInputRef: RefObject<HTMLInputElement>;
  idRef: Ref<number>; readTextRef: Ref<Map<number, string>>; genRef: Ref<number>;
  editRead: number | null; setEditRead: Setter<number | null>;
  readDraft: string; setReadDraft: Setter<string>; readInputRef: RefObject<HTMLInputElement>;
  setPaletteOpen: Setter<boolean>;
  setView: Setter<AnnView>; viewRef: Ref<AnnView>; fitRef: Ref<AnnView>;
  pointers: Ref<Map<number, { x: number; y: number }>>;
  gesture: Ref<null | { startDist: number; startK: number; cx: number; cy: number }>;
  redraw: (plain?: boolean) => void;
  clampToImage: (r: AnnRect) => AnnRect;
}
