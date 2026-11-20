// The PWA's background relay — the service worker half (plan:
// .claude/outbox/bg-link-send/PLAN.md, WP8). `sw.js` loads it with `importScripts`;
// node tests load it with a plain `import` (src/core/queue/swRelay.test.mjs). So it is
// a classic script with no `import`/`export`: it puts ONE global, `WPRelay`, on
// `globalThis`.
//
// THE RELAY IS THE QUEUE'S OWN FRAMES, NOT A SEND PATH. The page (`swRelayOwner.ts`)
// writes the shared `relayPlan` into IndexedDB (`relay` store, idb.ts v17); this file
// only reads it, POSTs one frame per lane per wake to `/api/relay`, and keeps what the
// host answered (receipts, verbatim) and which ackIds it wrote (with the `firstSentAt`
// it stamped) until the page claims them. It never mints an ackId, never edits a frame
// beyond the two send stamps, never deletes a row, and uses `fetch` only — never a
// WebSocket.
//
// Lane rules (PLAN Design §3): one in flight per lane; the next only after `ok` /
// `rescued`; `retryable` → the same ackId again on a later wake, with backoff, at most
// MAX_TRIES; `pending` (no verdict within waitMs) → the same ackId again on a later wake
// (the host joins or re-acks it); anything else stops the lane and the receipt waits
// for the page. A `needsRelease` row (held only by the reconnect question) is sent only
// after a person released it ("Send N" on Android), and only while the row is still
// the same frame.
(function (g) {
  "use strict";

  /** Keys in the `relay` store. `swRelayOwner.ts` writes the same names (its test pins both). */
  const KEYS = {
    plan: "plan", // RelayPlan
    own: "own", // { heartbeatAt?, releasedAt?, claimedAt? } — the PAGE writes it
    receipts: "receipts", // { [ackId]: ack frame }
    written: "written", // { [ackId]: firstSentAt }
    tries: "tries", // { [ackId]: { n, nextAt } } — retryable verdicts only
    released: "released", // { [ackId]: frame key } — rows a person said "send"
    auth: "auth", // { hostId, label, sealed, token? }
  };
  const ALL_KEYS = Object.values(KEYS);

  /** Past this, a page that neither released nor beat is taken for frozen or gone. */
  const OWN_STALE_MS = 150_000;
  /** How long the host may hold one request for its verdict (`/api/relay` `waitMs`). */
  const WAIT_MS = 20_000;
  /** A `retryable` verdict is tried again at most this many times (the first send included). */
  const MAX_TRIES = 3;
  const BACKOFF_MS = [30_000, 120_000, 300_000];

  /**
   * Does the worker own the queue now? Only when the page let go AFTER its last claim
   * (`freeze` / `pagehide`), or the page has neither beaten nor claimed for OWN_STALE_MS.
   * No record at all ⇒ no page has ever handed anything: nothing to own either way.
   */
  function swOwns(own, now) {
    if (!own) return false;
    const claimed = own.claimedAt || 0;
    if (own.releasedAt && own.releasedAt >= claimed) return true;
    const alive = Math.max(own.heartbeatAt || 0, claimed);
    return now - alive > OWN_STALE_MS;
  }

  /** What an ack means for its lane: go on to the next row, try this one again, or stop. */
  function verdictOf(ack) {
    if (!ack) return "stop";
    if (ack.t === "input.ack" && ack.state === "rescued") return "next";
    if (ack.ok === true && (ack.t !== "input.ack" || !ack.state || ack.state === "ok" || ack.state === "forked")) return "next";
    if (ack.retryable === true) return "retry";
    return "stop";
  }

  /** The key a release is checked against: the frame itself, so an edited row is a different row. */
  function frameKey(frame) {
    try { return JSON.stringify(frame); } catch { return ""; }
  }

  /**
   * Pure: per lane, what this wake may send. Walks each lane in order past rows already
   * answered `next`; the first other row decides the lane:
   *   - a stopping receipt, or a retry past MAX_TRIES ⇒ the lane is stopped (the page decides);
   *   - a retry still backing off ⇒ the lane waits;
   *   - `needsRelease` not released (or released as a different frame) ⇒ held for a person;
   *   - otherwise ⇒ sent now.
   * Returns { send:[{lane, item, firstSentAt?}], held:[{ackId, key}], waiting, stopped, remaining }.
   * `held` counts every needsRelease row in a lane from the first one on (they wait for one tap).
   */
  function planWake(state, now) {
    const out = { send: [], held: [], waiting: 0, stopped: 0, remaining: 0 };
    const plan = state.plan;
    if (!plan || !Array.isArray(plan.lanes)) return out;
    const receipts = state.receipts || {};
    const tries = state.tries || {};
    const released = state.released || {};
    const written = state.written || {};
    for (const lane of plan.lanes) {
      const items = Array.isArray(lane.items) ? lane.items : [];
      let i = 0;
      while (i < items.length && verdictOf(receipts[items[i].ackId]) === "next") i++;
      if (i >= items.length) continue;
      out.remaining += items.length - i;
      const item = items[i];
      const rec = receipts[item.ackId];
      if (rec) {
        const v = verdictOf(rec);
        const t = tries[item.ackId];
        if (v === "stop" || (t && t.n >= MAX_TRIES)) { out.stopped++; continue; }
        if (t && t.nextAt > now) { out.waiting++; continue; }
      }
      if (item.needsRelease && released[item.ackId] !== frameKey(item.frame)) {
        for (const it of items.slice(i)) if (it.needsRelease) out.held.push({ ackId: it.ackId, key: frameKey(it.frame) });
        continue;
      }
      out.send.push({ lane: lane.lane, item, firstSentAt: written[item.ackId] });
    }
    return out;
  }

  /** The frame as written: the plan's frame plus the two send stamps (`SendStamp`). */
  function stampFrame(frame, firstSentAt, now) {
    const f = { ...frame };
    if (typeof f.firstSentAt !== "number") f.firstSentAt = firstSentAt;
    f.sentAt = now;
    return f;
  }

  /**
   * One wake of the relay. `env`:
   *   store.update(keys, mutate) — ONE transaction: mutate(vals) → { put?, del?, result }; resolves result or null
   *   fetch(url, init) — the worker's fetch
   *   now() — epoch ms
   *   pageVisible() — Promise<boolean>: a visible window of this app exists
   * Returns a report: { ran, depth (the plan's; null = no plan read), remaining (rows not yet taken by the host, at the wake's start), reason?, sent, pending, held:[{ackId,key}], stopped, waiting, more, transient, label, sealed }.
   *   reason: "empty" | "visible" | "page" | "sealed" | "auth" | "unsupported" | "foreign" | undefined
   *   transient: worth another wake soon (network down, the page still owning).
   */
  async function runRelay(env) {
    const now = env.now();
    const state = await env.store.update(ALL_KEYS, (v) => ({ result: v }));
    const rep = { ran: false, depth: null, remaining: 0, sent: 0, pending: 0, held: [], stopped: 0, waiting: 0, more: false, transient: false, label: null, sealed: false, reason: undefined };
    if (!state) { rep.reason = "empty"; return rep; }
    const auth = state[KEYS.auth] || null;
    rep.label = (auth && auth.label) || null;
    const view = {
      plan: state[KEYS.plan], receipts: state[KEYS.receipts], tries: state[KEYS.tries],
      released: state[KEYS.released], written: state[KEYS.written],
    };
    // The queue's depth as the page last handed it (null = unknown: no plan was read), counting rows
    // the relay cannot carry too — `remaining` only counts the lanes.
    if (view.plan && typeof view.plan.depth === "number") rep.depth = view.plan.depth;
    const wake = planWake(view, now);
    rep.held = wake.held; rep.stopped = wake.stopped; rep.waiting = wake.waiting; rep.remaining = wake.remaining;
    if (!wake.remaining) { rep.reason = "empty"; return rep; }
    if (await env.pageVisible()) { rep.reason = "visible"; return rep; }
    if (!swOwns(state[KEYS.own], now)) { rep.reason = "page"; rep.transient = true; return rep; }
    if (!auth || auth.hostId !== view.plan.hostId) { rep.reason = "foreign"; return rep; }
    if (auth.sealed) { rep.reason = "sealed"; rep.sealed = true; return rep; }
    rep.ran = true;
    const results = await Promise.all(wake.send.map((s) => sendOne(env, s, auth)));
    for (const r of results) {
      if (r === "next") { rep.sent++; rep.more = true; }
      else if (r === "pending") { rep.pending++; rep.transient = true; }
      else if (r === "retry") { rep.transient = true; }
      else if (r === "net") { rep.transient = true; }
      else if (r === "auth") rep.reason = "auth";
      else if (r === "unsupported") rep.reason = "unsupported";
      else if (r === "page") { rep.transient = true; }
      else rep.stopped++;
    }
    // A lane that advanced may have its next row ready: another wake, not more of this one.
    if (rep.more) rep.more = planWake({ ...view, ...(await readAgain(env)) }, env.now()).send.length > 0;
    return rep;
  }

  async function readAgain(env) {
    const v = await env.store.update(ALL_KEYS, (x) => ({ result: x }));
    if (!v) return {};
    return { plan: v[KEYS.plan], receipts: v[KEYS.receipts], tries: v[KEYS.tries], released: v[KEYS.released], written: v[KEYS.written] };
  }

  /**
   * The host answered "nothing ran" (refused, no relay route, no sign-in): the row is not
   * "written", or the page's claim would mark it as sent by the relay and it could never be edited,
   * discarded or re-aimed. Only a first attempt is taken back — an earlier unanswered one may have
   * run — and only while the entry is still this attempt's own stamp. Returns `verdict`.
   */
  async function unwritten(env, ackId, stamp, verdict) {
    if (stamp.fresh) {
      await env.store.update([KEYS.written], (v) => {
        const written = { ...(v[KEYS.written] || {}) };
        if (written[ackId] !== stamp.first) return { result: false };
        delete written[ackId];
        return { put: { [KEYS.written]: written }, result: true };
      }).catch(() => null);
    }
    return verdict;
  }

  /** Send one row: claim the write in a transaction (ownership re-checked there), POST, keep the verdict. */
  async function sendOne(env, s, auth) {
    const ackId = s.item.ackId;
    // The write is recorded BEFORE the request, in the same transaction that re-checks
    // ownership: a claim landing first stops this send; a claim landing after sees it.
    const stamp = await env.store.update([KEYS.own, KEYS.written], (v) => {
      const now = env.now();
      if (!swOwns(v[KEYS.own], now)) return { result: null };
      const written = { ...(v[KEYS.written] || {}) };
      const first = typeof s.item.frame.firstSentAt === "number" ? s.item.frame.firstSentAt : (written[ackId] ?? now);
      // Only a FIRST write may be rolled back below: an earlier attempt may have run.
      const fresh = written[ackId] === undefined;
      written[ackId] = first;
      return { put: { [KEYS.written]: written }, result: { first, now, fresh } };
    });
    if (!stamp) return "page";
    const frame = stampFrame(s.item.frame, stamp.first, stamp.now);
    let res;
    try {
      const headers = { "content-type": "application/json" };
      if (auth.token) headers.authorization = `Bearer ${auth.token}`;
      res = await env.fetch("/api/relay", { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({ frame, waitMs: WAIT_MS, ...(typeof s.item.frame.firstSentAt === "number" ? {} : { firstByRelay: true }) }) });
    } catch {
      return "net";
    }
    if (res.status === 404 || res.status === 405) return unwritten(env, ackId, stamp, "unsupported");
    if (res.status === 401 || res.status === 403) return unwritten(env, ackId, stamp, "auth");
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (res.status === 422 || (body && typeof body.refused === "string")) return unwritten(env, ackId, stamp, "stop");
    if (!res.ok || !body) return "net";
    if (body.pending === true) return "pending";
    const ack = body.ack;
    if (!ack || ack.ackId !== ackId) return "net";
    const v = verdictOf(ack);
    await env.store.update([KEYS.receipts, KEYS.tries], (x) => {
      const receipts = { ...(x[KEYS.receipts] || {}), [ackId]: ack };
      const put = { [KEYS.receipts]: receipts };
      if (v === "retry") {
        const tries = { ...(x[KEYS.tries] || {}) };
        const n = ((tries[ackId] && tries[ackId].n) || 0) + 1;
        tries[ackId] = { n, nextAt: env.now() + BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)] };
        put[KEYS.tries] = tries;
      }
      return { put, result: true };
    });
    return v;
  }

  /**
   * Release the rows a person tapped "Send N" for: only ackIds still in the plan, still
   * `needsRelease`, and still the SAME frame they saw (an edited row is not released).
   * Returns how many were released.
   */
  async function release(env, wanted) {
    const r = await env.store.update([KEYS.plan, KEYS.released], (v) => {
      const plan = v[KEYS.plan];
      const now = {};
      for (const lane of (plan && plan.lanes) || []) for (const it of lane.items || []) {
        if (it.needsRelease) now[it.ackId] = frameKey(it.frame);
      }
      const released = { ...(v[KEYS.released] || {}) };
      let n = 0;
      for (const w of wanted || []) {
        if (w && now[w.ackId] !== undefined && now[w.ackId] === w.key) { released[w.ackId] = w.key; n++; }
      }
      return n ? { put: { [KEYS.released]: released }, result: n } : { result: 0 };
    });
    return r || 0;
  }

  /**
   * Is a push with this report one the phone can show quietly? Only when the relay READ a plan that
   * holds nothing (depth 0) and the wake left nothing sent, held, refused or waiting. An unreadable
   * store, a missing plan or a plan with rows the relay cannot carry (uploads, "wait for the agent",
   * auto-send off, a session not running) says nothing about the queue being empty: that phone has
   * a queue and must be told the desktop is back.
   */
  function quietPush(rep) {
    return !!rep && rep.depth === 0 && !rep.sent && !rep.pending && !(rep.held && rep.held.length) && !rep.stopped && !rep.remaining && !rep.waiting
      && (rep.reason === undefined || rep.reason === "empty");
  }

  const plural = (n, one, many) => (n === 1 ? one : many);

  /**
   * The notification a wake ends in, or null when there is nothing to say (a sync wake
   * that sent nothing and holds nothing). `push` = the push's own { title, body, hostLabel }
   * (a push ALWAYS shows one — iOS requires it). `canAct` = the platform draws actions.
   */
  function notice(rep, push, brand, canAct) {
    const label = (push && push.hostLabel) || rep.label || "the desktop";
    const sent = rep.sent + rep.pending;
    const held = rep.held.length;
    const rest = [];
    const stopped = rep.stopped || 0;
    // What waits is every row the wake left behind (held, a stopped or backing-off lane, the
    // lanes' next rows — iOS has no Background Sync to send them): the Android notice's depth − sent.
    const waits = Math.max(held, (rep.remaining || 0) - sent);
    const said = rep.reason === "sealed" || rep.reason === "auth"; // those lines already say they wait
    if (stopped > 0) rest.push(`${stopped} ${plural(stopped, "was", "were")} not accepted by ${label} — open to review.`);
    // Quiet when nothing is news (a sync wake only backing off): the push or a send is the occasion.
    if (waits > 0 && !said && (push || sent > 0 || held > 0 || stopped > 0)) {
      rest.push(`${waits} ${plural(waits, "waits", "wait")} for you — open to review.`);
    }
    if (rep.reason === "sealed") rest.push("Queued prompts wait for you to open the app: sign-ins on this phone are sealed.");
    else if (rep.reason === "auth") rest.push("Queued prompts wait for you to open the app: the desktop refused this phone's sign-in.");
    const sentLine = sent > 0 ? `Sent ${sent} to ${label}` : null;
    let title, body;
    if (push) {
      title = push.title || brand;
      body = [sentLine ? `${sentLine}.` : push.body, ...rest].filter(Boolean).join(" ");
    } else {
      if (!sentLine && !rest.length) return null;
      title = sentLine || brand;
      body = rest.join(" ");
    }
    const actions = canAct && held > 0 ? [{ action: "relay-send", title: `Send ${held}` }] : [];
    return { title, body, actions, release: held > 0 ? rep.held : [] };
  }

  /**
   * The worker's IndexedDB store: opened VERSIONLESS (a worker asking for a version can
   * block, or be blocked by, a page on another one), and never CREATED here — a DB that
   * does not exist yet, or has no `relay` store (a page not yet on v17), is "nothing to do".
   */
  function idbStore(dbName) {
    const open = () => new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(dbName); } catch { resolve(null); return; }
      req.onupgradeneeded = () => { try { req.transaction.abort(); } catch { /* resolves via onerror */ } };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        if (!db.objectStoreNames.contains("relay")) { db.close(); resolve(null); return; }
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return {
      async update(keys, mutate) {
        const db = await open();
        if (!db) return null;
        try {
          return await new Promise((resolve) => {
            const tx = db.transaction("relay", "readwrite");
            const s = tx.objectStore("relay");
            const vals = {};
            let left = keys.length;
            let out = null;
            const write = () => {
              try {
                const r = mutate(vals);
                for (const [k, v] of Object.entries(r.put || {})) s.put(v, k);
                for (const k of r.del || []) s.delete(k);
                out = r.result;
              } catch { tx.abort(); }
            };
            tx.oncomplete = () => resolve(out);
            tx.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
            if (!left) { write(); return; }
            for (const k of keys) {
              const req = s.get(k);
              req.onsuccess = () => { vals[k] = req.result; if (--left === 0) write(); };
            }
          });
        } catch {
          return null;
        } finally {
          db.close();
        }
      },
    };
  }

  g.WPRelay = { KEYS, OWN_STALE_MS, WAIT_MS, MAX_TRIES, BACKOFF_MS, swOwns, verdictOf, frameKey, planWake, stampFrame, runRelay, release, notice, quietPush, idbStore };
})(globalThis);
