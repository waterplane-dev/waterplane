/**
 * The `hdrcmd` sheet: the one-tap header chips, and — because "what is in my
 * header" is one question — the toolbar pins that share their row.
 */
import { Pin } from "lucide-react";
import { useCore } from "../../sdk";
import { backendMark } from "../../backendCaps";
import { SnippetSheet } from "../../SnippetSheet";
import { TOOLBAR_ITEMS } from "../../toolbar";
import { resetHeaderCmdsToDefault, toggleToolbarPin, writeHeaderCmds } from "./actions";
import { useHeaderCmds, useHeaderSplit, useToolbarCfg } from "./store";

export function HeaderCmdsSheet() {
  const core = useCore();
  const headerCmds = useHeaderCmds();
  const toolbarCfg = useToolbarCfg();
  const { active, backends } = core.world;
  // The same split the header drew from (`useHeaderSplit`).
  const hdrSplit = useHeaderSplit(core.world.sessionCan(active, "slash"));
  return (
    <SnippetSheet
      snippets={headerCmds}
      onSave={writeHeaderCmds}
      onClose={() => core.nav.close("hdrcmd")}
      heading="Header commands"
      hint={<>
        <div>One-tap chips in the session header — tapping one sends its text to the session you are in (a slash command runs as a command). The header survives a collapse, so these stay reachable in reader view.</div>
        {/* The list here is ALWAYS the whole list: this sheet edits global,
            synced configuration, not the session that happens to be open.
            But the session that happens to be open is why somebody is
            looking, so say what it is doing with them — as a fact about
            that session, never as a reason to delete a chip. */}
        {active && hdrSplit.hiddenSlash > 0 && (
          <div>
            {active.title} runs {backendMark(backends, active.backend) ?? "another backend"}, which takes no Claude
            slash commands — so {hdrSplit.hiddenSlash} of these {hdrSplit.hiddenSlash === 1 ? "is" : "are"} not
            offered in its header. They are still here, still synced, and still offered in every claude session.
          </div>
        )}
        {/* Pinned TOOLBAR actions live in the same header row, so they are
            configured here too — "what is in my header" is one question, and
            splitting it across two sheets is how `files` ended up unreachable
            in the collapsed layout. */}
        <div className="pin-head">Pin toolbar actions into the header</div>
        <div className="pin-cloud">
          {TOOLBAR_ITEMS.map((t) => {
            const on = (toolbarCfg.pinned ?? []).includes(t.id);
            return (
              <button key={t.id} className={`key hdr-cmd ${on ? "active" : ""}`}
                title={on ? `unpin ${t.name} from the header` : `pin ${t.name} into the header`}
                onClick={() => toggleToolbarPin(t.id)}>
                <t.Icon size={12} /> {t.name}{on ? <Pin size={11} /> : null}
              </button>
            );
          })}
        </div>
      </>}
      emptyText="No header commands. Tap “new” to add one."
      textPlaceholder="/compact — or any text to send…"
      onReset={resetHeaderCmdsToDefault}
      trackId="action:hdrcmd.save"
    />
  );
}
