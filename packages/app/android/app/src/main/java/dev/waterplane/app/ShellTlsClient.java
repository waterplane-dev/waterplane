package dev.waterplane.app;

import android.content.Context;

import androidx.annotation.Nullable;

import java.security.GeneralSecurityException;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSession;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;

/**
 * The one place an OkHttp client learns a pin, for {@link ShellLinkService} and
 * {@link ShellPullService}.
 *
 * <b>A pinned URL gets its own trust, not extra trust.</b> The leaf must carry the pinned key: the
 * system store is never consulted, so neither a public CA nor a chain that happens to validate can
 * stand in. The hostname verifier passes on that same fact and nothing else, because the desktop's
 * certificate is self-signed and names no address the phone dials; it is also what still checks
 * the key on a resumed session, where the trust manager is not called.
 *
 * <b>A URL with no pin gets {@code base} back, the same object</b>, so `tailscale serve` and a
 * person's own CA-valid front door keep system trust exactly as before.
 *
 * Redirects stay off on the pinned path: a bearer rides these requests and a pin says nothing
 * about wherever a redirect points.
 */
final class ShellTlsClient {

    /** Told the host and the key seen, each time a leaf is refused. */
    interface Refusals {
        void refused(@Nullable String host, @Nullable String seenSpki);
    }

    /** A leaf whose key is not the pinned one, as distinct from a TLS failure of any other kind. */
    static final class PinRefused extends CertificateException {
        PinRefused(String message) {
            super(message);
        }
    }

    /** The short form, for the status line. */
    static final String WORD_KEY = "key changed — pair again";
    static final String WORD_TLS = "encrypted link failed";

    private ShellTlsClient() {}

    /** Trusts one key. Exposed to the package so the JVM tests can hand it a chain directly. */
    static final class PinTrust implements X509TrustManager {
        private final String pin;
        @Nullable private final String host;
        @Nullable private final Refusals refusals;

        PinTrust(String pin, @Nullable String host, @Nullable Refusals refusals) {
            this.pin = pin;
            this.host = host;
            this.refusals = refusals;
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            String seen = chain == null || chain.length == 0 ? null : ShellTlsPins.spkiOf((Certificate) chain[0]);
            if (ShellTlsPins.matches(seen, pin)) return;
            if (refusals != null) refusals.refused(host, seen);
            throw new PinRefused("leaf key is not the pinned one");
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("this client trusts no client");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    /** Passes only when the session's leaf carries the pinned key. */
    static HostnameVerifier pinVerifier(String pin, @Nullable Refusals refusals) {
        return (String hostname, SSLSession session) -> {
            String seen = null;
            try {
                Certificate[] peer = session.getPeerCertificates();
                if (peer != null && peer.length > 0) seen = ShellTlsPins.spkiOf(peer[0]);
            } catch (SSLPeerUnverifiedException e) {
                seen = null;
            }
            if (ShellTlsPins.matches(seen, pin)) return true;
            if (refusals != null) refusals.refused(hostname, seen);
            return false;
        };
    }

    /** {@code base} for a null pin; otherwise a client that speaks to that key and no other. */
    static OkHttpClient forPin(OkHttpClient base, @Nullable String pin, @Nullable String url, @Nullable Refusals refusals) {
        if (pin == null) return base;
        PinTrust trust = new PinTrust(pin, ShellRoute.hostOf(url), refusals);
        try {
            SSLContext tls = SSLContext.getInstance("TLS");
            tls.init(null, new TrustManager[] { trust }, null);
            return base.newBuilder()
                    .sslSocketFactory(tls.getSocketFactory(), trust)
                    .hostnameVerifier(pinVerifier(pin, refusals))
                    .followRedirects(false)
                    .followSslRedirects(false)
                    .build();
        } catch (GeneralSecurityException e) {
            // Never system trust instead: a client that cannot pin must not dial.
            throw new IllegalStateException("no TLS context for a pinned client", e);
        }
    }

    /** The client for this desktop and address: refusals land in {@link ShellTlsPins}. */
    static OkHttpClient forUrl(Context ctx, OkHttpClient base, @Nullable String hostId, @Nullable String url) {
        final Context app = ctx.getApplicationContext();
        return forPin(base, ShellTlsPins.pinFor(app, hostId, url), url,
                (host, seen) -> ShellTlsPins.noteRefusal(app, host, seen, System.currentTimeMillis()));
    }

    /** Was this failure the key, rather than the network? Walks the causes: the TLS stack wraps. */
    static boolean isPinRefusal(@Nullable Throwable t) {
        for (Throwable c = t; c != null; c = c.getCause() == c ? null : c.getCause()) {
            if (c instanceof PinRefused || c instanceof SSLPeerUnverifiedException) return true;
        }
        return false;
    }

    private static boolean isTlsFailure(@Nullable Throwable t) {
        for (Throwable c = t; c != null; c = c.getCause() == c ? null : c.getCause()) {
            if (c instanceof SSLException) return true;
        }
        return false;
    }

    /** What to tell a person about a failure on a pinned URL. Null for one that is not TLS. */
    @Nullable
    static String words(@Nullable Throwable t) {
        if (isPinRefusal(t)) {
            return "this desktop's key is not the one this phone paired with: it changed, or someone is in between. Pair again by code";
        }
        if (isTlsFailure(t)) {
            return "the encrypted link to this desktop failed, so nothing was sent. Check that its TLS listener is on";
        }
        return null;
    }
}
