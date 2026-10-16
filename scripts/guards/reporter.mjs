// A node:test reporter that prints one JSON line per FAILED test and nothing
// else: `{file, name, message, actual}`. The guard runners (`edit-hook.mjs`,
// `precommit.mjs`) parse it to decide whose failure it is — `actual` is the
// offender list a deepEqual guard fails with (`['web-work: 28407 chars']`),
// which names a file far more precisely than the prose message around it.
//
// A file whose subtests failed also emits a failure of its own; that one says
// nothing the subtests did not, so it is dropped.
export default async function* guardReporter(source) {
  for await (const ev of source) {
    if (ev.type !== "test:fail") continue;
    const err = ev.data.details?.error;
    if (err?.failureType === "subtestsFailed") continue;
    const cause = err?.cause ?? err;
    let actual;
    try { actual = cause?.actual === undefined ? undefined : JSON.parse(JSON.stringify(cause.actual)); }
    catch { actual = String(cause.actual); }
    yield JSON.stringify({
      file: ev.data.file ?? "",
      name: ev.data.name,
      message: String(cause?.message ?? err?.message ?? "failed"),
      actual,
    }) + "\n";
  }
}
