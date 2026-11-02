/**
 * Trimming a run of given characters off a string's end (or start) in LINEAR
 * time. `s.replace(/[\\/]+$/, "")` is quadratic on a string with many runs of
 * the class that do not reach the end (the engine retries the run from every
 * offset), which CodeQL flags as polynomial ReDoS; these loops answer exactly
 * what that regex would, once per character.
 */

/** `s` with every trailing character that is in `chars` removed — `s.replace(/[<chars>]+$/, "")`. */
export function trimEndChars(s: string, chars: string): string {
  let e = s.length;
  while (e > 0 && chars.includes(s[e - 1])) e--;
  return e === s.length ? s : s.slice(0, e);
}

/** `s` with every leading character that is in `chars` removed — `s.replace(/^[<chars>]+/, "")`. */
export function trimStartChars(s: string, chars: string): string {
  let b = 0;
  while (b < s.length && chars.includes(s[b])) b++;
  return b === 0 ? s : s.slice(b);
}
