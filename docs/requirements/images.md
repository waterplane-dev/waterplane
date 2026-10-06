# images

### R-images-001 · shipped
Tapping an image opens view mode with horizontal swipe navigation and a button to switch to mark/annotation mode; annotation tools (including line drawing and a text marker tool) are available when an image is clicked, images can be enlarged, and the annotation editor also launches from the attach-image button.
- asked: 68a6130d, fa2e99b5, ce4f7a60, 0ff70d47, bfa500f5, 2026-09-11 (session 8504c0db)
- shipped: 664187d, 542d758, 8fbe9f1

### R-images-002 · shipped
Placed annotation objects can be moved after placement, via relative drag.
- asked: 0ff70d47
- shipped: bc83b7f

### R-images-003 · shipped
Image annotations with typed text include the full text and its position coordinates in the prompt metadata, optimized to reduce token usage while improving AI understanding.
- asked: 54598a9e, 2026-09-13 (session 8f0faac2)
- shipped: 8fbe9f1

### R-images-004 · shipped
Annotation editor's keyboard does not open by default when starting an annotation, and the image stays full screen (without needing to zoom) once the keyboard closes.
- asked: 2026-09-11 (session 8504c0db)
- shipped: c74402f

### R-images-005 · shipped
Annotation color picker displays as a single dot that opens full color selection on tap, and the undo button is positioned first in the annotation toolbar.
- asked: 2026-09-11 (session 8504c0db)
- shipped: c74402f

### R-images-006 · shipped
Assessment results display referenced images inline and clickable.
- asked: 2026-09-18 (session 31dcfad5)
- shipped: 4ea4a5b

### R-images-007 · shipped
Annotation marks can start beside the image (outside its bounds), and any overhang past the image edge is cut before sending.
- asked: 2026-09-19 (session 31cb7ed7)
- shipped: bde48c5

### R-images-008 · shipped
Mobile image annotation avoids finger obscuring small objects being repositioned, via a movable stick control with a move/resize mode toggle and a button to reposition the stick relative to the object.
- asked: 2026-09-21 (session c41cb97d), 2026-09-21 (session c41cb97d), 2026-09-21 (session c41cb97d)
- shipped: bc83b7f, 2bb41d4

### R-images-009 · shipped
The annotator offers knob mode as an option: move, size and turn knobs on strings (adult-sized), every mark turnable except the highlight band, and whether knobs are on is remembered across devices.
- asked: 2026-09-24 (session 98a7400e)
- shipped: 2bb41d4, 2bac688

