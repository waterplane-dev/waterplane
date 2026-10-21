/**
 * A CodeLens on the first line of an instruction file (CLAUDE.md, AGENTS.md, copilot-instructions.md,
 * a `*.instructions.md`, a `.claude/rules` file, a skill's SKILL.md): what it costs, from the
 * Always-on view's own row for that file (`lensWords`), in tokens as the view's headline prints them.
 * The figure comes from the active folder's `WeightDoc` when that is the file's folder, else a
 * `weighFolder` of its own held until a matching file is saved. A file with no inventory row gets
 * no lens. Click opens Always-on. Saving a file the inventory reads weighs the folder again first,
 * then the lens redraws: between edits and save the lens shows the last saved reading, never a guess.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { CopilotSwitches } from "@waterplane/shared";
import { isInstructionPath, LENS_PATTERNS, lensWords, weighFolder } from "./data/index.js";
import type { WeightDoc } from "./protocol.js";

export interface LensDeps {
  /** The host's current weight reading, if it is for this folder. */
  active(folder: string): WeightDoc | null;
  switches(): CopilotSwitches;
  /** An instruction file was saved in this folder: weigh it again; resolves when the host's reading is fresh. */
  saved(folder: string): Promise<void>;
  command: string;
}

export class InstructionLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly memo = new Map<string, Promise<WeightDoc | null>>();
  private readonly subs: vscode.Disposable[];

  constructor(private readonly deps: LensDeps) {
    this.subs = [
      this.changed,
      vscode.languages.registerCodeLensProvider(LENS_PATTERNS.map((pattern) => ({ scheme: "file", pattern })), this),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.scheme !== "file" || !isInstructionPath(d.uri.fsPath)) return;
        const f = vscode.workspace.getWorkspaceFolder(d.uri)?.uri.fsPath;
        if (!f) return;
        this.memo.delete(f);
        void this.deps.saved(f).finally(() => this.refresh());
      }),
    ];
  }

  /** The reading changed (the host weighed again): lenses ask again. */
  refresh(): void { this.changed.fire(); }
  /** A setting changed who reads what: held readings are void. */
  reset(): void { this.memo.clear(); this.refresh(); }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
    if (!folder) return [];
    const rel = path.relative(folder, doc.uri.fsPath).split(path.sep).join("/");
    const w = this.deps.active(folder) ?? (await this.weigh(folder));
    const words = lensWords(w?.files.find((f) => f.path === rel));
    if (!words) return [];
    return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: words, command: this.deps.command, arguments: ["always-on"] })];
  }

  private weigh(folder: string): Promise<WeightDoc | null> {
    let p = this.memo.get(folder);
    if (!p) { p = weighFolder(folder, this.deps.switches()).catch(() => null); this.memo.set(folder, p); }
    return p;
  }

  dispose(): void { for (const s of this.subs) s.dispose(); }
}
