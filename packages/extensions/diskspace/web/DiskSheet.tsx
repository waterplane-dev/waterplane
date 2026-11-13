/**
 * The disk-space sheet: the data volume as one bar (free, and how much of the used part is
 * temporary or AI models), then four lists — temporary (a delete each, plus "clean all"), AI models
 * (a delete each), show-only (sizes, and how to free them by hand) and the on-demand large-file
 * search (show-only). Every delete is asked first (`askConfirm`, the size and what puts it back) and
 * sends the row's ID, never a path.
 *
 * Each row is one line — what it is, its size, a meter against the biggest row of its section — so
 * the eye finds the big ones; what puts a deletable row back is in its confirm, not under every row.
 * Nothing is greyed out: a row being deleted says "deleting…" in place of its button, a running
 * scan says so in a line, and the refresh button always works (the host joins a running scan).
 */
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, HardDrive, Search, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { useConnStatus, useStore } from "@waterplane/sdk";
import { StaleHead, ago, useNow, Button, Explain } from "@waterplane/kit";
import { LARGE_LIMIT_S, type DiskEntry, type DiskScan, type DiskState } from "../shared/wire.mts";
import { barTotals, byWeight, codeButton, codeLine, codeParts, entrySize, largeLine, resultLine, scanLine, sideLine, sizeText, splitLabel, total, totalText, volumeBar, wslVolumeLine } from "./logic.ts";
import { cleanAll, closeDisk, disk, removeEntry, rescan, scanCode, scanLarge, scanOnOpen } from "./state.ts";
import "./diskspace.css";

const RECENT_MS = 60 * 60_000;

/** Backticked words as code, the rest as text. */
function Words({ text }: { text: string }) {
  return <>{codeParts(text).map(([t, code], i) => code ? <code key={i} className="dk-code">{t}</code> : t)}</>;
}

function Label({ text }: { text: string }) {
  const [dir, last] = splitLabel(text);
  return <span className="dk-label">{dir && <span className="dk-dir">{dir}</span>}{last}</span>;
}

function Meter({ kb, max }: { kb: number | null; max: number }) {
  if (kb == null || max <= 0) return null;
  return <div className="dk-meter" aria-hidden><span style={{ width: `${Math.max(1, (kb / max) * 100)}%` }} /></div>;
}

function EntryRow({ e, s, max, deletable, group, howShown }: { e: DiskEntry; s: DiskState; max: number; deletable: boolean; group?: string; howShown?: boolean }) {
  const busy = s.deleting.some((d) => d.id === e.id);
  const sub = [
    // A lone row names its group, unless its own label already does (~/Library/Caches/Homebrew).
    group && !e.label.toLowerCase().includes(group.toLowerCase()) ? group : null,
    e.mtime != null ? `changed ${ago(e.mtime)}` : null,
    e.note,
    e.sizeNote && (e.sizeKb == null || e.partial) ? e.sizeNote : null,
    deletable && e.side === "wsl" ? sideLine(e.side) : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="dk-row">
      <div className="dk-body">
        <div className="dk-line">
          <Label text={e.label} />
          <span className={`dk-size${e.sizeKb == null ? " unknown" : ""}`}>{entrySize(e)}</span>
        </div>
        <Meter kb={e.sizeKb} max={max} />
        {sub && <div className="dk-sub"><Words text={sub} /></div>}
        {!deletable && !howShown && e.regen && <div className="dk-sub dk-how">To free it: <Words text={e.regen} /></div>}
      </div>
      {deletable && (busy
        ? <span className="dk-busy">deleting…</span>
        : <Button className="dk-del" aria-label={`delete ${e.label}`} onClick={() => void removeEntry(e, s.scan?.at ?? null)}>
            <Trash2 size={16} />
          </Button>)}
    </li>
  );
}

/** A section's groups: a group of one is a plain row (its group named in the row's sub line); a
 *  show-only group whose rows all free the same way says how once, under its head. */
