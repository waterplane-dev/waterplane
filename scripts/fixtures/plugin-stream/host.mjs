// e2e fixture plugin (scripts/e2e-stream.mjs): serves the live stream "ticker". Each open
// starts a 40 ms timer sending one frame whose payload is JSON ({ n, label }) — a key frame
// first and every 10th, droppable otherwise. `params` re-labels it, `input` and `close` are
// recorded, and the "log" method hands the record back over plugin.call.
const log = { opens: 0, params: [], inputs: [], closes: [], keyframes: 0 };
const timers = new Map();

export function activate(api) {
  api.stream("ticker", {
    open(sub, params) {
      if (params?.refuse) return "The ticker is resting today";
      log.opens++;
      let n = 0;
      timers.set(sub.key, setInterval(() => {
        const key = n % 10 === 0;
        const payload = new TextEncoder().encode(JSON.stringify({ n, label: sub.params?.label ?? null }));
        const r = sub.send(payload, { kind: 1, key, droppable: !key });
        if (r !== "skipped") n++;
      }, 40));
    },
    params(_sub, p) { log.params.push(p); },
    input(_sub, ev) { log.inputs.push(ev); },
    keyframe() { log.keyframes++; },
    close(sub, cause) {
      clearInterval(timers.get(sub.key));
      timers.delete(sub.key);
      log.closes.push(cause);
    },
  });
  api.handle("log", () => log);
}

export function deactivate() {
  for (const t of timers.values()) clearInterval(t);
  timers.clear();
}
