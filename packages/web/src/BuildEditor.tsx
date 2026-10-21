import { useState } from "react";
import { AlertTriangle, Check, CloudOff, HelpCircle, Loader, Plus, Search, Trash2, Wand2, X } from "lucide-react";
import type { BuildCandidate, BuildConfig, BuildParam } from "@waterplane/shared";
import { cleanBuildParams, filterCandidates, paramEnvName, unknownParamRefs } from "@waterplane/shared";
import { ONE_BUILD_ASK, ONE_BUILD_ASK_NOTE, ONE_BUILD_LABEL, ONE_BUILD_NOTHING, ONE_BUILD_PLACEHOLDER, ONE_BUILD_TITLE, type BuildDraftSeed } from "./buildPrompt";
import { PromptComposer } from "./PromptComposer";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { ConfirmButton } from "./Confirm";
import { Empty } from "./Empty";
import { Unavailable } from "./Unavailable";
import { BuildScopeChoice } from "./BuildScopeChoice";
import { Button } from "./kit/Button";
import { Row, RowTitle, RowSub } from "./kit/Row";
import { Hint } from "./kit/Hint";
import { Tag } from "./kit/Tag";

/**
 * Add or edit one build command — and the reason this screen is not three blank
 * boxes any more.
 *
 * Typing `./gradlew assembleRelease -PbuildDir=…` into a phone keyboard is the
 * exact friction this app exists to remove, and the sheet's "set up" button —
 * which spends a whole agent turn reading the repo — is the wrong size of tool
 * for adding ONE more command. So the fields arrive with the repo's own answer
 * beside them: every command this project already describes, off its manifests,
 * its CI workflows and its scripts (`shared/buildscan.ts`). Free, instant, and
 * available while rate-limited, which is the state this sheet exists for.
 *
 * Three rules it follows, each of them load-bearing:
 *
 *  • **A suggestion is typing, not saving.** Tapping a row fills these fields
 *    and nothing else happens — the Save tap is still yours, the command is
 *    still editable, and nothing this list offers has run. That is what lets it
 *    be generous: a row you disagree with is a row you don't tap.
 *  • **The query is the fields you already typed.** Naming the button "release
 *    apk" narrows the list to the release APK, so the search box and the form
 *    are not two places to say one thing.
 *  • **Nothing here is dimmed to mean "no".** A repo whose manifests describe
 *    nothing gets a sentence saying exactly that, and one that has not answered
 *    yet gets a different one — an empty list and an unanswered one are not the
 *    same claim.
 */
