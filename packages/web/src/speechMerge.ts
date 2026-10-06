/**
 * One transcript out of a Web Speech result list.
 *
 * Desktop Chrome hands back one result per phrase, each carrying only its own
 * words (with a leading space), so joining them is the whole transcript.
 * Android Chrome in `continuous` mode does not: a later result REPEATS the
 * earlier ones — sometimes as a growing prefix ("or", "or so", "or so fix"),
 * sometimes as the same final phrase again — and its results carry no leading
 * space. Joining those blindly is what put "orsofixorsofixorsofix" into the box.
 *
 * So each result is merged, not appended: one that extends everything so far
 * replaces it, one already contained at either end is a repeat and is dropped,
 * anything else is a new phrase and joins with a space.
 */
export function mergeSpeechResults(transcripts: readonly string[]): string {
  let acc = "";
  for (const raw of transcripts) {
    const s = raw.replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (!acc || s.startsWith(acc)) acc = s;
    else if (acc.endsWith(s) || acc.startsWith(s)) continue;
    else acc = `${acc} ${s}`;
  }
  return acc;
}
