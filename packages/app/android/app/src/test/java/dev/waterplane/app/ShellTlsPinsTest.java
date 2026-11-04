package dev.waterplane.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Base64;

import org.junit.Test;

/** What every client asks ({@link ShellTlsPins}), on the JVM. */
public class ShellTlsPinsTest {

    /** A throwaway self-signed P-256 certificate, public half only. */
    private static final String CERT_DER_B64 =
            "MIIBVjCB/KADAgECAhQxGN0Sj3UVf01ri/XoEQ/57fMDQzAKBggqhkjOPQQDAjARMQ8wDQYDVQQDDAZ2ZWN0b3IwHhcNMjYx"
            + "MTAzMjIwNjQwWhcNMzYxMDMxMjIwNjQwWjARMQ8wDQYDVQQDDAZ2ZWN0b3IwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARr"
            + "Bl+s2YuexGv4j7Juppxag8e7Sr1364nqJYel1WtDytY67oyjQnEsKFuZnh4eF61B1CMlFKybsKvWyS7JTqqOozIwMDAdBgNV"
            + "HQ4EFgQUUKxU0Fak6rI+ONfFkBJ52rQ1w+AwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA4gDfE7ekIcQs"
            + "7y64cVhFumo5JtcT6xgri9jaBrNjYQsCIQDeFsxwFyG/C1FDogxafHB8RVMHZdig0zDwkIVKxwqc+A==";
    /** `openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256`. */
    private static final String CERT_SPKI = "af36a410f11bf9ac2a1d70897d6a392b8b5514049952e70e7db524f6057cce0d";
    private static final String OTHER_SPKI = "00" + CERT_SPKI.substring(2);

    private static final String HOST_A = "aaaa1111";
    private static final String HOST_B = "bbbb2222";

    @Test
    public void spkiOfACertificateIsWhatOpensslSays() {
        assertEquals(CERT_SPKI, ShellTlsPins.spkiOfDer(Base64.getDecoder().decode(CERT_DER_B64)));
    }

    @Test
    public void aCertificateThatDoesNotParseHasNoSpki() {
        assertNull(ShellTlsPins.spkiOfDer(null));
        assertNull(ShellTlsPins.spkiOfDer(new byte[0]));
        assertNull(ShellTlsPins.spkiOfDer(new byte[] { 1, 2, 3, 4 }));
    }

    @Test
    public void matchIsExactAndNeverOnNothing() {
        assertTrue(ShellTlsPins.matches(CERT_SPKI, CERT_SPKI));
        assertFalse(ShellTlsPins.matches(OTHER_SPKI, CERT_SPKI));
        assertFalse(ShellTlsPins.matches(null, CERT_SPKI));
        assertFalse(ShellTlsPins.matches(CERT_SPKI, null));
        assertFalse(ShellTlsPins.matches(null, null));
        assertFalse(ShellTlsPins.matches("", ""));
        assertFalse("hex is lowercase on the wire", ShellTlsPins.matches(CERT_SPKI.toUpperCase(), CERT_SPKI.toUpperCase()));
    }

    @Test
    public void oneHostHoldsOnePin() {
        ShellTlsPins.Book b = new ShellTlsPins.Book();
        assertEquals(ShellTlsPins.Outcome.ADDED, b.set(HOST_A, CERT_SPKI));
        assertEquals(ShellTlsPins.Outcome.SAME, b.set(HOST_A, CERT_SPKI));
        assertEquals(ShellTlsPins.Outcome.REPLACED, b.set(HOST_A, OTHER_SPKI));
        assertEquals(1, b.all().size());
        assertEquals(OTHER_SPKI, b.get(HOST_A));
        assertNull("the replaced key is trusted nowhere", b.hostIdOf(CERT_SPKI));
    }

    @Test
    public void aKeyIsLookedUpAcrossTheSet() {
        ShellTlsPins.Book b = new ShellTlsPins.Book();
        b.set(HOST_A, CERT_SPKI);
        b.set(HOST_B, OTHER_SPKI);
        assertEquals(HOST_A, b.hostIdOf(CERT_SPKI));
        assertEquals(HOST_B, b.hostIdOf(OTHER_SPKI));
        assertNull(b.hostIdOf("11" + CERT_SPKI.substring(2)));
        assertNull("an unread certificate proceeds nowhere", b.hostIdOf(null));
    }

    @Test
    public void badArgumentsAreRefusedAndChangeNothing() {
        ShellTlsPins.Book b = new ShellTlsPins.Book();
        assertEquals(ShellTlsPins.Outcome.REFUSED, b.set("BAD", CERT_SPKI));
        assertEquals(ShellTlsPins.Outcome.REFUSED, b.set(null, CERT_SPKI));
        assertEquals(ShellTlsPins.Outcome.REFUSED, b.set(HOST_A, "abc"));
        assertEquals(ShellTlsPins.Outcome.REFUSED, b.set(HOST_A, null));
        assertTrue(b.isEmpty());
    }

    @Test
    public void removeForgetsThatHostOnly() {
        ShellTlsPins.Book b = new ShellTlsPins.Book();
        b.set(HOST_A, CERT_SPKI);
        b.set(HOST_B, OTHER_SPKI);
        assertTrue(b.remove(HOST_A));
        assertFalse(b.remove(HOST_A));
        assertNull(b.get(HOST_A));
        assertEquals(OTHER_SPKI, b.get(HOST_B));
    }
}
