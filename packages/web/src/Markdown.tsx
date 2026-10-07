import { useState } from "react";
import { Copy, FileText } from "lucide-react";
import { FILE_REF_SRC, bareFileRef, docImageRef, parseFileRef, wholeFileRef, type FileRef } from "./fileRefs";
import { pickThumbWidth, viewerWidth } from "./media";
import { useFileMtime } from "./fileMtime";
import { cacheThumb } from "./thumbCache";
import { useThumbSrc } from "./thumbSrc";

/**
 * Markdown-lite renderer, shared by the reader view (TranscriptView) and the
 * gallery's document preview. Deliberately not a full parser and deliberately
 * dependency-free: everything it emits is React nodes, never
 * dangerouslySetInnerHTML, so an agent-written .md file can never inject HTML.
 *
 * `q` is the active find query — every text run routes through `hl()` so a hit
 * is highlighted wherever it lands. Pass "" when there is no find.
 */

/** Wrap every case-insensitive occurrence of `q` in <mark> (the find highlight). */
export function hl(text: string, q: string): (string | JSX.Element)[] | string {
  if (!q) return text;
  const lc = text.toLowerCase(), needle = q.toLowerCase();
  if (!lc.includes(needle)) return text;
  const out: (string | JSX.Element)[] = [];
  let from = 0, at = lc.indexOf(needle), n = 0;
  while (at !== -1) {
    if (at > from) out.push(text.slice(from, at));
    out.push(<mark key={n++} className="tr-hit">{text.slice(at, at + q.length)}</mark>);
    from = at + q.length;
    at = lc.indexOf(needle, from);
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/**
 * How the renderer turns a transport-dir path (see `fileRefs.ts`) into
 * something tappable. Supplied by whoever knows which repo the text belongs to
 * (the reader view, the gallery's document preview); omitted = paths stay plain
 * text, which is what every other caller gets.
 */
export interface FileRefCtx {
  /** Which repo these paths belong to — what makes an mtime lookup possible
   *  (fileMtime.ts), and with it a thumbnail this device may keep. */
  repoId: string;
  /** URL for the file, or a thumbnail of it at `width`. `mtime` versions that
   *  thumbnail URL; without one the response is cacheable by nobody. null = not
   *  resolvable. */
  url(relPath: string, width?: number, mtime?: number): string | null;
  /** Tap handler — open it in the viewer / a tab. */
  open(relPath: string): void;
  /** What is actually in this repo's transport dirs (repo-relative paths).
   *  Supplied, a code span holding a BARE media filename that exists there
   *  resolves to that file — see `bareFileRef`. Omitted, only written-out
   *  paths are recognised, which is what every caller got before. */
  known?: readonly string[];
  /** Repo-relative path of the document being read. Supplied, an image link
   *  (`![alt](docs/hero.svg)`) resolves against its folder and draws as the
   *  picture at reading width (`docImageRef`); omitted, only transport paths
   *  turn into pictures, which is right for a transcript. */
  docPath?: string;
}

/** CSS width of an inline thumbnail. Small enough to sit in a paragraph,
 *  big enough that you can tell WHICH screenshot it is without opening it. */
const THUMB_CSS = 132;

/**
 * A mentioned inbox/outbox file, rendered as the file itself: a thumbnail for
 * an image, a chip for anything else, both tapping through to the viewer.
 * Falls back to the chip when the thumbnail can't load (file deleted, or the
 * path belongs to a different repo than the one being read).
 *
 * The picture comes from THIS DEVICE when it has it (`useThumbSrc`), which is
 * what makes a transcript readable with the tunnel down — and the URL is
 * mtime-versioned (`useFileMtime`) because that is the only form any cache here
 * is allowed to keep. A thumbnail drawn LIVE is then remembered, so the same
 * screenshot is one request ever, not one per reader session.
 */
// `opens`: what a tap opens when it is not the picture itself — a linked image's target.
function FileRefNode({ fref: r, ctx, q, wide, opens }: { fref: FileRef; ctx: FileRefCtx; q: string; wide?: boolean; opens?: string }) {
  const [broken, setBroken] = useState(false);
  const mtime = useFileMtime(ctx.repoId, r.relPath);
  // `wide` is a document's own image link: drawn at reading width, not as a
  // thumbnail. A GIF is asked for whole — the host's thumbnail of one is a
  // still JPEG, and a GIF in a README is there to move.
  const width = !wide ? pickThumbWidth(THUMB_CSS) : /\.gif$/i.test(r.relPath) ? undefined : viewerWidth();
  const url = r.image && !broken ? ctx.url(r.relPath, width, mtime) : null;
  const { src, live } = useThumbSrc(url);
  // A thumbnail this device is still looking up draws as the chip rather than
  // as a gap: the label is the point, the picture is the bonus.
  if (url) {
    return (
      <button type="button" className={`fileref fileref-img${wide ? " fileref-wide" : ""}`} title={`${opens ?? r.relPath} — tap to open`} onClick={() => ctx.open(opens ?? r.relPath)}>
        {src && <img
          src={src}
          alt={r.name}
          loading="lazy"
          // It drew, so the bytes are in the browser's own HTTP cache and (with
          // `v`) the host marked them immutable — remembering them is a local
          // read, not a second trip over Tailscale (thumbCache.ts).
          onLoad={() => { if (live && mtime && width) cacheThumb(url); }}
          onError={() => setBroken(true)}
        />}
        <span className="fileref-name">{hl(r.raw, q)}</span>
      </button>
    );
  }
  return (
    <button type="button" className="fileref" title={`${r.relPath} — tap to open`} onClick={() => ctx.open(r.relPath)}>
      <FileText size={12} />{hl(r.raw, q)}
    </button>
  );
}

// Inline markdown: `code`, **bold**, *italic*, [label](url), bare URLs (tappable), and
// inbox/outbox file paths. The file-ref branch is LAST so a URL that happens to
// contain `.claude/outbox/` still renders as the link it is (alternation picks
// the leftmost match, and a URL starts earlier than the path inside it).
const INLINE_RE = new RegExp(
  "`([^`\\n]+)`" +
  // Emphasis and link labels may cross a soft line break: a paragraph holds
  // no blank line, and a hard-wrapped README splits them anywhere.
  "|\\*\\*([^*]+)\\*\\*" +
  "|\\*([^*\\s](?:[^*]*[^*\\s])?)\\*" +
  "|\\[([^\\]]+)\\]\\(([^)\\s]+)\\)" +
  "|(https?://[^\\s<>()\"']+)" +
  `|(${FILE_REF_SRC})`,
  "g",
);

/**
 * A markdown href, rendered only where following it can lead somewhere.
 *
 * `target="_blank"` is not a new window in the Android shell — the WebView has
 * multiple windows off, so it is a SAME-FRAME navigation. A relative href then
 * resolves against Capacitor's own local server, which allows it (same host)
 * and has nothing there: the whole app is replaced by a blank 404, silently, on
 * one tap in a transcript. The bundle is loaded out of the APK precisely so a
 * dead tunnel cannot do that, and a link was doing it anyway.
 *
 * So an anchor is emitted only for an ABSOLUTE http(s) or mailto: URL — the
 * ones that genuinely belong in a browser. A relative target is a path inside
 * the repo, and this reader has one right way to show one of those: as a file
 * reference (`.claude/…` paths already take that branch above). Anything else
 * stays as the label plus the path in a code span — visible, copyable, and
 * incapable of navigating anywhere.
 */
function linkNode(href: string, label: string, q: string, key: string): JSX.Element {
  if (/^(?:https?:|mailto:)/i.test(href)) {
    return <a key={key} href={href} target="_blank" rel="noreferrer">{hl(label, q)}</a>;
  }
  return <span key={key}>{hl(label, q)}{" "}<code>{href}</code></span>;
}

function inline(text: string, q: string, key: string, files?: FileRefCtx): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = [];
  let last = 0, n = 0;
  // Own copy: emphasis recurses into this function, and a shared global
  // regex's lastIndex would be reset under the outer loop.
  const re = new RegExp(INLINE_RE);
  // A parsed ref drops trailing sentence punctuation ("…/a.png." → "…/a.png"),
  // so the caller gets back what still has to be emitted as plain text.
  const fileNode = (raw: string, k: string): { node: JSX.Element; rest: string } | null => {
    if (!files) return null;
    const r = parseFileRef(raw);
    if (!r) return null;
    return { node: <FileRefNode key={k} fref={r} ctx={files} q={q} />, rest: raw.slice(r.raw.length) };
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const bang = m[4] !== undefined && text[m.index - 1] === "!" && m.index > last;
    if (m.index > last) {
      // `![alt](path)` — the bang belongs to the image syntax, not the prose.
      let pre = text.slice(last, m.index);
      if (bang) pre = pre.slice(0, -1);
      if (pre) out.push(<span key={`${key}t${n++}`}>{hl(pre, q)}</span>);
    }
    if (m[1] !== undefined) {
      // A code span that is ONLY a transport path is a file mention too — agents
      // write them in backticks about as often as bare.
      // …and a code span holding a bare media filename IS one too, when the
      // repo's listing says that file exists (bareFileRef) — the "dir named
      // once, then the files" list agents write constantly.
      const bare = wholeFileRef(m[1]) ? null : bareFileRef(m[1], files?.known);
      const asFile = wholeFileRef(m[1]) ? fileNode(m[1].trim(), `${key}f${n++}`)
        : bare && files ? { node: <FileRefNode key={`${key}f${n++}`} fref={bare} ctx={files} q={q} />, rest: "" }
        : null;
      out.push(asFile ? asFile.node : <code key={`${key}c${n++}`}>{hl(m[1], q)}</code>);
    }
    // Emphasis holds inline forms of its own: **[a link](…)**, **`code` in bold**.
    else if (m[2] !== undefined) out.push(<b key={`${key}b${n++}`}>{inline(m[2], q, `${key}b${n}`, files)}</b>);
    else if (m[3] !== undefined) out.push(<i key={`${key}i${n++}`}>{inline(m[3], q, `${key}i${n}`, files)}</i>);
    else if (m[4] !== undefined) {
      // ![alt](.claude/outbox/x.png) / [label](…) pointing at a transport file.
      const asFile = wholeFileRef(m[5]) ? fileNode(m[5], `${key}f${n++}`) : null;
      // An IMAGE link in a document (a README's hero) is the picture itself,
      // resolved against that document's folder; the alt text is its label.
      const img = !asFile && bang && files?.docPath != null ? docImageRef(m[5], files.docPath) : null;
      out.push(asFile ? asFile.node
        : img && files ? <FileRefNode key={`${key}f${n++}`} fref={{ ...img, raw: m[4] }} ctx={files} q={q} wide />
        : linkNode(m[5], m[4], q, `${key}a${n++}`));
    }
    else if (m[6] !== undefined) out.push(<a key={`${key}u${n++}`} href={m[6]} target="_blank" rel="noreferrer">{hl(m[6], q)}</a>);
    else {
      const asFile = fileNode(m[7], `${key}f${n++}`);
      if (asFile) {
        out.push(asFile.node);
        if (asFile.rest) out.push(<span key={`${key}t${n++}`}>{hl(asFile.rest, q)}</span>);
      } else out.push(<span key={`${key}t${n++}`}>{hl(m[7], q)}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<span key={`${key}t${n++}`}>{hl(text.slice(last), q)}</span>);
  return out;
}

// `[![alt](a.gif)](a.mp4)` in a document: a README's looping gif whose tap
// opens the whole film. Drawn as the picture; the tap opens the link's target
// when it is a picture or a video of this repo (the viewer plays it with
// controls), the picture itself otherwise. Split out before `inline` because
// its link pattern would take the outer brackets for a label.
const LINKED_IMG_RE = /\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)/g;
function inlineDoc(text: string, q: string, key: string, files?: FileRefCtx): (string | JSX.Element)[] {
  if (files?.docPath == null || !text.includes("[![")) return inline(text, q, key, files);
  const out: (string | JSX.Element)[] = [];
  let last = 0, n = 0;
  for (const m of text.matchAll(LINKED_IMG_RE)) {
    const img = docImageRef(m[2], files.docPath);
    if (!img?.image) continue;
    if (m.index! > last) out.push(...inline(text.slice(last, m.index), q, `${key}l${n}`, files));
    const target = docImageRef(m[3], files.docPath);
    out.push(<FileRefNode key={`${key}v${n++}`} fref={{ ...img, raw: m[1] }} ctx={files} q={q} wide opens={target?.relPath} />);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(...inline(text.slice(last), q, `${key}l${n}`, files));
  return out;
}

type Align = "left" | "center" | "right";

// GFM pipe-table row → cells. Splits on unescaped `|`, drops the optional
// leading/trailing pipe. No lookbehind (older mobile Safari), so scan by hand.
function rowCells(line: string): string[] {
  const s = line.trim();
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "|") { cells.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length && !cells[0].trim() && s.startsWith("|")) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim() && s.endsWith("|")) cells.pop();
  return cells.map((c) => c.trim());
}

// `|---|:--:|---:|` — the row that turns the line above it into a header.
function delimAligns(line: string): Align[] | null {
  if (!line.includes("|") || !line.includes("-")) return null;
  const cells = rowCells(line);
  if (!cells.length) return null;
  const aligns: Align[] = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    aligns.push(c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left");
  }
  return aligns;
}

/**
 * A fenced block that is itself markdown (```md / ```markdown) — a spec, a
 * README chunk, a doc the agent is drafting. Showing that as raw monospace
 * source is the thing this whole view exists to avoid, so it renders formatted
 * with a toggle back to the source. Nesting is bounded: a fence inside a fence
 * would have closed the outer one, so the recursion can't run away.
 */
function MdSnippet({ src, q, onCopy, files }: { src: string; q: string; onCopy: (text: string) => void; files?: FileRefCtx }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="tr-code tr-mdsnip">
      <div className="tr-code-head">
        <span>markdown</span>
        <span className="tr-code-acts">
          <button className="key" onClick={() => setRaw((v) => !v)}>{raw ? "rendered" : "source"}</button>
          <button className="key" title="copy" onClick={() => onCopy(src)}><Copy size={12} /></button>
        </span>
      </div>
      {raw
        ? <pre>{hl(src, q)}</pre>
        : <div className="tr-mdsnip-body"><Markdown src={src} q={q} onCopy={onCopy} files={files} /></div>}
    </div>
  );
}

