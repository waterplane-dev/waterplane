package dev.waterplane.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * **Downloading a file, in a process the phone will not freeze.**
 *
 * `web/pull.ts` is a complete, resumable downloader — and in the APK it stopped
 * dead every time the user switched apps. The reason is measured and written
 * down in {@link ShellLinkService}: a foreground service keeps the app's PROCESS
 * out of Android's cached-app freezer, but <b>Chromium freezes the DOCUMENT on
 * its own</b>, 300 s after {@code visibilitychange}, to the second. Everything
 * holding a JS transfer together — the pump's {@code setInterval}, the retry
 * timer, the two stall fuses, the {@code fetch} reader loop itself — is inside
 * that document. Five minutes in a pocket and a 90 MB APK is at whatever percent
 * it reached, with a spinner, until somebody looks at the screen again.
 *
 * So the transfer moves out of the page. This service is the whole engine: it
 * holds the socket, writes the bytes, resumes from the offset, retries with its
 * own backoff, and publishes the finished file into the phone's Downloads
 * ({@link Downloads}, shared with {@link ShellSavePlugin} so the two cannot word
 * one outcome two ways). The page keeps the QUEUE and every sentence about it;
 * this keeps only what has to survive the page.
 *
 * <h2>Why not {@code DownloadManager}</h2>
 *
 * It is the obvious answer and it is wrong here. {@code DownloadManager} runs in
 * {@code com.android.providers.downloads} — a different app, whose VPN routing,
 * cleartext policy and metered-network rules are not this app's. The daemon is
 * on a Tailscale tailnet, reachable because THIS process is inside the tunnel,
 * and handing the URL to another process makes reachability an untestable
 * property of a component the user can also disable. It reports a status enum
 * and a reason int where the rows in this app say what actually happened.
 *
 * <h2>{@code dataSync}, and why the cap does not bite</h2>
 *
 * {@link ShellLinkService} is {@code specialUse} precisely because Android 15
 * caps a {@code dataSync} service at ~6 h per 24 h and a permanent connection
 * built on it dies overnight. A DOWNLOAD is the opposite shape: it is bounded,
 * it is minutes, and {@code dataSync} is the type that honestly describes it.
 * The one consequence to know is that Android 15+ refuses to START one from the
 * background — so an enqueue made while the app is already backgrounded is
 * caught, left {@code queued}, and runs when the app is next opened. That is
 * stated in the row rather than hidden.
 *
 * <h2>Rules</h2>
 *
 * <ul>
 *   <li><b>The store is the truth, the events are a hint.</b> A frozen document
 *       runs no tasks, so a progress callback into the WebView can be dropped
 *       on the floor; every state change is written to {@code SharedPreferences}
 *       first, and the page re-reads the whole list on every wake. Nothing in
 *       this class assumes anybody heard anything.</li>
 *   <li><b>One transfer at a time</b>, the same rule `pull.ts` holds and for the
 *       same reason: two transfers on a bad link finish later than the same two
 *       run in sequence, and a half-downloaded APK is worth nothing.</li>
 *   <li><b>The offset is the file's own length.</b> There is no second record of
 *       "how much we have" that can disagree with the bytes on disk — the bug
 *       `pull.ts` needs its blob-plus-offset record to avoid does not exist
 *       here.</li>
 *   <li><b>A partial file is never published.</b> Bytes land in
 *       {@code files/pulls/<id>.part} and are renamed to {@code .bin} only when
 *       the transfer is complete; only a {@code .bin} is ever copied into
 *       Downloads.</li>
 * </ul>
 */
public class ShellPullService extends Service {

    private static final String TAG = "shell-pull";

    static final String ACTION_ENQUEUE = "dev.waterplane.app.pull.ENQUEUE";
    static final String ACTION_CANCEL = "dev.waterplane.app.pull.CANCEL";
    static final String ACTION_DISCARD = "dev.waterplane.app.pull.DISCARD";
    static final String ACTION_PUBLISH = "dev.waterplane.app.pull.PUBLISH";
    static final String ACTION_KICK = "dev.waterplane.app.pull.KICK";
    static final String ACTION_INSTALL = "dev.waterplane.app.pull.INSTALL";

    static final String EXTRA_ID = "id";

    private static final String PREFS = "shell.pull";
    private static final String KEY_ITEMS = "items";

    private static final String CHANNEL_PROGRESS = "pull";
    private static final int PROGRESS_NOTIFICATION_ID = 4772;

    /** Bytes between persists of the offset. The offset itself is the file
     *  length, so this only paces how often the ROW is rewritten and the page
     *  told; the transfer resumes correctly whatever happens between two. */
    private static final long PROGRESS_BYTES = 512 * 1024;
    /** …and a floor in time, because on a slow link 512 KB is minutes and a
     *  progress number that only moves per megabyte reads as frozen. */
    private static final long PROGRESS_MS = 1000;

    /** Mirrors `pull.ts`'s BACKOFF, clamped to the last entry. */
    private static final long[] BACKOFF = { 2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000 };
    /** Give up after this many attempts that moved NO bytes. An attempt that
     *  moved some resets the count — a link handing over 40 KB a try is awful
     *  but it is finishing the file. */
    private static final int MAX_ATTEMPTS = 50;

    /** Live instance, or null — only ever asked "is it up?". */
    @Nullable private static volatile ShellPullService instance;
    /**
     * A start has been asked for and the service has not come up yet.
     *
     * {@code startForegroundService} is asynchronous, so without this the page
     * reads "not running" one millisecond after handing a row over — and the
     * page's own recovery rule (a queued row with nothing alive to run it goes
     * back to the pump) would immediately hand it over again, for ever. Cleared
     * in {@link #onCreate}, and never set when the platform REFUSED the start,
     * which is the case that recovery exists for.
     */
    private static volatile boolean pendingStart;

    /** How the plugin hears about a change. Set while the bridge is alive;
     *  unset is a no-op, which is the normal state with the app closed. */
    interface Watcher { void onPullChanged(JSONArray items); }
    @Nullable private static volatile Watcher watcher;

    static void setWatcher(@Nullable Watcher w) { watcher = w; }

    private final Handler handler = new Handler(Looper.getMainLooper());
    /** One worker. See the class comment: sequential is the rule, not an
     *  accident of using a single thread. */
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    @Nullable private OkHttpClient client;
    private volatile boolean busy = false;
    private volatile boolean stopping = false;
    /** The id being transferred, so a cancel can drop the connection under it. */
    @Nullable private volatile String running;
    @Nullable private volatile okhttp3.Call call;
    /** What the foreground notification is currently about, so a command
     *  arriving mid-transfer repaints it with the transfer rather than with a
     *  bare "Downloading". */
    @Nullable private volatile Item current;
    /** The newest start id, so {@link #idle()} can stop with
     *  {@code stopSelf(id)} — which does nothing if a command arrived while the
     *  last transfer was finishing. Stopping unconditionally there is how an
     *  enqueue lands one millisecond into a shutdown and never runs. */
    private int lastStartId;

    // ── the store ────────────────────────────────────────────────────────

