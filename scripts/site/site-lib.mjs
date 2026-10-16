// waterplane.dev is drawn from the README, so the two cannot drift apart. Pure parts; the CLI is
// build-site.mjs, the drift check tools/site.test.mjs.
//
// The README marks what the site carries with invisible comments:
//
//   <!-- site:limit -->
//   ### When the usage limit hits, it carries on
//   ...
//   <!-- /site:limit -->
//
// and site/index.html has a slot of the same name, whose contents are generated and COMMITTED:
//
//   <!-- readme:limit -->
//   <section class="row" id="when-the-usage-limit-hits-it-carries-on">...</section>
//   <!-- /readme:limit -->
//
// Everything outside the slots (the head, the wordmark, the footer, the section order) is the
// site's own. Inside a block, the heading becomes the section's <h2> (a block with no heading
// is the hero: its leading bold sentence becomes the <h1>), a phone picture moves to the
// section's right-hand figure, a diagram (.svg) stays in the text, and the italic line under a
// picture (its video link, which the site does not host) is dropped.
//
// The markdown understood is the README's own subset: headings, paragraphs, `-` lists, `>`
// quotes, fenced code, inline code, bold, italic, links and pictures (markdown or one-line
// <a><img></a> HTML). Anything else in a block (a table, a numbered list) throws, naming the
// block, rather than being drawn wrong.

const BLOCK = /<!-- site:([a-z0-9-]+) -->\n([\s\S]*?)\n<!-- \/site:\1 -->/g;
const SLOT = /<!-- readme:([a-z0-9-]+) -->\n[\s\S]*?<!-- \/readme:\1 -->/g;

/** The README's marked blocks, by name. Throws on a name used twice or a marker left open. */
export function extractBlocks(readme) {
  const blocks = new Map();
  for (const m of readme.matchAll(BLOCK)) {
    if (blocks.has(m[1])) throw new Error(`README: site block "${m[1]}" is marked twice`);
    blocks.set(m[1], m[2]);
  }
  const opened = [...readme.matchAll(/<!-- site:([a-z0-9-]+) -->/g)].map((m) => m[1]);
  for (const name of opened) {
    if (!blocks.has(name)) throw new Error(`README: <!-- site:${name} --> has no matching <!-- /site:${name} --> on its own line`);
  }
  return blocks;
}

/** The slot names site/index.html asks for, in page order. */
export function slotNames(template) {
  return [...template.matchAll(SLOT)].map((m) => m[1]);
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
export function slug(text) {
  return text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) => esc(s).replace(/"/g, "&quot;");

/**
 * Where a README link points from the site. ctx: { repoUrl, siteIds: Set }.
 * An anchor the site has stays on the page; any other anchor is the README's on GitHub; a
 * relative path is the file on GitHub; an absolute URL is left alone.
 */
export function siteHref(url, ctx) {
  if (/^[a-z]+:/i.test(url)) return url;
  if (url.startsWith("#")) return ctx.siteIds.has(url.slice(1)) ? url : `${ctx.repoUrl}${url}`;
  return `${ctx.repoUrl}/blob/main/${url.replace(/^\.\//, "")}`;
}

/** One line (or joined lines) of inline markdown to HTML. */
export function inline(text, ctx) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${attr(siteHref(u.replace(/&amp;/g, "&"), ctx))}">${t}</a>`);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*(?![\s*])(.+?)\*(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
}

/** A line that is only a picture: markdown, linked markdown, or <a><img></a> / <img> HTML. */
export function parseImage(line) {
  const md = /^\[?!\[([^\]]*)\]\(([^)\s]+)\)(?:\]\([^)\s]+\))?$/.exec(line);
  if (md) return { alt: md[1], src: md[2] };
  const html = /^(?:<a [^>]*>)?<img ([^>]*)>(?:<\/a>)?$/.exec(line);
  if (!html) return null;
  const get = (name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(html[1]) || [])[1];
  return get("src") ? { alt: get("alt") ?? "", src: get("src") } : null;
}

