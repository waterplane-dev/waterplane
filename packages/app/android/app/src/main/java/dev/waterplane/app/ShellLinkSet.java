package dev.waterplane.app;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The background link's desktops, as plain data — every rule {@link ShellLinkService} applies to
 * "one link per saved desktop" that does not need Android, so a JVM unit test can hold it
 * ({@code src/test/.../ShellLinkSetTest}).
 *
 * <b>The page names the desktops; this never invents one.</b> The list arrives through
 * {@link ShellLinkPlugin#start} from the over-the-air bundle (`shellLinkSet.ts`), active desktop
 * FIRST. A bundle older than this shape sends one url and no list: that is one {@link Spec} with
 * no host id, and every prefix below is then absent — the old bundle reads exactly the strings it
 * always did.
 */
final class ShellLinkSet {

    private ShellLinkSet() {}

    /** More desktops than this is not a case; a bound keeps a bad list from opening sockets. */
    static final int MAX_LINKS = 8;

    /** `shared/hosts.ts` `isHostId`: what the page's `host:<id>|` parser accepts. */
    private static final Pattern HOST_ID = Pattern.compile("^[a-z0-9]{4,16}$");

    /** `deviceToken.ts` `validToken`: the shape the host mints. Anything else is never sent. */
    private static final Pattern TOKEN = Pattern.compile("^[A-Za-z0-9_-]{16,256}$");
    /** A base subprotocol name (`BRAND.wsProtocol`): plain lower-case, no separators. */
    private static final Pattern WS_PROTOCOL = Pattern.compile("^[a-z][a-z0-9-]{0,31}$");

    /** One desktop to watch. {@code hostId} is null only for the old single-url shape.
     *  {@code token} is that desktop's own device token (a password-gated desktop), or null. */
    static final class Spec {
        final String hostId;
        final String url;
        final String label;
        /** Sent ONLY to {@link #url}'s own origin (subprotocol on the socket, Bearer on the
         *  attention read). Never logged: {@link #toString} leaves it out. */
        final String token;
        /** The stored list's mark for a desktop whose token lives only in this process's memory
         *  ({@link ShellLinkService#enable}, {@code memoryOnly}): the row says one exists, never
         *  what it is. With {@code token} null that copy is gone, see {@link #locked}. */
        final boolean tokenHeld;

        Spec(String hostId, String url, String label) {
            this(hostId, url, label, null);
        }

        Spec(String hostId, String url, String label, String token) {
            this(hostId, url, label, token, false);
        }

        Spec(String hostId, String url, String label, String token, boolean tokenHeld) {
            this.hostId = hostId;
            this.url = url;
            this.label = label;
            this.token = token;
            this.tokenHeld = tokenHeld;
        }

        /** The same socket: a label change alone never reconnects. A different token does — the
         *  socket was let in on the old one, and a refused token is retried only with a new one. */
        boolean sameSocket(Spec o) {
            return o != null && url.equals(o.url) && eq(hostId, o.hostId) && eq(token, o.token);
        }

        boolean hasToken() {
            return token != null;
        }

        /** Its token was held in memory and the process that held it died: this desktop waits,
         *  undialled, for the page to hand the token again. Dialling without it could only be
         *  refused, and would word a link that is fine as one that needs a sign-in. */
        boolean locked() {
            return tokenHeld && token == null;
        }

        /** What a log line may say about this spec — never the token, only whether there is one. */
        @Override
        public String toString() {
            return label + " at " + url + (token != null ? " (with token)" : "");
        }
    }

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    static boolean isToken(String t) {
        return t != null && TOKEN.matcher(t).matches();
    }

    /**
     * The `Sec-WebSocket-Protocol` value a link with a token offers: {@code "<base>, <base>-tok.<tok>"}
     * — the host echoes the base and reads the token off the second (`host/auth.ts`
     * `tokenFromRequest`, `selectWsProtocol`). Null without a valid token or base name: the socket
     * then dials exactly as it always did.
     */
    static String subprotocols(String base, String token) {
        if (!isToken(token) || base == null || !WS_PROTOCOL.matcher(base).matches()) return null;
        return base + ", " + base + "-tok." + token;
    }

    /** `Authorization` for the attention read, or null. */
    static String bearer(String token) {
        return isToken(token) ? "Bearer " + token : null;
    }

    /** The link for this desktop whose own origin is {@code url}'s, or null: a token goes to that
     *  origin and no other, so a file on another address of the same desktop gets none. */
    static Spec linkFor(List<Spec> specs, String hostId, String url) {
        if (hostId == null || hostId.isEmpty()) return null;
        for (Spec s : specs) {
            if (hostId.equals(s.hostId) && ShellRoute.sameOrigin(s.url, url)) return s;
        }
        return null;
    }

    /** What a stored token is sealed to (GCM associated data): the desktop AND the address, so a
     *  blob moved to another host id or a re-addressed desktop does not decrypt there. */
    static String tokenAad(String hostId, String url) {
        return hostId + "\n" + url;
    }

    /** Does the stored list mark this row {@code tokenHeld}? Only a row that really carries a
     *  token, and only in memory mode: without it the stored list is what it always was. */
    static boolean marksHeld(Spec s, boolean memoryOnly) {
        return memoryOnly && s.hostId != null && isToken(s.token);
    }

    /** The tokens memory mode keeps, keyed like a sealed blob ({@link #tokenAad}): a token goes
     *  only to the desktop and address it was handed for. */
    static Map<String, String> memoryTokens(List<Spec> specs) {
        Map<String, String> out = new HashMap<>();
        for (Spec s : specs) {
            if (marksHeld(s, true)) out.put(tokenAad(s.hostId, s.url), s.token);
        }
        return Collections.unmodifiableMap(out);
    }

    /** What a paused link says on the status line, or null when it is not paused. A refusal
     *  outranks a lock: the desktop's own answer is the newer fact. */
    static String pausedWord(boolean tokenRefused, boolean locked, boolean authPaused) {
        if (tokenRefused) return "signed out — pair again";
        if (locked) return "locked — open the app";
        return authPaused ? "sign-in needed" : null;
    }

    static boolean isWsUrl(String url) {
        return url != null && (url.startsWith("ws://") || url.startsWith("wss://"));
    }

    static boolean isHostId(String id) {
        return id != null && HOST_ID.matcher(id).matches();
    }

    /**
     * The list as the service will hold it: rows with a bad url or host id dropped, one row per
     * host id and per address (two rows on one address would post every alert twice), order kept
     * (the active desktop first), at most {@link #MAX_LINKS}. A label left blank is the address.
     */
    static List<Spec> clean(List<Spec> in) {
        List<Spec> out = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        Set<String> urls = new HashSet<>();
        for (Spec s : in) {
            if (s == null || !isWsUrl(s.url) || !isHostId(s.hostId)) continue;
            if (ids.contains(s.hostId) || urls.contains(s.url)) continue;
            ids.add(s.hostId);
            urls.add(s.url);
            String label = s.label == null || s.label.trim().isEmpty() ? hostOf(s.url) : s.label.trim();
            out.add(new Spec(s.hostId, s.url, label, isToken(s.token) ? s.token : null, s.tokenHeld));
            if (out.size() >= MAX_LINKS) break;
        }
        return out;
    }

    /**
     * What changes when a new list replaces the held one: the {@code keep} set is the held specs
     * whose socket stays (same host, same address); everything else held is dropped and every new
     * spec without a kept twin is opened. Pure, so "re-sending the same list reconnects nothing"
     * is a test, not a hope.
     */
    static final class Diff {
        final List<Spec> drop = new ArrayList<>();
        final List<Spec> open = new ArrayList<>();
        /** new spec → the held spec whose socket it keeps. */
        final Map<Spec, Spec> keep = new LinkedHashMap<>();
    }

    static Diff diff(List<Spec> held, List<Spec> next) {
        Diff d = new Diff();
        List<Spec> unused = new ArrayList<>(held);
        for (Spec n : next) {
            Spec twin = null;
            for (Spec h : unused) {
                if (h.sameSocket(n)) { twin = h; break; }
            }
            if (twin != null) { unused.remove(twin); d.keep.put(n, twin); } else d.open.add(n);
        }
        d.drop.addAll(unused);
        return d;
    }

    /** The notification tag: two desktops' equal tags (`queue-depth`, `plugin-vault-ask:…`) must
     *  not replace each other in the shade. */
    static String tagFor(String hostId, String tag) {
        return hostId == null ? tag : hostId + "|" + tag;
    }

    /** "studio: Approve a secret?" — only when more than one desktop is watched; with one there
     *  is nothing to tell apart and the title stays as the host wrote it. */
    static String titleFor(String label, String title, int linkCount) {
        if (linkCount < 2 || label == null || label.isEmpty()) return title;
        return label + ": " + title;
    }

    /** What a tap hands `window.shellOpen`: `host:<id>|<target>` when the link has a host id
     *  (the page switches desktops on a tap, never by itself), else the target as before. Null
     *  target and no host id: nothing to hand over. */
    static String openTarget(String hostId, String target) {
        if (hostId == null) return target;
        return "host:" + hostId + "|" + (target == null ? "" : target);
    }

    /** One item of `GET /api/attention`, as far as the summary needs it. */
    static final class Waiting {
        final String kind;
        final String plugin;
        final String sessionId;

        Waiting(String kind, String plugin, String sessionId) {
            this.kind = kind;
            this.plugin = plugin;
            this.sessionId = sessionId;
        }
    }

    /** `features/hosts/logic.ts`'s KIND_WORD, the words the in-app sheet uses for the same rows. */
    private static String kindWord(String kind, int n) {
        String one, many;
        switch (kind == null ? "" : kind) {
            case "approval": one = "approval request"; many = "approval requests"; break;
            case "prompt": one = "question"; many = "questions"; break;
            case "signin": one = "sign-in"; many = "sign-ins"; break;
            case "cli": one = "CLI problem"; many = "CLI problems"; break;
            case "disk": one = "disk warning"; many = "disk warnings"; break;
            case "undelivered": one = "prompt not delivered"; many = "prompts not delivered"; break;
            case "followup": one = "follow-up"; many = "follow-ups"; break;
            default: one = "alert"; many = "alerts";
        }
        return n == 1 ? one : many;
    }

    /**
     * The one summary alert's body for a desktop that just answered: "1 approval request (vault) ·
     * 1 session on a question" — `elsewhereRowText`'s grouping, so the shade and the sheet say it
     * in the same words. {@code attentionN} counts past the listed items ("n more").
     */
    static String summaryBody(List<Waiting> items, int attentionN, int sessionsN) {
        Map<String, int[]> groups = new LinkedHashMap<>();
        Map<String, Waiting> firstOf = new LinkedHashMap<>();
        for (Waiting w : items) {
            String k = w.kind + "|" + (w.plugin == null ? "" : w.plugin);
            int[] n = groups.get(k);
            if (n == null) { n = new int[] {0}; groups.put(k, n); firstOf.put(k, w); }
            n[0]++;
        }
        List<String> parts = new ArrayList<>();
        for (Map.Entry<String, int[]> e : groups.entrySet()) {
            Waiting w = firstOf.get(e.getKey());
            int n = e.getValue()[0];
            parts.add(n + " " + kindWord(w.kind, n) + (w.plugin != null && !w.plugin.isEmpty() ? " (" + w.plugin + ")" : ""));
        }
        int more = attentionN - items.size();
        if (more > 0) parts.add(more + " more");
        if (sessionsN > 0) parts.add(sessionsN + " session" + (sessionsN == 1 ? "" : "s") + " on a question");
        return parts.isEmpty() ? "nothing waiting" : String.join(" · ", parts);
    }

    /** "studio: 2 waiting" (the label always: a summary is about one desktop by definition). */
    static String summaryTitle(String label, int total) {
        return (label == null || label.isEmpty() ? "waterplane" : label) + ": " + total + " waiting";
    }

    /** Where a tap on the summary lands on that desktop: its one item when there is exactly one
     *  (a session, else a plugin's screen), else nowhere in particular (switch only). */
    static String summaryTarget(List<Waiting> items, int attentionN, List<String> sessionIds, int sessionsN) {
        if (attentionN == 1 && sessionsN == 0 && items.size() == 1) {
            Waiting w = items.get(0);
            if (w.sessionId != null && !w.sessionId.isEmpty()) return w.sessionId;
            if (w.plugin != null && !w.plugin.isEmpty()) return "plugin:" + w.plugin;
            return null;
        }
        if (attentionN == 0 && sessionsN == 1 && sessionIds.size() == 1) return sessionIds.get(0);
        return null;
    }

    /** "100.64.0.5:8770" out of "ws://100.64.0.5:8770/ws", without android.net.Uri. */
    static String hostOf(String url) {
        if (url == null) return "host";
        String s = url.replaceFirst("^wss?://", "");
        int slash = s.indexOf('/');
        return slash >= 0 ? s.substring(0, slash) : s;
    }
}
