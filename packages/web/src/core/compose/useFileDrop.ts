/**
 * Files into the session from a DESKTOP: Cmd/Ctrl+V of a screenshot or a copied
 * file, and a drag from the file manager onto the compose box. Both take the
 * paperclip's route (`files.attachFiles` — pictures through the annotator, the
 * rest uploaded with their paths in the box); where a paste applies is
 * `pasteRoute`'s (features/images).
 *
 * Mounted by the compose bar, so it lives exactly as long as a session screen
 * is drawn. A file dropped NEXT TO the box is swallowed rather than left to
 * the browser, whose default is to navigate the tab to the file — the whole
 * app gone for a missed drop target.
 */
import { useEffect, useState, type DragEvent } from "react";
import { annotatorBusy, appendToBatch, pasteRoute } from "../../features/images";
import { isAnnotatable } from "../../media";
import { core } from "../../sdk";

/** The files a paste or a drop carries — a copied screenshot arrives as a
 *  `file` item (`image/png`), a file copied or dragged from Finder likewise. */
function filesOf(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== "file") continue;
    const f = it.getAsFile();
    if (f) out.push(f);
  }
  return out.length ? out : Array.from(dt.files ?? []);
}

const carriesFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types ?? []).includes("Files");

/** Route `files` into the session on screen, or say why not. */
function attach(files: File[], how: "paste" | "drop"): void {
  const c = core();
  const repoId = c.world.activeRepo?.id;
  if (!repoId) { c.say.toast("No repo for this session — files have nowhere to go"); return; }
  if (annotatorBusy()) {
    // Asked every time: the person may have meant this picture INSTEAD, and
    // the one on the annotator is the last copy of its marks — so it is never
    // replaced, and nothing is added without a yes.
    const n = files.filter(isAnnotatable).length;
    const what = n === files.length ? (n === 1 ? "this picture" : `these ${n} pictures`) : files.length === 1 ? "this file" : `these ${files.length} files`;
    void c.say.confirm({
      title: `Append ${what}?`,
      lines: [n ? "Pictures are marked next, after the one on screen — its marks stay." : "Uploaded into the inbox, its path added to the message."],
      confirmLabel: "Append", cancelLabel: "Leave it", tone: "info",
    }).then((yes) => { if (yes) { c.say.track(`action:attach.${how}.append`); appendToBatch(files); } });
    return;
  }
  c.say.track(`action:attach.${how}`);
  c.files.attachFiles(files, repoId);
}

export function useFileDrop(): {
  dragOver: boolean;
  dropProps: { onDragOver(e: DragEvent): void; onDragLeave(e: DragEvent): void; onDrop(e: DragEvent): void };
} {
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = filesOf(e.clipboardData);
      const t = e.target as HTMLElement | null;
      const c = core();
      const route = pasteRoute({
        files: files.length,
        editable: !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)),
        inCompose: !!t?.closest?.(".compose, .ann-prompt"),
        sheet: c.nav.overlay != null,
        annotating: annotatorBusy(),
        repoId: c.world.activeRepo?.id ?? null,
      });
      if (route === "ignore") return;
      e.preventDefault();
      attach(files, "paste");
    };
    // Outside the box: refuse the drop (cursor says so) and never navigate.
    const swallow = (e: globalThis.DragEvent) => { if (carriesFiles(e.dataTransfer)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "none"; } };
    document.addEventListener("paste", onPaste);
    document.addEventListener("dragover", swallow);
    document.addEventListener("drop", swallow);
    return () => {
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("dragover", swallow);
      document.removeEventListener("drop", swallow);
    };
  }, []);

  return {
    dragOver,
    dropProps: {
      onDragOver(e) {
        if (!carriesFiles(e.dataTransfer)) return;
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      },
      onDragLeave(e) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      },
      onDrop(e) {
        if (!carriesFiles(e.dataTransfer)) return;
        e.preventDefault(); e.stopPropagation();
        setDragOver(false);
        const files = filesOf(e.dataTransfer);
        if (files.length) attach(files, "drop");
      },
    },
  };
}