    /**
     * One queued or finished transfer.
     *
     * Deliberately a flat record read and written as JSON: it has to survive
     * process death, and the page has to be able to read the whole thing back
     * with no service running at all.
     */
    private static final class Item {
        String id = "";
        String url = "";
        String name = "";
        String mime = "";
        long size;            // what the host said, 0 when unknown
        long received;        // bytes on disk (the file's own length)
        String etag = "";
        boolean autoSave;
        String state = "queued";   // queued | downloading | done | failed | paused
        String error = "";
        String where = "";         // "Downloads/app.apk" once published
        int attempts;
        /** When the backoff lets this row run again. A `queued` row is not the
         *  same as a runnable one, and without this the pump picks a row up the
         *  instant its own retry was scheduled — spending the whole give-up
         *  budget in a second against a link that is simply down. */
        long nextAt;
        long updatedAt;
        /** What the APK says it is, read off the finished file — three repos on
         *  this desktop all build `app-debug.apk`, so the NAME says nothing. */
        String pkg = "";
        String pkgLabel = "";
        String pkgVersion = "";
        /** `versionCode` — the only monotonic thing an APK carries, and so the
         *  only way to ask afterwards whether THIS build is the one now
         *  installed. 0 = unread, never a version. */
        long pkgCode;
        /** "" | queued | installing | asked | installed | failed. `asked` is the
         *  system installer waiting for a tap, which is not a failure and must
         *  never be worded as one. */
        String install = "";
        String installError = "";
        /** When the install REACHED its outcome, by this phone's clock.
         *
         *  The desktop keeps the log (one host, many phones), and the report of
         *  an install that happened at 3 a.m. with the tunnel down arrives at
         *  the next handshake — so a log stamped on arrival would say the phone
         *  installed it at breakfast. Only the shell can answer this, and a
         *  shell older than this field answers nothing rather than a number
         *  somebody would read as the install's own. */
        long installedAt;
        /** The `PackageInstaller` session this row is waiting on, so a callback
         *  can be matched to the attempt that made it. A person can start a
         *  second install while the first is still at `asked`, and a status
         *  arriving for the abandoned one would otherwise stamp the row with an
         *  outcome belonging to a different attempt — and with the other one's
         *  `installAuto`. 0 = nothing in flight. */
        int installSession;
        /** Did this install itself, or did somebody tap the row? Recorded at the
         *  START of the install, which is the only moment that knows: the status
         *  receiver is woken by the system and has no idea who asked. */
        boolean installAuto;
        /** Did anybody RECORD which way it went? A row written by a shell older
         *  than `installAuto` has not, and `false` there would be printed as the
         *  positive claim "installed on a tap". */
        boolean installAutoKnown;
        /** "link" when {@link ShellLinkService} queued this row on its own, off a
         *  `pull.new` frame the frozen page never saw; "" once the page has
         *  handed it over itself (any {@link #enqueue}). Only an unclaimed row
         *  carries {@link #pullItem}, and only that one is ADOPTED by the page
         *  on its next wake — a row the page has claimed and then dropped is an
         *  orphan it discards, and must never come back to life from here. */
        String origin = "";
        /** The host's `PullItem`, verbatim, for the page to adopt. */
        String pullItem = "";
        /** "Later" on the ready-to-install notification: when it comes back.
         *  0 = not snoozed. The row is still listed as ready in the app. */
        long snoozeUntil;
        /** When the clean-up after an install deleted this row's APK
         *  ({@link #cleanAfterInstall}). 0 = never cleaned. The row stays: it is
         *  the record that the build was here and went on. */
        long cleanedAt;
        /** Bytes the clean-up gave back for this row, the app's copy and the
         *  Downloads copy together. */
        long cleanedBytes;
        /** Why a Downloads copy STAYED, where the clean-up could not remove it
         *  ("" = nothing stayed, or there was no copy). Said, never swallowed. */
        String cleanNote = "";
        /** When the app's own copy was deleted because Downloads holds the file
         *  ({@link #dropAfterSave}). 0 = the app still has it. The Downloads
         *  copy is then the only one, and installing reads it from there. */
        long droppedAt;

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("url", url);
            o.put("name", name);
            o.put("mime", mime);
            o.put("size", size);
            o.put("received", received);
            o.put("etag", etag);
            o.put("autoSave", autoSave);
            o.put("state", state);
            o.put("error", error);
            o.put("where", where);
            o.put("attempts", attempts);
            o.put("nextAt", nextAt);
            o.put("updatedAt", updatedAt);
            o.put("pkg", pkg);
            o.put("pkgLabel", pkgLabel);
            o.put("pkgVersion", pkgVersion);
            o.put("pkgCode", pkgCode);
            o.put("install", install);
            o.put("installError", installError);
            o.put("installedAt", installedAt);
            o.put("installSession", installSession);
            // Written only where an install was actually STARTED from here, so
            // the key is ABSENT on a row this shell inherited from an older one.
            // Absent means nobody recorded which way it went, and the desktop's
            // log must be able to tell that from a tap — `false` would be
            // printed as the positive claim "installed on a tap"
            // (`shared/installlog.ts`).
            if (installAutoKnown) o.put("installAuto", installAuto);
            if (snoozeUntil > 0) o.put("installSnoozedUntil", snoozeUntil);
            if (cleanedAt > 0) {
                o.put("cleanedAt", cleanedAt);
                o.put("cleanedBytes", cleanedBytes);
                if (!cleanNote.isEmpty()) o.put("cleanNote", cleanNote);
            }
            if (droppedAt > 0) o.put("droppedAt", droppedAt);
            if (!origin.isEmpty()) {
                o.put("origin", origin);
                try { o.put("item", new JSONObject(pullItem)); } catch (JSONException e) { /* adopted by nobody */ }
            }
            return o;
        }

