/**
 * One extension's count chip on a repo group's row (`RepoChipDef`). A COUNT IS A FILTER: the tap
 * opens exactly the rows the number counts (`def.open(repo, filter)`), and that sheet says "n of N".
 *
 * `useCount` is a HOOK, so it is called here — once per render, unconditionally, before any early
 * return — and nowhere else. The caller wraps this in `ExtBoundary`, so a def that throws draws one
 * sentence instead of taking the launcher down.
 */
import type { RepoTarget } from "@waterplane/shared";
import type { RepoChipDef } from "../../sdk/types.ts";
import { track } from "../../usage";
import { core } from "../api.ts";

export function ExtRepoChip({ def, repo }: { def: RepoChipDef; repo: RepoTarget }) {
  const r = def.useCount(repo);
  if (!r || !(r.n > 0)) return null;
  const Icon = def.icon;
  return (
    <button className="repo-group-stat" title={r.title}
      onClick={() => { track(`action:repo.chip.${def.id}`); def.open(repo, r.filter, core()); }}>
      <Icon size={12} />{r.label ? `${r.label} ` : ""}{r.n}
    </button>
  );
}
