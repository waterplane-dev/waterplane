package dev.waterplane.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import org.junit.Test;

/** The background link's per-desktop rules ({@link ShellLinkSet}), on the JVM. */
public class ShellLinkSetTest {

    private static ShellLinkSet.Spec spec(String id, String url, String label) {
        return new ShellLinkSet.Spec(id, url, label);
    }

    @Test
    public void linkForFindsOnlyThatDesktopsOwnOrigin() {
        ShellLinkSet.Spec lan = new ShellLinkSet.Spec("aaaa1111", "wss://192.168.1.5:8771/ws", "studio", "tok");
        ShellLinkSet.Spec other = new ShellLinkSet.Spec("bbbb2222", "wss://192.168.1.9:8771/ws", "zenbook", "tok2");
        List<ShellLinkSet.Spec> specs = Arrays.asList(other, lan);
        assertSame(lan, ShellLinkSet.linkFor(specs, "aaaa1111", "https://192.168.1.5:8771/api/repos/r/artifact?path=a"));
        assertNull("another port is another origin",
                ShellLinkSet.linkFor(specs, "aaaa1111", "https://192.168.1.5:8772/api/x"));
        assertNull("the plain address is another origin",
                ShellLinkSet.linkFor(specs, "aaaa1111", "http://192.168.1.5:8771/api/x"));
        assertNull("another desktop's address", ShellLinkSet.linkFor(specs, "aaaa1111", "https://192.168.1.9:8771/api/x"));
        assertNull(ShellLinkSet.linkFor(specs, null, "https://192.168.1.5:8771/api/x"));
        assertNull(ShellLinkSet.linkFor(specs, "", "https://192.168.1.5:8771/api/x"));
    }

    @Test
    public void cleanKeepsOrderAndDropsBadOrDuplicateRows() {
        List<ShellLinkSet.Spec> in = Arrays.asList(
                spec("bbbb2222", "ws://100.64.0.7:8770/ws", "zenbook"),
                spec("aaaa1111", "wss://studio.tail.ts.net/ws", " "),
                spec("BAD", "wss://x.ts.net/ws", "x"),
                spec("cccc3333", "https://not-a-socket", "y"),
                spec("dddd4444", "ws://100.64.0.7:8770/ws", "same address"),
                spec("bbbb2222", "wss://other.ts.net/ws", "same id"),
                null);
        List<ShellLinkSet.Spec> out = ShellLinkSet.clean(in);
        assertEquals(2, out.size());
        assertEquals("bbbb2222", out.get(0).hostId);
        assertEquals("zenbook", out.get(0).label);
        assertEquals("aaaa1111", out.get(1).hostId);
        assertEquals("studio.tail.ts.net", out.get(1).label);
    }

    @Test
    public void cleanIsBounded() {
        List<ShellLinkSet.Spec> in = new ArrayList<>();
        for (int i = 0; i < 20; i++) in.add(spec(String.format("host%04d", i), "wss://d" + i + ".ts.net/ws", "d" + i));
        assertEquals(ShellLinkSet.MAX_LINKS, ShellLinkSet.clean(in).size());
    }

    @Test
    public void resendingTheSameListReconnectsNothing() {
        ShellLinkSet.Spec a = spec("aaaa1111", "wss://a.ts.net/ws", "a");
        ShellLinkSet.Spec b = spec("bbbb2222", "wss://b.ts.net/ws", "b");
        ShellLinkSet.Diff d = ShellLinkSet.diff(Arrays.asList(a, b),
                Arrays.asList(spec("bbbb2222", "wss://b.ts.net/ws", "b renamed"), spec("aaaa1111", "wss://a.ts.net/ws", "a")));
        assertTrue(d.drop.isEmpty());
        assertTrue(d.open.isEmpty());
        assertEquals(2, d.keep.size());
    }

    @Test
    public void anAddedDesktopOpensARemovedOneClosesAMovedOneReconnects() {
        ShellLinkSet.Spec a = spec("aaaa1111", "wss://a.ts.net/ws", "a");
        ShellLinkSet.Spec b = spec("bbbb2222", "wss://b.ts.net/ws", "b");
        ShellLinkSet.Spec aMoved = spec("aaaa1111", "wss://a2.ts.net/ws", "a");
        ShellLinkSet.Spec c = spec("cccc3333", "wss://c.ts.net/ws", "c");
        ShellLinkSet.Diff d = ShellLinkSet.diff(Arrays.asList(a, b), Arrays.asList(aMoved, c));
        assertEquals(Arrays.asList(aMoved, c), d.open);
        assertEquals(Arrays.asList(a, b), d.drop);
        assertTrue(d.keep.isEmpty());
        // The old single-url shape (no host id) to a list naming the same address: a new socket,
        // because every string it posts changes shape.
        ShellLinkSet.Spec legacy = spec(null, "wss://a.ts.net/ws", "a");
        assertEquals(1, ShellLinkSet.diff(Collections.singletonList(legacy), Collections.singletonList(a)).open.size());
        assertSame(legacy, ShellLinkSet.diff(Collections.singletonList(legacy), Collections.singletonList(spec(null, "wss://a.ts.net/ws", "x"))).keep.values().iterator().next());
    }

