package dev.waterplane.app;

import androidx.annotation.Nullable;

import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.HttpUrl;

/**
 * Is this address one a file may be fetched from with nobody looking? The NAME part of the route
 * rule, ported from the page's `isPlainRoute`: this shell has no plain-route check of its own, and
 * the background adopt in {@link ShellPullService} runs while the page is frozen.
 *
 * <b>Protected</b> means exactly one of: loopback; `http` to a Tailscale address (100.64/10,
 * `fd7a:115c:a1e0::/48`) or a `*.ts.net` name; `https` to a `*.ts.net` name; `https` to a desktop
 * whose pin this shell enforces. Everything else is plain, whatever its scheme, and so is anything
 * that does not parse: the question is asked before trusting a route, so the unknown answer is the
 * cautious one. What the page knows and this cannot (`vouched`) is not ported. `NetState.tailnet`
 * is a live reading, so {@link #isProtected} stays pure of it and {@link #mayDial} takes it.
 *
 * Addresses are read with {@link HttpUrl}, the parser OkHttp connects with, so what is judged here
 * is what gets dialled. Pure, so the table runs on the JVM ({@code ShellRouteTest}).
 */
final class ShellRoute {

    /** No leading zeros: `100.064.0.1` is octal to the resolver, a public address. */
    private static final Pattern IPV4 = Pattern.compile(
            "^(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})$");
    private static final String TAILNET_V6 = "fd7a:115c:a1e0:";
    private static final String TAILNET_NAME = ".ts.net";
    /** `fd7a:115c:a1e0::/48` as bytes. */
    private static final byte[] TAILNET_V6_PREFIX = {(byte) 0xfd, 0x7a, 0x11, 0x5c, (byte) 0xa1, (byte) 0xe0};

    /** What a background service says of a desktop {@link #mayDial} refuses. Only the page can
     *  move that desktop to a protected address, so the words send the person there. */
    static final String WORD_LOCKED = "locked: open the app";

    private ShellRoute() {}

    /** @param pinned this shell holds and enforces a pin for the desktop at {@code url}. */
    static boolean isProtected(@Nullable String url, boolean pinned) {
        HttpUrl u = parse(url);
        if (u == null) return false;
        String h = u.host();
        if (isLoopback(h)) return true;
        boolean name = isTailnetName(h);
        if (u.isHttps()) return name || pinned;
        return name || isTailnetAddress(h);
    }

    /**
     * May a service with no page behind it dial {@code url}? A desktop with a pin is never reached
     * on an unprotected address: that is what stops a relay downgrading it by blocking the TLS
     * port. {@code true} goes straight to {@link #isProtected}'s pin argument because
     * {@link ShellTlsClient#forUrl} enforces the pin on every address where that argument counts.
     * A desktop with no pin dials as it always did.
     *
     * With Tailscale known to be off a tailnet address has no tunnel under it, so it reads as the
     * plain route it then is (the page's Rule 2). `https` to a Tailscale address keeps the pin, so
     * it stays dialable; an unknown {@code tailnet} is not a refusal.
     *
     * @param holdsPin {@link ShellTlsPins#pinOf}, whatever the address.
     * @param tailnet  {@link #tailnetOf}; null when unknown.
     */
    static boolean mayDial(@Nullable String url, boolean holdsPin, @Nullable Boolean tailnet) {
        if (!holdsPin) return true;
        if (!isProtected(url, true)) return false;
        return !(Boolean.FALSE.equals(tailnet) && needsTunnel(url));
    }

    /** Is this address protected only by Tailscale carrying it? */
    private static boolean needsTunnel(@Nullable String url) {
        HttpUrl u = parse(url);
        if (u == null) return false;
        String h = u.host();
        return isTailnetName(h) || (!u.isHttps() && isTailnetAddress(h));
    }

