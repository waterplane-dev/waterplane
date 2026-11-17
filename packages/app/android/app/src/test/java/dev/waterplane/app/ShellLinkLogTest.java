package dev.waterplane.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The background link's own log ({@link ShellLinkLog}), on the JVM. */
public class ShellLinkLogTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private ShellLinkLog log;

    @Before
    public void setUp() {
        log = new ShellLinkLog(tmp.getRoot());
    }

    @Test
    public void drainsOneFrameInOrderAndEmptiesTheRing() {
        log.note("h1", 1000, "fail", "SocketTimeoutException: sent ping but didn't receive pong");
        log.note("h1", 2000, "retry", "2000 ms");
        log.note("h1", 4000, "open", null);
        assertEquals("{\"t\":\"link.log\",\"sentAt\":5000,\"events\":["
                + "{\"at\":1000,\"ev\":\"fail\",\"d\":\"SocketTimeoutException: sent ping but didn't receive pong\"},"
                + "{\"at\":2000,\"ev\":\"retry\",\"d\":\"2000 ms\"},"
                + "{\"at\":4000,\"ev\":\"open\"}]}", log.drainFrame("h1", 5000));
        assertNull("sent once, then empty", log.drainFrame("h1", 6000));
    }

    @Test
    public void eachDesktopGetsOnlyItsOwnEvents() {
        log.note("h1", 1000, "dial", null);
        log.note("h2", 1001, "dial", null);
        log.note(null, 1002, "dial", null);
        assertTrue(log.drainFrame("h2", 9).contains("\"at\":1001"));
        assertTrue(log.drainFrame(null, 9).contains("\"at\":1002"));
        assertTrue(log.drainFrame("h1", 9).contains("\"at\":1000"));
    }

    @Test
    public void detailsAreOneEscapedLineAndBounded() {
        log.note("h", 1, "fail", "a\t\"b\"\nc\\" + "x".repeat(400));
        String f = log.drainFrame("h", 2);
        assertTrue(f, f.contains("\"d\":\"a \\\"b\\\" c\\\\xxx"));
        assertTrue(f.length() < 300);
    }

    @Test
    public void theRingKeepsTheNewest() {
        for (int i = 0; i < ShellLinkLog.MAX + 60; i++) log.note("h", i + 1, "retry", null);
        String f = log.drainFrame("h", 1);
        assertEquals(ShellLinkLog.MAX, f.split("\\{\"at\"").length - 1);
        assertTrue("the oldest went", f.contains("{\"at\":" + (ShellLinkLog.MAX + 60) + ","));
        assertTrue("the oldest went", !f.contains("{\"at\":1,"));
    }
}