/** What a block tagged with its source lines also carries (`lineTag`). */
export interface LineTag {
  className?: string;
  /** Drawn as a corner badge by the review mode's CSS (`data-n`). */
  badge?: string;
}

/**
 * Markdown-lite → DOM. Deliberately not a full parser: headings, lists,
 * blockquotes, fenced code and the inline forms above cover what Claude
 * actually writes, with no dependency and no HTML injection path (everything
 * is React nodes, never dangerouslySetInnerHTML).
 */
export function Markdown({ src, q, onCopy, files, lineTag }: {
  src: string; q: string; onCopy: (text: string) => void; files?: FileRefCtx;
  /**
   * Tag every top-level block with the SOURCE lines it was drawn from
   * (`data-l0`/`data-l1`, 1-based, inclusive) plus whatever this returns — the
   * file viewer's review mode (`FileReview.tsx`) marks a rendered README by
   * the lines a remark will name. Absent everywhere else, and then nothing
   * here changes.
   */
  lineTag?: (l0: number, l1: number) => LineTag;
}) {
  const nodes: JSX.Element[] = [];
  const parts = src.split(/```/);
  /** 0-based line the current part starts on. The fences hold no newline, so
   *  counting the part's own is the whole bookkeeping. */
  let base = 0;
  const tag = (l0: number, l1: number, cls: string) => {
    if (!lineTag) return { className: cls };
    const t = lineTag(l0 + 1, l1 + 1);
    return { className: [cls, t.className].filter(Boolean).join(" ") || undefined, "data-l0": l0 + 1, "data-l1": l1 + 1, "data-n": t.badge };
  };
  parts.forEach((part, pi) => {
    const start = base;
    base += part.split("\n").length - 1;
    if (pi % 2 === 1) {
      // Fenced code: first line may be the language tag.
      const nl = part.indexOf("\n");
      const lang = nl === -1 ? "" : part.slice(0, nl).trim();
      const code = (nl === -1 ? part : part.slice(nl + 1)).replace(/\n$/, "");
      if (/^(md|markdown|mdx)$/i.test(lang)) {
        const snip = <MdSnippet key={`m${pi}`} src={code} q={q} onCopy={onCopy} files={files} />;
        nodes.push(lineTag ? <div key={`m${pi}`} {...tag(start, base, "tr-mdsnip-wrap")}>{snip}</div> : snip);
        return;
      }
      nodes.push(
        <div {...tag(start, base, "tr-code")} key={`c${pi}`}>
          <div className="tr-code-head">
            <span>{lang || "code"}</span>
            <button className="key" title="copy code" onClick={() => onCopy(code)}><Copy size={12} /></button>
          </div>
          <pre>{hl(code, q)}</pre>
        </div>,
      );
      return;
    }
    const lines = part.split("\n");
    let para: string[] = [];
    let paraAt = 0;
    let list: { ordered: boolean; items: string[]; at: number[]; to: number[] } | null = null;
    const flushPara = (k: string) => {
      if (!para.length) return;
      const text = para.join("\n");
      nodes.push(<p {...tag(start + paraAt, start + paraAt + para.length - 1, "tr-p")} key={k}>{inlineDoc(text, q, k, files)}</p>);
      para = [];
    };
    const flushList = (k: string) => {
      if (!list) return;
      const L = list;
      const items = L.items.map((it, i) => <li {...(lineTag ? tag(start + L.at[i], start + L.to[i], "") : {})} key={i}>{inlineDoc(it, q, `${k}i${i}`, files)}</li>);
      nodes.push(L.ordered ? <ol className="tr-list" key={k}>{items}</ol> : <ul className="tr-list" key={k}>{items}</ul>);
      list = null;
    };
    for (let li = 0; li < lines.length; li++) {
      const k = `${pi}-${li}`;
      const line = lines[li].replace(/\s+$/, "");
      const aligns = line.includes("|") ? delimAligns(lines[li + 1] ?? "") : null;
      if (aligns) {
        // header row + delimiter + body rows until a line without a pipe
        flushPara(`p${k}`); flushList(`l${k}`);
        const header = rowCells(line);
        const body: string[][] = [];
        let j = li + 2;
        for (; j < lines.length && lines[j].includes("|"); j++) body.push(rowCells(lines[j]));
        const cols = Math.max(header.length, ...body.map((r) => r.length));
        const cell = (r: string[], c: number) => r[c] ?? "";
        nodes.push(
          <div {...tag(start + li, start + j - 1, "tr-table-wrap")} key={`tw${k}`}>
            <table className="tr-table">
              <thead>
                <tr>{Array.from({ length: cols }, (_, c) => (
                  <th key={c} style={{ textAlign: aligns[c] ?? "left" }}>{inline(cell(header, c), q, `th${k}-${c}`, files)}</th>
                ))}</tr>
              </thead>
              <tbody>{body.map((r, ri) => (
                <tr key={ri}>{Array.from({ length: cols }, (_, c) => (
                  <td key={c} style={{ textAlign: aligns[c] ?? "left" }}>{inline(cell(r, c), q, `td${k}-${ri}-${c}`, files)}</td>
                ))}</tr>
              ))}</tbody>
            </table>
          </div>,
        );
        li = j - 1;
        continue;
      }
      const head = /^(#{1,6})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const quote = /^>\s?(.*)$/.exec(line);
      if (head) {
        flushPara(`p${k}`); flushList(`l${k}`);
        nodes.push(<div {...tag(start + li, start + li, `tr-h tr-h${head[1].length}`)} key={`h${k}`}>{inline(head[2], q, `h${k}`, files)}</div>);
      } else if (bullet || ordered) {
        flushPara(`p${k}`);
        const isOrdered = !!ordered;
        const item = (bullet ?? ordered)![1];
        if (list && list.ordered !== isOrdered) flushList(`l${k}`);
        list ??= { ordered: isOrdered, items: [], at: [], to: [] };
        list.items.push(item);
        list.at.push(li);
        list.to.push(li);
      } else if (quote) {
        flushPara(`p${k}`); flushList(`l${k}`);
        nodes.push(<blockquote {...tag(start + li, start + li, "tr-quote")} key={`q${k}`}>{inline(quote[1], q, `q${k}`, files)}</blockquote>);
      } else if (!line.trim()) {
        flushPara(`p${k}`); flushList(`l${k}`);
      } else if (list && /^\s/.test(line)) {
        // An indented line straight under an item continues it — a README
        // hard-wraps its bullets, and a new paragraph there broke each one in two.
        const n = list.items.length - 1;
        list.items[n] += "\n" + line.trim();
        list.to[n] = li;
      } else {
        flushList(`l${k}`);
        if (!para.length) paraAt = li;
        para.push(line);
      }
    }
    flushPara(`pe${pi}`); flushList(`le${pi}`);
  });
  return <>{nodes}</>;
}