    @Test
    public void tagsTitlesAndTapsSayWhichDesktop() {
        assertEquals("aaaa1111|plugin-vault-ask:repo", ShellLinkSet.tagFor("aaaa1111", "plugin-vault-ask:repo"));
        assertEquals("queue-depth", ShellLinkSet.tagFor(null, "queue-depth"));
        assertEquals("studio: Approve a secret?", ShellLinkSet.titleFor("studio", "Approve a secret?", 2));
        assertEquals("Approve a secret?", ShellLinkSet.titleFor("studio", "Approve a secret?", 1));
        assertEquals("host:aaaa1111|plugin:vault", ShellLinkSet.openTarget("aaaa1111", "plugin:vault"));
        assertEquals("host:aaaa1111|", ShellLinkSet.openTarget("aaaa1111", null));
        assertEquals("3fa9c1d2", ShellLinkSet.openTarget(null, "3fa9c1d2"));
        assertNull(ShellLinkSet.openTarget(null, null));
    }

    @Test
    public void theSummaryUsesTheSheetsWordsAndLandsOnALoneItem() {
        List<ShellLinkSet.Waiting> vault = Collections.singletonList(new ShellLinkSet.Waiting("approval", "vault", null));
        assertEquals("1 approval request (vault)", ShellLinkSet.summaryBody(vault, 1, 0));
        assertEquals("plugin:vault", ShellLinkSet.summaryTarget(vault, 1, Collections.<String>emptyList(), 0));
        List<ShellLinkSet.Waiting> two = Arrays.asList(new ShellLinkSet.Waiting("approval", "vault", null),
                new ShellLinkSet.Waiting("prompt", null, "3fa9c1d2"));
        assertEquals("1 approval request (vault) · 1 question · 2 more · 1 session on a question", ShellLinkSet.summaryBody(two, 4, 1));
        assertNull(ShellLinkSet.summaryTarget(two, 4, Collections.singletonList("3fa9c1d2"), 1));
        assertEquals("3fa9c1d2", ShellLinkSet.summaryTarget(Collections.<ShellLinkSet.Waiting>emptyList(), 0, Collections.singletonList("3fa9c1d2"), 1));
        assertEquals("studio: 2 waiting", ShellLinkSet.summaryTitle("studio", 2));
    }

    private static final String TOK = "tokA_0123456789abcdef";
    private static final String TOK2 = "tokB_0123456789abcdef";

    @Test
    public void cleanCarriesAValidTokenAndDropsAHandEditedOne() {
        List<ShellLinkSet.Spec> out = ShellLinkSet.clean(Arrays.asList(
                new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", TOK),
                new ShellLinkSet.Spec("bbbb2222", "wss://b.ts.net/ws", "b", "not a token!"),
                new ShellLinkSet.Spec("cccc3333", "wss://c.ts.net/ws", "c")));
        assertEquals(TOK, out.get(0).token);
        assertNull(out.get(1).token);
        assertNull(out.get(2).token);
    }

