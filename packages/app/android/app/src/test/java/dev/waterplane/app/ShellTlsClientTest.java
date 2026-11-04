package dev.waterplane.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.TrustManager;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

/**
 * {@link ShellTlsClient} against a real TLS listener on loopback, serving a self-signed leaf that
 * names no address, which is what a desktop's listener looks like. The key is made per run with
 * the JDK's keytool, so no private key lives in this repo.
 */
public class ShellTlsClientTest {

    private static final char[] PASS = "changeit".toCharArray();
    private static final String WRONG_PIN = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    private static X509Certificate leaf;
    private static String pin;
    private static SSLServerSocket server;
    private static String origin;

    @BeforeClass
    public static void listen() throws Exception {
        File dir = Files.createTempDirectory("shelltls").toFile();
        File store = new File(dir, "desk.p12");
        String keytool = System.getProperty("java.home") + File.separator + "bin" + File.separator + "keytool";
        Process p = new ProcessBuilder(keytool, "-genkeypair", "-alias", "desk", "-keyalg", "EC", "-groupname", "secp256r1",
                "-sigalg", "SHA256withECDSA", "-dname", "CN=desk", "-validity", "2", "-storetype", "PKCS12",
                "-keystore", store.getPath(), "-storepass", new String(PASS)).redirectErrorStream(true).start();
        p.getInputStream().readAllBytes();
        assertTrue(p.waitFor(60, TimeUnit.SECONDS));
        assertEquals(0, p.exitValue());

        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (InputStream in = new FileInputStream(store)) {
            ks.load(in, PASS);
        }
        leaf = (X509Certificate) ks.getCertificate("desk");
        pin = ShellTlsPins.spkiOf((java.security.cert.Certificate) leaf);
        assertNotNull(pin);
        assertTrue(store.delete());
        assertTrue(dir.delete());

        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(ks, PASS);
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(kmf.getKeyManagers(), null, null);
        server = (SSLServerSocket) tls.getServerSocketFactory().createServerSocket(0, 16, InetAddress.getLoopbackAddress());
        origin = "https://127.0.0.1:" + server.getLocalPort();
        Thread t = new Thread(ShellTlsClientTest::serve, "tls-listener");
        t.setDaemon(true);
        t.start();
    }

    @AfterClass
    public static void stop() throws IOException {
        if (server != null) server.close();
    }

