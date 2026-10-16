import { File, FileArchive, FileAudio, FileCode, FileSpreadsheet, FileText, Package, type LucideIcon } from "lucide-react";
/** Extension → the glyph a document tile draws. One meaning per glyph (ux §4): text you read,
 *  code or markup, a table, an archive, an installable app, sound. Anything else is a plain file. */
const DOC_ICONS: [RegExp, LucideIcon][] = [
  [/^(md|markdown|txt|log|rst|pdf)$/, FileText],
  [/^(html?|json|ya?ml|toml|xml|js|mjs|ts|tsx|css|sh|py|diff|patch)$/, FileCode],
  [/^(csv|tsv|xlsx?|ods)$/, FileSpreadsheet],
  [/^(zip|tar|gz|tgz|7z|rar)$/, FileArchive],
  [/^(apk|aab|ipa)$/, Package],
  [/^(mp3|m4a|wav|ogg|opus|flac|aac)$/, FileAudio],
];

/**
 * A document's tile: its kind as a glyph, the extension small under it. It was the extension
 * alone, upper-cased in monospace ("MD") across the whole picture area, which read as a
 * placeholder rather than as a file.
 */
export function DocIcon({ name }: { name: string }) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const Icon = DOC_ICONS.find(([re]) => re.test(ext))?.[1] ?? File;
  return (
    <span className="doc" aria-hidden>
      <Icon size={30} strokeWidth={1.5} />
      {ext && <span className="doc-ext">{ext}</span>}
    </span>
  );
}
