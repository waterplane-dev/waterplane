import { CloudOff, Download, Minus, Package, Plus, Trash2 } from "lucide-react";
import type { ArtifactPolicy, BuildArtifact } from "@waterplane/shared";
import { MAX_ARTIFACT_KEEP, artifactPolicyText } from "@waterplane/shared";
import { DownloadButton } from "./DownloadButton";
import { track } from "./usage";
import { fmtSize, when } from "./format";
import { Explain } from "./Explain";
import { SetSwitch } from "./SettingsKit";

/**
 * What becomes of what a build produces — the two switches, and the number.
 *
 * It is here rather than in a settings screen because it is read in the second
 * before a build is tapped — right under the commands it governs — and because
 * what it governs is visible nowhere else: a name in the download list, and
 * files that stop existing.
 *
 * The two switches are the Settings kit's `SetSwitch`, so the state is the
 * `on`/`off` at the row's edge and never a sentence on a button ("✓ collect +
 * name: on"). What the next build will do, in full, is one tap away behind the
 * head's `?`, so a switch never has to be decoded from its own label. The keep
 * count is a stepper on ONE line: the number is prose between two buttons, not
 * a third button, and a button at an end of the ladder is absent, never dimmed.
 *
 * Offline it is the sentence, drawn, and nothing else. The policy lives with
 * the project on the desktop; a switch that cannot save is not drawn as a
 * dimmed one (a `title` is invisible on a phone) — the reason is said instead.
 */
export function ArtifactPolicyRow({ policy, online, onSave }: {
  policy?: ArtifactPolicy;
  online: boolean;
  onSave?: (p: ArtifactPolicy) => void;
}) {
  if (!policy || !onSave) return null;
  const set = (patch: Partial<ArtifactPolicy>) => onSave({ ...policy, ...patch });
  const sentence = <>Every build here: {artifactPolicyText(policy)}.</>;
  return (
    <div className="artifact-policy">
      <div className="section ap-head">
        What a build leaves
        {online && (
          <Explain of="what a build leaves">
            {sentence} <b>collect + name</b> copies what a build produces into .claude/outbox under a name carrying
            the repo, the variant and the version; <b>remove older</b> then deletes older builds of the same artifact
            from the outbox — never anything else.
          </Explain>
        )}
      </div>
      {online ? (
        <>
          <SetSwitch label="collect + name" icon={Package} on={policy.collect}
            onChange={() => { track("action:build.collect"); set({ collect: !policy.collect }); }} />
          {policy.collect && (
            <SetSwitch label="remove older" icon={Trash2} on={policy.prune}
              onChange={() => { track("action:build.prune"); set({ prune: !policy.prune }); }} />
          )}
          {policy.collect && policy.prune && (
            <div className="ap-keep">
              keep
              {policy.keep > 1 && (
                <button className="key" aria-label="keep one fewer" title="keep one fewer build of each artifact"
                  onClick={() => set({ keep: policy.keep - 1 })}><Minus size={14} /></button>
              )}
              <span className="ap-keep-n" aria-live="polite">{policy.keep}</span>
              {policy.keep < MAX_ARTIFACT_KEEP && (
                <button className="key" aria-label="keep one more" title="keep one more build of each artifact"
                  onClick={() => set({ keep: policy.keep + 1 })}><Plus size={14} /></button>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="form-hint">
          <div><Package size={13} style={{ verticalAlign: "-2px" }} /> {sentence}</div>
          <div><CloudOff size={13} style={{ verticalAlign: "-2px" }} /> this is this device's copy — changing it needs the desktop, where the policy lives with the project.</div>
        </div>
      )}
    </div>
  );
}

/**
 * One produced file: what it is, and what its download is doing.
 *
 * The row used to be a bare button that fired a download and looked identical
 * afterwards — so a 90 MB APK on a bad link invited a second tap, and a file
 * already on the phone offered no way to save it out. The verb is the app's one
 * download button now (`DownloadButton.tsx`); the row keeps the naming.
 */
export function ArtifactRow({ a, repoDir, repoName, onDownload }: {
  a: BuildArtifact;
  repoDir: string;
  repoName: string;
  onDownload: (a: BuildArtifact) => void;
}) {
  return (
    <div className="row-wrap">
      <button className="row grow" title={a.relPath} onClick={() => { track("action:build.artifact"); onDownload(a); }}>
        <span className="row-title"><Download size={14} /> {a.name}</span>
        {/* A build whose outputs were already current writes no file — gradle
            says UP-TO-DATE and the APK it would have produced is right there,
            older than the run. The host offers those anyway rather than
            reporting nothing; the row has to say which kind it is, because
            "download this" and "this run made this" are different claims. */}
        {/* The file's OWN date, beside its size. For a stale artifact this is
            the entire point: "unchanged by this run" says the bytes predate the
            run without saying by how much, and a phone showing two same-sized
            APKs has nothing else to separate them. */}
        <span className="row-sub">{fmtSize(a.size)}{a.mtime ? ` · ${when(a.mtime)}` : ""}{a.stale ? " · unchanged by this run (already up to date)" : ""}</span>
      </button>
      <DownloadButton compact trackId="action:build.artifact"
        target={{ repoId: a.repoId, relPath: a.relPath, name: a.name, size: a.size, mtime: a.mtime, repoDir, repoName }} />
    </div>
  );
}
