/**
 * One requirement: collapsed it is `id · status` and two lines of words; open it is the words in full,
 * who asked and when, the commits that shipped it, and what replaced it. Everything is TEXT (a `title`
 * is invisible on a phone). A commit opens the repo's git screen — the working tree only today; a
 * per-commit screen is a follow-up, so the subject and date are shown inline where they are known.
 */
import { ChevronDown, ChevronRight, GitCommit } from "lucide-react";
import type { RepoTarget } from "@waterplane/shared";
import { core } from "@waterplane/sdk";
import type { ReqItem, ReqList } from "../shared/methods.mts";
import { askedWords } from "./cut.ts";
import { Button, Hint } from "@waterplane/kit";

const CLAMP = { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as const;

export function ItemRow({ it, list, repo, open, onToggle, onFocus }: {
  it: ReqItem;
  list: ReqList;
  repo: RepoTarget;
  open: boolean;
  onToggle: () => void;
  /** Jump to another item by id. */
  onFocus: (id: string) => void;
}) {
  const Chev = open ? ChevronDown : ChevronRight;
  const target = it.supersededBy ? list.items.find((i) => i.id === it.supersededBy) : null;
  return (
    <li className={`check-row req-${it.status}`} data-req={it.id}>
      <Button style={{ textAlign: "left", justifyContent: "flex-start", gap: 6, width: "100%" }}
        aria-expanded={open} onClick={onToggle}>
        <Chev size={14} /><span className="mono">{it.id}</span> · {it.status}
      </Button>
      <div style={open ? undefined : CLAMP}>{it.text}</div>
      {open && (
        <>
          {it.asked.length > 0 && <Hint>asked: {askedWords(it.asked)}</Hint>}
          {/* The session is text only: no CoreApi verb resolves an 8-char conversation prefix. */}
          {it.shipped.map((sha) => {
            const c = list.commits[sha];
            return c ? (
              <Button key={sha} style={{ textAlign: "left", justifyContent: "flex-start", gap: 6 }}
                onClick={() => core().nav.openGit(repo.id)}>
                <GitCommit size={14} /> {sha} — {c.subject}{c.date ? ` (${c.date})` : ""}
              </Button>
            ) : (
              <Hint key={sha}>{sha} — not in this repo’s history</Hint>
            );
          })}
          {it.supersededBy && (target
            ? <Button style={{ textAlign: "left", justifyContent: "flex-start" }} onClick={() => onFocus(target.id)}>
                superseded by {target.id}
              </Button>
            : <Hint>superseded by {it.supersededBy} — not in this list</Hint>)}
        </>
      )}
    </li>
  );
}