    @Test
    public void aNewTokenReconnectsTheSameTokenDoesNot() {
        ShellLinkSet.Spec held = new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", TOK);
        ShellLinkSet.Diff same = ShellLinkSet.diff(Collections.singletonList(held),
                Collections.singletonList(new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "renamed", TOK)));
        assertEquals(1, same.keep.size());
        assertTrue(same.open.isEmpty());
        ShellLinkSet.Diff fresh = ShellLinkSet.diff(Collections.singletonList(held),
                Collections.singletonList(new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", TOK2)));
        assertEquals(1, fresh.open.size());
        assertSame(held, fresh.drop.get(0));
        ShellLinkSet.Diff cleared = ShellLinkSet.diff(Collections.singletonList(held),
                Collections.singletonList(new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a")));
        assertEquals("a token taken away reconnects without it", 1, cleared.open.size());
        assertNull(cleared.open.get(0).token);
    }

    @Test
    public void aSpecNeverPrintsItsToken() {
        ShellLinkSet.Spec s = new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "studio", TOK);
        assertEquals("studio at wss://a.ts.net/ws (with token)", s.toString());
        assertTrue(!s.toString().contains(TOK));
        assertEquals("studio at wss://a.ts.net/ws", new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "studio").toString());
    }

    @Test
    public void theTokenRidesAsTheSecondSubprotocolAndAsBearerOnlyWhenWellFormed() {
        assertEquals("waterplane, waterplane-tok." + TOK, ShellLinkSet.subprotocols("waterplane", TOK));
        assertNull("no base protocol (an older bundle): nothing offered", ShellLinkSet.subprotocols(null, TOK));
        assertNull(ShellLinkSet.subprotocols("water plane", TOK));
        assertNull(ShellLinkSet.subprotocols("waterplane", null));
        assertNull(ShellLinkSet.subprotocols("waterplane", "short"));
        assertEquals("Bearer " + TOK, ShellLinkSet.bearer(TOK));
        assertNull(ShellLinkSet.bearer("has space in it ......"));
    }

    @Test
    public void aStoredTokenIsSealedToItsDesktopAndAddress() {
        assertEquals("aaaa1111\nwss://a.ts.net/ws", ShellLinkSet.tokenAad("aaaa1111", "wss://a.ts.net/ws"));
        assertTrue(!ShellLinkSet.tokenAad("aaaa1111", "wss://a.ts.net/ws").equals(ShellLinkSet.tokenAad("bbbb2222", "wss://a.ts.net/ws")));
    }

    @Test
    public void onlyARowWithARealTokenInMemoryModeIsMarkedHeld() {
        ShellLinkSet.Spec gated = new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", TOK);
        assertTrue(ShellLinkSet.marksHeld(gated, true));
        assertFalse(ShellLinkSet.marksHeld(gated, false));
        assertFalse(ShellLinkSet.marksHeld(spec("aaaa1111", "wss://a.ts.net/ws", "a"), true));
        assertFalse(ShellLinkSet.marksHeld(new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", "short"), true));
        assertFalse(ShellLinkSet.marksHeld(new ShellLinkSet.Spec(null, "wss://a.ts.net/ws", "a", TOK), true));
    }

    @Test
    public void aHeldTokenOpensOnlyForItsDesktopAndAddress() {
        Map<String, String> held = ShellLinkSet.memoryTokens(Arrays.asList(
                new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", TOK),
                spec("bbbb2222", "wss://b.ts.net/ws", "no token")));
        assertEquals(1, held.size());
        assertEquals(TOK, held.get(ShellLinkSet.tokenAad("aaaa1111", "wss://a.ts.net/ws")));
        assertNull(held.get(ShellLinkSet.tokenAad("aaaa1111", "wss://moved.ts.net/ws")));
        assertNull(held.get(ShellLinkSet.tokenAad("bbbb2222", "wss://a.ts.net/ws")));
    }

    @Test
    public void aHeldRowIsLockedOnlyOnceItsTokenIsGone() {
        assertTrue(new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", null, true).locked());
        assertFalse(new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", TOK, true).locked());
        assertFalse(spec("aaaa1111", "wss://a.ts.net/ws", "a").locked());
    }

    @Test
    public void cleanKeepsTheHeldMark() {
        List<ShellLinkSet.Spec> out = ShellLinkSet.clean(Collections.singletonList(
                new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", null, true)));
        assertTrue(out.get(0).tokenHeld);
        assertTrue(out.get(0).locked());
    }

    @Test
    public void theTokenComingBackOpensALockedLinkAndTheMarkAloneReconnectsNothing() {
        ShellLinkSet.Spec locked = new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", null, true);
        ShellLinkSet.Spec handed = new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", TOK, true);
        ShellLinkSet.Spec sealedTwin = new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", TOK);
        assertFalse(locked.sameSocket(handed));
        assertTrue(handed.sameSocket(sealedTwin));
    }

    @Test
    public void aHeldSpecPrintsNoToken() {
        assertFalse(new ShellLinkSet.Spec("aaaa1111", "wss://a.ts.net/ws", "a", TOK, true).toString().contains(TOK));
    }

    @Test
    public void aRefusalOutranksALockAndALockOutranksASignIn() {
        assertEquals("signed out — pair again", ShellLinkSet.pausedWord(true, true, true));
        assertEquals("locked — open the app", ShellLinkSet.pausedWord(false, true, true));
        assertEquals("sign-in needed", ShellLinkSet.pausedWord(false, false, true));
        assertNull(ShellLinkSet.pausedWord(false, false, false));
    }
}
