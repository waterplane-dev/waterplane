/** The form hint, the prompt composer and the file strip. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import { CloudOff, Files } from "lucide-react";
import { AttachStrip } from "../AttachStrip";
import { dropFileRef } from "../fileRefs";
import { PromptComposer } from "../PromptComposer";
import type { SendSheetModel } from "./useSendSheet";
import { Hint } from "../kit/Hint";

export function ComposeSection({ m }: { m: SendSheetModel }) {
  const {
    seed, outbox, online, onReattach, onReplace, promptsRef, focusStep, text, attachCwd, attachRepo, repoId, ready, blockers, prompts, states, setStates, nonce, shots, updatePrompts, guard,
  } = m;
  return (
    <>
      <Hint>
        {seed.origin ? `${seed.origin} · ` : ""}
        {online
          ? "Write it, check the two lines below, send."
          : <><CloudOff size={12} /> No connection — this is queued and goes out the moment the link is back.</>}
      </Hint>

      {/* Text FIRST. Everything else has a working default; the words do not. */}
      <PromptComposer
        prompts={prompts}
        onChange={updatePrompts}
        placeholder="What should it do?"
        chain
        stepHint="then, once that step's turn finishes:"
        trackAdd="action:send.addprompt"
        focusRef={focusStep}
        autoFocus={!seed.prompts?.length}
      >
        {shots.length > 0 && (
          <Hint>
            <Files size={12} /> {shots.length} file{shots.length > 1 ? "s" : ""} queued for {attachRepo?.repoName ?? "that repo"}&apos;s inbox — the paths are in the prompt above.
          </Hint>
        )}
        {/* The files as files. A prompt written here names paths minted before
            the bytes moved, so "which screenshot is that, and is it going to
            be there" is unanswerable from the text alone. */}
        <AttachStrip
          compact={!seed.repair} debounceMs={700} text={text} repoId={repoId}
          outbox={outbox} online={online} nonce={nonce}
          onStates={seed.repair ? setStates : undefined}
          onReattach={seed.repair && onReattach && repoId && attachCwd
            ? (relPath) => void guard(() => onReattach(relPath, repoId, attachCwd))
            : undefined}
          onReplace={seed.repair && onReplace && repoId && attachCwd
            ? (relPath) => void guard(async () => {
                const next = await onReplace(relPath, repoId, attachCwd);
                // A replacement gets a freshly minted name, so the sentence
                // has to follow it — otherwise the message still names the
                // file that never arrived.
                if (next) updatePrompts(promptsRef.current.map((p) => p.split(relPath).join(next)));
              })
            : undefined}
          onForget={seed.repair
            ? (relPath) => updatePrompts(promptsRef.current.map((p) => dropFileRef(p, relPath)))
            : undefined}
          onRemove={seed.repair
            ? undefined
            : (relPath) => updatePrompts(promptsRef.current.map((p) => dropFileRef(p, relPath)))}
        />
        {seed.repair && states.length > 0 && (
          <Hint className={ready ? "" : "warn"}>
            {ready
              ? states.length === 1 ? "The file it names will be there." : "Every file it names will be there."
              : online
                ? `${blockers.length} of ${states.length} ${blockers.length === 1 ? "file is" : "files are"} not going to arrive. Fix or drop ${blockers.length === 1 ? "it" : "them"} above, or send anyway and the agent will find nothing at ${blockers.length === 1 ? "that path" : "those paths"}.`
                : "No connection, so the repo can't be checked — what this says about the files is only what this phone knows."}
          </Hint>
        )}
      </PromptComposer>

    </>
  );
}
