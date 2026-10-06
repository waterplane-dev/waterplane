import { useEffect, useState } from "react";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import type { ComplianceReport, ContextLimitsView, ContextWeightLimits } from "@waterplane/shared";
import { CHARS_PER_TOKEN, CONTEXT_LIMIT_BOUNDS, contextLimitError } from "@waterplane/shared";
import { api } from "./api";
import { track } from "./usage";

/**
 * The line the `context-weight` row is measured against, for THIS repo.
 *
 * Why it exists: the row's sentence said "over the 16k you asked to be warned
 * at" about a number nobody had ever been offered. The thresholds were three
 * env vars on the desktop — host-wide, invisible from the phone, and needing a
 * restart — so the two repos that most need different lines (a scratch project,
 * and one whose invariants are genuinely load-bearing) had to share one. The
 * second kind then sits amber for ever, and an amber that cannot be answered is
 * an amber that gets ignored, which costs the check its whole point.
 *
 * Shape, and the reasons:
 *
 *  - **It opens on the STORED override, not on the effective number.** Those
 *    differ whenever the host's env is doing the work, and pre-filling the
 *    effective value would silently convert "inheriting 20k from the host" into
 *    "pinned at 20k for ever" the moment anybody pressed Save.
 *  - **A blank field is not a zero — it is "inherit".** So one knob moves
 *    without freezing the other two at today's defaults.
 *  - **Every value states where it comes from.** `default` / `set on this host`
 *    / `set for this repo` is the whole reason the sentence upstairs can be
 *    trusted.
 *  - **Nothing is greyed out.** A refusal is a sentence (house rule: a
 *    `title` is invisible on a phone), and the host refuses too — this form
 *    validates for speed, never as the gate.
 */

const FIELDS: { key: keyof ContextWeightLimits; label: string; hint: string; chars: boolean }[] = [
  { key: "maxChars", label: "warn above", hint: "always-on chars before the row goes amber", chars: true },
  { key: "hardChars", label: "steep above", hint: "where it stops being a rounding error", chars: true },
  { key: "maxSkills", label: "skills before a mention", hint: "descriptions are always-on even when no skill is", chars: false },
];

const SOURCE_WORD = {
  default: "default",
  env: "set on this host",
  repo: "set for this repo",
} as const;

/** `16k` / `2.5k` / `900` — the same shortening the sentence upstairs uses, so
 *  the number in the form reads as the number in the paragraph. */
function shorten(n: number): string {
  if (n < 1_000) return String(n);
  const k = n / 1_000;
  if (k >= 10) return `${Math.round(k)}k`;
  const one = Math.round(k * 10) / 10;
  return `${Number.isInteger(one) ? one : one.toFixed(1)}k`;
}

type Draft = Record<keyof ContextWeightLimits, string>;

const draftFrom = (v: ContextLimitsView): Draft => ({
  maxChars: v.repo?.maxChars != null ? String(v.repo.maxChars) : "",
  hardChars: v.repo?.hardChars != null ? String(v.repo.hardChars) : "",
  maxSkills: v.repo?.maxSkills != null ? String(v.repo.maxSkills) : "",
});

