import { ArrowRight, Plus, Terminal } from "lucide-react";
import { track } from "../usage";
import type { GalleryProps } from "./galleryTypes";
import { Button } from "../kit/Button";
import { Row, RowTitle, RowSub } from "../kit/Row";

/**
 * The viewer's *to session* verbs. Which live session gets the file is the
 * person's pick, never "the first running one in this repo": one is named on
 * its button, two or more open a list of exactly those. A new session is its
 * own button, there whether or not any are live.
 *
 * `Buttons` sits in the action bar and `List` under it, so the open/closed
 * state is the viewer's (`picking`, keyed by the file's path: swiping to the
 * next picture closes the list instead of carrying it over).
 */
type PickArgs = {
  relPath: string; repoId: string; repoName?: string;
  props: Pick<GalleryProps, "onContinueInSession" | "sessionsIn">;
  picking: boolean; setPicking: (open: boolean) => void;
};

function targetsOf(p: PickArgs) {
  const { onContinueInSession, sessionsIn } = p.props;
  return onContinueInSession && sessionsIn ? sessionsIn(p.repoId) : [];
}
function go(p: PickArgs, sessionId: string | null) {
  track(sessionId ? "action:gallery.toSession" : "action:gallery.toNewSession");
  p.setPicking(false);
  p.props.onContinueInSession?.(p.relPath, p.repoId, sessionId);
}

export function SessionPickButtons(p: PickArgs) {
  if (!p.props.onContinueInSession) return null;
  const targets = targetsOf(p);
  return (
    <>
      {targets.length === 1 && <Button title="put this file's path in that session's prompt" onClick={() => go(p, targets[0].id)}><ArrowRight size={16} /> {targets[0].label}</Button>}
      {targets.length > 1 && <Button title="pick which live session gets this file's path" onClick={() => p.setPicking(!p.picking)}><ArrowRight size={16} /> session · {targets.length}</Button>}
      <Button title="start a new session in this repo with this file's path in its prompt" onClick={() => go(p, null)}><Plus size={16} /> new session</Button>
    </>
  );
}

export function SessionPickList(p: PickArgs) {
  const targets = targetsOf(p);
  if (!p.picking || targets.length < 2) return null;
  return (
    <>
      <div className="viewer-doc-note">{targets.length} live sessions in {p.repoName || "this repo"} — the path goes into the prompt of the one you pick</div>
      <div className="list">
        {targets.map((t) => (
          <Row key={t.id} as="button" onClick={() => go(p, t.id)}>
            <RowTitle><Terminal size={14} /> {t.label}</RowTitle>
            {t.onScreen && <RowSub>on screen behind the gallery</RowSub>}
          </Row>
        ))}
      </div>
    </>
  );
}