/** Markdown lines to tokens: heading, para, list, quote, code, image. */
export function tokenize(md, where) {
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  const unsupported = (what) => { throw new Error(`README block "${where}": ${what} is not drawn on the site; move it outside the <!-- site:${where} --> markers`); };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,6}) (.+)$/.exec(line))) { out.push({ t: "heading", level: m[1].length, text: m[2] }); i++; continue; }
    if (line.startsWith("```")) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      out.push({ t: "code", text: body.join("\n") });
      continue;
    }
    if (line.startsWith(">")) {
      const body = [];
      while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^> ?/, ""));
      out.push({ t: "quote", children: tokenize(body.join("\n"), where) });
      continue;
    }
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && (/^- /.test(lines[i]) || /^ {2,}\S/.test(lines[i]))) {
        if (/^- /.test(lines[i])) items.push(lines[i].slice(2));
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      out.push({ t: "list", items });
      continue;
    }
    if (/^\d+\. /.test(line)) unsupported("a numbered list");
    if (/^\|/.test(line)) unsupported("a table");
    const image = parseImage(line.trim());
    if (image) { out.push({ t: "image", ...image }); i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6} |```|>|- |\|)/.test(lines[i]) && !parseImage(lines[i].trim())) para.push(lines[i++].trim());
    out.push({ t: "para", text: para.join(" ") });
  }
  return out;
}

const isCaption = (tok) => tok?.t === "para" && /^\*[^*].*\*$/.test(tok.text);

/** A picture's file name on the site: every picture is served flat from assets/. */
export const assetName = (src) => src.split("/").pop();

/**
 * One README block as the site's <section>. dims(src) → { width, height } of the file.
 * Returns { html, media: [src, ...] }, media being the repo paths the page now shows.
 */
export function renderSection(name, md, ctx, dims) {
  const toks = tokenize(md, name);
  const media = [];
  const text = [];
  let figure = "";
  let id = name;
  let hero = false;
  const img = (tok, extra) => {
    media.push(tok.src);
    const { width, height } = dims(tok.src);
    return `<img src="assets/${attr(assetName(tok.src))}" width="${width}" height="${height}" ${extra} alt="${attr(tok.alt)}">`;
  };
  const renderInto = (list, sink) => {
    for (let k = 0; k < list.length; k++) {
      const tok = list[k];
      if (tok.t === "heading") {
        id = slug(tok.text);
        sink.push(`<h2>${inline(tok.text, ctx)}</h2>`);
      } else if (tok.t === "para") {
        const cls = /^\[[^\]]+\]\([^)]+\)( · |$)/.test(tok.text) && tok.text.includes(" · ") ? ' class="links"' : "";
        sink.push(`<p${cls}>${inline(tok.text, ctx).replace(/ · /g, '<span class="sep">·</span>')}</p>`);
      } else if (tok.t === "list") {
        sink.push(`<ul>\n${tok.items.map((it) => `  <li>${inline(it, ctx)}</li>`).join("\n")}\n</ul>`);
      } else if (tok.t === "code") {
        sink.push(`<pre><code>${esc(tok.text)}</code></pre>`);
      } else if (tok.t === "quote") {
        const inner = [];
        renderInto(tok.children, inner);
        sink.push(`<div class="note">\n${inner.join("\n")}\n</div>`);
      } else if (tok.t === "image") {
        if (isCaption(list[k + 1])) k++;
        if (tok.src.endsWith(".svg")) {
          sink.push(`<figure class="diagram">${img(tok, 'loading="lazy"')}</figure>`);
        } else if (!figure) {
          figure = `<figure class="phone">${img(tok, hero ? 'fetchpriority="high"' : 'loading="lazy"')}</figure>`;
        } else {
          throw new Error(`README block "${name}": a second phone picture; the site shows one per section`);
        }
      }
    }
  };
  if (toks[0]?.t !== "heading") {
    hero = true;
    const lead = toks[0]?.t === "para" ? /^\*\*([^*]+)\*\*\s*(.*)$/.exec(toks[0].text) : null;
    if (!lead) throw new Error(`README block "${name}": a block without a heading is the hero and must open with a **bold sentence**`);
    text.push(`<h1>${inline(lead[1], ctx)}</h1>`);
    if (lead[2]) text.push(`<p class="lede">${inline(lead[2], ctx)}</p>`);
    toks.shift();
  }
  renderInto(toks, text);
  const html = [
    `<section class="row${hero ? " hero" : ""}" id="${attr(id)}">`,
    `  <div class="text">`,
    // Not indented: a <pre> body would carry the indent into what it shows.
    ...text,
    `  </div>`,
    ...(figure ? [`  ${figure}`] : []),
    `</section>`,
  ].join("\n");
  return { html, media, id };
}

/** The section ids the blocks will produce, so links between them can stay on the page. */
export function sectionIds(blocks) {
  const ids = new Set();
  for (const [name, md] of blocks) {
    const h = /^#{1,6} (.+)$/m.exec(md);
    ids.add(h ? slug(h[1]) : name);
  }
  return ids;
}

/**
 * The page with every slot filled from the README. Throws when a slot names no README block, or a
 * README block has no slot (marked for the site but shown nowhere).
 * Returns { html, media: Set of repo paths to serve under assets/ }.
 */
export function renderSite(template, readme, { repoUrl, dims }) {
  const blocks = extractBlocks(readme);
  const slots = slotNames(template);
  for (const s of slots) if (!blocks.has(s)) throw new Error(`site/index.html asks for <!-- readme:${s} -->, but the README marks no <!-- site:${s} --> block`);
  for (const b of blocks.keys()) if (!slots.includes(b)) throw new Error(`README marks <!-- site:${b} -->, but site/index.html has no <!-- readme:${b} --> slot for it`);
  const ctx = { repoUrl, siteIds: sectionIds(blocks) };
  const media = new Set();
  const html = template.replace(SLOT, (_m, name) => {
    const r = renderSection(name, blocks.get(name), ctx, dims);
    r.media.forEach((p) => media.add(p));
    return `<!-- readme:${name} -->\n${r.html}\n<!-- /readme:${name} -->`;
  });
  return { html, media };
}

/** Pixel size from a GIF, PNG or SVG file's bytes. */
export function imageSize(buf, path) {
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  const svg = buf.subarray(0, 2048).toString("utf8");
  const w = /<svg[^>]*\bwidth="(\d+(?:\.\d+)?)"/.exec(svg);
  const h = /<svg[^>]*\bheight="(\d+(?:\.\d+)?)"/.exec(svg);
  if (w && h) return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) };
  const vb = /<svg[^>]*\bviewBox="[\d.-]+[ ,]+[\d.-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/.exec(svg);
  if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) };
  throw new Error(`${path}: cannot read its size (GIF, PNG or an SVG with width/height or viewBox only)`);
}
