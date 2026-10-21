/**
 * The usage meter: one segment per usage SOURCE that has a reading (claude,
 * copilot, a plugin's own), side by side. A source with nothing to say draws
 * nothing — never a `?` — EXCEPT claude: whenever the phone holds claude's
 * scrape and no claude reading came of it, claude still draws today's `?/? wk`
 * door beside the others (`claudeDoorBeside`), so a claude user never loses the
 * "nothing parsed" hint to another account's segment. A tap on a NON-claude
 * segment is a FILTER: it opens the token statistics on that source
 * (`openTokensOn` of `tokensOpenSource`) and the screen says which others it is
 * not showing; claude's opens the default view, as it always has.
 * `shared/usagesources.ts`'s `chipCut` is the one cut.
 *
 * A desktop with only Claude draws exactly the chip it always had: ONE button,
 * claude's markup (pinned by `usageChip.test.mjs`). With more, the group draws
 * the Gauge ONCE (on its first segment) and its buttons wear `.topbar > .key`'s
 * metrics, so claude's own segment keeps its width when a second source appears.
 */
import { Clock, Gauge } from "lucide-react";
import { chipCut, usageReadingTitle, type ChipSegment, type UsageInfo } from "@waterplane/shared";
import { hhmm, usageTitle } from "../../format";
import { track } from "../../usage";
import { claudeDoorBeside, claudeSegmentFigures, figuresHot, headerReadings, hiddenNote, infoFigures, launcherReadings, openTokensOn, tokensOpenSource, useUsage, useUsageReadings, type ClaudeFigures } from "../../features/tokens";
import { Button } from "../../kit/Button";
import { RowSub } from "../../kit/Row";

const ICON = 16;
const TAP = "\ntap for both windows, their reset times and the token history";
const TAP_OTHER = "\ntap for its quota windows and the readings kept";

/** Both windows: the 5-hour one paces the next hour, the weekly one is what
 *  actually strands you for days — showing only the former hid a 90% week behind
 *  a comfortable-looking 11%. The 5-hour reset rides right after THAT number,
 *  never after "wk", where it read as the week's. */
function ClaudeFace({ f, size, gauge = true }: { f: ClaudeFigures; size: number; gauge?: boolean }) {
  return (
    <>
      {gauge && <Gauge size={size} />}
      <span className={(f.sess ?? 0) >= 80 ? "usage-hot" : ""}>{f.sess != null ? `${f.sess}%` : "?"}</span>
      {f.sessResetAt != null && (
        <span className="usage-unit usage-reset"><Clock size={11} /> {hhmm(f.sessResetAt)}</span>
      )}
      <span className="usage-sep">/</span>
      <span className={(f.wk ?? 0) >= 80 ? "usage-hot" : ""}>{f.wk != null ? `${f.wk}%` : "?"}</span>
      <span className="usage-unit">wk</span>
    </>
  );
}

/** Any other source: `Copilot 5% mo`. A dollar-only source has no unit. */
function OtherFace({ seg, size, gauge = true }: { seg: ChipSegment; size: number; gauge?: boolean }) {
  return (
    <>
      {gauge && <Gauge size={size} />}
      <span className="usage-label">{seg.label}</span>
      <span className={seg.hot ? "usage-hot" : ""}>{seg.text}</span>
      {seg.unit && <span className="usage-unit">{seg.unit}</span>}
    </>
  );
}

/** The long-press wording of one segment (claude keeps `usageTitle`, byte for byte). */
export function segmentTitle(seg: ChipSegment, usage: UsageInfo | null, now = Date.now()): string {
  const base = seg.source === "claude" && usage ? usageTitle(usage) : usageReadingTitle(seg.reading, now);
  return `${base}${seg.source === "claude" ? TAP : TAP_OTHER}${hiddenNote(seg.hidden)}`;
}

