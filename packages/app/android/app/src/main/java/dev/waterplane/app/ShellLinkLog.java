package dev.waterplane.app;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * The background link's own record of its ups and downs, one file per desktop.
 *
 * <p>The desktop logs when the link opens and closes (`host/src/linklog.ts`), but a
 * link Android froze without closing looks open there until two pings go unanswered, and
 * nothing on the desktop can say when the phone dialled, what the failure was, how long the
 * retry waited or when an alert was actually shown. So the link notes those here as they
 * happen (dial, open, fail, closed, retry, wake, net-up, net-lost, alert), and on each
 * reconnect hands the whole ring to that desktop in one {@code link.log} frame
 * (`shared/wire/notifylink.ts`), which writes it beside its own rows on its own clock.
 *
 * <p>Plain files and hand-built JSON, no Android or org.json, so it runs in a JVM test. One
 * line per event, {@code at \t ev \t detail}; at most {@link #MAX} lines (the oldest go).
 * Fire and forget: a frame lost with its socket costs log lines, never work. Nothing here
 * throws into the link.
 */
final class ShellLinkLog {
    /** The host's `LINK_LOG_MAX_EVENTS`: it keeps no more per frame. */
    static final int MAX = 300;
    private static final int DETAIL_MAX = 160;

    private final File dir;

    ShellLinkLog(File dir) { this.dir = dir; }

    private File fileFor(String hostId) {
        String key = hostId == null || hostId.isEmpty() ? "_" : hostId.replaceAll("[^A-Za-z0-9_-]", "_");
        return new File(dir, "linklog-" + key + ".txt");
    }

    /** Notes one event now-ish ({@code at}, ms) for this desktop's link. */
    synchronized void note(String hostId, long at, String ev, String detail) {
        try {
            File f = fileFor(hostId);
            String d = detail == null ? "" : clean(detail);
            String line = at + "\t" + ev + "\t" + d + "\n";
            try (FileOutputStream out = new FileOutputStream(f, true)) {
                out.write(line.getBytes(StandardCharsets.UTF_8));
            }
            List<String> lines = Files.readAllLines(f.toPath(), StandardCharsets.UTF_8);
            if (lines.size() > MAX + 50) write(f, lines.subList(lines.size() - MAX, lines.size()));
        } catch (IOException | RuntimeException e) {
            // A log that cannot be written is a log line missing, never a link down.
        }
    }

    /**
     * Takes this desktop's events as one {@code link.log} frame and empties the ring, or
     * returns null when there is nothing to send. {@code sentAt} is the phone's clock at the
     * write: the desktop moves every {@code at} by (its now − sentAt).
     */
    synchronized String drainFrame(String hostId, long sentAt) {
        File f = fileFor(hostId);
        List<String> lines;
        try {
            if (!f.exists()) return null;
            lines = Files.readAllLines(f.toPath(), StandardCharsets.UTF_8);
        } catch (IOException | RuntimeException e) {
            return null;
        }
        int from = Math.max(0, lines.size() - MAX);
        StringBuilder sb = new StringBuilder("{\"t\":\"link.log\",\"sentAt\":").append(sentAt).append(",\"events\":[");
        int n = 0;
        for (String line : lines.subList(from, lines.size())) {
            String[] p = line.split("\t", 3);
            if (p.length < 2) continue;
            long at;
            try { at = Long.parseLong(p[0]); } catch (NumberFormatException e) { continue; }
            if (n++ > 0) sb.append(',');
            sb.append("{\"at\":").append(at).append(",\"ev\":").append(json(p[1]));
            if (p.length == 3 && !p[2].isEmpty()) sb.append(",\"d\":").append(json(p[2]));
            sb.append('}');
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
        return n == 0 ? null : sb.append("]}").toString();
    }

    private static void write(File f, List<String> lines) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        StringBuilder sb = new StringBuilder();
        for (String l : lines) sb.append(l).append('\n');
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(f)) throw new IOException("rename");
    }

    /** One line, no tabs, bounded: a detail is an exception message, not a document. */
    static String clean(String s) {
        String one = s.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ');
        return one.length() > DETAIL_MAX ? one.substring(0, DETAIL_MAX) : one;
    }

    static String json(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }
}
