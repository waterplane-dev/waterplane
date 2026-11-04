package dev.waterplane.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** The route rule's name part ({@link ShellRoute}). The page mirrors this table in TypeScript. */
public class ShellRouteTest {

    /** {url, protected with no pin, protected with a pin}. */
    private static final Object[][] TABLE = {
        // loopback
        {"http://localhost:8770", true, true},
        {"http://LOCALHOST:8770", true, true},
        {"http://app.localhost:8770", true, true},
        {"http://127.0.0.1:8770", true, true},
        {"http://127.1.2.3:8770", true, true},
        {"http://[::1]:8770", true, true},
        {"https://127.0.0.1:8771", true, true},
        // a name is not an address
        {"http://127.evil.example", false, false},
        {"http://100.64.evil.example", false, false},
        // 100.64/10, over http only
        {"http://100.64.0.1:8770", true, true},
        {"http://100.127.255.255:8770", true, true},
        {"ws://100.64.0.7:8770/ws", true, true},
        {"http://100.63.255.255:8770", false, false},
        {"http://100.128.0.1:8770", false, false},
        {"https://100.64.0.1:8771", false, true},
        {"http://100.064.0.1:8770", false, false},
        {"http://100.64.0.999:8770", false, false},
        // fd7a:115c:a1e0::/48
        {"http://[fd7a:115c:a1e0::1]:8770", true, true},
        {"http://[FD7A:115C:A1E0:AB12::1]:8770", true, true},
        {"http://[fd7a:115c:a1e1::1]:8770", false, false},
        {"https://[fd7a:115c:a1e0::1]:8771", false, true},
        // *.ts.net
        {"http://studio.tail.ts.net:8770", true, true},
        {"https://studio.tail.ts.net", true, true},
        {"wss://studio.tail.ts.net/ws", true, true},
        {"https://ts.net", false, true},
        {"https://evil-ts.net", false, true},
        {"https://x.ts.net.evil.example", false, true},
        // a pinned desktop: https only
        {"https://192.168.1.5:8771", false, true},
        {"wss://192.168.1.5:8771/ws", false, true},
        {"https://studio.local:8771", false, true},
        {"http://192.168.1.5:8770", false, false},
        {"ws://192.168.1.5:8770/ws", false, false},
        // plain whatever the scheme
        {"https://203.0.113.5", false, true},
        {"https://r.example", false, true},
        {"http://r.example", false, false},
        // the authority is what counts
        {"http://100.64.0.1@evil.example/", false, false},
        {"http://evil.example/#.ts.net", false, false},
        // no route
        {"ftp://100.64.0.1", false, false},
        {"javascript:alert(1)", false, false},
        {"not a url", false, false},
        {"", false, false},
        {null, false, false},
    };

    @Test
    public void theTable() {
        for (Object[] row : TABLE) {
            String url = (String) row[0];
            assertEquals("no pin: " + url, row[1], ShellRoute.isProtected(url, false));
            assertEquals("pinned: " + url, row[2], ShellRoute.isProtected(url, true));
        }
    }

    @Test
    public void aPinSpeaksForTlsAddressesOffTheTailnetName() {
        assertTrue(ShellRoute.pinApplies("https://192.168.1.5:8771"));
        assertTrue(ShellRoute.pinApplies("wss://studio.local:8771/ws"));
        assertTrue(ShellRoute.pinApplies("https://r.example"));
        assertFalse("nothing to check", ShellRoute.pinApplies("http://192.168.1.5:8770"));
        assertFalse("nothing to check", ShellRoute.pinApplies("ws://100.64.0.7:8770/ws"));
        assertFalse("tailscale serve's CA leaf is another key", ShellRoute.pinApplies("wss://studio.tail.ts.net/ws"));
        assertFalse(ShellRoute.pinApplies("https://studio.tail.ts.net"));
        assertFalse(ShellRoute.pinApplies(null));
    }

    @Test
    public void originsCompareAsDialled() {
        assertEquals("https://h:8771", ShellRoute.originOf("wss://h:8771/ws"));
        assertEquals("https://h:443", ShellRoute.originOf("https://H/x?y=1"));
        assertEquals("http://[fd7a:115c:a1e0::1]:8770", ShellRoute.originOf("ws://[fd7a:115c:a1e0::1]:8770/ws"));
        assertTrue(ShellRoute.sameOrigin("wss://h/ws", "https://h:443/api"));
        assertFalse(ShellRoute.sameOrigin("wss://h:8771/ws", "http://h:8771/api"));
        assertFalse(ShellRoute.sameOrigin("wss://h:8771/ws", "https://h.evil:8771/api"));
        assertFalse(ShellRoute.sameOrigin(null, null));
        assertNull(ShellRoute.originOf("not a url"));
    }

    @Test
    public void aDesktopWithNoPinDialsAsItAlwaysDid() {
        assertTrue(ShellRoute.mayDial("ws://192.168.1.5:8770/ws", false, null));
        assertTrue(ShellRoute.mayDial("wss://r.example/ws", false, null));
        assertTrue(ShellRoute.mayDial("not a url", false, null));
        assertTrue(ShellRoute.mayDial(null, false, null));
    }

