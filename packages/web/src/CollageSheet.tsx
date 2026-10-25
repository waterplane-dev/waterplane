import { useEffect, useRef, useState } from "react";
import {
  Check, ChevronLeft as MoveLeft, ChevronRight as MoveRight, Hash, Images,
  LayoutGrid, Sparkles, SplitSquareHorizontal,
} from "lucide-react";
import {
  autoCols, colChoices, collageFileName, collageLabel, decodeForCollage, planCollage,
  releaseCollage, renderCollage, type CollageGap, type CollageItem,
} from "./collage";
import { collagePanelNote } from "@waterplane/shared";
import { effectiveMaxWidth, widthLabel } from "./uploadScale";
import { fmtSize } from "./format";
import { track } from "./usage";
import { LS, lsGet, lsSet } from "./storage";
import { SheetHead } from "./Sheet";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";

/**
 * More than one image was picked — one picture, or several?
 *
 * This sheet exists because of a limit in the annotator, not in the picker: a
 * mark cannot leave the image it is drawn on. A bug that spans three screens
 * ("this id, then this list, then this error") is one thought, and sending it
 * as three separately-marked screenshots makes the reader reassemble it from
 * prose. Combined, one arrow crosses two panels and the prompt can just say
 * "why is ① showing what ③ says is deleted".
 *
 * It sits BEFORE the annotator, in front of every multi-image pick in the app
 * (compose bar, Start sheet, pad, backlog), because that is the only moment
 * where both answers are still cheap. The default is unchanged behaviour —
 * "keep separate" is one tap and drops straight into the batch that used to
 * open automatically — so the feature costs a tap and never a decision that has
 * to be undone.
 *
 * Three things are decided here, and all three are the user's:
 *
 *  - **The order.** A gallery hands over its own order (usually oldest first,
 *    sometimes not), and a sequence of screens read in the wrong order is worse
 *    than no collage: panel ③ is then the FIRST thing that happened. The strip
 *    reorders, and the panel numbers follow it.
 *  - **The arrangement.** `auto` is right most of the time (see
 *    `shared/src/collage.ts`), but "these two are a before/after, stack them" is
 *    a per-image call no rule can make. It sits in front of the preview rather
 *    than behind a disclosure, because the preview is what makes the answer
 *    obvious in one look.
 *  - **Whether to combine at all**, which is the one tap that costs nothing.
 */

const GAP_KEY = LS.collageGap;
const LABEL_KEY = LS.collageLabels;
/** Preview canvas cap. Small on purpose: this re-renders on every tap of the
 *  picker, and a full-size draw per tap is what makes a phone drop frames. */
const PREVIEW_SIDE = 1200;

const loadGap = (): CollageGap => {
  const v = lsGet(GAP_KEY);
  return v === "none" || v === "wide" ? v : "thin";
};
const loadLabels = (): boolean => lsGet(LABEL_KEY) !== "0";

interface Props {
  files: File[];
  /** Combine chosen: one flattened image, which the caller routes exactly as it
   *  would have routed a single picked file (annotator, then the usual upload). */
  /** The combined file, plus what its arrangement IS in words — the panel
   *  numbers exist only as pixels, and the note beside the path is the one place
   *  the order they run in can be stated (`shared/collagePanelNote`). */
  onCombine: (file: File, facts: string) => void;
  /** Keep them apart: the caller resumes whatever it did before this sheet, with
   *  the order set here — reordering and then declining must not silently go
   *  back to the picker's order. */
  onSeparate: (files: File[]) => void;
  onClose: () => void;
}