function Groups({ rows, s, deletable }: { rows: DiskEntry[]; s: DiskState; deletable: boolean }) {
  const max = Math.max(0, ...rows.map((r) => r.sizeKb ?? 0));
  return (
    <>
      {byWeight(rows).map(([g, list]) => list.length === 1
        ? <ul key={g} className="dk-list"><EntryRow e={list[0]!} s={s} max={max} deletable={deletable} group={g} /></ul>
        : <Group key={g} g={g} list={list} s={s} max={max} deletable={deletable} />)}
    </>
  );
}

function Group({ g, list, s, max, deletable }: { g: string; list: DiskEntry[]; s: DiskState; max: number; deletable: boolean }) {
  const how = !deletable && list[0]?.regen && list.every((e) => e.regen === list[0]!.regen) ? list[0]!.regen : null;
  return (
    <div className="dk-group">
      <div className="dk-group-head"><span>{g}</span><span className="dk-size">{totalText(total(list))}</span></div>
      {how && <div className="dk-sub dk-how dk-group-how">To free it: <Words text={how} /></div>}
      <ul className="dk-list">{list.map((e) => <EntryRow key={e.id} e={e} s={s} max={max} deletable={deletable} howShown={!!how} />)}</ul>
    </div>
  );
}

function SectionHead({ title, size, explain, children }: { title: string; size?: string; explain?: string; children?: ReactNode }) {
  return (
    <div className="dk-sec">
      <h3 className="dk-sec-title">{title}</h3>
      {size && <span className="dk-sec-size">{size}</span>}
      {explain && <Explain of={title}>{explain}</Explain>}
      {children && <span className="dk-sec-act">{children}</span>}
    </div>
  );
}

function Volume({ scan }: { scan: DiskScan | null }) {
  const v = scan?.volume ?? null;
  if (!scan) return <div className="dk-vol"><div className="dk-vol-of">Free space: not read yet.</div></div>;
  const second = wslVolumeLine(scan.wslVolume);
  if (!v) return <div className="dk-vol"><div className="dk-vol-of">Free space could not be read.</div>{second && <div className="dk-vol-of">{second}</div>}</div>;
  const { tempKb, modelKb } = barTotals(scan);
  const bar = volumeBar(v, tempKb, modelKb);
  return (
    <div className={`dk-vol${bar?.low ? " low" : ""}`}>
      <div className="dk-vol-free">{v.label ? `${v.label} ` : ""}<b>{sizeText(v.freeKb)}</b> free</div>
      <div className="dk-vol-of">of {sizeText(v.totalKb)}{bar ? ` · ${Math.round(bar.freePct)}% free` : ""}</div>
      {bar && (
        <>
          <div className="dk-bar" role="img" aria-label={`${Math.round(bar.usedPct)}% used`}>
            {bar.tempPct > 0 && <span className="dk-seg temp" style={{ width: `${bar.tempPct}%` }} />}
            {bar.modelPct > 0 && <span className="dk-seg model" style={{ width: `${bar.modelPct}%` }} />}
            <span className="dk-seg other" style={{ width: `${bar.usedPct - bar.tempPct - bar.modelPct}%` }} />
          </div>
          {(bar.tempPct > 0 || bar.modelPct > 0) && (
            <div className="dk-legend">
              {bar.tempPct > 0 && <span><i className="temp" />temporary</span>}
              {bar.modelPct > 0 && <span><i className="model" />AI models</span>}
              <span><i className="other" />everything else</span>
              <span><i className="free" />free</span>
            </div>
          )}
        </>
      )}
      {second && <div className="dk-vol-of">{second}</div>}
    </div>
  );
}