/** The launcher's chip. Another backend's quota only while one of its sessions runs (`launcherReadings`). */
export function UsageChip({ sessions }: { sessions: readonly { backend?: string; running: boolean }[] }) {
  const usage = useUsage();
  const readings = launcherReadings(useUsageReadings(), sessions);
  const { segments } = chipCut(readings, 3);
  const open = (seg: ChipSegment) => { track("overlay:tokens"); openTokensOn(tokensOpenSource(seg.source)); };
  // Today's chip over the bare scrape (`?` for what the CLI printed none of): alone when no source
  // has a reading, and FIRST in the group when others do but claude's scrape gave none.
  const door = () => {
    const f = infoFigures(usage);
    return (
      <Button key="claude" className={`usage-key ${figuresHot(f) ? "danger" : ""}`} title={`${usageTitle(usage)}${TAP}`}
        onClick={() => { track("overlay:tokens"); openTokensOn(null); }}>
        <ClaudeFace f={f} size={ICON} />
      </Button>
    );
  };

  if (!segments.length) return door();
  const withDoor = claudeDoorBeside(segments, usage);
  const group = withDoor || segments.length > 1;
  const buttons = segments.map((seg, i) => {
    const claude = seg.source === "claude";
    const f = claude ? claudeSegmentFigures(seg.reading, usage) : null;
    // One Gauge per meter: on the lone button, else on the group's first segment only.
    const gauge = !group || (!withDoor && i === 0);
    return (
      <Button key={seg.source} className={`usage-key${group ? " usage-seg" : ""} ${(f ? figuresHot(f) : seg.hot) ? "danger" : ""}`}
        title={segmentTitle(seg, usage)} onClick={() => open(seg)}>
        {f ? <ClaudeFace f={f} size={ICON} gauge={gauge} /> : <OtherFace seg={seg} size={ICON} gauge={gauge} />}
      </Button>
    );
  });
  return group ? <div className="usage-multi">{withDoor && door()}{buttons}</div> : <>{buttons}</>;
}

/**
 * The session header's inline readings: only this backend's own account (a
 * claude session shows claude; a different binary's quota is a wrong number).
 * Claude's segment keeps the `sess … resets … · wk …` markup it has always had.
 */
export function SessionUsage({ backend }: { backend: string | null | undefined }) {
  const usage = useUsage();
  const all = useUsageReadings();
  const { segments } = chipCut(headerReadings(all, backend), 3);
  const open = (seg: ChipSegment | null) => { track("overlay:tokens"); openTokensOn(seg ? tokensOpenSource(seg.source) : null); };

  const claudeInline = (f: ClaudeFigures, title: string, seg: ChipSegment | null) => (
    <RowSub key={seg?.source ?? "claude"} className={`usage-inline${(f.sess ?? 0) >= 80 ? " danger" : ""}`} title={title} onClick={() => open(seg)}>
      {/* The reset belongs to the 5-hour window, so it sits beside that
          number — at the end of the strip it read as the week's. */}
      <Gauge size={11} /> sess {f.sess != null ? `${f.sess}%` : "?"}
      {f.sessResetAt != null && <> resets {hhmm(f.sessResetAt)}</>}
      {" · "}wk {f.wk != null ? `${f.wk}%` : "?"}
    </RowSub>
  );
  if (!segments.length) return claudeInline(infoFigures(usage), `${usageTitle(usage)}${TAP}`, null);
  return <>{segments.map((seg: ChipSegment) => seg.source === "claude"
    ? claudeInline(claudeSegmentFigures(seg.reading, usage), segmentTitle(seg, usage), seg)
    : (
      <RowSub key={seg.source} className={`usage-inline${seg.hot ? " danger" : ""}`} title={segmentTitle(seg, usage)} onClick={() => open(seg)}>
        <Gauge size={11} /> {seg.label} {seg.text}{seg.unit ? ` ${seg.unit}` : ""}
      </RowSub>
    ))}</>;
}
