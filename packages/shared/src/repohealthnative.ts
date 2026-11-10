/**
 * Reading `plot.native` — what the repo's own tools say — off the engine's JSON.
 *
 * Same contract as `repohealthhabits.ts`: rebuilt from the fields it NAMES
 * (`test/repohealth.test.mjs` fails until every key path the engine emits is
 * named here), optional as a block, dropped WHOLE when malformed. A part that
 * says it is `absent` keeps only the sentence.
 */
import type { RepoHealthNativeAnalyzer, RepoHealthPlotNative } from "./repohealth.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);

type Part<T> = ({ absent?: undefined } & T) | { absent: string };

function part<T>(v: unknown, shape: (o: Rec) => T | null): Part<T> | null {
  if (!isRec(v)) return null;
  if (isStr(v.absent)) return { absent: v.absent };
  const t = shape(v);
  return t ? ({ ...t } as Part<T>) : null;
}

export function readNative(v: unknown): RepoHealthPlotNative | null {
  if (!isRec(v)) return null;
  if (v.absent !== undefined && !isStr(v.absent)) return null;

  const vulns = part(v.vulns, (o) => {
    if (!isNum(o.total) || !isNum(o.packages) || !isNum(o.lockfiles) || !isNum(o.itemsTotal) || !isRec(o.bySeverity) || !Array.isArray(o.items)) return null;
    const bySeverity: Record<string, number> = {};
    for (const [k, n] of Object.entries(o.bySeverity)) {
      if (!isNum(n)) return null;
      bySeverity[k] = n;
    }
    const items: { package: string; version: string; severity: string; ids: string[] }[] = [];
    for (const i of o.items) {
      if (!isRec(i) || !isStr(i.package) || !isStr(i.version) || !isStr(i.severity) || !Array.isArray(i.ids) || !i.ids.every((x) => typeof x === "string")) return null;
      items.push({ package: i.package, version: i.version, severity: i.severity, ids: i.ids as string[] });
    }
    return { total: o.total, packages: o.packages, lockfiles: o.lockfiles, bySeverity, items, itemsTotal: o.itemsTotal };
  });
  if (!isRec(v.dependencyAge) || !isStr(v.dependencyAge.absent)) return null;
  const dependencyAge = { absent: v.dependencyAge.absent };

  if (!Array.isArray(v.analyzers)) return null;
  const analyzers: RepoHealthNativeAnalyzer[] = [];
  for (const a of v.analyzers) {
    if (!isRec(a) || !isStr(a.key) || !isStr(a.label) || !isStr(a.tool)) return null;
    if (!numOrNull(a.findings) || !numOrNull(a.lines) || !numOrNull(a.per1000)) return null;
    if (a.note !== undefined && !isStr(a.note)) return null;
    if (a.absent !== undefined && !isStr(a.absent)) return null;
    const out: RepoHealthNativeAnalyzer = { key: a.key, label: a.label, tool: a.tool, findings: a.findings, lines: a.lines, per1000: a.per1000 };
    if (isStr(a.note)) out.note = a.note;
    if (isStr(a.absent)) out.absent = a.absent;
    analyzers.push(out);
  }

  const strictness = part(v.strictness, (o) => {
    if (!isNum(o.total) || !Array.isArray(o.facts)) return null;
    const facts: { kind: "typescript" | "mypy" | "dart"; path: string; settings: Record<string, boolean | null> }[] = [];
    for (const f of o.facts) {
      if (!isRec(f) || !isStr(f.path) || !isRec(f.settings)) return null;
      if (f.kind !== "typescript" && f.kind !== "mypy" && f.kind !== "dart") return null;
      const settings: Record<string, boolean | null> = {};
      for (const [k, b] of Object.entries(f.settings)) {
        if (b !== null && typeof b !== "boolean") return null;
        settings[k] = b;
      }
      facts.push({ kind: f.kind, path: f.path, settings });
    }
    return { facts, total: o.total };
  });
  const coverage = part(v.coverage, (o) => {
    if (!isNum(o.total) || !Array.isArray(o.files)) return null;
    const files: { path: string; kind: string; covered: number; total: number; percent: number }[] = [];
    for (const f of o.files) {
      if (!isRec(f) || !isStr(f.path) || !isStr(f.kind) || !isNum(f.covered) || !isNum(f.total) || !isNum(f.percent)) return null;
      files.push({ path: f.path, kind: f.kind, covered: f.covered, total: f.total, percent: f.percent });
    }
    return { files, total: o.total };
  });
  if (!vulns || !strictness || !coverage) return null;

  const out: RepoHealthPlotNative = { vulns, dependencyAge, analyzers, strictness, coverage };
  if (isStr(v.absent)) out.absent = v.absent;
  return out;
}