export function BuildEditor({ draft, candidates, candidatesTotal, online, saved, scope, onAssist, onDelete, onCancel, onSave }: {
  draft: BuildConfig;
  candidates: BuildCandidate[] | null;
  candidatesTotal: number;
  online: boolean;
  /** Is this entry already in the repo's builds file? The wand's prompt says "edit
   *  this id in place" or "add one entry" off exactly this, and getting it
   *  wrong is how a sheet ends up with two buttons called "Release APK". */
  saved: boolean;
  /** Where this entry lives now; `null` = older host (no `localIds`), no control. */
  scope: { local: boolean } | null;
  /** Spend ONE agent turn on THIS entry, seeded with whatever is typed. The
   *  sheet's other wand reads the whole repo; this one is the right size for
   *  "the same as the release APK but for the other flavour". */
  onAssist: (seed: BuildDraftSeed) => void;
  /** Remove this entry from the repo's builds file. Drawn only for a `saved` one. */
  onDelete: () => void;
  onCancel: () => void;
  onSave: (b: BuildConfig, local: boolean) => void;
}) {
  const [local, setLocal] = useState(scope?.local ?? false);
  const [name, setName] = useState(draft.name);
  const [cmd, setCmd] = useState(draft.cmd);
  const [dir, setDir] = useState(draft.dir ?? "");
  const [params, setParams] = useState<BuildParam[]>(draft.params ?? []);
  /*
   * The wand's own question, asked HERE and not in the prompt.
   *
   * It read "ask me what I want before writing anything" and the session did
   * what a session does: it started working, on a button nobody had described.
   * A rule a model may decline is not a gate — so the question is a box in front
   * of the person now, `null` while it is shut, and NOTHING is spent until the
   * button under it is tapped.
   */
  const [brief, setBrief] = useState<string | null>(null);
  // The suggest list is open on a NEW build (nothing typed, everything to
  // offer) and shut on an edit, where the answer is already in the fields and
  // a list of sixty alternatives is just noise over them.
  const isNew = !draft.cmd && !draft.name;
  const [open, setOpen] = useState(isNew);

  // What is typed IS the query. An edit starts with its own command in the
  // boxes, which would filter the list down to itself, so the query only
  // follows the fields while this is a new build.
  const shown = filterCandidates(candidates ?? [], isNew ? `${name} ${dir}`.trim() : "");

  function use(c: BuildCandidate) {
    track("action:build.suggest.use");
    setName(c.name);
    setCmd(c.cmd);
    setDir(c.dir ?? "");
    setOpen(false);
  }

  // Placeholders the command (or the dir) names that no question answers. Not a
  // refusal and never a dimmed Save: the two ways to get here are a typo and a
  // half-finished edit, and both are cheaper to see now than in a shell error
  // twenty minutes later. The command runs with the braces still in it, which
  // is the loud failure `applyParams` deliberately keeps.
  const unknown = unknownParamRefs({ cmd, dir, params });

  return (
    <div className="sheet">
      <SheetHead title={<>{draft.cmd || draft.name ? "Edit build" : "New build"}</>} onClose={onCancel}>
        {/* The sheet's "set up" reads the whole repo and rewrites the list; this
            one is about the entry in front of you. Not gated on the link: it is
            the ordinary durable create-and-prompt path, so a tap on a dead
            tunnel opens the session when the link is back. */}
        <Button title={ONE_BUILD_TITLE}
          onClick={() => setBrief((b) => (b === null ? "" : null))}>
          <Wand2 size={16} /> {ONE_BUILD_LABEL}
        </Button>
      </SheetHead>
      <div className="form">
        <input className="search" placeholder="Name (e.g. Release APK)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <textarea className="search" rows={3} placeholder="Command (e.g. ./gradlew assembleRelease)" value={cmd}
          onChange={(e) => setCmd(e.target.value)} style={{ resize: "vertical", fontFamily: "monospace" }} />
        <input className="search" placeholder="Working sub-dir (optional, relative to repo root)" value={dir} onChange={(e) => setDir(e.target.value)} style={{ fontFamily: "monospace" }} />
      </div>
      {brief === null ? (
        <Hint>
          Tap <Wand2 size={12} style={{ verticalAlign: "-2px" }} /> {ONE_BUILD_LABEL} to say what you want in a sentence and have Claude work this one command out of the repo — one turn, this entry only.
        </Hint>
      ) : (
        <div className="build-assist">
          <div className="section">{ONE_BUILD_ASK}</div>
          {/* The one prompt-writing surface, inline — not a fifth textarea.
              `chain={false}`: this is a brief, not a conversation, and the
              session it opens is where anything further gets said. */}
          <PromptComposer inline rows={3} placeholder={ONE_BUILD_PLACEHOLDER}
            prompts={[brief]} onChange={(next) => setBrief(next[0] ?? "")} autoFocus />
          <Hint>{ONE_BUILD_ASK_NOTE}</Hint>
          <div className="sheet-actions">
            <Button onClick={() => setBrief(null)}><X size={16} /> cancel</Button>
            <span className="spacer" />
            {/* Nothing said and nothing typed ⇒ there is nothing to work out, and
                the verb is a SENTENCE rather than a dimmed button. A session
                opened on silence starts guessing, which is the bug this box is. */}
            {brief.trim() || name.trim() || cmd.trim()
              ? <button className="send" onClick={() => onAssist({ id: draft.id, brief, name, cmd, dir, existing: saved })}>
                <Wand2 size={14} /> {ONE_BUILD_LABEL}
              </button>
              : <Unavailable cants={[{ label: ONE_BUILD_LABEL, reason: ONE_BUILD_NOTHING }]} />}
          </div>
        </div>
      )}

      <ParamsEditor params={params} cmd={cmd} dir={dir} unknown={unknown} onChange={setParams} />

      {/* The count on the control is the count of what a tap opens — the
          filtered list, not the whole scan — so the number and the list cannot
          disagree. While the host has not answered, the control says it is
          reading rather than claiming a number. */}
      <div className="sheet-actions">
        <Button onClick={() => { if (!open) track("action:build.suggest.open"); setOpen(!open); }}>
          {/* A spinner is a promise that something is coming. The link can
              drop between opening this editor and the host answering, and a
              "reading the repo…" that spins for ever is the one thing this
              control must not become — so with no socket it says what is
              actually true instead. */}
          {candidates !== null
            ? <><Search size={16} /> {open ? "hide" : "suggest"} ({shown.length})</>
            : online
              ? <><Loader size={16} className="spin" /> reading the repo…</>
              : <><CloudOff size={16} /> no connection</>}
        </Button>
      </div>

      {open && (
        <div className="build-suggest">
          <Hint>
            From this repo’s own files — package.json scripts, gradle tasks, Makefile targets, CI workflow steps, scripts.
            Tap one to fill the fields above; nothing is saved or run until you tap Save.
            {candidates !== null && candidatesTotal > candidates.length && ` Showing the top ${candidates.length} of ${candidatesTotal} found.`}
          </Hint>
          <div className="list">
            {shown.map((c) => (
              <Row key={`${c.dir ?? ""}|${c.cmd}`} as="button" onClick={() => use(c)}>
                <RowTitle>
                  {c.name}
                  {c.already ? <> <Tag className="idle"><Check size={11} /> already a button</Tag></> : null}
                </RowTitle>
                <RowSub className="mono">{c.dir ? `${c.dir}$ ` : ""}{c.cmd}</RowSub>
                <RowSub>{c.source}</RowSub>
                {/* A publishing command is offered, not hidden — a release
                    script is a legitimate thing to want on a phone. What it is
                    NOT allowed to be is a surprise, since these run later with
                    nobody watching. */}
                {c.note ? <RowSub className="warn"><AlertTriangle size={12} /> {c.note}</RowSub> : null}
              </Row>
            ))}
            {/* Three different nothings, and they are not interchangeable: the
                host has not answered; it answered and this repo describes no
                build at all; or it described plenty and the words in the Name
                box match none of them. Only the last one is undone by clearing
                a filter, and only the middle one says anything about the
                repo. */}
            {shown.length === 0 && (candidates === null ? (
              online
                ? <Empty>Reading this repo’s manifests…</Empty>
                : <Empty>
                    No connection, so this repo’s files could not be read — the scan happens on the desktop.
                    Type the command above; it is saved when the link is back.
                  </Empty>
            ) : candidates.length === 0 ? (
              <Empty>
                Nothing in this repo describes a build — no package.json scripts, no gradle or Make targets, no CI steps.
                Type the command above, or close this and tap “set up” to have Claude work it out from the repo.
              </Empty>
            ) : (
              <Empty>
                None of this repo’s {candidates.length} known commands match “{`${name} ${dir}`.trim()}”. Clear the Name field to see all of them.
              </Empty>
            ))}
          </div>
        </div>
      )}

      {scope && <BuildScopeChoice local={local} wasShared={saved && !scope.local} onChange={setLocal} />}

      <div className="sheet-actions">
        <Button onClick={onCancel}><X size={16} /> cancel</Button>
        {/* Delete is here and not on the sheet's rows: you are looking at the
            whole command you are about to lose, and it takes two taps. */}
        {saved && (
          <ConfirmButton title="delete this build command" confirm={<><Trash2 size={16} /> delete it?</>}
            onConfirm={() => { track("action:build.delete"); onDelete(); }}><Trash2 size={16} /> delete</ConfirmButton>
        )}
        <span className="spacer" />
        <button className="send" disabled={!cmd.trim()} onClick={() => { track("action:build.save"); onSave({ ...draft, name, cmd, dir, params: cleanBuildParams(params) }, local); }}>Save</button>
      </div>
    </div>
  );
}