    @Test
    public void aPinnedDesktopIsNeverDialledOnAnUnprotectedAddress() {
        assertFalse("plain LAN socket", ShellRoute.mayDial("ws://192.168.1.5:8770/ws", true, null));
        assertFalse("plain LAN pull", ShellRoute.mayDial("http://192.168.1.5:8770/api/file", true, null));
        assertFalse("a name is not an address", ShellRoute.mayDial("ws://100.64.evil.example:8770/ws", true, null));
        assertFalse("what does not parse is plain", ShellRoute.mayDial("not a url", true, null));
        assertFalse(ShellRoute.mayDial(null, true, null));
    }

    @Test
    public void aPinnedDesktopDialsItsProtectedAddresses() {
        assertTrue("the pin holds here", ShellRoute.mayDial("wss://192.168.1.5:8771/ws", true, null));
        assertTrue("the pin holds here", ShellRoute.mayDial("https://192.168.1.5:8771/api/file", true, null));
        assertTrue("tailnet address", ShellRoute.mayDial("ws://100.64.0.7:8770/ws", true, null));
        assertTrue("tailnet address", ShellRoute.mayDial("ws://[fd7a:115c:a1e0::1]:8770/ws", true, null));
        assertTrue("tailnet name", ShellRoute.mayDial("wss://studio.tail.ts.net/ws", true, null));
        assertTrue("loopback", ShellRoute.mayDial("ws://127.0.0.1:8770/ws", true, null));
    }

    @Test
    public void withTailscaleOffATailnetAddressIsPlainForAPinnedDesktop() {
        assertFalse("tailnet address", ShellRoute.mayDial("ws://100.64.0.7:8770/ws", true, false));
        assertFalse("tailnet address", ShellRoute.mayDial("ws://[fd7a:115c:a1e0::1]:8770/ws", true, false));
        assertFalse("tailnet name", ShellRoute.mayDial("wss://studio.tail.ts.net/ws", true, false));
        assertTrue("the pin holds with no tunnel", ShellRoute.mayDial("wss://192.168.1.5:8771/ws", true, false));
        assertTrue("the pin holds with no tunnel", ShellRoute.mayDial("wss://100.64.0.7:8771/ws", true, false));
        assertTrue("loopback needs no tunnel", ShellRoute.mayDial("ws://127.0.0.1:8770/ws", true, false));
        assertTrue("Tailscale on", ShellRoute.mayDial("ws://100.64.0.7:8770/ws", true, true));
        assertTrue("no pin dials as it always did", ShellRoute.mayDial("ws://100.64.0.7:8770/ws", false, false));
    }

    private static byte[] raw(String literal) throws UnknownHostException {
        return InetAddress.getByName(literal).getAddress();
    }

    @Test
    public void linkAddressesInsideTheTailnetRanges() throws UnknownHostException {
        for (String a : new String[] {"100.64.0.0", "100.100.1.2", "100.127.255.255",
                "fd7a:115c:a1e0::", "fd7a:115c:a1e0:ab12::1", "fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff"}) {
            assertTrue(a, ShellRoute.isTailnetLinkAddress(raw(a)));
        }
    }

    @Test
    public void linkAddressesOutsideTheTailnetRanges() throws UnknownHostException {
        for (String a : new String[] {"100.63.255.255", "100.128.0.0", "10.0.0.2", "192.168.1.5", "228.64.0.1",
                "fd7a:115c:a1e1::1", "fd7a:115d:a1e0::1", "fd00::1", "2001:db8::1", "fe80::1"}) {
            assertFalse(a, ShellRoute.isTailnetLinkAddress(raw(a)));
        }
        assertFalse(ShellRoute.isTailnetLinkAddress(null));
        assertFalse(ShellRoute.isTailnetLinkAddress(new byte[0]));
    }

    @Test
    public void tailnetIsAVpnHoldingATailscaleAddress() throws UnknownHostException {
        List<byte[]> tailscale = Arrays.asList(raw("fe80::1"), raw("100.100.1.2"));
        List<byte[]> otherVpn = Arrays.asList(raw("10.8.0.2"), raw("fd00::2"));
        assertEquals(Boolean.TRUE, ShellRoute.tailnetOf(true, tailscale));
        assertEquals(Boolean.TRUE, ShellRoute.tailnetOf(true, Collections.singletonList(raw("fd7a:115c:a1e0::9"))));
        assertEquals("any VPN is not the tailnet", Boolean.FALSE, ShellRoute.tailnetOf(true, otherVpn));
        assertEquals("a carrier's 100.64 address on no VPN", Boolean.FALSE, ShellRoute.tailnetOf(false, tailscale));
        assertEquals("no VPN needs no addresses", Boolean.FALSE, ShellRoute.tailnetOf(false, null));
    }

    @Test
    public void tailnetIsAbsentWhenUnknown() throws UnknownHostException {
        assertNull("no network to ask", ShellRoute.tailnetOf(null, Collections.singletonList(raw("100.100.1.2"))));
        assertNull(ShellRoute.tailnetOf(null, null));
        assertNull("a VPN's addresses unread", ShellRoute.tailnetOf(true, null));
        assertNull("a VPN with no address yet", ShellRoute.tailnetOf(true, Collections.<byte[]>emptyList()));
    }
}
