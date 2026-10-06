/**
 * The session menu's `plugins` entry: for each ACTIVE plugin, its per-session
 * switches, the core-owned "let <name> answer" switch when its manifest
 * declared `answers`, and its session-scoped actions. Where the oracle's chip
 * and its `propose` button used to be.
 *
 * The switches mutate in place and never shut the menu (a second tap is the
 * common case); an action is a choice and does. Nothing is drawn for a session
 * no active plugin has anything to say about, and a queued (pending) session
 * gets nothing — there is no session on the desktop for a plugin to act on.
 */
import { BRAND } from "@waterplane/shared";
import { Bot, Play, Puzzle, ToggleLeft, ToggleRight } from "lucide-react";
import type { ReactNode } from "react";
import type { PluginBadge, SessionInfo } from "@waterplane/shared";
import { useStore } from "../../sdk";
import { runPluginAction, setSessionAnswer, setSessionToggle } from "./actions";
import { actionKey, nextToggleValue, sessionBadges, sessionControls, sessionRuleGroups } from "./logic";
import { plugins, results } from "./store";

const ICON = 16;

export function PluginsToolbar({ active, dismiss }: { active: SessionInfo | null; dismiss(): void }): ReactNode {
  const list = useStore(plugins);
  const res = useStore(results);
  if (!active || active.id.startsWith("pending:")) return null;
  const groups = sessionControls(list, active);
  const ruled = sessionRuleGroups(active, list);
  if (!groups.length && !ruled.length) return null;
  return (
    <>
      {ruled.map((g) => (
        // What answers on this session with nobody tapping, because a person tapped
        // "don't ask again" — the host's list, not the plugin's (`answergate.ts`).
        <div key={`rules-${g.id}`} className="plugin-menu" role="group" aria-label={`${g.name} standing rules`}>
          <div className="plugin-menu-head"><Puzzle size={12} /> {g.name} · won't ask again, this session only</div>
          {g.lines.map((l, i) => <div key={i} className="plugin-menu-note">{l}</div>)}
        </div>
      ))}
      {groups.map((g) => (
        <div key={g.id} className="plugin-menu" role="group" aria-label={g.name}>
          <div className="plugin-menu-head"><Puzzle size={12} /> {g.name}</div>
          {g.toggles.map((t) => (
            <button key={t.def.id} className={`key${t.on ? " active" : ""}`} aria-pressed={t.on}
              title={t.def.note}
              onClick={() => setSessionToggle(g.id, active.id, t.def.id, nextToggleValue(t), `${g.name} · ${t.def.label}`)}>
              {t.on ? <ToggleRight size={ICON} /> : <ToggleLeft size={ICON} />} {t.def.label}: {t.on ? "on" : "off"}{t.overridden ? "" : " (default)"}
            </button>
          ))}
          {g.mayAnswer !== null && (
            <>
              <button className={`key${g.mayAnswer ? " active" : ""}`} aria-pressed={g.mayAnswer}
                onClick={() => setSessionAnswer(g.id, g.name, active.id, !g.mayAnswer)}>
                <Bot size={ICON} /> let {g.name} answer: {g.mayAnswer ? "on" : "off"}
              </button>
              <div className="plugin-menu-note">
                {g.mayAnswer ? `${g.name} may pick an option in this session's choice boxes without a tap.` : `Off: ${g.name} can only suggest here.`}{" "}
                {BRAND.displayName} itself still refuses permission, plan, trust and destructive boxes, whatever this says.
              </div>
            </>
          )}
          {g.actions.map((a) => {
            const r = res[actionKey(g.id, a.id, active.id)];
            return (
              <button key={a.id} className="key" title={a.note}
                onClick={() => { dismiss(); runPluginAction(g.id, a.id, active.id); }}>
                <Play size={ICON} /> {a.label}{r?.pending ? " …" : ""}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}

/** A session row's plugin badges (text + tone), where the oracle's tag was. */
export function PluginBadges({ s }: { s: Pick<SessionInfo, "pluginBadges"> }): ReactNode {
  const list = useStore(plugins);
  const badges = sessionBadges(s, list);
  if (!badges.length) return null;
  return <>{badges.map(({ id, name, badge }) => <BadgeTag key={id} name={name} badge={badge} />)}</>;
}

function BadgeTag({ name, badge }: { name: string; badge: PluginBadge }) {
  return (
    <span className={`tag plugin-badge plugin-${badge.tone}`} title={`${name}: ${badge.text}`}>
      <Puzzle size={12} /> {badge.text}
    </span>
  );
}