        static Item fromJson(JSONObject o) {
            Item it = new Item();
            it.id = o.optString("id", "");
            it.url = o.optString("url", "");
            it.name = o.optString("name", "");
            it.mime = o.optString("mime", "");
            it.size = o.optLong("size", 0);
            it.received = o.optLong("received", 0);
            it.etag = o.optString("etag", "");
            it.autoSave = o.optBoolean("autoSave", false);
            it.state = o.optString("state", "queued");
            it.error = o.optString("error", "");
            it.where = o.optString("where", "");
            it.attempts = o.optInt("attempts", 0);
            it.nextAt = o.optLong("nextAt", 0);
            it.updatedAt = o.optLong("updatedAt", 0);
            it.pkg = o.optString("pkg", "");
            it.pkgLabel = o.optString("pkgLabel", "");
            it.pkgVersion = o.optString("pkgVersion", "");
            it.pkgCode = o.optLong("pkgCode", 0);
            it.install = o.optString("install", "");
            it.installError = o.optString("installError", "");
            it.installedAt = o.optLong("installedAt", 0);
            it.installSession = o.optInt("installSession", 0);
            it.installAuto = o.optBoolean("installAuto", false);
            it.installAutoKnown = o.has("installAuto");
            it.snoozeUntil = o.optLong("installSnoozedUntil", 0);
            it.cleanedAt = o.optLong("cleanedAt", 0);
            it.cleanedBytes = o.optLong("cleanedBytes", 0);
            it.cleanNote = o.optString("cleanNote", "");
            it.droppedAt = o.optLong("droppedAt", 0);
            it.origin = o.optString("origin", "");
            JSONObject pi = o.optJSONObject("item");
            it.pullItem = pi == null ? "" : pi.toString();
            return it;
        }
    }

    /**
     * The store is read-modify-written from two threads — the worker, once a
     * second for the length of a transfer, and the main thread, on every pause,
     * discard and enqueue. Unsynchronised, a pause lands between the worker's
     * read and its write and is silently overwritten by a row that still says
     * `downloading`, so the transfer is retried instead of staying paused.
     */
    private static final Object LOCK = new Object();

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Every row, in insertion order. Static so the plugin can answer `list()`
     *  with the service stopped — which is the state after every completion. */
    static JSONArray snapshot(Context ctx) {
        // The one moment an install nobody heard the end of can be settled: the
        // page is asking, so this process is alive — which, for a self-update,
        // is itself half the evidence.
        settleInstalls(ctx);
        JSONArray out = new JSONArray();
        for (Item it : load(ctx).values()) {
            try { out.put(it.toJson()); } catch (JSONException e) { Log.w(TAG, "bad row: " + e); }
        }
        return out;
    }

    /** Every row's id — for the plugin, which may not see an `Item`. */
    static List<String> ids(Context ctx) {
        return new ArrayList<>(load(ctx).keySet());
    }

    private static Map<String, Item> load(Context ctx) {
        Map<String, Item> items = new LinkedHashMap<>();
        String raw = prefs(ctx).getString(KEY_ITEMS, "[]");
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Item it = Item.fromJson(o);
                if (!it.id.isEmpty()) items.put(it.id, it);
            }
        } catch (JSONException e) {
            Log.w(TAG, "unreadable queue, starting empty: " + e);
        }
        return items;
    }

    private static void save(Context ctx, Map<String, Item> items) {
        JSONArray arr = new JSONArray();
        for (Item it : items.values()) {
            try { arr.put(it.toJson()); } catch (JSONException e) { Log.w(TAG, "bad row: " + e); }
        }
        // `commit`, not `apply`: the next thing that happens to this process may
        // be the OS killing it, and a queue that lost its last state change
        // re-downloads a finished file or forgets a failure.
        prefs(ctx).edit().putString(KEY_ITEMS, arr.toString()).commit();
        Watcher w = watcher;
        if (w != null) {
            try { w.onPullChanged(arr); } catch (RuntimeException e) { Log.d(TAG, "watcher: " + e); }
        }
    }

    /** Add a row (or adopt an existing one) BEFORE the service is started, so a
     *  start the platform refuses still leaves something the page can see and
     *  the next foreground can run. */
    static void enqueue(Context ctx, String id, String url, String name, String mime,
                        long size, String etag, boolean autoSave) {
        synchronized (LOCK) {
            Map<String, Item> items = load(ctx);
            Item it = items.get(id);
            if (it == null) {
                it = new Item();
                it.id = id;
                items.put(id, it);
            }
            it.url = url;
            it.name = name;
            it.mime = mime == null || mime.isEmpty() ? Downloads.guessMime(name) : mime;
            if (size > 0) it.size = size;
            if (etag != null && !etag.isEmpty()) it.etag = etag;
            it.autoSave = it.autoSave || autoSave;
            // A tap on a failed or paused row is a decision to try again, and it
            // clears the give-up count. A row already `done` keeps its verdict —
            // re-downloading a file the phone has is the one thing an idempotent
            // enqueue must not do.
            if (!"done".equals(it.state)) {
                it.state = "queued";
                it.attempts = 0;
                it.error = "";
                it.nextAt = 0;   // a tap outranks the backoff, the same way `pump(force)` does
            }
            it.received = partOf(ctx, id).length();
            it.updatedAt = System.currentTimeMillis();
            // Handed over by the page: it is the page's row from here on.
            it.origin = "";
            it.pullItem = "";
            save(ctx, items);
        }
        start(ctx, new Intent(ctx, ShellPullService.class).setAction(ACTION_KICK));
    }

    // ── the auto-download switch, mirrored ───────────────────────────────

    private static final String KEY_AUTO = "auto";

    /** The page's auto-download switch (`pull.ts` `autoPull()`), mirrored here
     *  because the one moment it matters is when the document is frozen. On by
     *  default, as it is on the page — a bundle that has never mirrored it has
     *  never had it switched off either. */
    static boolean autoEnabled(Context ctx) {
        return prefs(ctx).getBoolean(KEY_AUTO, true);
    }

    static void setAuto(Context ctx, boolean on) {
        prefs(ctx).edit().putBoolean(KEY_AUTO, on).apply();
    }

    /**
     * Queue a `pull.new` item the page could not: it arrived on
     * {@link ShellLinkService}'s socket while the document was frozen (Chromium
     * does that 300 s after the app is hidden), and before this the download
     * waited for the app to be opened again — the whole reason this engine
     * exists, undone at the handover.
     *
     * <b>Only a row nobody holds.</b> An existing id is the page's (or an
     * earlier adoption's) and keeps its backoff, its give-up count and its
     * verdict — this is a heartbeat-grade call, never a tap. What to fetch is
     * still the host's decision (its rules queued the item) and the switch is
     * the page's (mirrored in {@link #autoEnabled}); nothing is decided here.
     */
    static boolean adopt(Context ctx, JSONObject item, String base) {
        String id = item.optString("id", "");
        String repoId = item.optString("repoId", "");
        String relPath = item.optString("relPath", "");
        if (id.isEmpty() || repoId.isEmpty() || relPath.isEmpty()) return false;
        String name = Downloads.safeName(item.optString("name", relPath.substring(relPath.lastIndexOf('/') + 1)));
        if (name == null) return false;
        String url = base + "/api/repos/" + Uri.encode(repoId) + "/artifact?path=" + Uri.encode(relPath) + "&download=1";
        synchronized (LOCK) {
            Map<String, Item> items = load(ctx);
            if (items.containsKey(id)) return false;
            Item it = new Item();
            it.id = id;
            it.url = url;
            it.name = name;
            it.mime = Downloads.guessMime(name);
            it.size = Math.max(0, item.optLong("size", 0));
            it.origin = "link";
            it.pullItem = item.toString();
            it.updatedAt = System.currentTimeMillis();
            items.put(id, it);
            save(ctx, items);
        }
        start(ctx, new Intent(ctx, ShellPullService.class).setAction(ACTION_KICK));
        return true;
    }

    static void mutate(Context ctx, String id, String action) {
        Intent i = new Intent(ctx, ShellPullService.class).setAction(action);
        i.putExtra(EXTRA_ID, id);
        start(ctx, i);
    }

    /**
     * {@code startForegroundService} throws when the app is in a state that may
     * not start one — Android 15 refuses a background start of a
     * {@code dataSync} service outright. Catching it is the honest behaviour:
     * the row stays queued, the page can say so, and the next time the app is
     * opened the queue runs. A crash here would take the app down for a
     * download.
     */
    private static void start(Context ctx, Intent intent) {
        try {
            ContextCompat.startForegroundService(ctx, intent);
            pendingStart = true;
        } catch (RuntimeException e) {
            pendingStart = false;
            Log.w(TAG, "cannot start: " + e);
        }
    }

    /** Up, or on its way up. Both are "somebody is going to run that row"; only
     *  the third state — refused, or stopped with work left — is the one the
     *  page has to take back. */
    static boolean isRunning() { return instance != null || pendingStart; }

    // ── lifecycle ────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        pendingStart = false;
        createChannel();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        // Unconditionally and first: the platform kills the process if a service
        // started with `startForegroundService` has not called this within five
        // seconds — including on the path where the next thing we do is stop.
        goForeground(current);
        lastStartId = startId;
        // A command means this service is wanted again, whatever the last
        // drain-and-stop decided.
        stopping = false;

        String action = intent != null ? intent.getAction() : null;
        String id = intent != null ? intent.getStringExtra(EXTRA_ID) : null;
        if (ACTION_CANCEL.equals(action) && id != null) cancel(id);
        else if (ACTION_DISCARD.equals(action) && id != null) discard(id);
        else if (ACTION_PUBLISH.equals(action) && id != null) worker.execute(() -> { publishNow(id, true); dropAfterSave(this, id); });
        else if (ACTION_INSTALL.equals(action) && id != null) worker.execute(() -> installNow(id, true));

        pump();
        // START_STICKY: the queue is in SharedPreferences precisely so a restart
        // does not depend on an Intent the platform may not have kept.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        stopping = true;
        okhttp3.Call c = call;
        if (c != null) c.cancel();
        worker.shutdownNow();
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null; // Started, never bound — the plugin talks to it with Intents.
    }

    // ── the queue ────────────────────────────────────────────────────────

    /** Start the next queued row, or stop: an idle foreground service is a
     *  permanent notification for nothing. */
    private void pump() {
        if (stopping || busy) return;
        long now = System.currentTimeMillis();
        Item next = null;
        long soonest = Long.MAX_VALUE;
        for (Item it : load(this).values()) {
            if (!"queued".equals(it.state) || it.attempts >= MAX_ATTEMPTS) continue;
            if (it.nextAt > now) { soonest = Math.min(soonest, it.nextAt); continue; }
            next = it;
            break;
        }
        if (next == null) {
            if (soonest == Long.MAX_VALUE) { idle(); return; }
            // A retry is pending. Staying alive is the whole point: this service
            // exists because the page's own timers stop when the app is
            // backgrounded, and stopping here would move the retry back into the
            // frozen document. The backoff caps at two minutes, so the wait is
            // bounded and the notification says what it is waiting for.
            goForeground(null);
            handler.removeCallbacks(pumpRunnable);
            handler.postDelayed(pumpRunnable, Math.max(250, soonest - now));
            return;
        }
        busy = true;
        running = next.id;
        current = next;
        final Item item = next;
        patch(item.id, it -> { it.state = "downloading"; it.error = ""; it.nextAt = 0; });
        goForeground(item);
        worker.execute(() -> {
            try {
                transfer(item);
            } catch (Throwable t) {
                // Never let the worker die on an unexpected throw: the queue
                // would sit at "downloading" for ever with nothing running.
                Log.w(TAG, "transfer crashed: " + t);
                fail(item.id, String.valueOf(t.getMessage()), false);
            } finally {
                busy = false;
                running = null;
                current = null;
                call = null;
                handler.post(this::pump);
            }
        });
    }

    private final Runnable pumpRunnable = this::pump;

    private void idle() {
        if (stopping) return;
        stopping = true;
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        stopSelf(lastStartId);
    }

    private void cancel(String id) {
        if (id.equals(running)) {
            okhttp3.Call c = call;
            if (c != null) c.cancel();
        }
        // The bytes stay: `paused` resumes from the file's own length.
        patch(id, it -> { if (!"done".equals(it.state)) it.state = "paused"; });
    }

    private void discard(String id) {
        if (id.equals(running)) {
            okhttp3.Call c = call;
            if (c != null) c.cancel();
        }
        //noinspection ResultOfMethodCallIgnored
        partOf(this, id).delete();
        //noinspection ResultOfMethodCallIgnored
        binOf(this, id).delete();
        synchronized (LOCK) {
            Map<String, Item> items = load(this);
            if (items.remove(id) != null) save(this, items);
        }
    }

    // ── one transfer ─────────────────────────────────────────────────────

    private void transfer(Item item) {
        File part = partOf(this, item.id);
        //noinspection ResultOfMethodCallIgnored
        part.getParentFile().mkdirs();
        long have = part.length();
        long before = have;

        Request.Builder rb = new Request.Builder().url(item.url);
        if (have > 0) {
            rb.header("Range", "bytes=" + have + "-");
            // Without this a file rewritten under us is appended to, and the
            // result is a corrupt file that looks complete. With it the host
            // answers 200 instead and we start over.
            if (!item.etag.isEmpty()) rb.header("If-Range", item.etag);
        }
        // The LAN gate (`host/auth.ts`) hands out a cookie, and the WebView is
        // where it lives. Borrowing it is what lets a gated host be downloaded
        // from at all; on the ordinary Tailscale setup there is none and this is
        // a no-op.
        String cookie = cookieFor(item.url);
        if (cookie != null) rb.header("Cookie", cookie);

        Response res = null;
        try {
            okhttp3.Call c = http().newCall(rb.build());
            call = c;
            res = c.execute();
            int code = res.code();

            if (code == 416) {
                // The stored prefix is past the end of what the host now serves.
                // Throw it away and let the retry start clean — the host answers
                // 416 exactly so this is detectable instead of silently
                // appending to garbage.
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                fail(item.id, "the partly downloaded file no longer matches — starting over", false);
                return;
            }
            if (code != 200 && code != 206) {
                // A file the host will never hand over is not a bad link, and
                // retrying it 50 times only hides the ones that are.
                boolean permanent = code == 401 || code == 403 || code == 404 || code == 410;
                String msg = code == 403
                        ? "http 403 — the host refused this request (origin not allowed)"
                        : code == 401 ? "http 401 — this host wants a sign-in; open the app"
                        : "http " + code;
                fail(item.id, msg, permanent);
                return;
            }

            String etag = res.header("ETag");
            // 200 where a range was asked for = the whole body, either because
            // the host does not do ranges or because `If-Range` was declined.
            boolean fromZero = code == 200;
            if (fromZero) have = 0;

            long total = totalOf(res, code, have, item.size);
            ResponseBody body = res.body();
            if (body == null) { fail(item.id, "empty response", false); return; }

            long written = have;
            long lastPersist = System.currentTimeMillis();
            long sincePersist = 0;
            byte[] buf = new byte[64 * 1024];
            try (InputStream in = body.byteStream();
                 OutputStream out = new FileOutputStream(part, !fromZero)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    written += n;
                    sincePersist += n;
                    long now = System.currentTimeMillis();
                    if (sincePersist >= PROGRESS_BYTES || now - lastPersist >= PROGRESS_MS) {
                        out.flush();
                        sincePersist = 0;
                        lastPersist = now;
                        final long w = written;
                        final long tot = total;
                        final String tag = etag;
                        patch(item.id, it -> {
                            it.received = w;
                            if (tot > 0) it.size = tot;
                            if (tag != null && !tag.isEmpty()) it.etag = tag;
                        });
                        updateNotification(withProgress(item, written, total));
                    }
                }
                out.flush();
            }

            if (total > 0 && written < total) {
                // Ended without an error and short: not done. Whatever arrived
                // is kept, and the retry resumes from it.
                final long w = written;
                patch(item.id, it -> it.received = w);
                fail(item.id, "incomplete (" + written + "/" + total + ")", false);
                return;
            }
            complete(item.id, written, etag);
        } catch (IOException e) {
            long now = part.length();
            final long w = now;
            patch(item.id, it -> it.received = w);
            // Progress resets the give-up count; a cancel is not a failure.
            boolean cancelled = "paused".equals(stateOf(item.id));
            if (cancelled) return;
            fail(item.id, describe(e), false, now > before);
        } finally {
            if (res != null) res.close();
        }
    }

    /** The whole size, whichever header carries it. */
    private static long totalOf(Response res, int code, long have, long known) {
        if (code == 206) {
            String cr = res.header("Content-Range");
            if (cr != null) {
                int slash = cr.indexOf('/');
                if (slash > 0) {
                    try { return Long.parseLong(cr.substring(slash + 1).trim()); }
                    catch (NumberFormatException ignored) { /* fall through */ }
                }
            }
            long len = res.body() != null ? res.body().contentLength() : -1;
            if (len > 0) return have + len;
            return known;
        }
        long len = res.body() != null ? res.body().contentLength() : -1;
        return len > 0 ? len : known;
    }

    /**
     * The file is here. Rename it out of `.part` — nothing publishes a partial
     * file — and hand it to Downloads if a person asked for it.
     */
    private void complete(String id, long written, @Nullable String etag) {
        File part = partOf(this, id);
        File bin = binOf(this, id);
        //noinspection ResultOfMethodCallIgnored
        bin.delete();
        if (!part.renameTo(bin)) {
            fail(id, "could not finish the file on this phone", false);
            return;
        }
        patch(id, it -> {
            it.state = "done";
            it.received = written;
            if (it.size <= 0) it.size = written;
            if (etag != null && !etag.isEmpty()) it.etag = etag;
            it.error = "";
            it.attempts = 0;
            it.nextAt = 0;
        });
        publishNow(id, false);
        inspectApk(id);
        installNow(id, false);
        // Nothing started it (not on the list, a first install, no access yet):
        // the build still gets its one-tap notification. If an install DID
        // start, the receiver posts the same notification on the way to asking.
        Item after = load(this).get(id);
        if (after != null && after.install.isEmpty()) ShellInstallReceiver.postReady(this, id, null);
        // Last, after everything that reads the app's copy (inspect, install —
        // whose session has the bytes by the time it returns).
        dropAfterSave(this, id);
    }

    // ── ready to install ─────────────────────────────────────────────────

    /** What the ready-to-install notification says about a row. */
    static final class Ready {
        String id, pkg, label, version;
        long snoozeUntil;
    }

    /**
     * The row as a ready-to-install build, or null where it is not one: not an
     * APK, not finished, the file gone, already installed or installing, or a
     * NEWER finished build of the same package is on this phone — that one is
     * the build worth installing, and its notification replaces this one's.
     */
    @Nullable
    static Ready ready(Context ctx, String id) {
        Map<String, Item> items = load(ctx);
        Item it = items.get(id);
        if (it == null || !"done".equals(it.state) || !Installs.isApk(it.name, it.mime)) return null;
        if ("installed".equals(it.install) || "installing".equals(it.install)) return null;
        if (!hasBytes(ctx, it)) return null;
        // The `play` build never installs itself, nor an archive it could not
        // name (Installs.refusal), so it never offers either as ready.
        if (!BuildConfig.SELF_UPDATE && (it.pkg.isEmpty() || it.pkg.equals(ctx.getPackageName()))) return null;
        if (!it.pkg.isEmpty()) {
            for (Item o : items.values()) {
                if (o != it && it.pkg.equals(o.pkg) && "done".equals(o.state) && o.updatedAt > it.updatedAt) return null;
            }
        }
        Ready r = new Ready();
        r.id = id;
        r.pkg = it.pkg;
        r.label = !it.pkgLabel.isEmpty() ? it.pkgLabel : it.name;
        r.version = it.pkgVersion;
        r.snoozeUntil = it.snoozeUntil;
        return r;
    }

    static void snooze(Context ctx, String id, long until) {
        patch(ctx, id, r -> r.snoozeUntil = until);
    }

    /**
     * Put a finished file into the phone's Downloads.
     *
     * Also the {@code ACTION_PUBLISH} entry point, which is how the "save to
     * phone" button reaches a file the service downloaded — including the case
     * below API 29 where the plugin had to ask for a storage permission first
     * and only then hands the job here.
     *
     * A file already there is left alone: MediaStore does not overwrite, it
     * renames, so a second publish is another "app-debug (6).apk" beside the
     * five before it.
     */
    private void publishNow(String id, boolean asked) {
        Item it = load(this).get(id);
        if (it == null || !"done".equals(it.state)) return;
        // `autoSave` is what a TAP promised (`download.ts`); the host's own
        // auto-pull rules leave it off, because nobody is there to be handed a
        // file and an APK appearing in Downloads unasked is a surprise. Those
        // wait for the save button, which arrives here as `asked`.
        if (!asked && !it.autoSave) return;
        File bin = binOf(this, id);
        if (!bin.isFile()) return;
        if (!Downloads.canPublish(this)) {
            // Below API 29 with no storage grant. The bytes are safe; the plugin
            // can ask for the permission and send ACTION_PUBLISH back.
            patch(id, r -> r.error = "saved on this phone — Downloads needs permission");
            return;
        }
        try {
            Downloads.Found found = Downloads.find(this, it.name, bin.length());
            String where = found != null
                    ? "Downloads/" + found.name
                    : Downloads.publish(this, bin, it.name, it.mime);
            patch(id, r -> { r.where = where; r.error = ""; });
            announce(it.name, where);
        } catch (IOException | RuntimeException e) {
            patch(id, r -> r.error = "could not save to Downloads: " + e.getMessage());
        }
    }

    /**
     * Read what a finished APK says it is, onto its row.
     *
     * Done once, at completion, because it is the answer to "is this Tiptoi or
     * TalkingPictures" and the file name cannot give it — both repos build
     * `app-debug.apk`. A file that is not an APK, or one the package manager
     * cannot read, leaves the fields empty: absent, never a guess.
     */
    private void inspectApk(String id) {
        Item it = load(this).get(id);
        if (it == null || !"done".equals(it.state)) return;
        if (!Installs.isApk(it.name, it.mime)) return;
        Installs.Info info = Installs.read(this, binOf(this, id));
        if (info == null) return;
        patch(id, r -> {
            r.pkg = info.pkg;
            r.pkgLabel = info.label;
            r.pkgVersion = info.version.isEmpty() ? String.valueOf(info.code) : info.version;
            r.pkgCode = info.code;
        });
    }

    /**
     * Install a finished APK.
     *
     * {@code asked} is a tap on the row, which installs whatever the allow-list
     * says — a person looking at the screen IS the confirmation. Without it this
     * is the automatic path at the end of a download, and it runs only for a
     * package the person put on the list, only where the special access is
     * granted, and only as an UPDATE of something already installed
     * ({@link Installs#mayAutoInstall}).
     *
     * Every refusal is recorded on the row rather than logged: this runs with
     * the app closed, so the row is the only place anybody will ever read it.
     */
    private void installNow(String id, boolean asked) {
        Item it = load(this).get(id);
        if (it == null || !"done".equals(it.state)) return;
        if (!Installs.isApk(it.name, it.mime)) return;
        // One session at a time. Two committed sessions for one row produce two
        // status callbacks, and the second one stamps the row with an outcome
        // and an `installAuto` that belong to different attempts — which the
        // desktop then logs as two installs of one build, attributed wrongly.
        // `settleInstalls` is what unsticks a row whose callback never came.
        if ("installing".equals(it.install)) return;
        File bin = installSource(this, it);
        if (bin == null) {
            if (asked) patch(id, r -> {
                r.install = "failed";
                r.installError = "the file is not on this phone any more";
                r.installAuto = false;
                r.installAutoKnown = true;
                r.installedAt = System.currentTimeMillis();
            });
            return;
        }
        Installs.Info info = Installs.read(this, bin);
        if (asked && !Installs.canInstall(this)) {
            patch(id, r -> {
                r.install = "failed";
                r.installError = "this phone has not allowed waterplane to install apps";
                r.installAuto = false;
                r.installAutoKnown = true;
                r.installedAt = System.currentTimeMillis();
            });
            return;
        }
        if (!asked && !Installs.mayAutoInstall(this, info)) { unstage(this, id); return; }
        // A silent install is only ever possible for an UPDATE, and only with a
        // consent: the person's tap on Install (a second "Update?" after it was
        // the same question twice), or the package on the list for the
        // automatic path. A first install always asks — and a refused silence
        // (another app's update owner) asks too, so this can never cost one.
        boolean silent = info != null
                && Installs.silentPossible()
                && Installs.isInstalled(this, info.pkg)
                && (asked || Installs.allowed(this).contains(info.pkg));
        // `installAuto` is recorded HERE because this is the only moment that
        // knows: the status receiver is woken by the system long afterwards and
        // cannot tell a tap from the automatic path at the end of a download.
        // The previous attempt's stamp goes with it — a re-install is a second
        // thing that happened, and the desktop's log keys on that instant.
        boolean auto = !asked;
        patch(id, r -> {
            if (asked) r.snoozeUntil = 0;
            r.install = "installing";
            r.installError = "";
            r.installAuto = auto;
            r.installAutoKnown = true;
            r.installedAt = 0;
            r.installSession = 0;
        });
        try {
            int session;
            try { session = Installs.install(this, id, bin, info, silent); }
            finally { unstage(this, id); }
            // Only while the row is still waiting: a silent update can answer
            // before this line runs, and writing the session id over a row that
            // has already settled would leave a finished install pointing at a
            // session nothing is coming from.
            patch(id, r -> { if ("installing".equals(r.install)) r.installSession = session; });
        } catch (IOException | RuntimeException e) {
            String why = e.getMessage() == null ? "the install could not be started" : e.getMessage();
            patch(id, r -> { r.install = "failed"; r.installError = why; r.installedAt = System.currentTimeMillis(); });
        }
    }

    /**
     * Ask again, out loud, after the platform refused a SILENT attempt.
     *
     * A refused silence is supposed to come back as a pending user action — but
     * the package verifier (Play Protect) answers an unattended install it wants
     * to show something about with {@code INSTALL_FAILED_VERIFICATION_FAILURE}
     * instead, and that arrives as a plain failure. Without this the row read
     * "could not install" for a build that only needed a tap: asking must never
     * cost an install. One retry, never silent, so it cannot loop — its own
     * failure is the answer.
     *
     * Runs on the receiver's thread, not through the service: a background
     * {@code dataSync} start is refused on Android 15, and this is exactly the
     * moment nobody is looking at the app. Returns false where the attempt it
     * answers is not this row's live one any more, or the file is gone.
     */
    static boolean installLoudAfterRefusal(Context ctx, String id, int session) {
        Item it = load(ctx).get(id);
        if (it == null || !"installing".equals(it.install)) return false;
        if (session != 0 && it.installSession != 0 && it.installSession != session) return false;
        File bin = installSource(ctx, it);
        if (bin == null) return false;
        Installs.Info info = Installs.read(ctx, bin);
        patch(ctx, id, r -> { r.installSession = 0; r.installError = ""; });
        try {
            int next;
            try { next = Installs.install(ctx, id, bin, info, false); }
            finally { unstage(ctx, id); }
            patch(ctx, id, r -> { if ("installing".equals(r.install)) r.installSession = next; });
            return true;
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "loud retry could not start: " + e);
            return false;
        }
    }

    private void fail(String id, String message, boolean permanent) {
        fail(id, message, permanent, false);
    }

    private void fail(String id, String message, boolean permanent, boolean progressed) {
        patch(id, it -> {
            it.attempts = progressed ? 0 : it.attempts + 1;
            it.error = message;
            it.state = permanent || it.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
        });
        Item after = load(this).get(id);
        if (after == null || !"queued".equals(after.state)) return;
        long wait = BACKOFF[Math.min(Math.max(1, after.attempts) - 1, BACKOFF.length - 1)];
        // The wait is STORED, not only scheduled: a timer dies with the process
        // and a row whose backoff lived only in a handler comes back runnable
        // immediately after a restart, which is how fifty attempts are spent in
        // a second against a link that is simply down.
        patch(id, it -> it.nextAt = System.currentTimeMillis() + wait);
        handler.removeCallbacks(pumpRunnable);
        handler.postDelayed(pumpRunnable, wait);
    }

    private static String describe(IOException e) {
        String m = e.getMessage();
        if (m == null || m.isEmpty()) return e.getClass().getSimpleName();
        return m;
    }

    @Nullable
    private String stateOf(String id) {
        Item it = load(this).get(id);
        return it == null ? null : it.state;
    }

    private interface Change { void apply(Item it); }

    private void patch(String id, Change change) {
        patch(this, id, change);
    }

    /** The same write, addressable with no service instance — the install
     *  answer arrives at a BroadcastReceiver, long after this service stopped
     *  itself, and the row it belongs on is the one the page reads. */
    private static void patch(Context ctx, String id, Change change) {
        synchronized (LOCK) {
            Map<String, Item> items = load(ctx);
            Item it = items.get(id);
            if (it == null) return;
            change.apply(it);
            it.updatedAt = System.currentTimeMillis();
            save(ctx, items);
        }
    }

    /** What the platform said about an install, onto its row. Called by
     *  {@link ShellInstallReceiver} and by nothing else. */
    static void noteInstall(Context ctx, String id, String state, String error) {
        noteInstall(ctx, id, state, error, 0, "");
    }

    /**
     * The same, from a status callback that can say WHICH session it is about.
     *
     * {@code session} 0 means the caller could not tell (the platform left the
     * extra out), and is accepted — refusing it would lose an outcome over a
     * missing field. A session that DISAGREES with the one the row is waiting
     * on is dropped: it belongs to an attempt this row has moved on from, and
     * writing it would stamp an outcome beside another attempt's
     * {@code installAuto}.
     *
     * {@code pkg} is what the platform named on success. Written only onto a row
     * that could not read the archive itself — which is the one case where an
     * install is otherwise absent from the desktop's log entirely, the log being
     * keyed on which app.
     */
    static void noteInstall(Context ctx, String id, String state, String error, int session, String pkg) {
        patch(ctx, id, it -> {
            if (session != 0 && it.installSession != 0 && it.installSession != session) return;
            if (it.pkg.isEmpty() && pkg != null && !pkg.isEmpty()) it.pkg = pkg;
            it.install = state;
            it.installError = error == null ? "" : error;
            // Only a TERMINAL outcome is an instant. `asked` is the system
            // installer waiting for a person — it may wait for hours, and
            // stamping it would put that moment in the desktop's log as the
            // time this phone installed something it has not installed yet.
            if ("installed".equals(state) || "failed".equals(state)) {
                it.installedAt = System.currentTimeMillis();
                it.installSession = 0;   // nothing in flight any more
            }
        });
    }

    /**
     * How long an install may sit `installing` before nobody is coming.
     *
     * A committed session answers in seconds. The case this waits out is the one
     * where the answer can never arrive: **waterplane updating ITSELF.** The platform
     * kills this process to replace the package, and a force-stop cancels the
     * PendingIntent the status would have come back on — so the row the fleet
     * most wants in its log is precisely the row that never settles.
     */
    private static final long INSTALL_STALE_MS = 10 * 60 * 1000L;

    /**
     * Settle any install whose callback never came, from facts rather than from
     * a guess.
     *
     * Asked of the package manager: is the build this row carries the one now
     * installed? `versionCode` is the only monotonic thing an APK has, so a
     * version at least as new as the archive's means this install landed —
     * whatever became of the callback.
     *
     * **The instant stays 0.** Nobody knows WHEN it landed, and inventing the
     * moment somebody happened to open the app would put that time in the
     * desktop's log as the install's own. Absent there means the log says
     * *reported*, which is a claim about the log and true.
     *
     * A row that cannot be settled either way goes back to having no install
     * state at all — not to `failed`. "The installer never said" is not evidence
     * that it failed, and an empty state is the one that both offers the tap
     * again and claims nothing.
     */
    static void settleInstalls(Context ctx) {
        List<String> landed = new ArrayList<>();
        synchronized (LOCK) {
            Map<String, Item> items = load(ctx);
            boolean moved = false;
            long now = System.currentTimeMillis();
            for (Item it : items.values()) {
                if (!"installing".equals(it.install)) continue;
                if (now - it.updatedAt < INSTALL_STALE_MS) continue;
                long have = Installs.installedCode(ctx, it.pkg);
                if (it.pkgCode > 0 && have >= it.pkgCode) {
                    it.install = "installed";
                    it.installError = "";
                    landed.add(it.id);
                } else {
                    it.install = "";
                    it.installError = "";
                }
                it.installSession = 0;
                it.updatedAt = now;
                moved = true;
            }
            if (moved) save(ctx, items);
        }
        // Outside the lock: the clean-up takes it itself, and touches MediaStore.
        for (String id : landed) cleanAfterInstall(ctx, id);
    }

    // ── one copy once it is in Downloads ─────────────────────────────────

    private static final String KEY_DROP = "dropAfterSave";

    /**
     * The page's "keep only the Downloads copy" switch, held here for the
     * reason the clean-up switch is: the save happens at the end of a transfer
     * the service runs with the document frozen. On by default — once
     * Downloads holds the file the app's copy is the same bytes twice. Per
     * phone, never synced.
     */
    static boolean dropEnabled(Context ctx) {
        return prefs(ctx).getBoolean(KEY_DROP, true);
    }

    static void setDrop(Context ctx, boolean on) {
        prefs(ctx).edit().putBoolean(KEY_DROP, on).apply();
    }

    /**
     * The file is in Downloads: with the switch on, delete the app's own copy.
     *
     * Only on proof, never on the row's word: Downloads is asked for the saved
     * name at the app copy's exact size, so a copy the person already deleted,
     * or a different file under the name, keeps the app's copy where it is.
     * An install started from this row already has its bytes in the installer
     * session; a later one (a tap, the loud retry) stages the Downloads copy
     * ({@link #installSource}).
     */
    static void dropAfterSave(Context ctx, String id) {
        if (!dropEnabled(ctx)) return;
        Item it = load(ctx).get(id);
        if (it == null || !"done".equals(it.state) || !it.where.startsWith("Downloads/")) return;
        File bin = binOf(ctx, id);
        if (!bin.isFile()) return;
        String saved = it.where.substring("Downloads/".length());
        Downloads.Found found = Downloads.find(ctx, saved, bin.length());
        if (found == null || !found.name.equals(saved) || found.size != bin.length()) return;
        if (!bin.delete()) return;
        long now = System.currentTimeMillis();
        patch(ctx, id, r -> r.droppedAt = now);
    }

    /** Are this row's bytes anywhere this app can install from? */
    static boolean hasBytes(Context ctx, Item it) {
        if (binOf(ctx, it.id).isFile()) return true;
        if (it.droppedAt <= 0 || !it.where.startsWith("Downloads/")) return false;
        Downloads.Found f = Downloads.find(ctx, it.where.substring("Downloads/".length()), it.size);
        return f != null && f.name.equals(it.where.substring("Downloads/".length()));
    }

    /**
     * The file an install reads: the app's own copy, or — dropped after the
     * save — the Downloads copy staged into {@link #stagedOf} for this one
     * install. Null when neither is there. A staged file is removed by
     * {@link #unstage} once the installer session has the bytes.
     */
    @Nullable
    static File installSource(Context ctx, Item it) {
        File bin = binOf(ctx, it.id);
        if (bin.isFile()) return bin;
        if (it.droppedAt <= 0 || !it.where.startsWith("Downloads/")) return null;
        File staged = stagedOf(ctx, it.id);
        if (staged.isFile() && (it.size <= 0 || staged.length() == it.size)) return staged;
        return Downloads.stage(ctx, it.where.substring("Downloads/".length()), it.size, staged) ? staged : null;
    }

    static File stagedOf(Context ctx, String id) {
        return new File(new File(ctx.getCacheDir(), "install"), safeId(id) + ".apk");
    }

    static void unstage(Context ctx, String id) {
        //noinspection ResultOfMethodCallIgnored
        stagedOf(ctx, id).delete();
    }

    // ── clean-up after an install, opt-in ────────────────────────────────

    private static final String KEY_CLEAN = "cleanAfterInstall";

    /**
     * The page's "delete the APK once it is installed" switch, held HERE and
     * nowhere else: the install ends at a broadcast receiver with the document
     * frozen or the app closed, and that is the only moment the clean-up runs.
     * Off by default — deleting a file is never something this app starts doing
     * on its own; somebody turns it on. Per phone, never synced: it is a
     * question about THIS phone's storage.
     */
    static boolean cleanEnabled(Context ctx) {
        return prefs(ctx).getBoolean(KEY_CLEAN, false);
    }

    static void setClean(Context ctx, boolean on) {
        prefs(ctx).edit().putBoolean(KEY_CLEAN, on).apply();
    }

    /**
     * A build just installed: with the switch on, give back the space its APK
     * holds — the copy inside the app ({@link #binOf}), the copy this app saved
     * to Downloads, and the same two for every OLDER finished build of the same
     * package still sitting here, which nothing will ever install now.
     *
     * Only what the platform has confirmed installed, never a guess: the row is
     * `installed` (the receiver's STATUS_SUCCESS, or {@link #settleInstalls}
     * reading the installed versionCode). An older build is one whose own
     * versionCode is known and not newer than the installed one — an unread
     * archive (code 0) is left alone, as is anything waiting at the installer.
     *
     * The ROW stays, marked cleaned: it is the record of what came and went on,
     * and what the page reads to say why there is no file to install again.
     * A Downloads copy that cannot be removed (another app now owns it, or the
     * old-Android permission is gone) is SAID on the row, never dropped quietly.
     */
    static void cleanAfterInstall(Context ctx, String id) {
        if (!cleanEnabled(ctx)) return;
        Map<String, Item> items = load(ctx);
        Item done = items.get(id);
        if (done == null || !"installed".equals(done.install)) return;
        List<Item> victims = new ArrayList<>();
        victims.add(done);
        if (!done.pkg.isEmpty() && done.pkgCode > 0) {
            for (Item o : items.values()) {
                if (o == done || !done.pkg.equals(o.pkg) || !"done".equals(o.state)) continue;
                if (o.pkgCode <= 0 || o.pkgCode > done.pkgCode) continue;
                if ("installing".equals(o.install) || "asked".equals(o.install)) continue;
                victims.add(o);
            }
        }
        long now = System.currentTimeMillis();
        for (Item v : victims) {
            File bin = binOf(ctx, v.id);
            long size = bin.isFile() ? bin.length() : v.size;
            long freed = 0;
            if (bin.isFile() && bin.delete()) freed += size;
            String note = "";
            boolean removedCopy = false;
            if (v.where.startsWith("Downloads/")) {
                String saved = v.where.substring("Downloads/".length());
                String why = Downloads.remove(ctx, saved, size);
                if (why == null) { removedCopy = true; freed += size; }
                else if (why.isEmpty()) removedCopy = true;   // already gone: the row stops claiming it
                else note = why;
            }
            // Nothing was here to give back (cleared earlier, or by the seven-day
            // eviction): claiming the clean-up did it would be a wrong account.
            if (freed == 0 && note.isEmpty()) continue;
            final long gave = freed;
            final String said = note;
            final boolean dropWhere = removedCopy;
            patch(ctx, v.id, r -> {
                r.cleanedAt = now;
                r.cleanedBytes += gave;
                r.cleanNote = said;
                if (dropWhere) r.where = "";
            });
            ShellInstallReceiver.cancelReady(ctx, v.pkg, v.id);
        }
    }

    private static Item withProgress(Item item, long received, long total) {
        item.received = received;
        if (total > 0) item.size = total;
        return item;
    }

    // ── files ────────────────────────────────────────────────────────────

    /**
     * Where a transfer's bytes live. {@code getFilesDir()}, not the cache: the
     * cache is the OS's to reclaim, and reclaiming half of a 90 MB download
     * that resumes across days is exactly the wrong trade.
     */
    static File dir(Context ctx) {
        return new File(ctx.getFilesDir(), "pulls");
    }

    static File partOf(Context ctx, String id) {
        return new File(dir(ctx), safeId(id) + ".part");
    }

    /** The finished file, still inside the app — the copy a preview is drawn
     *  from, and the source a later "save to phone" publishes. */
    static File binOf(Context ctx, String id) {
        return new File(dir(ctx), safeId(id) + ".bin");
    }

    /** Ids are minted by `pull.ts` and are already tame, but they arrive over a
     *  bridge and end up in a path: nothing but the alphabet they use survives. */
    private static String safeId(String id) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < id.length() && b.length() < 64; i++) {
            char c = id.charAt(i);
            b.append(Character.isLetterOrDigit(c) || c == '_' || c == '-' ? c : '_');
        }
        return b.length() == 0 ? "x" : b.toString();
    }

    // ── http ─────────────────────────────────────────────────────────────

    private OkHttpClient http() {
        OkHttpClient c = client;
        if (c != null) return c;
        c = new OkHttpClient.Builder()
                // A dead Tailscale path does not error, it HANGS. These two are
                // the same two fuses `pull.ts` arms by hand, in the one place
                // OkHttp already implements them.
                .connectTimeout(25, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .callTimeout(0, TimeUnit.MILLISECONDS)   // a big file is not a slow call
                .retryOnConnectionFailure(true)
                .build();
        client = c;
        return c;
    }

    @Nullable
    private static String cookieFor(String url) {
        try {
            String c = android.webkit.CookieManager.getInstance().getCookie(url);
            return c == null || c.isEmpty() ? null : c;
        } catch (RuntimeException e) {
            // No WebView in this process yet (a sticky restart before the
            // activity): a gated host will answer 401 and the row says so.
            return null;
        }
    }

    // ── notifications ────────────────────────────────────────────────────

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_PROGRESS, "Downloads", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Files being fetched from your desktop, and where they landed.");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    /**
     * Repaint the progress line.
     *
     * Deliberately {@code notify} and not a second {@code startForeground}: the
     * service is already foreground, this runs on the WORKER thread once a
     * second for the length of a transfer, and re-entering the
     * start-foreground path from off the main thread to change a percentage is
     * work — and a lifecycle call — that nothing here needs.
     */
    private void updateNotification(@Nullable Item item) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        try {
            nm.notify(PROGRESS_NOTIFICATION_ID, progressNotification(item));
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS refused: the transfer still runs, there is
            // simply nowhere to show how far it has got.
            Log.d(TAG, "progress not shown: " + e);
        }
    }

    private void goForeground(@Nullable Item item) {
        Notification n = progressNotification(item);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(PROGRESS_NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(PROGRESS_NOTIFICATION_ID, n);
        }
    }

    private Notification progressNotification(@Nullable Item item) {
        // No item = nothing is moving right now: either the service has just
        // been started and is about to pick a row, or a retry is counting down.
        // Saying "waiting" beats a progress bar at 0% for a transfer that is
        // not running.
        String title = item == null ? "Downloads" : item.name;
        int pct = item != null && item.size > 0
                ? (int) Math.min(100, item.received * 100 / item.size) : 0;
        boolean known = item != null && item.size > 0;
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_PROGRESS)
                .setSmallIcon(R.drawable.ic_stat_app)
                .setContentTitle(title)
                .setContentText(item == null ? "waiting to retry…" : known ? pct + "%" : "fetching…")
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setContentIntent(openApp(PROGRESS_NOTIFICATION_ID))
                .setProgress(100, pct, !known);
        return b.build();
    }

    /**
     * "It landed, and here is where." Suppressed while the user is looking at
     * the app — the page's own toast says it, and two notices about one file is
     * noise about something already on screen. Same rule, and the same reason,
     * as {@link ShellLinkService}'s alerts.
     */
    private void announce(String name, String where) {
        if (ShellLinkService.isAppForeground()) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        Notification n = new NotificationCompat.Builder(this, CHANNEL_PROGRESS)
                .setSmallIcon(R.drawable.ic_stat_app)
                .setContentTitle(name)
                .setContentText("saved to " + where)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(openApp(where.hashCode()))
                .build();
        try {
            nm.notify("pull|" + where, where.hashCode(), n);
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS refused. The file is still saved; there is
            // simply nowhere to say so.
            Log.d(TAG, "not shown: " + e);
        }
    }

    private PendingIntent openApp(int requestCode) {
        Intent i = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, requestCode, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
