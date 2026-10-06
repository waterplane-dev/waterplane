import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { BRAND, type RepoTarget } from "@waterplane/shared";
import { api, type EnvFileInfo, type SecretResult, type WriteTarget } from "./api";
import { track } from "./usage";
import { RepoSelect } from "./RepoPicker";
import { useRemoteResource } from "./useRemoteResource";
import { SheetHead } from "./Sheet";

interface Props {
  repos: RepoTarget[];
  onClose: () => void;
}

/**
 * Set/replace a secret in a write-only target. WRITE-ONLY from the app: the app has
 * no read path for these values and the response only ever shows a masked tail.
 * The value still lands as plaintext in a file on the host, so anything running
 * there (incl. the Claude CLI) can read it — this guards against leaking via the
 * phone/transcript, not against on-host access. Two scopes:
 *  - the host → one of the configured write-only targets. The built-in `env`
 *    splices KEY=value into the host's config-dir .env (applied live). Extra targets
 *    (declared host-side in write-targets.json) can be dotenv or whole-file JSON
 *    (paste a JSON blob, no key — e.g. a cookie jar).
 *  - a repo → the repo's .env (gitignore-gated).
 */
export function SecretSheet({ repos, onClose }: Props) {
  const [scope, setScope] = useState<"host" | "repo">("host");
  const primaryRepos = repos.filter((r) => r.isPrimary);
  const [repoId, setRepoId] = useState(primaryRepos[0]?.id ?? "");
  const [file, setFile] = useState(".env");
  const [targetId, setTargetId] = useState("env");
  const [key, setKey] = useState("GEMINI_API_KEY");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SecretResult | null>(null);

  /**
   * Two host reads, told honestly (`useRemoteResource`).
   *
   * Both were `.catch(() => {})`, and on a sheet whose whole job is to write a
   * credential somewhere specific that is the worst possible silence: the
   * target dropdown renders empty, the file dropdown offers only ".env (new)",
   * and neither says whether the host refused or was never reached. Nothing is
   * cached here on purpose — a stale list of write targets would invite typing
   * a secret at a path that no longer exists.
   */
  const targetsRes = useRemoteResource<WriteTarget[]>("secret-targets", () => api.secretTargets());
  const targets = targetsRes.data ?? [];
  const envRes = useRemoteResource<EnvFileInfo[]>(repoId, () => api.envFiles(repoId), { enabled: scope === "repo" && !!repoId });
  const envFiles = envRes.data ?? [];

  const chosen = envFiles.find((f) => f.name === file);
  const trackedWarn = scope === "repo" && chosen?.tracked && !chosen?.gitignored && !chosen?.template;

  const target = targets.find((t) => t.id === targetId);
  const jsonMode = scope === "host" && target?.mode === "json";

  // For JSON targets the value must parse; gate the button on it.
  let jsonValid = true;
  if (jsonMode && value) {
    try { JSON.parse(value); } catch { jsonValid = false; }
  }

  const canSubmit =
    !busy && !!value &&
    (scope === "repo"
      ? !!key.trim()
      : jsonMode
        ? jsonValid
        : !!key.trim());

  async function submit() {
    track("action:secret.set");
    setBusy(true);
    setResult(null);
    try {
      const body =
        scope === "host"
          ? jsonMode
            ? { scope: "host" as const, targetId, value }
            : { scope: "host" as const, targetId, key: key.trim(), value }
          : { scope: "repo" as const, repoId, file, key: key.trim(), value };
      const r = await api.setSecret(body);
      setResult(r);
      if (r.ok) setValue(""); // never keep the plaintext around in the field
    } catch (e) {
      setResult({ ok: false, error: String((e as Error).message || e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet">
      <SheetHead title={"Set secret"} onClose={onClose} />

      <div className="annot-tools">
        <button className={`key ${scope === "host" ? "active" : ""}`} onClick={() => setScope("host")}>this host</button>
        <button className={`key ${scope === "repo" ? "active" : ""}`} onClick={() => setScope("repo")}>a repo</button>
      </div>

      <div className="form">
        <div className="form-hint">
          <ShieldCheck size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          Write-only here: this app never shows the value back, only a masked
          tail. It's stored as plaintext in a gitignored file on the host, so
          the Claude CLI running there can still read it.
        </div>

        {scope === "host" ? (
          <>
            <select className="search" value={targetId} onChange={(e) => { setTargetId(e.target.value); setResult(null); }}>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>{t.label} · {t.mode}</option>
              ))}
            </select>
            <div className="form-hint mono">
              → {target?.path ?? `~/.config/${BRAND.configDirName}/.env`}
              {target?.hotReload || targetId === "env" ? " · applied live, no restart" : ""}
            </div>
            {targetsRes.state === "offline" && <div className="form-hint">No connection — the host's write targets could not be listed, so only the built-in one is offered.</div>}
            {targetsRes.state === "error" && <div className="form-hint" style={{ color: "var(--dead)" }}>The host refused to list its write targets: {targetsRes.error}</div>}
          </>
        ) : (
          <>
            {/* The shared picker (`RepoPicker.tsx`). This sheet writes into a
                repo's own `.env`, so worktrees are offerable behind the toggle
                like everywhere else. */}
            <RepoSelect
              repos={repos}
              worktreeFilter
              value={repos.find((r) => r.id === repoId)?.worktreePath ?? ""}
              onChange={(dir) => { const r = repos.find((x) => x.worktreePath === dir); if (r) { setRepoId(r.id); setResult(null); } }}
              aria-label="repo"
            />
            {envRes.state === "offline" && <div className="form-hint">No connection — this repo's .env files could not be listed, so nothing below says whether one is gitignored.</div>}
            {envRes.state === "error" && <div className="form-hint" style={{ color: "var(--dead)" }}>The host refused to list this repo's .env files: {envRes.error}</div>}
            <select className="search" value={file} onChange={(e) => setFile(e.target.value)}>
              {!envFiles.some((f) => f.name === ".env") && <option value=".env">.env (new)</option>}
              {envFiles.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}{f.template ? " · template" : f.tracked && !f.gitignored ? " ⚠ tracked" : f.gitignored ? " ✓ ignored" : ""}
                </option>
              ))}
            </select>
            {trackedWarn && (
              <div className="form-hint" style={{ color: "var(--dead)" }}>
                {file} is tracked by git — writing a secret there risks committing it. The host will refuse.
              </div>
            )}
          </>
        )}

        {!jsonMode && (
          <>
            <input
              className="search"
              placeholder="KEY (e.g. GEMINI_API_KEY)"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              list="secret-keys"
            />
            <datalist id="secret-keys">
              <option value="GEMINI_API_KEY" />
            </datalist>
          </>
        )}

        {jsonMode ? (
          <>
            <textarea
              className="search"
              placeholder="paste JSON (the whole file content)"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={6}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              style={{ fontFamily: "monospace", resize: "vertical" }}
            />
            {value && !jsonValid && (
              <div className="form-hint" style={{ color: "var(--dead)" }}>Not valid JSON.</div>
            )}
          </>
        ) : (
          <input
            className="search"
            type="password"
            placeholder="value (paste it)"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        )}

        <button className="send" onClick={submit} disabled={!canSubmit}>
          {busy ? "Setting…" : "Set secret"}
        </button>

        {result && (
          <div className="form-hint" style={{ color: result.ok ? undefined : "var(--dead)" }}>
            {result.ok
              ? `✓ ${result.key ? result.key + " " : ""}${result.action} in ${result.file} — ${result.masked}` +
                (result.addedToGitignore ? " · added to .gitignore" : "") +
                (scope === "host" && (target?.hotReload || targetId === "env") ? " · live now" : "")
              : `Error: ${result.error}`}
          </div>
        )}
      </div>
    </div>
  );
}