/**
 * What this button will ASK for — the editor's half of parameters.
 *
 * Five fields per question is a lot of form for a phone, which is why the wand
 * above it exists and why this section is SHUT until there is something to show
 * or somebody opens it: the common case is a button with no questions at all,
 * and it should cost nothing to look at.
 *
 * Nothing here is validated into silence. An id the rules refuse is kept in the
 * box exactly as typed and the row says what an id may be — `cleanBuildParams`
 * runs on Save, so a refused row is dropped from the file and a person who
 * cannot see why would have no way to tell that from a bug.
 */
function ParamsEditor({ params, cmd, dir, unknown, onChange }: {
  params: BuildParam[];
  cmd: string;
  dir: string;
  unknown: string[];
  onChange: (next: BuildParam[]) => void;
}) {
  const [open, setOpen] = useState(params.length > 0 || unknown.length > 0);
  const set = (i: number, patch: Partial<BuildParam>) =>
    onChange(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <>
      <div className="sheet-actions">
        <Button onClick={() => setOpen(!open)}>
          <HelpCircle size={16} /> {open ? "hide" : "asks for"} ({params.length})
        </Button>
        {open && (
          <Button onClick={() => onChange([...params, { id: "", kind: "text" }])}>
            <Plus size={16} /> question
          </Button>
        )}
      </div>

      {/* A placeholder nothing answers, said where it can still be fixed. It is
          not an error: the command runs with the braces in it and fails loudly,
          which is the only outcome readable off a build log afterwards. */}
      {unknown.length > 0 && (
        <Hint tone="warn">
          <AlertTriangle size={13} style={{ verticalAlign: "-2px" }} />{" "}
          {unknown.map((u) => `{{${u}}}`).join(", ")} {unknown.length === 1 ? "is" : "are"} in the command but nothing here answers {unknown.length === 1 ? "it" : "them"} — the shell will see the braces. Add a question with that id, or fix the spelling.
        </Hint>
      )}

      {open && (
        <div className="build-params">
          <Hint>
            A question is asked when you tap run. Its value is put into the command at <span className="mono">{"{{id}}"}</span> — and into the environment as <span className="mono">{paramEnvName("id")}</span>, whether the command names it or not. One question beats one button per app.
          </Hint>
          {params.map((p, i) => (
            <div key={i} className="build-param">
              <div className="set-row">
                <label>id
                  <input className="search mono" placeholder="app" value={p.id}
                    onChange={(e) => set(i, { id: e.target.value.trim() })} />
                </label>
                <label>label
                  <input className="search" placeholder="Garmin app" value={p.label ?? ""}
                    onChange={(e) => set(i, { label: e.target.value })} />
                </label>
                <label>kind
                  <select value={p.kind} onChange={(e) => set(i, { kind: e.target.value as BuildParam["kind"] })}>
                    <option value="text">typed in</option>
                    <option value="choice">picked from a list</option>
                  </select>
                </label>
                {p.kind === "choice" && (
                  <>
                    <label>list command
                      <input className="search mono" placeholder="ls -1 apps" value={p.optionsCmd ?? ""}
                        onChange={(e) => set(i, { optionsCmd: e.target.value })} />
                    </label>
                    <span className="set-note">Run in the repo root when the form opens, one option per line. Leave it empty and type the options below instead — a list that can change is better read than transcribed.</span>
                    <label>or fixed options
                      <input className="search" placeholder="debug, release" value={(p.options ?? []).join(", ")}
                        onChange={(e) => set(i, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
                    </label>
                  </>
                )}
                <label>default
                  <input className="search mono" placeholder="(none — an unattended run is refused)" value={p.default ?? ""}
                    onChange={(e) => set(i, { default: e.target.value })} />
                </label>
                <span className="set-note">
                  With no default, a run nobody is watching — a schedule, a chain, “run it now” — is refused in words rather than guessing this value.
                </span>
              </div>
              <div className="sheet-actions">
                {/* What this question is actually wired to, so an id that is in
                    the form but not in the command is visible here rather than
                    at run time. */}
                <RowSub>
                  {p.id && (cmd + " " + dir).includes(`{{${p.id}}}`)
                    ? <>in the command as <span className="mono">{`{{${p.id}}}`}</span></>
                    : p.id
                      ? <>only in the environment — the command does not name <span className="mono">{`{{${p.id}}}`}</span></>
                      : <>an id is <span className="mono">app</span>, <span className="mono">flavour</span> — a letter, then letters, digits or underscores</>}
                </RowSub>
                <span className="spacer" />
                <Button variant="danger" title="remove this question"
                  onClick={() => onChange(params.filter((_, j) => j !== i))}><Trash2 size={16} /></Button>
              </div>
            </div>
          ))}
          {params.length === 0 && <Empty>This button asks nothing — every tap runs the same command. Add a question to run it against one app, flavour or target.</Empty>}
        </div>
      )}
    </>
  );
}
