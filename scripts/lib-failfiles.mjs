// A `node --test` reporter for `run-node-tests.mjs`: one JSON line per failed test — its file and
// name — and nothing else. A failed `todo` is the runner's "known, not counted", so it is skipped.
export default async function* failFiles(source) {
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const d = event.data ?? {};
    if (d.todo !== undefined && d.todo !== false) continue;
    yield JSON.stringify({ file: d.file ?? null, name: String(d.name ?? "") }) + "\n";
  }
}