export function ContextLimitsEditor({ repoId, view, setAt, onReport }: {
  repoId: string;
  view: ContextLimitsView;
  /** When this repo's override was written, or null. Shown, never load-bearing. */
  setAt?: number | null;
  /** The re-run report the host answers with — the row above must restate itself
   *  against the new line, or the user has to re-check to believe the change. */
  onReport: (r: ComplianceReport) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(view));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the host answers, or when the sheet switches repo: the form is
  // a view of a stored override, and holding a stale draft over a different
  // repo's numbers is how somebody saves one repo's line onto another.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on repo and the serialised `view.repo` so a re-run report re-seeds the draft; `view` itself changes identity too often
  useEffect(() => { setDraft(draftFrom(view)); setError(null); }, [repoId, JSON.stringify(view.repo)]);

  const hasOverride = !!view.repo && Object.keys(view.repo).length > 0;

  /** Local validation, for a sentence before the round trip. The host runs the
   *  same rule from `@waterplane/shared` and is the one that decides. */
  const localError = (): string | null => {
    for (const f of FIELDS) {
      const raw = draft[f.key].trim();
      if (!raw) continue;
      const err = contextLimitError(f.key, Number(raw));
      if (err) return err;
    }
    const warn = Number(draft.maxChars.trim() || view.effective.maxChars);
    const hard = Number(draft.hardChars.trim() || view.effective.hardChars);
    if (Number.isFinite(warn) && Number.isFinite(hard) && hard < warn) {
      return `The steep line (${shorten(hard)}) is below the warn line (${shorten(warn)}) — it would never fire. Raise it, or leave it blank to inherit.`;
    }
    return null;
  };

  async function save(reset: boolean) {
    const bad = reset ? null : localError();
    if (bad) { setError(bad); return; }
    track(reset ? "action:setup.limits.reset" : "action:setup.limits.save");
    setBusy(true);
    setError(null);
    try {
      const patch: Record<string, number> = {};
      if (!reset) {
        for (const f of FIELDS) {
          const raw = draft[f.key].trim();
          if (raw) patch[f.key] = Number(raw);
        }
      }
      const r = await api.complianceLimits(repoId, reset ? { reset: true } : patch);
      if (r.ok && r.report) { onReport(r.report); setOpen(false); }
      else setError(r.error || "the host refused the change");
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="check-acts">
        <button className="key" onClick={() => setOpen(true)}>
          <SlidersHorizontal size={12} /> thresholds{hasOverride ? " (set here)" : ""}
        </button>
      </div>
    );
  }

  const warnPreview = Number(draft.maxChars.trim() || view.effective.maxChars);

  return (
    <div className="ctxlim">
      <div className="form-hint">
        What this repo is measured against. Leave a field blank to inherit the
        host's line — blank is “inherit”, not zero.
      </div>
      {FIELDS.map((f) => (
        <label key={f.key} className="form-hint">
          {f.label} — now {f.chars ? shorten(view.effective[f.key]) : view.effective[f.key]} ({SOURCE_WORD[view.source[f.key]]})
          <input
            className="search"
            type="number"
            inputMode="numeric"
            min={CONTEXT_LIMIT_BOUNDS[f.key].min}
            max={CONTEXT_LIMIT_BOUNDS[f.key].max}
            step={f.chars ? 1_000 : 1}
            placeholder={`inherit ${f.chars ? shorten(view.effective[f.key]) : view.effective[f.key]}`}
            value={draft[f.key]}
            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
          />
          <span style={{ opacity: 0.7 }}>{f.hint}</span>
        </label>
      ))}
      {Number.isFinite(warnPreview) && warnPreview > 0 && (
        <div className="form-hint">
          A warn line of {shorten(warnPreview)} chars is ~{shorten(Math.round(warnPreview / CHARS_PER_TOKEN))} tokens
          on every turn of every session and every subagent here.
        </div>
      )}
      {view.note && <div className="form-hint">{view.note}</div>}
      {error && <div className="form-hint" style={{ color: "var(--dead)" }}>{error}</div>}
      <div className="check-acts">
        <button className="key" onClick={() => void save(false)}>
          {busy ? "saving…" : "save for this repo"}
        </button>
        {/* Only offered when there is something to undo — and it says what it
            goes back TO, since "default" and "the host's line" are different
            things whenever an env knob is set. */}
        {hasOverride && (
          <button className="key" onClick={() => void save(true)}>
            <RotateCcw size={12} /> back to {Object.keys(view.env).length ? "the host's line" : "the default"}
          </button>
        )}
        <button className="key" onClick={() => { setOpen(false); setDraft(draftFrom(view)); setError(null); }}>
          cancel
        </button>
      </div>
      {hasOverride && setAt != null && (
        <div className="form-hint">Set for this repo {new Date(setAt).toLocaleDateString()}.</div>
      )}
    </div>
  );
}
