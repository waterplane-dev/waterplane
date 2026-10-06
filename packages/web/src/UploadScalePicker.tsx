import { useState } from "react";
import { Gauge } from "lucide-react";
import {
  UPLOAD_WIDTHS, autoMaxWidth, getUploadScale, linkInfo, setUploadScale, widthLabel,
  type UploadScale,
} from "./uploadScale";
import { track } from "./usage";

/**
 * How big an image goes UP. Rendered in the annotator (right above the send
 * buttons — the last moment before the bytes are committed) and in Settings →
 * Data usage, sharing one sticky per-device preference.
 *
 * `auto` is the default and reads the link: a measured upload rate when we have
 * one (the only number that reflects the actual Tailscale path, DERP relay and
 * all), otherwise `navigator.connection`. The explicit widths exist because
 * auto can't know the content — a 4K UI screenshot with 10px text stays
 * readable only at full size, while a photo of a whiteboard never needs it.
 */
export function UploadScalePicker({ onChange, compact }: { onChange?: (v: UploadScale) => void; compact?: boolean }) {
  const [value, setValue] = useState<UploadScale>(() => getUploadScale());
  // Compact (the annotator): one line saying what WILL go up, the six widths
  // one tap away — two rows of keys under a picture is room the picture needs.
  const [open, setOpen] = useState(false);
  const link = linkInfo();
  const auto = autoMaxWidth();

  const pick = (v: UploadScale) => {
    setUploadScale(v);
    setValue(v);
    track("action:upload.scale");
    onChange?.(v);
    setOpen(false);
  };

  const opts: { v: UploadScale; label: string }[] = [
    { v: "auto", label: "auto" },
    { v: "full", label: "full" },
    ...UPLOAD_WIDTHS.slice().reverse().map((w) => ({ v: w as UploadScale, label: `${w}px` })),
  ];

  const note = value === "auto" ? `auto → ${widthLabel(auto)} · ${link.label}` : `${link.label}`;
  if (compact && !open) {
    return (
      <button className="upscale-line" onClick={() => setOpen(true)} aria-expanded={false}
        title="images are re-encoded to this width before they are uploaded">
        <Gauge size={12} /> upload {value === "auto" ? `auto → ${widthLabel(auto)}` : widthLabel(value === "full" ? 0 : value)} · {link.label} · <span className="upscale-change">change</span>
      </button>
    );
  }

  return (
    <div className="upscale">
      <span className="upscale-head" title="images are re-encoded to this width before they are uploaded">
        <Gauge size={12} /> upload size
      </span>
      {opts.map((o) => (
        <button key={String(o.v)} className={`key ${value === o.v ? "active" : ""}`} onClick={() => pick(o.v)}>{o.label}</button>
      ))}
      <span className="upscale-note">{note}</span>
    </div>
  );
}
