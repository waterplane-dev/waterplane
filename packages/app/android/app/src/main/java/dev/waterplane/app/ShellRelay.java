package dev.waterplane.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * <b>The background relay's state, with no Android in it</b> (plan:
 * {@code .claude/outbox/bg-link-send/PLAN.md}). {@link ShellLinkService} does the HTTP; this
 * decides WHAT may go next and keeps what happened until the page claims it.
 *
 * <p><b>The relay is the queue's own frames, not a send path.</b> The page hands a plan
 * ({@code shared/queue/queuerelay.ts} {@code relayPlan}): per lane, the leading run of rows it
 * would send unasked, each an {@code entryFrame}. This class never mints an ackId, never edits or
 * drops a row; it adds the two stamps the page's {@code ws.ts} would ({@code firstSentAt} at the
 * FIRST write, kept on every retry, and {@code sentAt} per write) and records each verdict
 * verbatim so the page replays it through its own receipt handlers on {@link #claim}.
 *
 * <p>Rules: one frame in flight per lane; the next only after {@code ok}/{@code rescued}; a
 * {@code retryable} verdict re-sends the SAME ackId after a backoff, at most
 * {@link #MAX_RETRIES} times; any other verdict stops the lane (the page decides it). A
 * {@code needsRelease} row waits for a person's "Send N" ({@link #release}), and so does
 * everything behind it in its lane.
 *
 * <p><b>On disk</b>: one app-private JSON file, written temp + rename. A file that does not
 * parse is MOVED ASIDE, never read as empty and overwritten, and the next claim says
 * {@code lost:true}. No token is ever in it: tokens live in {@link ShellLinkTokens} or memory.
 *
 * <p>Thread-safe: every public method is synchronized (the plugin's claim runs on its own thread).
 */
final class ShellRelay {

    /** Retries of one ackId on a {@code retryable} verdict before the lane is handed back. */
    static final int MAX_RETRIES = 3;
    static final long RETRY_BASE_MS = 5_000;
    /** Hidden this long with no {@code freeze} signal: the page is frozen (Chromium freezes at
     *  300 s), so the relay may own the queue. The plan's 330 s fallback. */
    static final long HIDDEN_FALLBACK_MS = 330_000;

    /** May the relay start a send? Released by the page, or no page left in this process, or the
     *  app hidden past the freeze. Never while the app is in front. */
    static boolean mayOwn(boolean released, boolean appForeground, boolean pageInProcess, long hiddenForMs) {
        if (appForeground) return false;
        if (released || !pageInProcess) return true;
        return hiddenForMs >= HIDDEN_FALLBACK_MS;
    }

    /** One frame to POST, as built by {@link #next}. */
    static final class Send {
        final String lane;
        final String ackId;
        /** {@code {"frame":…,"waitMs":…}}, the request body. */
        final String body;
        final long gen;

        Send(String lane, String ackId, String body, long gen) {
            this.lane = lane;
            this.ackId = ackId;
            this.body = body;
            this.gen = gen;
        }
    }

    private static final class Item {
        final String ackId;
        final Map<String, Object> frame;
        final boolean needsRelease;

        Item(String ackId, Map<String, Object> frame, boolean needsRelease) {
            this.ackId = ackId;
            this.frame = frame;
            this.needsRelease = needsRelease;
        }
    }

    private static final class Lane {
        final String lane;
        final List<Item> items;

        Lane(String lane, List<Item> items) {
            this.lane = lane;
            this.items = items;
        }
    }

    private final File file;

    // ── Persisted ────────────────────────────────────────────────────────
    private boolean released = false;
    /** The plan as the page sent it (re-written verbatim), or null. */
    private Map<String, Object> planRaw;
    private String hostId;
    private List<Lane> lanes = Collections.emptyList();
    /** ackId → the host's ack frame, in arrival order. Cleared only by {@link #claim}. */
    private final LinkedHashMap<String, Map<String, Object>> receipts = new LinkedHashMap<>();
    /** ackId → the firstSentAt this relay wrote it with. Cleared only by {@link #claim}. */
    private final LinkedHashMap<String, Long> written = new LinkedHashMap<>();
    private final LinkedHashSet<String> releasedIds = new LinkedHashSet<>();
    /** The file did not parse and was moved aside; the next claim says so. */
    private boolean lost = false;

    // ── Memory only ──────────────────────────────────────────────────────
    private final Map<String, String> inFlight = new HashMap<>();
    /** Lanes whose head is written with no verdict yet ({@code pending}, a lost answer): wait
     *  for the next connect, then the SAME ackId again (joined or re-acked by the host). */
    private final Set<String> waitConnect = new HashSet<>();
    /** Lanes the host refused (422): nothing ran; the page decides them. */
    private final Set<String> stopped = new HashSet<>();
    private final Map<String, Long> retryAt = new HashMap<>();
    private final Map<String, Integer> retries = new HashMap<>();
    /** ackIds the host holds ({@code pending}): counted as sent. */
    private final Set<String> heldByHost = new HashSet<>();
    private long gen = 0;

    ShellRelay(File file) {
        this.file = file;
        load();
    }

    // ── The page's side ──────────────────────────────────────────────────

    /** Replace the plan (the page's {@code setQueue}). A plan that does not read is no plan:
     *  sending nothing is the safe answer. Receipts and the written list are kept. */
    synchronized void setPlan(String planJson) {
        Map<String, Object> raw = null;
        try {
            Object o = Json.read(planJson);
            if (o instanceof Map) raw = asMap(o);
        } catch (IllegalArgumentException e) {
            raw = null;
        }
        applyPlan(raw);
        // A release names rows of THIS plan; one no longer in it (sent, edited, re-aimed) is dropped.
        releasedIds.retainAll(needsReleaseIds(false));
        persist();
    }

    /** The page is freezing ({@code releaseOwnership}). */
    synchronized void releaseOwnership() {
        released = true;
        persist();
    }

    /**
     * Ownership back to the page, synchronously: after this returns no new send starts and a
     * verdict for a frame already in flight is dropped (the page re-sends that ackId itself; the
     * host joins or re-acks it). Answers {@code {receipts, written[, lost]}} as JSON and clears
     * them.
     */
    synchronized String claim() {
        String out = snapshot();
        released = false;
        receipts.clear();
        written.clear();
        releasedIds.clear();
        lost = false;
        gen++;
        inFlight.clear();
        waitConnect.clear();
        stopped.clear();
        retryAt.clear();
        retries.clear();
        heldByHost.clear();
        persist();
        return out;
    }

    /** Ownership back to the page, keeping every receipt and the written list for the next
     *  claim (a claim whose answer could not be handed over). */
    synchronized void takeBack() {
        released = false;
        gen++;
        inFlight.clear();
        persist();
    }

    /** What {@link #claim} would answer, changing nothing. Hold this object's lock across the two
     *  to hand the answer over before anything is cleared. */
    synchronized String snapshot() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("receipts", new ArrayList<Object>(receipts.values()));
        List<Object> w = new ArrayList<>();
        for (Map.Entry<String, Long> e : written.entrySet()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ackId", e.getKey());
            row.put("firstSentAt", e.getValue());
            w.add(row);
        }
        out.put("written", w);
        if (lost) out.put("lost", Boolean.TRUE);
        return Json.write(out);
    }

    // ── The service's side ───────────────────────────────────────────────

    synchronized boolean released() {
        return released;
    }

    synchronized String hostId() {
        return hostId;
    }

    /** The link came (back): lanes waiting on a verdict try their head again. */
    synchronized void onConnect() {
        waitConnect.clear();
    }

    /**
     * The next frame of each lane that may go now, each marked in flight. The first write of an
     * ackId stamps {@code firstSentAt} and records it in the written list ON DISK before this
     * returns — a crash mid-POST must still tell the page it may have run.
     */
    synchronized List<Send> next(long now) {
        List<Send> out = new ArrayList<>();
        boolean dirty = false;
        for (Lane l : lanes) {
            Item it = head(l, now);
            if (it == null) continue;
            Map<String, Object> frame = new LinkedHashMap<>(it.frame);
            Long first = written.get(it.ackId);
            // A row the page never attempted: its firstSentAt is this relay's own stamp, which the host
            // must not read as an age (an unknown ackId then never arrived — see /api/relay).
            boolean firstByRelay = !(it.frame.get("firstSentAt") instanceof Number);
            if (first == null) {
                Object had = frame.get("firstSentAt");
                first = had instanceof Number ? ((Number) had).longValue() : now;
                written.put(it.ackId, first);
                dirty = true;
            }
            frame.put("firstSentAt", first);
            frame.put("sentAt", now);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("frame", frame);
            body.put("waitMs", 100_000L);
            if (firstByRelay) body.put("firstByRelay", true);
            inFlight.put(l.lane, it.ackId);
            out.add(new Send(l.lane, it.ackId, Json.write(body), gen));
        }
        if (dirty) persist();
        return out;
    }

    /** The earliest backoff still running, or 0. */
    synchronized long nextRetryAt(long now) {
        long best = 0;
        for (Long t : retryAt.values()) if (t > now && (best == 0 || t < best)) best = t;
        return best;
    }

    /** Anything in flight? */
    synchronized boolean busy() {
        return !inFlight.isEmpty();
    }

    /** The host's answer: {@code {ack}}. Returns false when the send was claimed meanwhile. */
    synchronized boolean onAck(Send s, Map<String, Object> ack, long now) {
        if (!settle(s)) return false;
        if (Boolean.TRUE.equals(ack.get("retryable"))) {
            int n = retries.containsKey(s.ackId) ? retries.get(s.ackId) : 0;
            if (n < MAX_RETRIES) {
                retries.put(s.ackId, n + 1);
                retryAt.put(s.lane, now + RETRY_BASE_MS * (1L << n));
                return true;
            }
        }
        retries.remove(s.ackId);
        retryAt.remove(s.lane);
        receipts.put(s.ackId, ack);
        persist();
        return true;
    }

    /** {@code {pending:true}}: the host holds it. Written; the lane waits for the next connect. */
    synchronized boolean onPending(Send s) {
        if (!settle(s)) return false;
        heldByHost.add(s.ackId);
        waitConnect.add(s.lane);
        return true;
    }

    /** No answer (network, timeout, a 5xx): it may have run. Same as pending, minus the count. */
    synchronized boolean onNoAnswer(Send s) {
        if (!settle(s)) return false;
        waitConnect.add(s.lane);
        return true;
    }

    /** 422 {@code {refused}}: nothing ran. The lane is the page's. */
    synchronized boolean onRefused(Send s) {
        if (!settle(s)) return false;
        stopped.add(s.lane);
        return true;
    }

    private boolean settle(Send s) {
        if (s.gen != gen) return false;
        if (s.ackId.equals(inFlight.get(s.lane))) inFlight.remove(s.lane);
        return true;
    }

    // ── "Send N" ─────────────────────────────────────────────────────────

    /** The rows waiting only for a person, not yet released, with no verdict. */
    synchronized List<String> releasable() {
        return needsReleaseIds(true);
    }

    /** Release exactly these ackIds — only rows still in the current plan, marked
     *  {@code needsRelease}, under the same ackId. Returns how many were released. */
    synchronized int release(Collection<String> ackIds) {
        Set<String> ok = new HashSet<>(needsReleaseIds(true));
        int n = 0;
        for (String id : ackIds) if (ok.contains(id) && releasedIds.add(id)) n++;
        if (n > 0) persist();
        return n;
    }

    private List<String> needsReleaseIds(boolean unreleasedOnly) {
        List<String> out = new ArrayList<>();
        for (Lane l : lanes) {
            for (Item it : l.items) {
                if (!it.needsRelease || receipts.containsKey(it.ackId)) continue;
                if (unreleasedOnly && releasedIds.contains(it.ackId)) continue;
                out.add(it.ackId);
            }
        }
        return out;
    }

    // ── What the notification says ───────────────────────────────────────

    /** Rows the host took since the last claim: an {@code ok}/{@code rescued} verdict, or held. */
    synchronized int sentCount() {
        Set<String> ids = new HashSet<>(heldByHost);
        for (Map.Entry<String, Map<String, Object>> e : receipts.entrySet()) if (isOk(e.getValue())) ids.add(e.getKey());
        return ids.size();
    }

    /** The backlog alert's title: what was sent, else what waits. */
    static String backlogTitle(int sent, int waits) {
        if (sent > 0) return sent == 1 ? "1 prompt sent" : sent + " prompts sent";
        return waits == 1 ? "1 prompt waiting" : waits + " prompts waiting";
    }

    /** "Sent 2 to studio. 1 waits for you — open to review." With nothing sent, the old notice,
     *  or what waits for a person's OK when "Send N" is offered. */
    static String backlogBody(int sent, int waits, int releasable, String desktop) {
        String them = waits == 1 ? "it" : "them";
        if (sent > 0) {
            String head = "Sent " + sent + " to " + desktop + ".";
            if (waits == 0) return head;
            return head + " " + waits + (waits == 1 ? " waits" : " wait") + " for you — open to review.";
        }
        if (releasable > 0) {
            return "The link is back. " + waits + (waits == 1 ? " waits" : " wait") + " for you — send " + them + " or open to review.";
        }
        return "The link is back. Open the app to send " + them + ".";
    }

    static boolean isOk(Map<String, Object> ack) {
        return Boolean.TRUE.equals(ack.get("ok")) || "rescued".equals(ack.get("state"));
    }

    // ── Lanes ────────────────────────────────────────────────────────────

    /** The lane's next item that may go now, or null: in flight, waiting, stopped by a non-ok
     *  verdict, or at a row a person has not released. */
    private Item head(Lane l, long now) {
        if (inFlight.containsKey(l.lane) || waitConnect.contains(l.lane) || stopped.contains(l.lane)) return null;
        Long at = retryAt.get(l.lane);
        if (at != null && at > now) return null;
        for (Item it : l.items) {
            Map<String, Object> r = receipts.get(it.ackId);
            if (r != null) {
                if (isOk(r)) continue;
                return null;
            }
            if (it.needsRelease && !releasedIds.contains(it.ackId)) return null;
            return it;
        }
        return null;
    }

    private void applyPlan(Map<String, Object> raw) {
        planRaw = null;
        hostId = null;
        lanes = Collections.emptyList();
        if (raw == null) return;
        Object v = raw.get("v");
        Object h = raw.get("hostId");
        Object ls = raw.get("lanes");
        if (!(v instanceof Number) || ((Number) v).longValue() != 1) return;
        if (!(h instanceof String) || ((String) h).isEmpty() || !(ls instanceof List)) return;
        List<Lane> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Object lo : (List<?>) ls) {
            if (!(lo instanceof Map)) return;
            Map<String, Object> lm = asMap(lo);
            Object name = lm.get("lane");
            Object items = lm.get("items");
            if (!(name instanceof String) || !(items instanceof List)) return;
            List<Item> its = new ArrayList<>();
            for (Object io : (List<?>) items) {
                if (!(io instanceof Map)) return;
                Map<String, Object> im = asMap(io);
                Object ackId = im.get("ackId");
                Object frame = im.get("frame");
                if (!(ackId instanceof String) || ((String) ackId).isEmpty() || !(frame instanceof Map)) return;
                Map<String, Object> fm = asMap(frame);
                // The frame must carry the row's own ackId: the relay never sends a frame under
                // an id it does not name.
                if (!ackId.equals(fm.get("ackId"))) return;
                if (!seen.add((String) ackId)) return;
                its.add(new Item((String) ackId, fm, Boolean.TRUE.equals(im.get("needsRelease"))));
            }
            if (!its.isEmpty()) out.add(new Lane((String) name, its));
        }
        planRaw = raw;
        hostId = (String) h;
        lanes = out;
    }

    // ── Disk ─────────────────────────────────────────────────────────────

    private void load() {
        if (!file.exists()) return;
        String text;
        try {
            text = readAll(file);
        } catch (IOException e) {
            moveAside();
            return;
        }
        Map<String, Object> s;
        try {
            Object o = Json.read(text);
            if (!(o instanceof Map)) throw new IllegalArgumentException("not an object");
            s = asMap(o);
            released = Boolean.TRUE.equals(s.get("owns"));
            lost = Boolean.TRUE.equals(s.get("lost"));
            Object p = s.get("plan");
            applyPlan(p instanceof Map ? asMap(p) : null);
            Object r = s.get("receipts");
            if (r instanceof List) {
                for (Object ro : (List<?>) r) {
                    if (!(ro instanceof Map)) throw new IllegalArgumentException("receipt");
                    Map<String, Object> rm = asMap(ro);
                    Object id = rm.get("ackId");
                    if (!(id instanceof String)) throw new IllegalArgumentException("receipt");
                    receipts.put((String) id, rm);
                }
            }
            Object w = s.get("written");
            if (w instanceof List) {
                for (Object wo : (List<?>) w) {
                    if (!(wo instanceof Map)) throw new IllegalArgumentException("written");
                    Map<String, Object> wm = asMap(wo);
                    Object id = wm.get("ackId");
                    Object at = wm.get("firstSentAt");
                    if (!(id instanceof String) || !(at instanceof Number)) throw new IllegalArgumentException("written");
                    written.put((String) id, ((Number) at).longValue());
                }
            }
            Object rel = s.get("released");
            if (rel instanceof List) for (Object x : (List<?>) rel) if (x instanceof String) releasedIds.add((String) x);
        } catch (IllegalArgumentException e) {
            released = false;
            applyPlan(null);
            receipts.clear();
            written.clear();
            releasedIds.clear();
            moveAside();
        }
    }

    /** Keep the unreadable file for a person to look at; start over, and say so on the claim. */
    private void moveAside() {
        File aside = new File(file.getPath() + ".corrupt-" + System.currentTimeMillis());
        if (!file.renameTo(aside)) {
            // Could not move it: never write over it either. Nothing is relayed (no plan) and the
            // page's claim says lost.
            lost = true;
            return;
        }
        lost = true;
        persist();
    }

    private void persist() {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("v", 1L);
        s.put("owns", released);
        if (lost) s.put("lost", Boolean.TRUE);
        if (planRaw != null) s.put("plan", planRaw);
        s.put("receipts", new ArrayList<Object>(receipts.values()));
        List<Object> w = new ArrayList<>();
        for (Map.Entry<String, Long> e : written.entrySet()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ackId", e.getKey());
            row.put("firstSentAt", e.getValue());
            w.add(row);
        }
        s.put("written", w);
        s.put("released", new ArrayList<Object>(releasedIds));
        if (file.exists() && !readable(file)) return; // an unreadable file the move left: never overwritten
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(Json.write(s).getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (IOException e) {
            return;
        }
        if (!tmp.renameTo(file)) {
            // Some filesystems refuse a rename over an existing file.
            File old = new File(file.getPath() + ".old");
            if (file.renameTo(old) && tmp.renameTo(file)) old.delete();
        }
    }

    private static boolean readable(File f) {
        try {
            Object o = Json.read(readAll(f));
            return o instanceof Map;
        } catch (IOException | IllegalArgumentException e) {
            return false;
        }
    }

    private static String readAll(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            return new String(b.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> asMap(Object o) {
        return (Map<String, Object>) o;
    }

    // ── JSON ─────────────────────────────────────────────────────────────

    /**
     * Plain JSON both ways — {@code org.json} is a stub on the JVM, where this class is tested,
     * and frames must round-trip unchanged. Objects are {@link LinkedHashMap}s (key order kept),
     * arrays lists, whole numbers {@link Long}, others {@link Double}. Malformed text throws
     * {@link IllegalArgumentException}.
     */
    static final class Json {
        private static final int DEPTH_MAX = 64;

        private Json() {}

        static Object read(String text) {
            if (text == null) throw new IllegalArgumentException("no text");
            Reader r = new Reader(text);
            Object v = r.value(0);
            r.space();
            if (r.i != text.length()) throw new IllegalArgumentException("trailing text");
            return v;
        }

        static String write(Object v) {
            StringBuilder b = new StringBuilder();
            write(b, v);
            return b.toString();
        }

        private static void write(StringBuilder b, Object v) {
            if (v == null) b.append("null");
            else if (v instanceof String) quote(b, (String) v);
            else if (v instanceof Boolean) b.append(v.toString());
            else if (v instanceof Long || v instanceof Integer || v instanceof Short || v instanceof Byte) b.append(v.toString());
            else if (v instanceof Number) {
                double d = ((Number) v).doubleValue();
                if (Double.isNaN(d) || Double.isInfinite(d)) b.append("null");
                else if (d == Math.rint(d) && Math.abs(d) < 9.007199254740992E15) b.append((long) d);
                else b.append(Double.toString(d));
            } else if (v instanceof Map) {
                b.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                    if (!first) b.append(',');
                    first = false;
                    quote(b, String.valueOf(e.getKey()));
                    b.append(':');
                    write(b, e.getValue());
                }
                b.append('}');
            } else if (v instanceof List) {
                b.append('[');
                boolean first = true;
                for (Object x : (List<?>) v) {
                    if (!first) b.append(',');
                    first = false;
                    write(b, x);
                }
                b.append(']');
            } else quote(b, v.toString());
        }

        private static void quote(StringBuilder b, String s) {
            b.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': b.append("\\\""); break;
                    case '\\': b.append("\\\\"); break;
                    case '\n': b.append("\\n"); break;
                    case '\r': b.append("\\r"); break;
                    case '\t': b.append("\\t"); break;
                    case '\b': b.append("\\b"); break;
                    case '\f': b.append("\\f"); break;
                    default:
                        // U+2028/2029 escaped too: harmless in JSON, and JS-safe.
                        if (c < 0x20 || c == ' ' || c == ' ') b.append(String.format("\\u%04x", (int) c));
                        else b.append(c);
                }
            }
            b.append('"');
        }

        private static final class Reader {
            final String s;
            int i = 0;

            Reader(String s) {
                this.s = s;
            }

            void space() {
                while (i < s.length() && " \t\r\n".indexOf(s.charAt(i)) >= 0) i++;
            }

            boolean eat(char c) {
                space();
                if (i < s.length() && s.charAt(i) == c) {
                    i++;
                    return true;
                }
                return false;
            }

            IllegalArgumentException bad() {
                return new IllegalArgumentException("malformed JSON at " + i);
            }

            Object value(int depth) {
                if (depth > DEPTH_MAX) throw bad();
                space();
                if (i >= s.length()) throw bad();
                char c = s.charAt(i);
                if (c == '{') return object(depth);
                if (c == '[') return array(depth);
                if (c == '"') return string();
                if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
                if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
                if (s.startsWith("null", i)) { i += 4; return null; }
                return number();
            }

            Map<String, Object> object(int depth) {
                i++;
                Map<String, Object> out = new LinkedHashMap<>();
                if (eat('}')) return out;
                do {
                    space();
                    if (i >= s.length() || s.charAt(i) != '"') throw bad();
                    String key = string();
                    if (!eat(':')) throw bad();
                    out.put(key, value(depth + 1));
                } while (eat(','));
                if (!eat('}')) throw bad();
                return out;
            }

            List<Object> array(int depth) {
                i++;
                List<Object> out = new ArrayList<>();
                if (eat(']')) return out;
                do {
                    out.add(value(depth + 1));
                } while (eat(','));
                if (!eat(']')) throw bad();
                return out;
            }

            String string() {
                i++;
                StringBuilder out = new StringBuilder();
                while (i < s.length()) {
                    char c = s.charAt(i++);
                    if (c == '"') return out.toString();
                    if (c < 0x20) throw bad();
                    if (c != '\\') {
                        out.append(c);
                        continue;
                    }
                    if (i >= s.length()) break;
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"': case '\\': case '/': out.append(e); break;
                        case 'b': out.append('\b'); break;
                        case 'f': out.append('\f'); break;
                        case 'n': out.append('\n'); break;
                        case 'r': out.append('\r'); break;
                        case 't': out.append('\t'); break;
                        case 'u': {
                            if (i + 4 > s.length()) throw bad();
                            int v = 0;
                            for (int k = 0; k < 4; k++) {
                                int d = Character.digit(s.charAt(i++), 16);
                                if (d < 0) throw bad();
                                v = v * 16 + d;
                            }
                            out.append((char) v);
                            break;
                        }
                        default: throw bad();
                    }
                }
                throw bad();
            }

            Object number() {
                int start = i;
                while (i < s.length() && "+-.eE0123456789".indexOf(s.charAt(i)) >= 0) i++;
                String t = s.substring(start, i);
                if (!t.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")) throw bad();
                try {
                    return Long.valueOf(t);
                } catch (NumberFormatException e) {
                    return Double.valueOf(t);
                }
            }
        }
    }
}
