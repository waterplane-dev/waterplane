package dev.waterplane.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.http.SslCertificate;
import android.os.Build;
import android.os.Bundle;

import androidx.annotation.Nullable;

import java.io.ByteArrayInputStream;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * The desktops whose TLS key this phone was told, one {@code {hostId, spki}} each, in private
 * prefs. {@code spki} is lowercase hex SHA-256 of the leaf's SPKI DER: a pin survives a re-issued
 * certificate on the same key, and the desktop's listener prints the same number.
 *
 * Every client asks here: the WebView's handler ({@link MainActivity}) and both OkHttp services
 * ({@link ShellTlsClient}). The hashing, the match and the one-pin-per-host rule are pure and run
 * on the JVM ({@code ShellTlsPinsTest}); only the prefs and {@link SslCertificate} touch Android.
 */
final class ShellTlsPins {

    private static final String PREFS = "shell.tls";
    private static final String PIN_PREFIX = "pin.";
    private static final String KEY_REFUSAL_HOST = "refusal.host";
    private static final String KEY_REFUSAL_SPKI = "refusal.spki";
    private static final String KEY_REFUSAL_AT = "refusal.at";
    private static final Pattern SPKI = Pattern.compile("^[0-9a-f]{64}$");

    private ShellTlsPins() {}

    // ── Pure ─────────────────────────────────────────────────────────────

    static boolean isSpki(@Nullable String s) {
        return s != null && SPKI.matcher(s).matches();
    }

