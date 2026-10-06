import type { GalleryProps } from "./gallery/galleryTypes";
import { useGallery } from "./gallery/useGallery";
import { GalleryBar } from "./gallery/GalleryBar";
import { GalleryGrid } from "./gallery/GalleryGrid";
import { GalleryViewer } from "./gallery/GalleryViewer";

/** Browse / search images & documents in one repo or across all repos.
 *  A thin composer over `gallery/` (docs/notes/webclient-architecture.md). */
export function Gallery(props: GalleryProps) {
  const m = useGallery(props);
  return (
    <div className="sheet">
      <GalleryBar m={m} />
      <GalleryGrid m={m} />
      <GalleryViewer m={m} />
    </div>
  );
}
