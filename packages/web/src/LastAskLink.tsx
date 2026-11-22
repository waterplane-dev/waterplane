/**
 * The line under an "ask the agent" button: where the last answer to that button is
 * (`lastAsk.ts`). A live session is one tap away; a closed one is a sentence naming where it
 * went; a create still on its way says so. Unknown to this desktop: nothing is drawn.
 */
import { CornerDownRight } from "lucide-react";
import { core } from "./core/api.ts";
import { useStore } from "./sdk/store.ts";
import { useQueueEntries } from "./sdk/hooks.ts";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";
import { ago } from "./format";
import { isCreateOp, loadAdoptions } from "./outbox";
import { lastAsks } from "./lastAsk";
import { askPlace } from "./lastAskLogic.ts";

export function LastAskLink({ askKey }: { askKey: string }) {
  const map = useStore(lastAsks);
  const queue = useQueueEntries();
  const w = core().world;
  const place = askPlace(map[askKey], loadAdoptions(), w.sessions, w.closed,
    (ack) => queue.some((e) => e.ackId === ack && isCreateOp(e)));
  if (!place) return null;
  const when = ago(place.at);
  if (place.kind === "starting") return <Hint>Asked {when}; that session is still starting.</Hint>;
  if (place.kind === "closed") return <Hint>Asked {when} in “{place.title}”, since closed: it is under Recently closed.</Hint>;
  const open = () => {
    const s = core().world.sessions.find((x) => x.id === place.sid);
    if (s) core().nav.attach(s);
  };
  return (
    <div className="sc-acts last-ask">
      <Button title="opens the session this button started last time" onClick={open}>
        <CornerDownRight size={12} /> last answer: {place.title} · {when}
      </Button>
    </div>
  );
}