    private static void serve() {
        while (!server.isClosed()) {
            try (Socket s = server.accept()) {
                BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1));
                String first = in.readLine();
                for (String l = first; l != null && !l.isEmpty(); l = in.readLine()) { /* the headers */ }
                String reply = first != null && first.contains("/hop")
                        ? "HTTP/1.1 302 Found\r\nLocation: " + origin + "/landed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        : "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
                OutputStream out = s.getOutputStream();
                out.write(reply.getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
            } catch (IOException e) {
                // A refused client ends its handshake here; the listener goes on.
            }
        }
    }

    private static OkHttpClient base() {
        return new OkHttpClient.Builder().followSslRedirects(false).callTimeout(10, TimeUnit.SECONDS).build();
    }

    private static Request get(String path) {
        return new Request.Builder().url(origin + path).build();
    }

    private static final class Seen implements ShellTlsClient.Refusals {
        final List<String> rows = Collections.synchronizedList(new ArrayList<>());

        @Override
        public void refused(String host, String seenSpki) {
            rows.add(host + " " + seenSpki);
        }
    }

    @Test
    public void thePinnedLeafIsLetInThoughItNamesNoAddress() throws IOException {
        Seen seen = new Seen();
        try (Response r = ShellTlsClient.forPin(base(), pin, origin, seen).newCall(get("/ok")).execute()) {
            assertEquals(200, r.code());
            assertEquals("ok", r.body().string());
        }
        assertTrue(seen.rows.isEmpty());
    }

    @Test
    public void aLeafOffThePinIsRefusedAndRemembered() {
        Seen seen = new Seen();
        try (Response r = ShellTlsClient.forPin(base(), WRONG_PIN, origin, seen).newCall(get("/ok")).execute()) {
            fail("reached a server off the pin: " + r.code());
        } catch (IOException e) {
            assertTrue(e.toString(), ShellTlsClient.isPinRefusal(e));
            assertTrue(ShellTlsClient.words(e).startsWith("this desktop's key is not the one"));
        }
        assertEquals("127.0.0.1 " + pin, seen.rows.get(0));
    }

    @Test
    public void theVerifierPassesOnlyOnThePin() throws Exception {
        // A trust manager that would let this leaf in, and a verifier pinned to another key: the
        // resumed-session case, where the verifier is all that looks.
        ShellTlsClient.PinTrust trust = new ShellTlsClient.PinTrust(pin, "127.0.0.1", null);
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(null, new TrustManager[] { trust }, null);
        Seen seen = new Seen();
        OkHttpClient c = base().newBuilder()
                .sslSocketFactory(tls.getSocketFactory(), trust)
                .hostnameVerifier(ShellTlsClient.pinVerifier(WRONG_PIN, seen))
                .build();
        try (Response r = c.newCall(get("/ok")).execute()) {
            fail("the verifier passed off the pin: " + r.code());
        } catch (SSLPeerUnverifiedException e) {
            assertTrue(ShellTlsClient.isPinRefusal(e));
        }
        assertEquals("127.0.0.1 " + pin, seen.rows.get(0));
    }

    @Test
    public void noPinIsTheSameClientAndSystemTrust() {
        OkHttpClient base = base();
        assertSame(base, ShellTlsClient.forPin(base, null, origin, null));
        // System trust knows nothing of a self-signed leaf, and that is not a pin refusal.
        try (Response r = base.newCall(get("/ok")).execute()) {
            fail("system trust let a self-signed leaf in: " + r.code());
        } catch (SSLHandshakeException e) {
            assertFalse(ShellTlsClient.isPinRefusal(e));
        } catch (IOException e) {
            fail("expected a handshake failure: " + e);
        }
    }

    @Test
    public void aPinnedClientDoesNotInheritTheBasesVerifier() {
        OkHttpClient base = base();
        OkHttpClient pinned = ShellTlsClient.forPin(base, pin, origin, null);
        assertNotSame(base, pinned);
        assertNotSame(base.hostnameVerifier(), pinned.hostnameVerifier());
        assertNotSame(base.sslSocketFactory(), pinned.sslSocketFactory());
        assertFalse(pinned.followRedirects());
        assertFalse(pinned.followSslRedirects());
    }

    @Test
    public void aPinnedClientStaysPutOnARedirect() throws IOException {
        try (Response r = ShellTlsClient.forPin(base(), pin, origin, null).newCall(get("/hop")).execute()) {
            assertEquals(302, r.code());
            assertNull(r.priorResponse());
        }
    }

    @Test
    public void anEmptyChainIsRefused() {
        Seen seen = new Seen();
        ShellTlsClient.PinTrust t = new ShellTlsClient.PinTrust(pin, "h", seen);
        try {
            t.checkServerTrusted(new X509Certificate[0], "ECDHE_ECDSA");
            fail("an empty chain passed");
        } catch (CertificateException e) {
            assertTrue(e instanceof ShellTlsClient.PinRefused);
        }
        assertEquals("h null", seen.rows.get(0));
    }

    @Test
    public void onlyTheLeafCounts() throws CertificateException {
        ShellTlsClient.PinTrust t = new ShellTlsClient.PinTrust(WRONG_PIN, "h", null);
        try {
            t.checkServerTrusted(new X509Certificate[] { leaf }, "ECDHE_ECDSA");
            fail("a leaf off the pin passed");
        } catch (ShellTlsClient.PinRefused e) {
            assertNotNull(e.getMessage());
        }
        new ShellTlsClient.PinTrust(pin, "h", null).checkServerTrusted(new X509Certificate[] { leaf }, "ECDHE_ECDSA");
    }

    @Test
    public void wordsAreForTlsFailuresOnly() {
        SSLHandshakeException wrapped = new SSLHandshakeException("handshake");
        wrapped.initCause(new ShellTlsClient.PinRefused("x"));
        assertTrue(ShellTlsClient.isPinRefusal(wrapped));
        assertTrue(ShellTlsClient.words(wrapped).contains("Pair again by code"));

        SSLHandshakeException plain = new SSLHandshakeException("protocol");
        assertFalse(ShellTlsClient.isPinRefusal(plain));
        assertTrue(ShellTlsClient.words(plain).contains("encrypted link"));

        assertNull("the network is not the key", ShellTlsClient.words(new IOException("timeout")));
        assertNull(ShellTlsClient.words(null));
    }
}
