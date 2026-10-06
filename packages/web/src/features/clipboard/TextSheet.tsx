/**
 * The `text` sheet: the terminal's — or the conversation's — text, to copy,
 * quote or follow a link out of.
 */
import { useRef } from "react";
import { Copy, ExternalLink, Quote, RotateCw } from "lucide-react";
import { findUrlsInText } from "@waterplane/shared";
import { useCore, useStore } from "../../sdk";
import { SheetHead } from "../../Sheet";
import { TextDumpLines, type TextDumpHandle } from "../../TextDumpLines";
import { quoteBlock } from "./logic";
import { dump } from "./store";
import { copyLink, openLink, openTextDump } from "./actions";

/** App's header-button size. */
const ICON = 16;

export function TextSheet() {
  const core = useCore();
  const { text: textDump, source } = useStore(dump);
  const textRef = useRef<TextDumpHandle>(null);
  const getSel = (): string => textRef.current?.pick().text ?? textDump;
  const copy = async () => {
    const t = getSel();
    try { await navigator.clipboard.writeText(t); core.say.toast(`copied ${t.length} chars`); }
    catch { core.say.toast("clipboard unavailable (needs https)"); }
  };
  const quote = () => {
    const block = quoteBlock(getSel());
    if (!block) return;
    core.compose.insert(block);
    core.nav.close("text");
  };
  // Every link on the screen, put back together. A terminal GRID has no soft
  // wrap, so a long URL is N separate rows with nothing marking them as one
  // string — which is why hand-selecting one out of the box below never
  // worked, and why this list is not a convenience but the only way to get
  // at them (`@waterplane/shared`'s `findUrls`).
  const links = findUrlsInText(textDump);
  return (
    <div className="sheet">
      <SheetHead title={source === "grid" ? "Terminal text" : "Conversation text"} onClose={() => core.nav.close("text")}>
        <button className="key" onClick={() => void openTextDump()} title="re-pull"><RotateCw size={ICON} /></button>
      </SheetHead>
      <div className="form-hint">Tick lines (or select text), then copy or quote. Nothing ticked or selected ⇒ acts on the entire dump.</div>
      {links.length > 0 && (
        <div className="form">
          <div className="set-note">{links.length} link{links.length > 1 ? "s" : ""} on screen — rejoined across the rows the terminal broke them into.</div>
          <div className="link-list">
            {links.map((l) => (
              <div className="row" key={l.url}>
                <button className="row-title link-row" title={l.url} onClick={() => openLink(l.url)}>
                  <ExternalLink size={ICON} /> <span className="link-url">{l.url}</span>
                </button>
                <button className="key" title="copy link" onClick={() => void copyLink(l.url)}><Copy size={ICON} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
      <TextDumpLines ref={textRef} text={textDump} />
      <div className="sheet-actions">
        <button className="key" onClick={copy}><Copy size={16} /> copy</button>
        <button className="key" onClick={quote}><Quote size={16} /> quote in compose</button>
        <div className="spacer" />
        <button className="send" onClick={() => core.nav.close("text")}>done</button>
      </div>
    </div>
  );
}