    static String spkiSha256(byte[] spkiDer) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(spkiDer);
            StringBuilder b = new StringBuilder(d.length * 2);
            for (byte x : d) b.append(Character.forDigit((x >> 4) & 0xf, 16)).append(Character.forDigit(x & 0xf, 16));
            return b.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e); // every platform this runs on has SHA-256
        }
    }

    /** Null when the key cannot be read, which every caller treats as no match. */
    @Nullable
    static String spkiOf(@Nullable Certificate cert) {
        if (cert == null) return null;
        try {
            PublicKey key = cert.getPublicKey();
            byte[] der = key == null ? null : key.getEncoded();
            return der == null ? null : spkiSha256(der);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** The same, off a certificate's DER. Null on anything that does not parse. */
    @Nullable
    static String spkiOfDer(@Nullable byte[] certDer) {
        if (certDer == null || certDer.length == 0) return null;
        try {
            return spkiOf(CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(certDer)));
        } catch (GeneralSecurityException | RuntimeException e) {
            return null;
        }
    }

    /** A malformed value on either side is no match: never two nulls agreeing. */
    static boolean matches(@Nullable String seen, @Nullable String pin) {
        return isSpki(seen) && isSpki(pin) && seen.equals(pin);
    }

    /** What {@link Book#set} did, because a replacement has to clear what the WebView remembers. */
    enum Outcome { ADDED, SAME, REPLACED, REFUSED }

    /** The pins as a value: keyed by host, so a second pin for a host can only replace the first. */
    static final class Book {
        private final Map<String, String> pins = new TreeMap<>();

        Outcome set(@Nullable String hostId, @Nullable String spki) {
            if (!ShellLinkSet.isHostId(hostId) || !isSpki(spki)) return Outcome.REFUSED;
            String was = pins.put(hostId, spki);
            return was == null ? Outcome.ADDED : was.equals(spki) ? Outcome.SAME : Outcome.REPLACED;
        }

        boolean remove(@Nullable String hostId) {
            return hostId != null && pins.remove(hostId) != null;
        }

        @Nullable
        String get(@Nullable String hostId) {
            return hostId == null ? null : pins.get(hostId);
        }

        /** Whose key is this? Null for a key no desktop here holds, and for an unread one. */
        @Nullable
        String hostIdOf(@Nullable String seen) {
            for (Map.Entry<String, String> e : pins.entrySet()) {
                if (matches(seen, e.getValue())) return e.getKey();
            }
            return null;
        }

        boolean isEmpty() {
            return pins.isEmpty();
        }

        Map<String, String> all() {
            return new TreeMap<>(pins);
        }
    }

    /** The last leaf refused, for `lastRefusal`: why the page cannot get through, in its words. */
    static final class Refusal {
        @Nullable final String host;
        @Nullable final String spki;
        final long at;

        Refusal(@Nullable String host, @Nullable String spki, long at) {
            this.host = host;
            this.spki = spki;
            this.at = at;
        }
    }

    // ── Stored ───────────────────────────────────────────────────────────

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static Book read(Context ctx) {
        Book b = new Book();
        for (Map.Entry<String, ?> e : prefs(ctx).getAll().entrySet()) {
            if (!e.getKey().startsWith(PIN_PREFIX) || !(e.getValue() instanceof String)) continue;
            b.set(e.getKey().substring(PIN_PREFIX.length()), (String) e.getValue());
        }
        return b;
    }

    /** Set or replace. A sealed pairing or a welcome on a protected route said this key is the
     *  desktop's, so whatever was refused before is no longer the story and is dropped with it. */
    static synchronized Outcome set(Context ctx, String hostId, String spki) {
        Outcome o = read(ctx).set(hostId, spki);
        if (o == Outcome.REFUSED) return o;
        SharedPreferences.Editor e = prefs(ctx).edit();
        e.putString(PIN_PREFIX + hostId, spki);
        clearRefusal(e);
        e.commit();
        return o;
    }

    /** The refusal stays: the screen that removes a pin is the one that words why. */
    static synchronized boolean remove(Context ctx, String hostId) {
        if (!read(ctx).remove(hostId)) return false;
        prefs(ctx).edit().remove(PIN_PREFIX + hostId).commit();
        return true;
    }

    /** This desktop's pin, whatever the address. */
    @Nullable
    static String pinOf(Context ctx, @Nullable String hostId) {
        return hostId == null || hostId.isEmpty() ? null : read(ctx).get(hostId);
    }

    /** The pin that must hold on {@code url}, or null where system trust stays exactly as it was
     *  ({@link ShellRoute#pinApplies}). */
    @Nullable
    static String pinFor(Context ctx, @Nullable String hostId, @Nullable String url) {
        return ShellRoute.pinApplies(url) ? pinOf(ctx, hostId) : null;
    }

    static void noteRefusal(Context ctx, @Nullable String host, @Nullable String seen, long at) {
        SharedPreferences.Editor e = prefs(ctx).edit();
        clearRefusal(e);
        if (host != null) e.putString(KEY_REFUSAL_HOST, host);
        if (seen != null) e.putString(KEY_REFUSAL_SPKI, seen);
        e.putLong(KEY_REFUSAL_AT, at).apply();
    }

    private static void clearRefusal(SharedPreferences.Editor e) {
        e.remove(KEY_REFUSAL_HOST).remove(KEY_REFUSAL_SPKI).remove(KEY_REFUSAL_AT);
    }

    /** Null when nothing has been refused. */
    @Nullable
    static Refusal lastRefusal(Context ctx) {
        SharedPreferences p = prefs(ctx);
        long at = p.getLong(KEY_REFUSAL_AT, 0);
        if (at <= 0) return null;
        return new Refusal(p.getString(KEY_REFUSAL_HOST, null), p.getString(KEY_REFUSAL_SPKI, null), at);
    }

    // ── The WebView's certificate ────────────────────────────────────────

    /**
     * The leaf's SPKI as the WebView saw it, or null when it cannot be read, which refuses.
     *
     * {@code getX509Certificate()} is API 29. Before that the DER is only reachable through
     * {@code saveState}'s `x509-certificate` bytes.
     */
    @Nullable
    static String spkiOf(@Nullable SslCertificate cert) {
        if (cert == null) return null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                X509Certificate x = cert.getX509Certificate();
                return x == null ? null : spkiOf((Certificate) x);
            }
            Bundle state = SslCertificate.saveState(cert);
            return state == null ? null : spkiOfDer(state.getByteArray("x509-certificate"));
        } catch (RuntimeException e) {
            return null;
        }
    }
}
