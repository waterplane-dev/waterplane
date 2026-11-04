// e2e fixture plugin (scripts/e2e-attention.mjs): `ask` raises ONE urgent notification — the
// "approval" kind a vault card lands on — so `GET /api/attention` has an attention item to count.
export function activate(api) {
  api.handle("ask", () => {
    api.notify({ title: "Asker: approve a key", body: "the body never leaves the feed", urgent: true, tag: "ask:one" });
    return { ok: true };
  });
}
