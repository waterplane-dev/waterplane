/**
 * Tools' plugin rows: one searchable row, `plugins`, drawing a section per
 * installed plugin inside it (a plugin's own fields are DYNAMIC, so they cannot
 * each be a catalogued row — they are nested controls with no id, which
 * `SettingsKit` counts under their parent), and the decision log's door in the
 * rack.
 *
 * Everything drawn here is DECLARED by the plugin's manifest and drawn by the
 * app's own controls — the phone never runs plugin code.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Download, FolderOpen, KeyRound, Play, Puzzle, ScrollText, XCircle } from "lucide-react";
import { BRAND, PLUGIN_MANIFEST } from "@waterplane/shared";
import type { PluginField, PluginView } from "@waterplane/shared";
import { useCore, useStore } from "../../sdk";
import { ConfirmButton } from "../../Confirm";
import { SetAction, SetChoice, SetCustom, SetNote, SetPick, SetSwitch, SetWarn, useNestedShown } from "../../SettingsKit";
import { enablePlugin, openDecisions, refuseValue, runPluginAction, setPluginValue } from "./actions";
import { actionKey, envRows, fieldValue, globalActions, parseFieldInput, pluginStateLine, pluginWords } from "./logic";
import { errors, plugins as pluginStore, results } from "./store";
import { Button, RowSub, Tag } from "../../kit";
import { AddByUrl, ApplyNote, AvailableList, CheckedLine, MaturityTag } from "./UpdatesParts";
import { updatePlugin } from "./updatesActions";
import { installedRows } from "./logic";
import type { InstalledRow } from "./logic";
import { updatesStatus } from "./store";

/** The rack's door to the decision log. */
export function DecisionLogDoor() {
  return (
    <SetAction id="tool-decisions" compact label="decision log" icon={ScrollText}
      title="every usage-limit auto-continue and every plugin suggestion or answer"
      onClick={() => openDecisions(null)} />
  );
}

