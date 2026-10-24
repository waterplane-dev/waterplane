/**
 * Pictures and repo files on the phone: the pickers, the annotator and its
 * round trips, the full-screen viewer, the "new N" strip, the gallery, the file
 * tree and the sweep. README.md says what it owns and what it reads from core.
 */
import { createElement } from "react";
import { core, type FeatureManifest } from "../../sdk";
import { ann, browseAim, collage, swipe, sweepFor } from "./store";
import { bootImages, inActiveRepo, openBrowseAt, onSessionImages, openBrowseHere, openGalleryHere, pickFileFor, pickImageFor } from "./actions";
import { CombineSheet, MarkUpSheet, ViewerSheet } from "./ImageSheets";
import { FileTreeSheet, GallerySheet, SweepEntrySheet } from "./GalleryEntry";
import { InboxToolbarItem } from "./NewImages";
import { TAB_FILE_EVENT, type FileTab } from "../../sessionTabs";

export {
  alreadyMarking, annotate, annotateUrl, annotatorBusy, appendToBatch, attachForInbox, backlogEditImage, downloadArtifact, openArtifact, openBrowseAt,
  openBrowseFor, openFileRef, openGalleryFor, openGalleryForSend, openNewImages, openOutboxFor, openSweep, pickFileFor,
  pickImageFor, routeFiles, seedFromRoute, takeBoxReturn, viewImage,
} from "./actions";
export { useBoxReturn } from "./store";
export { useAnnBeside } from "./ImageSheets";
export { NewImagesStrip, NewImagesTag } from "./NewImages";
export { galleryCtxForFile, pasteRoute, type GalleryCtx } from "./logic";

export const manifest: FeatureManifest = {
  id: "images",
  sheets: [
    // Guarded: an overlay whose backing state is gone (a reload restored the
    // route with no picked file) falls through to the screen underneath.
    { id: "collage", persisted: false, render: () => (collage.get() ? createElement(CombineSheet) : null) },
    { id: "image", persisted: false, render: () => (ann.get() ? createElement(MarkUpSheet) : null) },
    { id: "swipe", persisted: false, render: () => (swipe.get() ? createElement(ViewerSheet) : null) },
    { id: "gallery", persisted: true, render: () => createElement(GallerySheet) },
    { id: "sweep", persisted: false, render: (c) => {
      const s = sweepFor.get();
      return s && c.world.repos.some((r) => r.id === s.repoId) ? createElement(SweepEntrySheet) : null;
    } },
    { id: "browse", persisted: true, render: () => createElement(FileTreeSheet) },
  ],
  commands: [
    { id: "image", run: inActiveRepo(pickImageFor) },
    { id: "file", run: inActiveRepo(pickFileFor) },
    { id: "files", run: inActiveRepo(openGalleryHere) },
    { id: "browse", run: inActiveRepo(openBrowseHere) },
  ],
  messages: {
    "session.images": (msg) => onSessionImages(msg.id, msg.repoId, msg.images),
  },
  toolbarItems: [
    {
      id: "inbox",
      render: (c, ctx) => {
        const repo = c.world.activeRepo;
        return repo && repo.outboxCount > 0 ? createElement(InboxToolbarItem, { repo, dismiss: ctx.dismiss }) : null;
      },
    },
  ],
  boot: () => {
    const offImages = bootImages();
    // A pinned file's tab (`sessionTabs.ts` `FileTab`): the strip is mounted
    // beside App and says the tap as an event. Closing returns to the screen it
    // was tapped from — or, from inside the file viewer, to where THAT viewer
    // would have returned, so Back never lands on the file just left.
    const onFileTab = (e: Event) => {
      const f = (e as CustomEvent<FileTab>).detail;
      if (!f) return;
      const here = core().nav.overlay;
      openBrowseAt(f.repoId, f.path, here === "browse" ? browseAim.get()?.back ?? null : here);
    };
    window.addEventListener(TAB_FILE_EVENT, onFileTab);
    return () => { offImages(); window.removeEventListener(TAB_FILE_EVENT, onFileTab); };
  },
};
