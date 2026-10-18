# images

### R-images-001 · shipped
Tapping an image opens view mode with horizontal swipe navigation and a button to switch to mark/annotation mode; annotation tools (including line drawing and a text marker tool) are available when an image is clicked, images can be enlarged, and the annotation editor also launches from the attach-image button.
- asked: 2026-09-11
- shipped: 664187d, 542d758, 8fbe9f1

### R-images-002 · shipped
Placed annotation objects can be moved after placement, via relative drag.
- shipped: bc83b7f

### R-images-003 · shipped
Image annotations with typed text include the full text and its position coordinates in the prompt metadata, optimized to reduce token usage while improving AI understanding.
- asked: 2026-09-13
- shipped: 8fbe9f1

### R-images-004 · shipped
Annotation editor's keyboard does not open by default when starting an annotation, and the image stays full screen (without needing to zoom) once the keyboard closes.
- asked: 2026-09-11
- shipped: c74402f

### R-images-005 · shipped
Annotation color picker displays as a single dot that opens full color selection on tap, and the undo button is positioned first in the annotation toolbar.
- asked: 2026-09-11
- shipped: c74402f

### R-images-006 · shipped
Assessment results display referenced images inline and clickable.
- asked: 2026-09-18
- shipped: 4ea4a5b

### R-images-007 · shipped
Annotation marks can start beside the image (outside its bounds), and any overhang past the image edge is cut before sending.
- asked: 2026-09-19
- shipped: bde48c5

### R-images-008 · shipped
Mobile image annotation avoids finger obscuring small objects being repositioned, via a movable stick control with a move/resize mode toggle and a button to reposition the stick relative to the object.
- asked: 2026-09-21, 2026-09-21, 2026-09-21
- shipped: bc83b7f, 2bb41d4

### R-images-009 · shipped
The annotator offers knob mode as an option: move, size and turn knobs on strings (adult-sized), every mark turnable except the highlight band; an arrow or line instead gets a knob on each end that drags that end freely (no turn knob), and whether knobs are on is remembered across devices.
- asked: 2026-09-24
- shipped: 2bb41d4, 2bac688

### R-images-010 · shipped
The image editor's tip banner has an x button that dismisses it to free up screen space.
- asked: 2026-10-06
- shipped: d06313ef

### R-images-011 · shipped
Image annotation offers an option to run OCR on the whole image on the backend and send only the extracted text, which the user can review and edit before it is sent.
- asked: 2026-10-07
- shipped: f1e91658


### R-images-012 · shipped
The highlighter only points: a highlighted band is not read by the desktop or by any cloud model, so a highlight costs nothing. The agent reads the picture itself; words a person types onto a band are still quoted with it. (The whole-picture "text only" read of R-images-011 is a different, on-desktop, free path and stays.)
- asked: 2026-10-18 (owner: "I don't want to waste money with Gemini calls on this feature"; "don't involve the Mac or a backend for this one piece. Either it's all on the phone or we just skip it — then the model does it anyway")
- shipped: the highlighter's Gemini reader (`readtext.ts`, `POST /api/host/readtext`) removed; `annotator/annRead.ts` keeps only typed words
