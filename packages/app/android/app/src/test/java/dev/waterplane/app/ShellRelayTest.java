package dev.waterplane.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The background relay's rules ({@link ShellRelay}), on the JVM. */
public class ShellRelayTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private File file;

    @Before
    public void setUp() throws IOException {
        file = new File(tmp.getRoot(), "shell.relay.json");
    }

    private static String item(String ackId, boolean needsRelease) {
        return "{\"ackId\":\"" + ackId + "\",\"frame\":{\"t\":\"session.input\",\"id\":\"s\",\"data\":\"hi \\u00e9\",\"ackId\":\""
                + ackId + "\",\"submit\":true}" + (needsRelease ? ",\"needsRelease\":true" : "") + "}";
    }

    private static String plan(String host, String... lanes) {
        return "{\"hostId\":\"" + host + "\",\"v\":1,\"issuedAt\":1,\"lanes\":[" + String.join(",", lanes) + "],\"depth\":3}";
    }

    private static String lane(String name, String... items) {
        return "{\"lane\":\"" + name + "\",\"items\":[" + String.join(",", items) + "]}";
    }

    private static Map<String, Object> ack(String ackId, boolean ok, String extra) {
        Object o = ShellRelay.Json.read("{\"t\":\"input.ack\",\"id\":\"s\",\"ackId\":\"" + ackId + "\",\"ok\":" + ok + extra + "}");
        return ShellRelay.asMap(o);
    }

    private static Map<String, Object> frameOf(ShellRelay.Send s) {
        return ShellRelay.asMap(ShellRelay.asMap(ShellRelay.Json.read(s.body)).get("frame"));
    }

    private static Map<String, Object> read(String json) {
        return ShellRelay.asMap(ShellRelay.Json.read(json));
    }

    private ShellRelay twoLanes() {
        ShellRelay r = new ShellRelay(file);
        r.setPlan(plan("aaaa1111", lane("A", item("a1", false), item("a2", false)), lane("B", item("b1", false))));
        return r;
    }

    @Test
    public void oneInFlightPerLaneAndTheNextOnlyAfterOk() {
        ShellRelay r = twoLanes();
        assertEquals("aaaa1111", r.hostId());
        List<ShellRelay.Send> first = r.next(1000);
        assertEquals(2, first.size());
        assertEquals("a1", first.get(0).ackId);
        assertEquals("b1", first.get(1).ackId);
        assertTrue(r.busy());
        assertTrue("nothing more while both are in flight", r.next(1001).isEmpty());

        Map<String, Object> f = frameOf(first.get(0));
        assertEquals("a1", f.get("ackId"));
        assertEquals("hi \u00e9", f.get("data"));
        assertEquals(1000L, f.get("firstSentAt"));
        assertEquals(1000L, f.get("sentAt"));
        assertEquals(100_000L, read(first.get(0).body).get("waitMs"));

        assertTrue(r.onAck(first.get(0), ack("a1", true, ",\"state\":\"ok\""), 2000));
        List<ShellRelay.Send> second = r.next(2000);
        assertEquals(1, second.size());
        assertEquals("a2", second.get(0).ackId);
    }

    @Test
    public void rescuedCountsAsOk() {
        ShellRelay r = twoLanes();
        ShellRelay.Send a1 = r.next(1).get(0);
        r.onAck(a1, ack("a1", false, ",\"state\":\"rescued\""), 2);
        assertEquals("a2", r.next(3).get(0).ackId);
    }

    @Test
    public void aNonOkVerdictStopsTheLaneAndIsKept() {
        ShellRelay r = twoLanes();
        List<ShellRelay.Send> s = r.next(1);
        r.onAck(s.get(0), ack("a1", false, ",\"state\":\"unsubmitted\""), 2);
        r.onAck(s.get(1), ack("b1", true, ""), 2);
        assertTrue("a2 never overtakes a1", r.next(3).isEmpty());
        Map<String, Object> c = read(r.claim());
        List<?> receipts = (List<?>) c.get("receipts");
        assertEquals(2, receipts.size());
        assertEquals("a1", ShellRelay.asMap(receipts.get(0)).get("ackId"));
        assertEquals("unsubmitted", ShellRelay.asMap(receipts.get(0)).get("state"));
    }

    @Test
    public void retryableResendsTheSameAckIdThenGivesUp() {
        ShellRelay r = new ShellRelay(file);
        r.setPlan(plan("h", lane("A", item("a1", false), item("a2", false))));
        long now = 1000;
        ShellRelay.Send s = r.next(now).get(0);
        for (int i = 0; i < ShellRelay.MAX_RETRIES; i++) {
            r.onAck(s, ack("a1", false, ",\"state\":\"notready\",\"retryable\":true"), now);
            assertTrue("backing off", r.next(now).isEmpty());
            long at = r.nextRetryAt(now);
            assertTrue(at > now);
            now = at;
            s = r.next(now).get(0);
            assertEquals("a1", s.ackId);
            assertEquals("firstSentAt never moves", 1000L, frameOf(s).get("firstSentAt"));
            assertEquals(now, frameOf(s).get("sentAt"));
        }
        r.onAck(s, ack("a1", false, ",\"state\":\"notready\",\"retryable\":true"), now);
        assertTrue("past the bound the lane is the page's", r.next(now + 3_600_000).isEmpty());
        assertEquals(1, ((List<?>) read(r.claim()).get("receipts")).size());
    }

    @Test
    public void pendingIsWrittenAndWaitsForTheNextConnect() {
        ShellRelay r = twoLanes();
        List<ShellRelay.Send> s = r.next(500);
        assertTrue(r.onPending(s.get(0)));
        assertTrue(r.onNoAnswer(s.get(1)));
        assertTrue(r.next(600).isEmpty());
        assertEquals("held by the host counts as sent", 1, r.sentCount());
        r.onConnect();
        List<ShellRelay.Send> again = r.next(700);
        assertEquals(2, again.size());
        assertEquals("a1", again.get(0).ackId);
        assertEquals(500L, frameOf(again.get(0)).get("firstSentAt"));
        Map<String, Object> c = read(r.claim());
        assertEquals(0, ((List<?>) c.get("receipts")).size());
        assertEquals(2, ((List<?>) c.get("written")).size());
    }

    @Test
    public void refusedStopsTheLane() {
        ShellRelay r = twoLanes();
        ShellRelay.Send a1 = r.next(1).get(0);
        r.onRefused(a1);
        r.onConnect();
        List<ShellRelay.Send> next = r.next(2);
        assertTrue(next.isEmpty() || !"A".equals(next.get(0).lane));
    }

    @Test
    public void aFirstAttemptTheHostRefusedIsNotWritten() {
        ShellRelay r = twoLanes();
        r.onRefused(r.next(1).get(0));
        for (Object o : (List<?>) read(r.claim()).get("written")) {
            assertFalse("nothing ran, so the page is not told it was sent", "a1".equals(ShellRelay.asMap(o).get("ackId")));
        }
    }

    @Test
    public void aRefusalAfterAnUnansweredAttemptKeepsTheRowWritten() {
        ShellRelay r = twoLanes();
        ShellRelay.Send a1 = r.next(1).get(0);
        r.onNoAnswer(a1);
        r.onConnect();
        ShellRelay.Send again = r.next(2).get(0);
        assertEquals("a1", again.ackId);
        r.onRefused(again);
        List<?> w = (List<?>) read(r.claim()).get("written");
        boolean has = false;
        for (Object o : w) if ("a1".equals(ShellRelay.asMap(o).get("ackId"))) has = true;
        assertTrue("the first attempt may have run", has);
    }

    @Test
    public void aFrameTheRowAlreadySentKeepsItsFirstSentAt() {
        ShellRelay r = new ShellRelay(file);
        r.setPlan(plan("h", lane("A", "{\"ackId\":\"x\",\"frame\":{\"t\":\"backlog.add\",\"ackId\":\"x\",\"firstSentAt\":42}}")));
        ShellRelay.Send s = r.next(9000).get(0);
        assertEquals(42L, frameOf(s).get("firstSentAt"));
        Map<String, Object> w = ShellRelay.asMap(((List<?>) read(r.claim()).get("written")).get(0));
        assertEquals(42L, w.get("firstSentAt"));
    }

    @Test
    public void aRowThePageNeverAttemptedIsSentAsFirstByRelay() {
        ShellRelay r = new ShellRelay(file);
        r.setPlan(plan("h",
            lane("A", item("fresh", false)),
            lane("B", "{\"ackId\":\"x\",\"frame\":{\"t\":\"backlog.add\",\"ackId\":\"x\",\"firstSentAt\":42}}")));
        List<ShellRelay.Send> sends = r.next(9000);
        assertEquals(Boolean.TRUE, read(sends.get(0).body).get("firstByRelay"));
        assertEquals("the page's own stamp is an age the host may judge", null, read(sends.get(1).body).get("firstByRelay"));
        // a retry of the relay's own first send is still the relay's
        r.onNoAnswer(sends.get(0));
        r.onConnect();
        assertEquals(Boolean.TRUE, read(r.next(9_000_000).get(0).body).get("firstByRelay"));
    }

    @Test
    public void aRefusingAckIsKeptAsTheReceipt() {
        ShellRelay r = twoLanes();
        ShellRelay.Send a1 = r.next(1).get(0);
        assertTrue(r.onAck(a1, ack("a1", false, ",\"reason\":\"too long ago\",\"retryable\":false"), 2));
        Map<String, Object> c = read(r.claim());
        assertEquals(1, ((List<?>) c.get("receipts")).size());
    }

    @Test
    public void receiptsAndWrittenSurviveAReloadUntilClaimed() {
        ShellRelay r = twoLanes();
        r.releaseOwnership();
        List<ShellRelay.Send> s = r.next(100);
        r.onAck(s.get(0), ack("a1", true, ""), 200);

        ShellRelay again = new ShellRelay(file);
        assertTrue(again.released());
        assertEquals("aaaa1111", again.hostId());
        // a1 is done; b1 is written but unanswered (the process died mid-POST): both lanes go on.
        List<ShellRelay.Send> next = again.next(300);
        assertEquals(2, next.size());
        assertEquals("a2", next.get(0).ackId);
        assertEquals("b1", next.get(1).ackId);
        assertEquals(100L, frameOf(next.get(1)).get("firstSentAt"));

        Map<String, Object> c = read(again.claim());
        assertEquals(1, ((List<?>) c.get("receipts")).size());
        assertEquals(3, ((List<?>) c.get("written")).size());
        assertFalse(c.containsKey("lost"));

        Map<String, Object> after = read(new ShellRelay(file).claim());
        assertEquals(0, ((List<?>) after.get("receipts")).size());
        assertEquals(0, ((List<?>) after.get("written")).size());
    }

    @Test
    public void aCorruptFileIsMovedAsideAndSaidLost() throws IOException {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write("{\"owns\":true,\"receipts\":[{\"ackId\":".getBytes(StandardCharsets.UTF_8));
        }
        ShellRelay r = new ShellRelay(file);
        File[] aside = tmp.getRoot().listFiles((d, n) -> n.startsWith("shell.relay.json.corrupt-"));
        assertNotNull(aside);
        assertEquals("the unreadable file is kept, not overwritten", 1, aside.length);
        assertFalse(r.released());
        assertEquals(null, r.hostId());
        assertTrue(r.next(1).isEmpty());
        assertEquals("lost survives a reload", Boolean.TRUE, read(new ShellRelay(file).snapshot()).get("lost"));
        assertEquals(Boolean.TRUE, read(r.claim()).get("lost"));
        assertFalse(read(new ShellRelay(file).claim()).containsKey("lost"));
    }

    @Test
    public void ownershipRules() {
        assertFalse("never while in front", ShellRelay.mayOwn(true, true, true, 999_999));
        assertFalse("never while in front, page or not", ShellRelay.mayOwn(true, true, false, 0));
        assertTrue("released by freeze", ShellRelay.mayOwn(true, false, true, 0));
        assertTrue("no page in this process", ShellRelay.mayOwn(false, false, false, 0));
        assertFalse("hidden, page alive, no freeze yet", ShellRelay.mayOwn(false, false, true, 299_000));
        assertTrue("hidden past the freeze fallback", ShellRelay.mayOwn(false, false, true, ShellRelay.HIDDEN_FALLBACK_MS));
    }

    @Test
    public void aClaimTakesOwnershipBackAndDropsLateVerdicts() {
        ShellRelay r = twoLanes();
        r.releaseOwnership();
        List<ShellRelay.Send> s = r.next(10);
        Map<String, Object> c = read(r.claim());
        assertFalse(r.released());
        assertEquals("in-flight rows are handed back as written", 2, ((List<?>) c.get("written")).size());
        assertFalse("a verdict after the claim is the page's", r.onAck(s.get(0), ack("a1", true, ""), 20));
        assertEquals(0, ((List<?>) read(r.snapshot()).get("receipts")).size());
        assertFalse(new ShellRelay(file).released());
    }

    @Test
    public void takeBackKeepsReceipts() {
        ShellRelay r = twoLanes();
        r.releaseOwnership();
        ShellRelay.Send a1 = r.next(10).get(0);
        r.onAck(a1, ack("a1", true, ""), 11);
        r.takeBack();
        assertFalse(r.released());
        assertEquals(1, ((List<?>) read(r.snapshot()).get("receipts")).size());
    }

    @Test
    public void releaseAppliesOnlyToMatchingAckIdsInTheCurrentPlan() {
        ShellRelay r = new ShellRelay(file);
        r.setPlan(plan("h", lane("A", item("a1", true), item("a2", false)), lane("B", item("b1", false))));
        List<ShellRelay.Send> s = r.next(1);
        assertEquals("lane A waits for a person", 1, s.size());
        assertEquals("b1", s.get(0).ackId);
        assertEquals(Collections.singletonList("a1"), r.releasable());

        assertEquals(0, r.release(Arrays.asList("zz", "b1")));
        assertEquals(1, r.release(Arrays.asList("a1", "zz")));
        assertTrue(r.releasable().isEmpty());
        assertEquals("a1", r.next(2).get(0).ackId);
    }

    @Test
    public void aReleaseDoesNotFollowARowThatChanged() {
        ShellRelay r = new ShellRelay(file);
        r.setPlan(plan("h", lane("A", item("a1", true))));
        // The row was re-aimed (a new ackId) before the tap landed.
        r.setPlan(plan("h", lane("A", item("a1b", true))));
        assertEquals(0, r.release(Collections.singletonList("a1")));
        assertTrue(r.next(1).isEmpty());
        // Released, then the plan moved on: the release does not carry over to another id.
        assertEquals(1, r.release(Collections.singletonList("a1b")));
        r.setPlan(plan("h", lane("A", item("a1c", true))));
        assertTrue(r.next(2).isEmpty());
        assertEquals(Collections.singletonList("a1c"), r.releasable());
    }

    @Test
    public void anUnreadablePlanIsNoPlan() {
        ShellRelay r = twoLanes();
        r.setPlan("{\"hostId\":\"h\",\"v\":2,\"lanes\":[]}");
        assertEquals(null, r.hostId());
        assertTrue(r.next(1).isEmpty());
        r.setPlan(plan("h", lane("A", "{\"ackId\":\"x\",\"frame\":{\"t\":\"session.input\",\"ackId\":\"other\"}}")));
        assertEquals("a frame under another ackId is refused whole", null, r.hostId());
        r.setPlan("not json");
        assertEquals(null, r.hostId());
        r.setPlan(null);
        assertEquals(null, r.hostId());
    }

    @Test
    public void backlogWords() {
        assertEquals("2 prompts sent", ShellRelay.backlogTitle(2, 1));
        assertEquals("Sent 2 to studio. 1 waits for you — open to review.", ShellRelay.backlogBody(2, 1, 0, "studio"));
        assertEquals("Sent 1 to studio.", ShellRelay.backlogBody(1, 0, 0, "studio"));
        assertEquals("3 prompts waiting", ShellRelay.backlogTitle(0, 3));
        assertEquals("The link is back. Open the app to send them.", ShellRelay.backlogBody(0, 3, 0, "studio"));
        assertEquals("The link is back. 1 waits for you — send it or open to review.", ShellRelay.backlogBody(0, 1, 1, "studio"));
    }

    @Test
    public void jsonRoundTripsAFrame() {
        String in = "{\"t\":\"op\",\"n\":-12,\"f\":1.5,\"big\":1731600000000,\"s\":\"a\\\"b\\\\c\\n\\u2028\",\"x\":null,\"l\":[true,false,{}]}";
        Object o = ShellRelay.Json.read(in);
        assertEquals(in, ShellRelay.Json.write(o));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("d", 2.0);
        assertEquals("{\"d\":2}", ShellRelay.Json.write(m));
    }
}