export function CollageSheet({ files, onCombine, onSeparate, onClose }: Props) {
  const [items, setItems] = useState<CollageItem[] | null>(null);
  const [failed, setFailed] = useState<File[]>([]);
  // null = auto. Not persisted, unlike gap/labels: the right arrangement is a
  // property of THESE pictures, and carrying "3 across" onto a two-image pick
  // would silently override the rule that gets it right.
  const [cols, setCols] = useState<number | null>(null);
  const [gap, setGap] = useState<CollageGap>(loadGap);
  const [labels, setLabels] = useState<boolean>(loadLabels);
  const [preview, setPreview] = useState<{ url: string; bytes: number } | null>(null);
  const [rendering, setRendering] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reduced, setReduced] = useState(false);
  const urlRef = useRef<string | null>(null);
  // Thumbnails for the order strip, keyed by the item itself so a reorder never
  // has to re-create (or worse, mis-match) them.
  const thumbs = useRef(new Map<CollageItem, string>());

  // The width each PANEL will actually be uploaded at (`uploadWidthFor`: the
  // cap is per panel, so four across is not four quarter-width screens).
  // Drawing wider than that is memory spent on pixels `scaleForUpload` throws
  // away on the way out — and on a phone that is where the encode fails.
  const upload = effectiveMaxWidth();

  // Decode once, up front. Every later render draws these bitmaps again; a
  // decode per picker tap would be seconds of frozen UI on the device this is for.
  useEffect(() => {
    let live = true;
    let got: CollageItem[] = [];
    decodeForCollage(files).then(({ items: decoded, failed: bad }) => {
      got = decoded;
      if (!live) { releaseCollage(decoded); return; }
      setItems(decoded);
      setFailed(files.filter((f) => bad.includes(f.name)));
      if (decoded.length < 2) {
        setErr(decoded.length
          ? "Only one of these could be read as an image on this device."
          : "None of these could be read as an image on this device.");
      }
    });
    return () => {
      live = false;
      releaseCollage(got);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup deliberately reads the LATEST `thumbs.current` map (a ref held for the sheet's lifetime)
      for (const u of thumbs.current.values()) URL.revokeObjectURL(u);
      thumbs.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `files` is fixed for the sheet's life: `offerCollage` sets it only while no collage sheet is up, and every exit sets the store to null, which unmounts this
  }, []);

  // Re-render the preview whenever order or arrangement changes. Generation-
  // guarded: three fast taps must not leave the second render's image on screen.
  useEffect(() => {
    if (!items || items.length < 2) { setRendering(false); return; }
    let live = true;
    setRendering(true);
    renderCollage(items, { cols: cols ?? undefined, gap, labels, maxSide: PREVIEW_SIDE }).then((res) => {
      if (!live) return;
      setRendering(false);
      if (!res) { setErr("This device couldn't draw the combined image."); return; }
      setErr(null);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(res.blob);
      setPreview({ url: urlRef.current, bytes: res.blob.size });
    });
    return () => { live = false; };
  }, [items, cols, gap, labels]);

  const count = items?.length ?? files.length;
  const auto = items && items.length > 1 ? autoCols(items, gap) : 1;
  const chosen = cols ?? auto;
  const plan = items && items.length > 1
    ? planCollage(items, { cols: chosen, gap, ...(upload.width ? { maxWidth: upload.width * chosen } : {}) })
    : null;

  function thumbUrl(it: CollageItem): string {
    let u = thumbs.current.get(it);
    if (!u) { u = URL.createObjectURL(it.file); thumbs.current.set(it, u); }
    return u;
  }
  /** Move one panel earlier or later. Arrows rather than a drag: a long-press
   *  drag inside a sheet that also pans is the gesture phones get wrong, and
   *  three taps that always work beat one that sometimes scrolls the page. */
  function move(i: number, dir: -1 | 1) {
    setItems((cur) => {
      if (!cur) return cur;
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = cur.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    track("action:collage.reorder");
  }
  function pickCols(next: number | null) {
    track("action:collage.layout");
    setCols(next);
  }
  function pickGap(next: CollageGap) {
    setGap(next);
    lsSet(GAP_KEY, next);
  }
  function toggleLabels() {
    const next = !labels;
    setLabels(next);
    lsSet(LABEL_KEY, next ? "1" : "0");
  }

  /** Render at full size and hand the single file back. The preview is a
   *  smaller draw of the same layout, so what is sent is what was seen. */
  async function combine() {
    if (!items || items.length < 2) return;
    track("action:collage.combine");
    setBusy(true);
    setErr(null);
    const res = await renderCollage(items, {
      // `chosen`, not `cols ?? undefined`: the width cap below is per column,
      // so the column count must be the one it was computed for.
      cols: chosen, gap, labels,
      ...(upload.width ? { maxWidth: upload.width * chosen } : {}),
    });
    if (!res) {
      setBusy(false);
      setErr("This device couldn't draw the combined image at any size — send them separately instead.");
      return;
    }
    setReduced(res.reduced);
    onCombine(
      new File([res.blob], collageFileName(items.length, res.layout.cols), { type: "image/jpeg" }),
      collagePanelNote(items.length, res.layout.cols, labels),
    );
  }

  /** Declining still keeps the order that was set here. */
  const separate = () => {
    track("action:collage.separate");
    onSeparate(items ? [...items.map((i) => i.file), ...failed] : files);
  };

  return (
    <div className="sheet">
      <SheetHead title={<>{count} images</>} onClose={onClose}>
        <span className="upscale-note">{plan ? `${plan.width} × ${plan.height}` : ""}</span>
      </SheetHead>
      <Hint>
        Put them on one canvas so a circle or an arrow can span them — that is the only way to
        point at something that crosses screens. Or keep them apart and mark each in turn.
      </Hint>

      {items && items.length > 1 && (
        <>
          {/* Order first: it is the one choice the picker got to make for you,
              and the panel numbers below follow it. */}
          <div className="collage-strip">
            {items.map((it, i) => (
              <div key={`${it.name}-${i}`} className="collage-chip">
                <img src={thumbUrl(it)} alt={it.name} />
                <span className="collage-chip-n">{i + 1}</span>
                <div className="collage-chip-acts">
                  <Button disabled={i === 0} title="earlier" onClick={() => move(i, -1)}>
                    <MoveLeft size={14} />
                  </Button>
                  <Button disabled={i === items.length - 1} title="later" onClick={() => move(i, 1)}>
                    <MoveRight size={14} />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="upscale">
            <span className="upscale-head"><LayoutGrid size={12} /> arrangement</span>
            <Button className={cols === null ? "active" : ""}
              title="chosen from the shapes of these images"
              onClick={() => pickCols(null)}>
              <Sparkles size={13} /> auto
            </Button>
            {colChoices(items.length).map((c) => (
              <Button key={c} className={cols === c ? "active" : ""} onClick={() => pickCols(c)}>
                {collageLabel(items.length, c)}
              </Button>
            ))}
            <span className="upscale-note">{cols === null ? `auto → ${collageLabel(items.length, auto)}` : ""}</span>
          </div>
          <div className="upscale">
            <span className="upscale-head"><SplitSquareHorizontal size={12} /> seam</span>
            {(["none", "thin", "wide"] as CollageGap[]).map((g) => (
              <Button key={g} className={gap === g ? "active" : ""} onClick={() => pickGap(g)}>{g}</Button>
            ))}
            <Button className={labels ? "active" : ""}
              title="number each panel, so the prompt can say which screen it means"
              onClick={toggleLabels}><Hash size={13} /> numbers</Button>
          </div>
        </>
      )}

      <div className="collage-prev">
        {preview
          ? <img src={preview.url} alt="combined preview" className={rendering ? "dim" : ""} />
          : <span className="upscale-note">{err ? "" : "preparing…"}</span>}
      </div>

      {(err || failed.length > 0) && (
        <Hint tone="warn">
          {err}
          {failed.length > 0 && ` ${failed.length} file${failed.length === 1 ? "" : "s"} couldn't be decoded on this device and ${failed.length === 1 ? "is" : "are"} not in the picture: ${failed.map((f) => f.name).join(", ")}.`}
        </Hint>
      )}
      {preview && !err && (
        <Hint>
          One image, {collageLabel(count, chosen)}{labels ? ", panels numbered" : ""} · goes to the
          annotator next, and uploads at {widthLabel(upload.width)}{upload.width ? " per panel" : ""}{upload.auto ? " (auto)" : ""}.
          {reduced ? " This device couldn't draw it at full size, so it was drawn smaller." : ""}
          {` Preview is ${fmtSize(preview.bytes)}.`}
        </Hint>
      )}

      <div className="sheet-actions">
        <Button disabled={busy}
          title="mark each image on its own, one after another"
          onClick={separate}>
          <Images size={16} /> keep separate
        </Button>
        <button className="send" disabled={busy || !items || items.length < 2}
          onClick={() => void combine()}>
          <Check size={16} /> {busy ? "combining…" : "combine & mark"}
        </button>
      </div>
    </div>
  );
}
