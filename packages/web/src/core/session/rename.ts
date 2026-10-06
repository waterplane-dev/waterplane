/**
 * The pencil: a name a person types for a session. One function for the
 * launcher row and the session header, so both say the same thing about what
 * the name will become.
 *
 * It lands in `tabTitle` on the desktop (`record.ts` `renameTab`), through the
 * same `cleanTabTitle` the generated name goes through — the tab strip's width
 * is the limit either way. So the clip is done HERE first and the receipt names
 * the result, rather than a person typing five words and finding three.
 */
import { cleanTabTitle, MAX_TAB_CHARS, MAX_TAB_WORDS, sessionName } from "@waterplane/shared";
import type { ClientMessage, SessionInfo } from "@waterplane/shared";
import { askText } from "../../AskText";
import { showToast } from "../../toast";
import { track } from "../../usage";

type LiveSend = (frame: ClientMessage, done: string, blocked?: string) => boolean;

export async function renameSession(s: SessionInfo, liveSend: LiveSend): Promise<void> {
  const typed = await askText({
    title: "Name this session",
    initial: sessionName(s),
    placeholder: "what this session is about",
    note: `Shown on the tab, the row and the header — up to ${MAX_TAB_WORDS} words, ${MAX_TAB_CHARS} characters.`,
  });
  if (!typed) return;
  const name = cleanTabTitle(typed);
  if (!name) { showToast("that name was not kept — one word longer than the tab, or an ellipsis in it"); return; }
  track("action:session.rename");
  const clipped = name !== typed.trim() ? " (shortened to fit the tab)" : "";
  liveSend({ t: "session.rename", id: s.id, title: name }, `named “${name}”${clipped}`,
    "no connection — the name lives on the desktop and was not changed");
}