    /** Is this link address, raw from {@link java.net.InetAddress#getAddress}, a Tailscale one? */
    static boolean isTailnetLinkAddress(@Nullable byte[] raw) {
        if (raw == null) return false;
        if (raw.length == 4) return (raw[0] & 0xff) == 100 && (raw[1] & 0xc0) == 64;
        if (raw.length != 16) return false;
        for (int i = 0; i < TAILNET_V6_PREFIX.length; i++) if (raw[i] != TAILNET_V6_PREFIX[i]) return false;
        return true;
    }

    /**
     * {@code NetState.tailnet}: is the default network the tailnet, and not merely some VPN? Null
     * when that is unknown: no network to ask, or a VPN whose addresses are not there yet. The page
     * reads {@code false} as "a Tailscale address has no route", so it is never said from a guess.
     *
     * @param vpn   the default network runs over a VPN; null with no network to ask.
     * @param links its link addresses, raw; null when they could not be read.
     */
    @Nullable
    static Boolean tailnetOf(@Nullable Boolean vpn, @Nullable List<byte[]> links) {
        if (vpn == null) return null;
        if (!vpn) return Boolean.FALSE;
        if (links == null || links.isEmpty()) return null;
        for (byte[] a : links) if (isTailnetLinkAddress(a)) return Boolean.TRUE;
        return Boolean.FALSE;
    }

    /**
     * Can a pin speak for this address at all? Only over TLS, and never on a `*.ts.net` name: that
     * is the `tailscale serve` front door, whose CA-issued leaf is a different key from the LAN
     * listener's. The pin belongs to that listener (a tailnet base is never rewritten to it), and
     * enforcing it there would refuse a desktop that is answering correctly. The WebView treats
     * that address the same way: a CA-valid leaf never reaches its handler.
     */
    static boolean pinApplies(@Nullable String url) {
        HttpUrl u = parse(url);
        return u != null && u.isHttps() && !isTailnetName(u.host());
    }

    /** `wss://h:8771/ws` → `https://h:8771`. Null for what is not an http(s)/ws(s) URL. */
    @Nullable
    static String originOf(@Nullable String url) {
        HttpUrl u = parse(url);
        if (u == null) return null;
        String h = u.host();
        return u.scheme() + "://" + (h.indexOf(':') >= 0 ? "[" + h + "]" : h) + ":" + u.port();
    }

    static boolean sameOrigin(@Nullable String a, @Nullable String b) {
        String oa = originOf(a);
        return oa != null && oa.equals(originOf(b));
    }

    /** The name only, for a status line and a refusal. Null when {@code url} does not parse. */
    @Nullable
    static String hostOf(@Nullable String url) {
        HttpUrl u = parse(url);
        return u == null ? null : u.host();
    }

    @Nullable
    private static HttpUrl parse(@Nullable String url) {
        if (url == null) return null;
        String s = url.trim();
        String lower = s.toLowerCase(Locale.ROOT);
        if (lower.startsWith("ws:")) s = "http:" + s.substring(3);
        else if (lower.startsWith("wss:")) s = "https:" + s.substring(4);
        return HttpUrl.parse(s);
    }

    private static boolean isLoopback(String h) {
        if (h.equals("localhost") || h.endsWith(".localhost") || h.equals("::1")) return true;
        Matcher m = IPV4.matcher(h);
        return m.matches() && validQuad(m) && m.group(1).equals("127");
    }

    private static boolean isTailnetName(String h) {
        return h.endsWith(TAILNET_NAME);
    }

    private static boolean isTailnetAddress(String h) {
        if (h.startsWith(TAILNET_V6)) return true;
        Matcher m = IPV4.matcher(h);
        if (!m.matches() || !validQuad(m) || !m.group(1).equals("100")) return false;
        int second = Integer.parseInt(m.group(2));
        return second >= 64 && second <= 127;
    }

    private static boolean validQuad(Matcher m) {
        for (int i = 1; i <= 4; i++) if (Integer.parseInt(m.group(i)) > 255) return false;
        return true;
    }
}
