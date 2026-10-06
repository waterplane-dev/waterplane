/**
 * A row's inline edit form: the one prompt surface (`PromptComposer`,
 * inline), label, the suggested title and its hint, kind, repo, session.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import type { BacklogItem, ItemCategory } from "@waterplane/shared";
import { ITEM_CATEGORIES, MAX_HEADLINE_CHARS } from "@waterplane/shared";
import { editTargetOptions, headlineEditHint } from "../backlogFilter";
import { PromptComposer } from "../PromptComposer";
import { RepoSelect } from "../RepoPicker";
import type { BacklogModel } from "./backlogTypes";

export function RowEditor({ m, it }: { m: BacklogModel; it: BacklogItem }) {
  const {
    editCategory, editHeadline, editLabel, editRepo, editTarget, editText, p, repoLabel, saveEdit, setEditCategory,
    setEditHeadline, setEditingId, setEditLabel, setEditRepo, setEditTarget, setEditText,
  } = m;
            const running = it.status === "running";
  return (
              <div key={it.id} className={`bl-row bl-${it.status} bl-edit`}>
                <div className="form" style={{ width: "100%" }}>
                  {/* The one prompt-writing surface (`PromptComposer`), inline:
                      this editor sits inside a list row with four more fields
                      under it. */}
                  <PromptComposer inline rows={3} prompts={[editText]}
                    onChange={(next) => setEditText(next[0] ?? "")} placeholder="Instruction…" />
                  <input className="search" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} placeholder="Label (optional)" />
                  {/* **The machine's title, and the one consequence of saving
                      it.** Editing a suggestion is how a wrong one costs a tap
                      rather than an argument — but saving makes it the
                      PERSON'S, stamped `hand` by the host, and from then on no
                      assessment and no naming pass will touch it again. The
                      sentence saying so is `headlineEditHint`'s, with every
                      other sentence on this sheet: it is a claim about the
                      host's stamp, and an inline literal is a claim nothing
                      pins. */}
                  <input className="search" value={editHeadline} maxLength={MAX_HEADLINE_CHARS}
                    onChange={(e) => setEditHeadline(e.target.value)} placeholder="Suggested title (optional)" />
                  <div className="form-hint">{headlineEditHint(it.headlineBy)}</div>
                  {/* **Absent is an answer**, so `— none —` is a real option and
                      not a placeholder: it clears the kind and its author, and
                      the row then draws no chip at all rather than a default
                      bucket nobody chose. */}
                  <select className="search" value={editCategory} aria-label="kind"
                    onChange={(e) => setEditCategory(e.target.value as ItemCategory | "")}>
                    <option value="">— none —</option>
                    {ITEM_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {/* `keepValue`: an item whose repo has since gone must stay
                      offerable, or picking a session below silently re-aims it
                      at whatever sorts first. */}
                  {running
                    ? <span className="form-hint">{repoLabel(editRepo)}</span>
                    : <RepoSelect repos={p.repos} value={editRepo} keepValue aria-label="repo"
                        onChange={(dir) => { setEditRepo(dir); setEditTarget(""); }} />}
                  {/* **The target the row actually carries is always one of
                      the options**, closed or not (`editTargetOptions`): a
                      picker that quietly re-displayed a dead aim as *A new
                      session* made the one edit this group's own notes tell a
                      person to make — take the aim off — a tap that changed
                      nothing and saved nothing. A single option is not a
                      question, so with no sessions and no aim there is no
                      select. */}
                  {(() => {
                    const sess = p.sessions.filter((s) => s.running && s.cwd === editRepo);
                    const opts = editTargetOptions(sess, editTarget);
                    if (opts.length < 2 || running) return null;
                    return (
                      <select className="search" value={editTarget} aria-label="session"
                        onChange={(e) => setEditTarget(e.target.value)}>
                        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    );
                  })()}
                  <div className="annot-tools">
                    {/* Also gated here, not only on the pencil: the socket can drop
                        while the editor is open, and `backlog.update` is a bare
                        send that would then be dropped silently. */}
                    {editText.trim() && p.online && <button className="send" onClick={() => saveEdit(it)}>Save</button>}
                    <button className="key" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                  {!editText.trim() && <div className="form-hint">Nothing to save — type the task text.</div>}
                  {running && <div className="form-hint">Repo & session can't change while running.</div>}
                  {!p.online && <div className="form-hint">Offline — edits can't be saved until the connection is back.</div>}
                </div>
              </div>
  );
}
