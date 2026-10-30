/**
 * Reading git's push verdict from its output: pure functions that turn a push's stdout/stderr
 * into "the remote refused for a branch rule" and into the words the phone shows. No git
 * process here — git.ts runs git, this reads what it printed.
 */

/** git's porcelain refusal of one ref: `!\t<src>:<dst>\t[remote rejected] (<why>)`. Only
 *  git writes these lines (`--porcelain`, start of line, tab-separated); a hook's log does not. */
const PORCELAIN_REFUSED = /^!\t(\S+)\t\[remote rejected\] \((.*)\)\s*$/;
const RULE_REASON = /repository rule violations|protected branch hook declined/;

/**
 * True when the REMOTE refused the push for a branch rule (GitHub's GH013 ruleset or GH006
 * classic protection). Read off git's own porcelain status line only — the pre-push hook's
 * log rides the same streams, and this repo's own tests print "GH013" and "protected branch"
 * (bughunt 2026-10-29 PR-10). A hook that failed never reached the remote, so no such line.
 */
export function pushRefusedByRule(stdout: string, stderr: string): boolean {
  const lines = `${stdout}\n${stderr}`.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const refused = lines.map((l) => PORCELAIN_REFUSED.exec(l)).filter((m): m is RegExpExecArray => !!m);
  if (!refused.length) return false; // the remote refused nothing — whatever the text says
  // The reason on the ref line, or (a pre-receive that words it its own way) the remote's own
  // anchored `remote: error: GH013:`/`GH006:` line beside a ref the remote did refuse.
  return refused.some((m) => RULE_REASON.test(m[2])) || lines.some((l) => /^(?:remote:\s*)+error: GH0(?:13|06):/.test(l));
}

/**
 * The rules GitHub names when a ruleset (GH013, `remote: - <rule>` lines) or classic branch
 * protection (GH006, `remote: error: <rule>` lines) refuses a push, plus the page that lists them —
 * as a clause, or "" when the remote named none. Only the remote's own words, never a guess.
 */
function ruleWords(lines: string[]): string {
  const rules: string[] = [];
  let page = "";
  for (const l of lines) {
    const at = /^remote:\s+Review all repository rules at (\S+)/.exec(l);
    if (at) { page = at[1]; continue; }
    const r = /^remote:\s+(?:- |error: )(.+?)\s*$/.exec(l);
    if (r && !/^GH0\d\d:/.test(r[1]) && !rules.includes(r[1])) rules.push(r[1].replace(/\.$/, ""));
  }
  return (rules.length ? `: ${rules.join("; ")}` : "") + (page ? ` (rules: ${page})` : "");
}

/**
 * What a refused push says on the phone. A pre-push hook (the local CI) prints
 * its steps to git's STDOUT, so stderr alone held only node's warnings and
 * git's closing "failed to push" — the step that failed was in the half that
 * was dropped. Both halves, colour codes and node's MODULE_TYPELESS noise out,
 * the hook's `FAILED: <step>` line first, then the last lines that explain it.
 *
 * A hook that PASSED and a remote that then refused is the other case: `--porcelain`
 * writes the refusal (`!\t<ref>\t[rejected] (fetch first)`) to stdout, and 20k of e2e
 * chatter on stderr pushed it out of the tail — the phone showed host warnings and
 * "failed to push" after a green 24-minute check, with the reason nowhere on screen.
 */
export function pushFailureText(stdout: string, stderr: string, tail = 40): string {
  const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
    .filter((l) => !/^\(node:\d+\) \[MODULE_TYPELESS_PACKAGE_JSON\]|^Reparsing as ES module|^To eliminate this warning|^\(Use `node --trace-warnings/.test(l));
  const lines = [...clean(stdout), ...clean(stderr)].filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
  const failed = lines.find((l) => /^FAILED: /.test(l));
  const body = lines.slice(-tail).join("\n").trim();
  if (failed) return `The pre-push check stopped it — ${failed.replace(/^FAILED: /, "")}\n\n${body}`;
  const rejected = lines.map((l) => /^!\t(\S+)\t(.*)$/.exec(l)).find(Boolean);
  if (rejected) {
    const ref = rejected[1].split(":").pop()!.replace(/^refs\/heads\//, "");
    const why = rejected[2].trim();
    const passed = lines.some((l) => /^local CI passed\b/.test(l)) ? "The pre-push check passed, but the" : "The";
    const moved = /fetch first|non-fast-forward/.test(why)
      ? ` — ${ref} moved on the remote while this ran. Pull, then push again.`
      : /repository rule violations|protected branch hook declined/.test(why)
        ? ` — a branch rule on the remote blocks this push${ruleWords(lines)}. Nothing changed there; your commits are still here.`
        : ` — ${why}`;
    return `${passed} remote refused ${ref}${moved}\n\n${rejected[0]}\n${body}`;
  }
  return body;
}
