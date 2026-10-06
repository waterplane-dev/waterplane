/**
 * A unified diff laid out side by side — pure, so the pairing is pinned by a
 * test and not by looking at a screen.
 *
 * Built from the unified diff alone (no second fetch): each hunk's context
 * lines sit on both sides, and a run of `-` lines followed by a run of `+`
 * lines is paired row by row, the shorter run padded with blanks. Line numbers
 * come off the `@@ -a,b +c,d @@` header. The file header (`diff --git`, `index`,
 * `---`, `+++`) is dropped — the sheet's title already names the file.
 */

export type SplitCell = { n: number; text: string; kind: "ctx" | "del" | "add" } | null;
export type SplitRow =
  | { kind: "hunk"; text: string }
  | { kind: "note"; text: string }
  | { kind: "line"; left: SplitCell; right: SplitCell };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function splitDiff(diff: string): SplitRow[] {
  const rows: SplitRow[] = [];
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({ kind: "line", left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };
  for (const line of diff.split("\n")) {
    const h = HUNK.exec(line);
    if (h) {
      flush();
      oldN = Number(h[1]);
      newN = Number(h[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("diff --git")) { flush(); inHunk = false; continue; }
    if (!inHunk) {
      // "Binary files … differ", "new file mode", a host's own sentence: said, not dropped.
      if (line && !/^(index |--- |\+\+\+ |(new|deleted) file mode |old mode |new mode |similarity |rename )/.test(line)) {
        rows.push({ kind: "note", text: line });
      }
      continue;
    }
    if (line.startsWith("-")) { dels.push({ n: oldN++, text: line.slice(1), kind: "del" }); continue; }
    if (line.startsWith("+")) { adds.push({ n: newN++, text: line.slice(1), kind: "add" }); continue; }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    flush();
    if (line === "") continue; // the trailing newline of the whole diff
    const text = line.slice(1);
    rows.push({ kind: "line", left: { n: oldN++, text, kind: "ctx" }, right: { n: newN++, text, kind: "ctx" } });
  }
  flush();
  return rows;
}