export function PluginsSettings() {
  const c = useCore();
  const list = useStore(pluginStore);
  const status = useStore(updatesStatus);
  const rows = installedRows(list ?? [], status);
  // The host sends the list on connect and after every change; asking once
  // when the screen comes up covers a phone that connected before an older
  // host knew the message. Nobody tapped anything, so no receipt.
  useEffect(() => {
    if (c.conn.status === "open") c.conn.send({ t: "plugin.list" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening of the screen, not on every reconnect (the host pushes the list itself)
  }, []);
  return (
    <SetCustom id="plugins" label="plugins" icon={Puzzle}
      note={`Code that runs on the desktop and extends ${BRAND.displayName}, with full access to it. A new or changed plugin takes effect after the desktop restarts.`}>
      {list === null && <SetNote>The desktop has not listed its plugins yet.</SetNote>}
      {list?.length === 0 && (
        <SetNote>
          No plugins installed. Install one below, or put a folder under <code>~/.config/{BRAND.configDirName}/plugins/</code> on the
          desktop (or list its path in <code>~/.config/{BRAND.configDirName}/plugin-paths.json</code>); the desktop loads plugins when it starts.
        </SetNote>
      )}
      {list?.map((p) => <PluginSection key={p.source} p={p} row={rows.find((r) => r.id === p.manifest.id)} />)}
      <CheckedLine status={status} />
      <AvailableList status={status} />
      <AddByUrl />
    </SetCustom>
  );
}

const TONE_ICON = { ok: CheckCircle2, bad: XCircle, dim: CircleDashed } as const;

function PluginSection({ p, row }: { p: PluginView; row: InstalledRow | undefined }) {
  const m = p.manifest;
  const err = useStore(errors)[m.id];
  const res = useStore(results);
  const state = pluginStateLine(p);
  const StateIcon = TONE_ICON[state.tone];
  const env = envRows(p);
  // Under a query only its own words answer, the sections beside it step aside.
  if (!useNestedShown("plugins", pluginWords(p))) return null;
  return (
    <div className="plugin-sec">
      <div className="plugin-head">
        <b>{m.name}</b> <RowSub>v{m.version}</RowSub>
        {row?.untagged && <RowSub>{row.untagged}</RowSub>}
        {row && <MaturityTag m={row.maturity} />}
        {m.experimental === true && m.maturity === undefined && <Tag>experimental</Tag>}
        <Tag className={`plugin-${state.tone}`}><StateIcon size={12} /> {p.state}</Tag>
      </div>
      {row?.due && (
        <div className="plugin-head">
          <RowSub>{row.due.from ?? `v${m.version}`} → {row.due.to}</RowSub>
          <Button variant="primary" onClick={() => updatePlugin(m.id, m.name, row.due!.from, row.due!.to, { fromOrg: row.fromOrg, url: row.url })}><Download size={14} /> update</Button>
        </div>
      )}
      <ApplyNote target={{ kind: "plugin-update", id: m.id }} />
      {m.description && <SetNote>{m.description}</SetNote>}
      <SetNote className="plugin-src">{row?.source} · <FolderOpen size={12} /> <code>{p.source}</code></SetNote>
      {state.tone !== "ok" && <SetWarn tone={state.tone === "bad" ? "bad" : "plain"}>{state.text}</SetWarn>}
      {p.status && p.state === "active" && (
        <SetWarn tone={p.status.tone === "bad" ? "bad" : "plain"} icon={p.status.tone === "ok" ? CheckCircle2 : AlertTriangle}>
          {p.status.text}
        </SetWarn>
      )}
      {(p as PluginView & { manifestLegacy?: boolean }).manifestLegacy && (
        <SetWarn icon={AlertTriangle}>This plugin still uses an older manifest file name. It loads, but rename it to <code>{PLUGIN_MANIFEST}</code>; the old name will stop working in a later release.</SetWarn>
      )}
      {err && <SetWarn icon={AlertTriangle}>{err}</SetWarn>}
      <SetSwitch label={`use ${m.name}`} icon={Puzzle} on={p.enabled} onChange={() => enablePlugin(p, !p.enabled)}
        note={p.enabled ? undefined : "Off: the desktop does not activate it, and it sees nothing."} />
      {env.length > 0 && (
        <SetNote className="plugin-env">
          <KeyRound size={12} /> {env.map((e, i) => (
            <span key={e.name}>{i > 0 && " · "}<code>{e.name}</code> {e.set ? "set" : "not set"}</span>
          ))}
          {env.some((e) => !e.set) && <> — set it with the secret tool, or in the desktop&apos;s environment.</>}
        </SetNote>
      )}
      {p.state !== "error" && (m.settings ?? []).map((f) => <PluginFieldRow key={f.key} p={p} f={f} />)}
      {p.state === "active" && globalActions(p).map((a) => {
        const r = res[actionKey(m.id, a.id)];
        return (
          <SetAction key={a.id} label={a.label} icon={Play} note={a.note} busy={r?.pending === true}
            onClick={() => runPluginAction(m.id, a.id)}>
            {r && !r.pending && <SetWarn tone={r.ok ? "plain" : "bad"}>{r.message}</SetWarn>}
          </SetAction>
        );
      })}
      {p.state !== "active" && globalActions(p).length > 0 && (
        <SetNote>Its {globalActions(p).length === 1 ? "action is" : `${globalActions(p).length} actions are`} here once it is active.</SetNote>
      )}
    </div>
  );
}

function PluginFieldRow({ p, f }: { p: PluginView; f: PluginField }) {
  const v = fieldValue(p, f);
  switch (f.kind) {
    case "switch":
      return <SetSwitch label={f.label} on={v === true} note={f.note} onChange={() => setPluginValue(p, f.key, !(v === true))} />;
    case "choice":
      // A handful reads as chips; a long list (model ids) is a `<select>`,
      // `SetPick`'s reason. A stored value no option names is shown AS ITSELF.
      if (f.options.length <= 4) {
        return <SetChoice label={f.label} value={String(v)} note={f.note}
          options={f.options.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(x) => setPluginValue(p, f.key, x)} />;
      }
      return <SetPick label={f.label} note={f.note} control={
        <select value={String(v)} onChange={(e) => setPluginValue(p, f.key, e.target.value)}>
          {!f.options.some((o) => o.value === v) && <option value={String(v)}>{String(v)}</option>}
          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      } />;
    case "number":
    case "text":
      return <TypedField p={p} f={f} value={String(v)} />;
  }
}

/**
 * A number or text field: typed into a local draft and SENT on save, never on
 * each keystroke. The draft is the person's words, so a host push that changes
 * the stored value while they type does not overwrite it (`local/no-draft-clobber`'s
 * rule): the draft only follows the host while it is untouched.
 */
function TypedField({ p, f, value }: { p: PluginView; f: Extract<PluginField, { kind: "number" | "text" }>; value: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const dirty = draft !== null && draft !== value;
  const save = () => {
    if (draft === null) return;
    const r = parseFieldInput(f, draft);
    if (!r.ok) { refuseValue(p.manifest.id, r.why); return; }
    setPluginValue(p, f.key, r.value);
    setDraft(null);
  };
  const unit = f.kind === "number" ? [f.unit, `${f.min}–${f.max}`].filter(Boolean).join(" · ") : "";
  const note = [f.note, unit].filter(Boolean).join(" — ") || undefined;
  const multiline = f.kind === "text" && f.multiline;
  return (
    <SetCustom label={f.label} note={note}>
      <div className={`plugin-field${multiline ? " multi" : ""}`}>
        {multiline ? (
          <textarea rows={6} value={shown} placeholder={f.placeholder} onChange={(e) => setDraft(e.target.value)} />
        ) : (
          <input type="text" inputMode={f.kind === "number" ? "decimal" : undefined} value={shown}
            placeholder={f.kind === "text" ? f.placeholder : undefined}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        )}
        {dirty && <Button onClick={save}>save</Button>}
        {dirty && <Button onClick={() => setDraft(null)}>undo edit</Button>}
        {/* Armed twice: the stored text may be the only copy of what
            somebody wrote (a system prompt), and a default is not an undo. */}
        {!dirty && String(f.default) !== value && (
          <ConfirmButton className="key" title="put the plugin's own default back"
            confirmTitle="tap again to replace the stored value with the default"
            confirm={<>replace it?</>}
            onConfirm={() => setPluginValue(p, f.key, f.default)}>reset to default</ConfirmButton>
        )}
      </div>
    </SetCustom>
  );
}