export function DiskSheet() {
  const v = useStore(disk);
  const status = useConnStatus();
  const now = useNow(5_000);
  useEffect(() => { if (status === "open") void scanOnOpen(); }, [status]);

  const head = (
    <StaleHead title={<><HardDrive size={16} /> disk space</>} onClose={closeDisk} onRefresh={() => void rescan()}
      refreshTitle="scan again" at={v.res?.ok ? (v.res.result.scan?.at ?? null) : null} />
  );
  if (!v.res) return <div className="sheet">{head}<div className="empty">{status === "open" ? "Asking the desktop…" : "No connection — the desktop can't be asked from here."}</div></div>;
  if (!v.res.ok) return <div className="sheet">{head}<div className="empty">The desktop did not answer: {v.res.error}</div></div>;
  const s = v.res.result;
  const scan = s.scan;
  const line = scanLine(s, now, ago);
  const recent = s.results.filter((r) => now - r.at < RECENT_MS).slice(0, 6);
  const tempIdle = (scan?.temp ?? []).filter((e) => !s.deleting.some((d) => d.id === e.id));
  const large = s.large;
  const largeMax = Math.max(0, ...(large?.items ?? []).map((f) => f.sizeKb));
  const walkLine = codeLine(s, now, ago);
  const walkButton = codeButton(s);

  return (
    <div className="sheet">
      {head}
      <div className="sheet-scroll dk">
        <Volume scan={scan} />
        {(line || s.deleting.length > 0 || recent.length > 0 || (scan?.notes.length ?? 0) > 0) && (
          <ul className="dk-notes">
            {line && <li>{line}</li>}
            {s.deleting.length > 0 && <li>Deleting on the desktop: {s.deleting.map((d) => d.label).join(", ")}.</li>}
            {recent.map((r) => (
              <li key={`${r.id}-${r.at}`} className={r.ok ? "ok" : "bad"}>
                {r.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}<span>{resultLine(r, scan?.profile)}</span>
              </li>
            ))}
            {scan?.notes.map((n) => <li key={n}><Words text={n} /></li>)}
          </ul>
        )}

        {scan && (
          <>
            <SectionHead title="Temporary" size={totalText(total(scan.temp))}
              explain="Caches and build output: each rebuilds itself when it is needed again — a slower next build or download. Each delete says what puts it back before it runs.">
              {tempIdle.length > 0 && (
                <Button onClick={() => void cleanAll(tempIdle)}>
                  <Trash2 size={14} /> {tempIdle.length === scan.temp.length ? "clean all" : `clean the other ${tempIdle.length}`}
                </Button>
              )}
            </SectionHead>
            {(walkLine || walkButton) && (
              <div className="dk-walk">
                {walkLine && <div className="dk-sec-line">{walkLine}</div>}
                {s.code?.notes.map((n) => <div key={n} className="dk-sec-line"><Words text={n} /></div>)}
                {walkButton && <Button onClick={() => void scanCode()}><Search size={14} /> {walkButton}</Button>}
              </div>
            )}
            {scan.temp.length === 0
              ? <div className="empty">Nothing temporary found.</div>
              : <Groups rows={scan.temp} s={s} deletable />}

            <SectionHead title="AI models" size={totalText(total(scan.models))}
              explain="Hugging Face and Ollama downloads. Each is downloaded again the next time something asks for that model." />
            {scan.models.length === 0 ? <div className="empty">No Hugging Face or Ollama models found.</div> : <Groups rows={scan.models} s={s} deletable />}

            <SectionHead title="Show only"
              explain="Where else the space is. Nothing here can be deleted from the phone — each row says how to free it by hand." />
            {scan.show.length === 0 ? <div className="empty">None of these folders exist on this desktop.</div> : <Groups rows={scan.show} s={s} deletable={false} />}
          </>
        )}

        <SectionHead title="Large files">
          {!large?.running && <Button onClick={() => void scanLarge()}><Search size={14} /> {large ? "search again" : "search"}</Button>}
        </SectionHead>
        <div className="dk-sec-line">{largeLine(large, now, LARGE_LIMIT_S, ago)}</div>
        {large && large.items.length > 0 && (
          <ul className="dk-list">
            {large.items.map((f) => (
              <li key={f.path} className="dk-row">
                <div className="dk-body">
                  <div className="dk-line"><Label text={f.path} /><span className="dk-size">{sizeText(f.sizeKb)}</span></div>
                  <Meter kb={f.sizeKb} max={largeMax} />
                  {f.mtime != null && <div className="dk-sub">changed {ago(f.mtime)}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
