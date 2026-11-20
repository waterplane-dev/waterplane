package dev.waterplane.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * **The app, still there when nobody is looking at it.**
 *
 * Backgrounded, this app used to do nothing at all — and not for one reason but
 * for a chain of them, of which the middle link is the one that matters. With no
 * foreground service the process drops to the cached bucket within minutes and
 * **Android 12+'s cached-app freezer suspends the whole thing**: JS, timers, the
 * WebSocket. `ws.ts` even anticipates its own death — its `freeze` handler
 * closes the socket on the way down. The WebView is not stopped by Capacitor
 * (`KeepRunning` defaults to true); it is stopped by the process being frozen.
 *
 * So this service does three jobs, and the first one it does merely by existing:
 *
 * <ol>
 *   <li><b>It keeps the process out of the freezer</b>, so the WebView's own
 *       {@code ws.ts} socket, {@code flushOutbox}, upload POSTs and reconnect
 *       logic keep running in the background, unchanged. That is the whole
 *       reason none of the app's protocol is reimplemented here.</li>
 *   <li><b>It holds a deliberately minimal socket of its own</b> for the one
 *       case the WebView can never cover: the app swiped away and the process
 *       gone — which is exactly when a waiting question matters most.</li>
 *   <li><b>It relays the page's queued sends once the page is frozen or gone</b>
 *       ({@link ShellRelay}, {@code POST /api/relay}): the frames the queue
 *       itself built, never one of its own — see below.</li>
 * </ol>
 *
 * <h2>Why {@code specialUse} and not {@code dataSync}</h2>
 *
 * {@code FOREGROUND_SERVICE_DATA_SYNC} is the obvious type and it is a trap
 * here: <b>Android 15+ caps a {@code dataSync} service at roughly six hours per
 * 24-hour window</b>, then calls {@code onTimeout()} and refuses background
 * restarts — so a "permanent connection" built on it stops working overnight,
 * which is precisely the failure this app exists to prevent. Android 15 also
 * bans starting a {@code dataSync} service from {@code BOOT_COMPLETED}, which
 * would take the recovery path with it. {@code specialUse} has no timeout and is
 * allowed from a boot receiver. Its only cost is a Play Store policy review,
 * which is zero for an APK that is sideloaded by design.
 *
 * <h2>The socket speaks a few frames, not the protocol</h2>
 *
 * The duplication worry is the right worry, so the split is explicit. The
 * WebView remains the <em>only</em> speaker of the full protocol — attach,
 * {@code resumeSeq}, acks, ops, the flusher, and the send queue whose upload
 * bytes live in IndexedDB where native cannot reach them. This socket sends
 * {@code hello}, stays alive on WebSocket <em>protocol</em> pings (OkHttp's
 * {@code pingInterval}; the host's ws library auto-pongs, so liveness costs no
 * protocol duplication and far fewer radio wakeups than {@code ws.ts}'s
 * 12-second JSON ping), and acts on exactly three inbound frames:
 * {@code notification}, {@code authRequired} and {@code pull.new} — the last
 * because the page that would otherwise start that download is frozen by then
 * ({@link #onPullNew}). Everything else is ignored on
 * purpose — the wire is versioned and a host one version ahead must not make
 * this class fall over.
 *
 * <h2>The relay: the queue's own frames, over HTTP</h2>
 *
 * Chromium freezes the hidden page at 300 s, and from then on nothing sends
 * what was queued. So the page hands over a PLAN ({@code setQueue}: per lane,
 * the leading run of {@code entryFrame}s it would send unasked) and, from its
 * {@code freeze} handler, the ownership. While this side owns the queue, the
 * app is not in front and the plan's desktop is connected, each lane's next
 * frame is POSTed to {@code /api/relay} with that desktop's token, through its
 * pinned client — one in flight per lane, the next only after {@code ok}. Every
 * verdict is kept, verbatim, until the page's {@code claimQueue} takes them (and
 * the ownership) back and replays them through its own receipt handlers. This
 * side never mints an ackId and never edits or drops a row: the localStorage
 * queue stays the only source of truth. An older host answers 404 and that
 * desktop gets the old "open to send" notice.
 *
 * <b>{@code PROTOCOL_VERSION} and the host address are passed in, never
 * compiled in.</b> The version ships in the over-the-air bundle and the APK does
 * not update, so a constant here would drift; the address lives in the
 * WebView's own localStorage, which is the only copy there is.
 *
 * <h2>Opt-in, and inert until it is not</h2>
 *
 * Nothing starts this but an explicit {@link ShellLinkPlugin#start} call. With
 * {@link #KEY_ENABLED} unset the boot receiver returns immediately, no periodic
 * work is scheduled, no channel is created and no notification is posted — a
 * user who never touches the toggle pays nothing at all.
 */
public class ShellLinkService extends Service {

    private static final String TAG = "shell-link";

    // ── Intent actions ───────────────────────────────────────────────────
    static final String ACTION_START = "dev.waterplane.app.link.START";
    static final String ACTION_STOP = "dev.waterplane.app.link.STOP";
    /** "Something changed out there — re-check the socket now." Sent by the
     *  connectivity callback, the WorkManager backstop and the boot receiver. */
    static final String ACTION_NUDGE = "dev.waterplane.app.link.NUDGE";
    /** The backlog alert's "Send N": release exactly {@link #EXTRA_ACK_IDS} ({@link ShellRelay#release}). */
    static final String ACTION_RELAY_RELEASE = "dev.waterplane.app.link.RELAY_RELEASE";
    static final String EXTRA_ACK_IDS = "ackIds";

    static final String EXTRA_URL = "url";
    static final String EXTRA_PROTOCOL = "protocol";
    static final String EXTRA_LABEL = "label";

    // ── Persisted configuration ──────────────────────────────────────────
    /** The service outlives the activity and survives process death, so its
     *  configuration cannot live in an Intent: a sticky restart arrives with a
     *  null one, and the boot receiver has no Intent at all. */
    private static final String PREFS = "shell.link";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_URL = "url";
    private static final String KEY_PROTOCOL = "protocol";
    private static final String KEY_LABEL = "label";
    private static final String KEY_QUEUE = "queueDepth";
    /** Every desktop to watch, as a JSON list of {@code {hostId,url,label}}, active FIRST
     *  ({@link ShellLinkSet}). Absent: the old single-url shape, read off
     *  {@link #KEY_URL}/{@link #KEY_LABEL}. Those two always hold the ACTIVE desktop either way, so
     *  {@link #savedUrl} (the paired-host check, auto-downloads) keeps meaning what it meant. */
    private static final String KEY_LINKS = "links";
    /** The base WebSocket subprotocol (`BRAND.wsProtocol`) a link's token rides beside, handed
     *  over by the page like {@link #KEY_PROTOCOL}. Absent (an older bundle, which sends no token
     *  either): no token is offered on any socket. */
    private static final String KEY_WS_PROTOCOL = "wsProtocol";
    /** The last {@code start} asked that no token reach the disk: tokens are read from
     *  {@link #heldTokens} only, {@link ShellLinkTokens} is never opened, and a row marked
     *  {@code tokenHeld} with no token in memory is locked. Absent: tokens are sealed at rest. */
    private static final String KEY_TOKENS_MEMORY = "tokensInMemory";

    // ── Notification channels ────────────────────────────────────────────
    /** The service's own status line. Its own channel, at
     *  {@code IMPORTANCE_MIN}, because it is a status surface and not an alert:
     *  no sound, no heads-up, and mutable by the user without touching the
     *  channels the actual alerts arrive on. */
    static final String CHANNEL_STATUS = "status";
    /** One channel per notification KIND, prefixed. Android's per-channel
     *  controls then complement the host's own `notifyprefs` gate rather than
     *  fighting it: the host decides what may be published at all, the phone
     *  decides how loudly each kind lands. */
    private static final String CHANNEL_KIND_PREFIX = "kind.";
    private static final int STATUS_NOTIFICATION_ID = 4771;

    /** The frames this class acts on; every other one is dropped on purpose. */
    private static final String FRAME_NOTIFICATION = "notification";
    private static final String FRAME_AUTH_REQUIRED = "authRequired";
    /** The host queued a file worth having (`host/autopull.ts`). Handed to
     *  {@link ShellPullService#adopt} when the page cannot take it itself. */
    private static final String FRAME_PULL_NEW = "pull.new";

    /** Protocol-ping cadence. Two minutes rather than `ws.ts`'s twelve seconds:
     *  this socket carries no PTY stream and has nothing to be quick about, and
     *  a wakeup every two minutes is a fraction of the radio cost. Long enough
     *  to sit inside most NAT/keepalive windows; short enough that a dead tunnel
     *  is noticed while the answer still matters. */
    private static final long PING_SECONDS = 120;

    /** A socket younger than this is not the zombie a network change exists to
     *  replace. {@code registerDefaultNetworkCallback} delivers the CURRENT
     *  network immediately on registration, so without this every service start
     *  tore down the socket it had just opened. */
    private static final long FRESH_SOCKET_MS = 10_000;

    /**
     * <b>A retry has to wake the phone, or it never happens.</b> The backoff runs on
     * {@link #handler}, whose clock ({@code uptimeMillis}) stops while the CPU is
     * suspended — and a phone in a pocket is suspended most of the time. A socket
     * lost there (the host's 20 s ping check, Wi-Fi power save, the router) stayed
     * lost until something else woke the phone: the screen, or the fifteen-minute
     * WorkManager check. Seen on a real phone: no connection at all for 5½ minutes
     * with the link switched on. So every retry also sets an inexact
     * {@code ELAPSED_REALTIME_WAKEUP} alarm (no exact-alarm permission, no manifest
     * entry: the listener form), and the dial it starts holds a partial wake lock
     * until the socket opens or fails, at most {@link #DIAL_WAKE_MS}.
     *
     * <p>Battery: a desktop that stays unreachable (asleep, off, another network)
     * would otherwise wake the phone once a minute all night. After
     * {@link #WAKE_FAST_FOR_MS} down, the alarm slows to {@link #WAKE_SLOW_MS}; the
     * handler's own backoff still dials every minute whenever the phone is awake
     * anyway, and a network change still dials at once. In Doze the platform
     * defers the alarm to its maintenance window, which is the most any app gets.
     */
    private static final long WAKE_FAST_FOR_MS = 10 * 60_000;
    private static final long WAKE_SLOW_MS = 5 * 60_000;
    /** OkHttp's default connect timeout (10 s, none set here) plus the TLS handshake and the
     *  upgrade: long enough for one dial to finish, and the lock is let go on either answer. */
    private static final long DIAL_WAKE_MS = 20_000;

    /**
     * <b>A dial that never answers is abandoned, or the link waits on it forever.</b> The client
     * has {@code readTimeout(0)} (an open socket is idle by design) and no call timeout, so a dial
     * whose TCP connected but whose TLS handshake or upgrade never came back had no failure to
     * report: no {@code onFailure}, so no retry, and {@link #ensureSocket} saw a socket and did
     * nothing. Seen 2026-11-19/20: the row said "connecting" for 17 hours, no dial reached the
     * desktop, and every vault approval in that time raised no notification. Only a network
     * change replaced it. After this long a dial is cancelled and retried like a failed one.
     */
    private static final long DIAL_TIMEOUT_MS = 30_000;

    private static final long BACKOFF_MIN_MS = 2_000;
    private static final long BACKOFF_MAX_MS = 60_000;

    // ── Cross-class state ────────────────────────────────────────────────
    /**
     * Whether the activity is on screen. **The service is the only poster of OS
     * notifications**, so when the user is looking at the app it must post none:
     * the WebView has its own in-app feed and a duplicate in the shade is noise
     * about something already visible. Written from the activity's lifecycle,
     * read on OkHttp's reader thread.
     */
    private static final AtomicBoolean APP_FOREGROUND = new AtomicBoolean(false);
    /** When the app last left the screen ({@code elapsedRealtime}), 0 while in front or never
     *  shown. The relay's 330 s fallback when no {@code freeze} signal came. */
    private static volatile long hiddenSince = 0;

    /** The relay's state, one per process: the plugin's claim and this service share it. */
    @Nullable private static ShellRelay relayStore;
    private static final String RELAY_FILE = "shell.relay.json";
    private static final MediaType JSON_TYPE = MediaType.get("application/json; charset=utf-8");
    /** OkHttp's whole-call bound for one relay POST: the host's wait (100 s) plus transit. */
    private static final long RELAY_CALL_S = 110;

    /** Live instance, or null. Only used to answer "is it up?" for the plugin's
     *  status call and the WorkManager backstop; never dereferenced for work. */
    @Nullable private static volatile ShellLinkService instance;

    /** A start has been asked for and the service has not come up yet.
     *  {@code startForegroundService} is asynchronous, so without this a status
     *  read immediately after `start()` says "stopped" about a service that is
     *  starting — a settings row would draw the switch as having failed at the
     *  exact moment it worked. */
    private static volatile boolean pendingStart;
    /**
     * Memory mode's tokens ({@link ShellLinkSet#memoryTokens}), replaced whole. Static because the
     * plugin and the service share this process and nothing else may carry them: not an Intent,
     * not a preference. It dies with the process, which is the point; the rows then read locked.
     */
    private static volatile Map<String, String> heldTokens = Collections.emptyMap();

    private final Handler handler = new Handler(Looper.getMainLooper());
    @Nullable private OkHttpClient client;
    @Nullable private ConnectivityManager.NetworkCallback netCallback;
    /**
     * One {@link Link} per watched desktop, active FIRST. Replaced whole (copy on write) on the
     * main thread, so the plugin's {@link #describe} reads a list that never changes under it.
     */
    private volatile List<Link> links = Collections.emptyList();
    /** The stored list has been read once: before that an empty {@link #links} is "starting",
     *  not "no desktop saved" (the status line is drawn before anything can have been read). */
    private boolean linksApplied = false;
    private boolean stopping = false;
    /** The relay's next look ({@link #pumpRelay}); one callback, re-posted, never stacked. */
    private final Runnable relayPump = this::pumpRelay;
    /** What the backlog alert last said, so a nudge that finds nothing new does not post it
     *  again. Cleared on each (re)connect, a release and a claim. Main thread. */
    @Nullable private String lastBacklogKey;
    /** The link just came back and has not been told about yet. {@link #pumpRelay} runs on every
     *  freeze, timer and nudge; the alert is news only after a reconnect or after the relay SENT
     *  something — never because a held or unsendable row sits in a link that never dropped. */
    private boolean backlogDue;

    // ── Static API for the rest of the shell ─────────────────────────────

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The host's `ws(s)://` address the link uses, or null before one was saved. */
    @Nullable
    static String savedUrl(Context ctx) {
        return prefs(ctx).getString(KEY_URL, null);
    }

    /** Has the user switched this on? The single question every entry point —
     *  boot receiver, periodic worker, sticky restart — asks first. */
    static boolean isEnabled(Context ctx) {
        return prefs(ctx).getBoolean(KEY_ENABLED, false);
    }

    static boolean isRunning() {
        return instance != null;
    }

    /** Remember the configuration, then start. Persisting BEFORE the start is
     *  what makes a sticky restart and a boot start able to reconstruct it. */
    static void enable(Context ctx, String url, int protocol, String label, @Nullable String linksJson,
                       List<ShellLinkSet.Spec> withTokens, @Nullable String wsProtocol, boolean memoryOnly) {
        heldTokens = memoryOnly ? ShellLinkSet.memoryTokens(withTokens) : Collections.<String, String>emptyMap();
        // Sealed beside the list, never in it; a desktop gone from the list, or handed without a
        // token, loses its stored one here (`ShellLinkTokens.replaceAll`).
        if (memoryOnly) {
            if (!ShellLinkTokens.clearNow(ctx)) Log.w(TAG, "stored tokens not deleted yet");
        } else if (linksJson != null) ShellLinkTokens.replaceAll(ctx, withTokens);
        else ShellLinkTokens.clear(ctx);
        SharedPreferences.Editor e = prefs(ctx).edit()
                .putBoolean(KEY_ENABLED, true)
                .putString(KEY_URL, url)
                .putInt(KEY_PROTOCOL, protocol)
                .putString(KEY_LABEL, label);
        // An old bundle's start (no list) is the single-url shape again: forget a list a newer
        // bundle left, or this would keep watching desktops the page no longer names.
        if (linksJson != null) e.putString(KEY_LINKS, linksJson); else e.remove(KEY_LINKS);
        if (wsProtocol != null) e.putString(KEY_WS_PROTOCOL, wsProtocol); else e.remove(KEY_WS_PROTOCOL);
        if (memoryOnly) e.putBoolean(KEY_TOKENS_MEMORY, true); else e.remove(KEY_TOKENS_MEMORY);
        e.apply();
        pendingStart = true;
        Intent i = new Intent(ctx, ShellLinkService.class).setAction(ACTION_START);
        i.putExtra(EXTRA_URL, url);
        i.putExtra(EXTRA_PROTOCOL, protocol);
        i.putExtra(EXTRA_LABEL, label);
        startSafely(ctx, i, "enable");
    }

    static void disable(Context ctx) {
        pendingStart = false;
        prefs(ctx).edit().putBoolean(KEY_ENABLED, false).apply();
        // Off means nothing to sign in with: no token outlives the switch (the next start
        // hands them again).
        heldTokens = Collections.emptyMap();
        ShellLinkTokens.clear(ctx);
        ShellLinkWorker.cancel(ctx);
        try {
            ctx.startService(new Intent(ctx, ShellLinkService.class).setAction(ACTION_STOP));
        } catch (RuntimeException e) {
            // Not running is the outcome we wanted anyway.
            Log.d(TAG, "stop: " + e);
        }
    }

    /**
     * Start the service if — and only if — the user has switched it on. The one
     * entry point for the recovery paths ({@link ShellBootReceiver},
     * {@link ShellLinkWorker}), which is why the enabled check lives here rather
     * than being repeated, differently, in each of them.
     */
    static void startIfEnabled(Context ctx, String why) {
        if (!isEnabled(ctx)) return;
        Intent i = new Intent(ctx, ShellLinkService.class).setAction(ACTION_NUDGE);
        startSafely(ctx, i, why);
    }

    /**
     * {@code startForegroundService} throws on Android 12+ when the app is in a
     * state that may not start one — which is exactly the state the recovery
     * paths run in. Catching it is the honest behaviour: the WorkManager
     * backstop will try again at the next window, and the battery-optimisation
     * exemption (which the settings flow offers) is what removes the restriction
     * for good. A crash here would take the whole app down for a background
     * retry nobody asked for.
     */
    private static void startSafely(Context ctx, Intent intent, String why) {
        try {
            ContextCompat.startForegroundService(ctx, intent);
            Log.i(TAG, "start (" + why + ")");
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot start service (" + why + "): " + e);
        }
    }

    /** Called from {@link MainActivity}'s lifecycle. See {@link #APP_FOREGROUND}. In front,
     *  the relay starts no new send from this moment ({@link #pumpRelay} asks first). */
    static void setAppForeground(boolean foreground) {
        boolean was = APP_FOREGROUND.getAndSet(foreground);
        if (foreground) {
            hiddenSince = 0;
            return;
        }
        if (was || hiddenSince == 0) hiddenSince = SystemClock.elapsedRealtime();
        ShellLinkService s = instance;
        if (s != null) {
            s.handler.removeCallbacks(s.relayPump);
            s.handler.postDelayed(s.relayPump, ShellRelay.HIDDEN_FALLBACK_MS + 1_000);
        }
    }

    // ── The relay's bridge (ShellLinkPlugin) ─────────────────────────────

    static synchronized ShellRelay relay(Context ctx) {
        if (relayStore == null) {
            relayStore = new ShellRelay(new File(ctx.getApplicationContext().getFilesDir(), RELAY_FILE));
        }
        return relayStore;
    }

    /** The page's plan, replacing the last ({@code setQueue}). The page is alive: nothing pumps. */
    static void setRelayPlan(Context ctx, @Nullable String planJson) {
        relay(ctx).setPlan(planJson);
    }

    /** The page is freezing: the relay may own the queue once the app is hidden. */
    static void releaseRelay(Context ctx) {
        relay(ctx).releaseOwnership();
        ShellLinkService s = instance;
        if (s != null) s.handler.post(s.relayPump);
    }

    /** Ownership back to the page, synchronously, and what the relay did since the last claim. */
    static String claimRelay(Context ctx) {
        String out = relay(ctx).claim();
        ShellLinkService s = instance;
        if (s != null) s.handler.post(() -> s.lastBacklogKey = null);
        return out;
    }

    /** Is the user looking at the app? Asked by {@link ShellPullService} for the
     *  same reason this class asks it: whoever is posting must not duplicate a
     *  row the page is already showing. One answer, from the activity's own
     *  lifecycle, rather than two flags that can disagree. */
    static boolean isAppForeground() {
        return APP_FOREGROUND.get();
    }

    /** How many sends the page has queued but not delivered. Persisted, because
     *  the point of it is to survive the process death that lost the page. */
    static void setQueueDepth(Context ctx, int depth) {
        prefs(ctx).edit().putInt(KEY_QUEUE, Math.max(0, depth)).apply();
    }

    /** What the plugin's `status()` answers with. A `JSObject` rather than a
     *  bare `JSONObject` only so the plugin can resolve with it directly — its
     *  put() does not throw, which is what makes this readable. */
    static JSObject describe(Context ctx) {
        JSObject o = new JSObject();
        ShellLinkService s = instance;
        o.put("supported", true);
        o.put("enabled", isEnabled(ctx));
        o.put("running", s != null);
        List<Link> held = s != null ? s.links : Collections.<Link>emptyList();
        Link active = held.isEmpty() ? null : held.get(0);
        String idle = pendingStart ? "starting" : "stopped";
        o.put("state", s == null ? idle : active != null ? active.status : "unconfigured");
        o.put("host", prefs(ctx).getString(KEY_LABEL, null));
        o.put("queueDepth", prefs(ctx).getInt(KEY_QUEUE, 0));
        if (active != null) {
            o.put("connectedAt", active.connectedAt);
            o.put("lastFrameAt", active.lastFrameAt);
            if (active.lastError != null) o.put("error", active.lastError);
        }
        // One row per watched desktop — what the settings row words apart. Built from the stored
        // list when the service is not up, so a stopped link still names what it would watch.
        JSONArray rows = new JSONArray();
        if (s != null) {
            for (Link l : held) rows.put(l.describe());
        } else {
            for (ShellLinkSet.Spec sp : storedSpecs(ctx)) {
                JSObject r = new JSObject();
                r.put("hostId", sp.hostId);
                r.put("label", sp.label);
                r.put("state", idle);
                rows.put(r);
            }
        }
        o.put("links", rows);
        return o;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        pendingStart = false;
        createChannels();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        // First, unconditionally, and before anything that can throw: the
        // platform kills the process if a service started with
        // `startForegroundService` has not called this within five seconds —
        // including on the path where the very next thing we do is stop.
        startForegroundNow();

        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            shutdown();
            return START_NOT_STICKY;
        }
        if (!isEnabled(this)) {
            // A sticky restart of a service the user has since switched off.
            shutdown();
            return START_NOT_STICKY;
        }
        if (ACTION_START.equals(action)) {
            // An explicit start is a DECISION, the same way `ws.ts`'s
            // `reconnect()` is: it clears an auth pause, because the only thing
            // that sends one is the user having just signed in. A NUDGE must
            // not — the WorkManager backstop fires every fifteen minutes and
            // would otherwise reopen a socket the host has said it will refuse,
            // for ever, on a phone nobody is holding.
            // A REFUSED token is the exception: the same token would be refused again, so
            // only a new one (a new Link, `sameSocket`) reopens that desktop.
            for (Link l : links) {
                if (!l.tokenRefused) l.authPaused = false;
                l.pinPaused = false;
            }
        }

        // The stored list against the held one: a desktop added opens, one removed closes, one
        // unchanged keeps its socket (a re-sent list reconnects nothing — `ShellLinkSet.diff`).
        applyLinks();
        registerNetworkCallback();
        ShellLinkWorker.schedule(this);
        for (Link l : links) l.ensureSocket(0);
        if (ACTION_RELAY_RELEASE.equals(action)) {
            String[] ids = intent.getStringArrayExtra(EXTRA_ACK_IDS);
            int n = ids == null ? 0 : relay(this).release(Arrays.asList(ids));
            Log.i(TAG, "relay: released " + n + " of " + (ids == null ? 0 : ids.length));
            lastBacklogKey = null;
        }
        // A nudge (the network, the health worker, a boot) is also the relay's chance.
        pumpRelay();
        // START_STICKY, not START_REDELIVER_INTENT: the configuration is in
        // SharedPreferences precisely so the restart does not depend on an
        // Intent the platform may or may not have kept.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        unregisterNetworkCallback();
        for (Link l : links) l.close();
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null; // Started, never bound: the plugin talks to it with Intents.
    }

    private void shutdown() {
        stopping = true;
        for (Link l : links) l.close();
        unregisterNetworkCallback();
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    // ── The foreground notification ──────────────────────────────────────

    private void startForegroundNow() {
        Notification n = statusNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(STATUS_NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            // Below API 34 there is no `specialUse` constant and no requirement
            // to name a type at all.
            startForeground(STATUS_NOTIFICATION_ID, n);
        }
    }

    private Notification statusNotification() {
        String line = stopping ? "stopping" : !linksApplied ? "starting…" : statusLine(links);
        return new NotificationCompat.Builder(this, CHANNEL_STATUS)
                .setSmallIcon(R.drawable.ic_stat_app)
                .setContentTitle("waterplane")
                .setContentText(line)
                .setOngoing(true)
                .setShowWhen(false)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(openAppIntent(null, STATUS_NOTIFICATION_ID))
                .build();
    }

    /** Repaint the status line. Cheap, and the only way "reconnecting…" is ever
     *  distinguishable from "connected" without opening the app. */
    private void refreshStatus() {
        if (stopping) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        try {
            nm.notify(STATUS_NOTIFICATION_ID, statusNotification());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS refused: the service still runs and the queue
            // still drains, there is simply nowhere to show this.
            Log.d(TAG, "status not shown: " + e);
        }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel status = new NotificationChannel(
                CHANNEL_STATUS, "Background link", NotificationManager.IMPORTANCE_MIN);
        status.setDescription("The permanent connection to your desktop. Silent by design.");
        status.setShowBadge(false);
        nm.createNotificationChannel(status);
    }

    /**
     * The channel one alert kind lands on, created on first use.
     *
     * Per kind rather than one "alerts" channel because the kinds genuinely
     * differ in urgency — a waiting question and a usage limit need a human, a
     * finished turn does not — and because a per-kind channel is the only way
     * the phone's own controls can express that. The host's `notifyprefs`
     * decides what may be published at all; this decides how loudly it lands.
     * The two are complementary, and neither can be reconstructed from the
     * other.
     */
    private String channelFor(String kind) {
        String id = CHANNEL_KIND_PREFIX + kind;
        // Channel importance is immutable once created. An older APK fed a newer
        // host would have created `kind.approval` at DEFAULT (an unknown kind is
        // not "urgent" there), and it could never be raised. So approval lives on
        // its own id, created HIGH, and the stale one is dropped best-effort.
        if ("approval".equals(kind)) id = id + ".high";
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return id;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return id;
        if ("approval".equals(kind)) {
            try { nm.deleteNotificationChannel(CHANNEL_KIND_PREFIX + kind); } catch (RuntimeException ignored) { /* best effort */ }
        }
        if (nm.getNotificationChannel(id) != null) return id;
        boolean urgent = isUrgent(kind);
        NotificationChannel ch = new NotificationChannel(id, labelFor(kind),
                urgent ? NotificationManager.IMPORTANCE_HIGH : NotificationManager.IMPORTANCE_DEFAULT);
        nm.createNotificationChannel(ch);
        return id;
    }

    /** Kinds a person must act on: heads-up channel, and PRIORITY_HIGH before Android 8. */
    private static boolean isUrgent(String kind) {
        return "prompt".equals(kind) || "approval".equals(kind) || "limit".equals(kind)
                || "signin".equals(kind) || "cli".equals(kind) || "undelivered".equals(kind);
    }

    /** Human names for the host's `NOTIFICATION_KINDS`. An unknown kind — a host
     *  newer than this APK — gets its own channel named after itself rather than
     *  being dropped. */
    private static String labelFor(String kind) {
        switch (kind) {
            case "prompt": return "Waiting questions";
            case "approval": return "Approval requests";
            case "limit": return "Usage limits";
            case "signin": return "Signed out";
            case "burn": return "Usage burn";
            case "plugin": return "Plugins";
            case "cli": return "CLI health";
            case "undelivered": return "Undelivered prompts";
            case "backlog": return "Backlog";
            case "followup": return "Follow up";
            case "artifact": return "Artifacts";
            case "image": return "Images";
            case "oracle": return "Oracle";
            case "autofire": return "Auto-fire";
            case "idle": return "Turn finished";
            case "info": return "Info";
            default: return kind;
        }
    }

    // ── The links: one socket per watched desktop ────────────────────────

    /** The stored list, or the old single url as one spec with no host id. */
    static List<ShellLinkSet.Spec> storedSpecs(Context ctx) {
        return storedSpecs(ctx, false);
    }

    /** {@code withTokens}: each spec carries its desktop's token, unsealed or, in memory mode, out
     *  of {@link #heldTokens} — the service's own read, never the status one. */
    static List<ShellLinkSet.Spec> storedSpecs(Context ctx, boolean withTokens) {
        SharedPreferences p = prefs(ctx);
        boolean memoryOnly = p.getBoolean(KEY_TOKENS_MEMORY, false);
        String raw = p.getString(KEY_LINKS, null);
        if (raw != null) {
            List<ShellLinkSet.Spec> in = new ArrayList<>();
            try {
                JSONArray a = new JSONArray(raw);
                for (int i = 0; i < a.length(); i++) {
                    JSONObject o = a.optJSONObject(i);
                    if (o == null) continue;
                    String hostId = o.optString("hostId", null);
                    String url = o.optString("url", null);
                    String tok = !withTokens ? null
                            : memoryOnly ? heldTokens.get(ShellLinkSet.tokenAad(hostId, url))
                            : ShellLinkTokens.read(ctx, hostId, url);
                    in.add(new ShellLinkSet.Spec(hostId, url, o.optString("label", null), tok, o.optBoolean("tokenHeld", false)));
                }
            } catch (org.json.JSONException e) {
                Log.w(TAG, "stored link list unreadable: " + e);
            }
            List<ShellLinkSet.Spec> clean = ShellLinkSet.clean(in);
            if (!clean.isEmpty()) return clean;
        }
        String url = p.getString(KEY_URL, null);
        if (!ShellLinkSet.isWsUrl(url)) return Collections.emptyList();
        String label = p.getString(KEY_LABEL, null);
        return Collections.singletonList(new ShellLinkSet.Spec(null, url, label != null ? label : ShellLinkSet.hostOf(url)));
    }

    /** This desktop's link at {@code url}'s origin, with its token (see {@link #storedSpecs}). */
    @Nullable
    static ShellLinkSet.Spec linkFor(Context ctx, @Nullable String hostId, @Nullable String url) {
        return ShellLinkSet.linkFor(storedSpecs(ctx, true), hostId, url);
    }

    /**
     * A pin was set or removed. The next dial reads it anyway; this is for what will not dial: a
     * link paused on a refused key, and a socket let in under a key no longer pinned.
     *
     * @param changed false when the same key was set again, which leaves an open socket alone.
     */
    static void pinChanged(@Nullable String hostId, boolean changed) {
        ShellLinkService s = instance;
        if (s == null || hostId == null) return;
        s.handler.post(() -> {
            for (Link l : s.links) if (hostId.equals(l.spec.hostId)) l.repinned(changed);
        });
    }

    /** Make the held links match the stored list. Main thread only. */
    private void applyLinks() {
        // A blob a crash kept past `enable`: nothing reads it in memory mode, and it does not stay.
        if (prefs(this).getBoolean(KEY_TOKENS_MEMORY, false)) ShellLinkTokens.clear(this);
        List<ShellLinkSet.Spec> next = storedSpecs(this, true);
        List<ShellLinkSet.Spec> heldSpecs = new ArrayList<>();
        for (Link l : links) heldSpecs.add(l.spec);
        ShellLinkSet.Diff d = ShellLinkSet.diff(heldSpecs, next);
        List<Link> out = new ArrayList<>();
        for (ShellLinkSet.Spec n : next) {
            ShellLinkSet.Spec kept = d.keep.get(n);
            Link l = null;
            if (kept != null) for (Link h : links) if (h.spec == kept) { l = h; break; }
            if (l != null) { l.spec = n; l.pauseIfLocked(); } // a new label rides on the same socket
            else { l = new Link(n); Log.i(TAG, "watching " + n); } // Spec.toString: never the token
            out.add(l);
        }
        for (Link h : links) if (!out.contains(h)) { Log.i(TAG, "no longer watching " + h.spec.label); h.close(); }
        links = Collections.unmodifiableList(out);
        linksApplied = true;
        if (out.isEmpty()) refreshStatus();
    }

    /** Is this link the ACTIVE desktop's (the first)? */
    private boolean isActive(Link l) {
        List<Link> held = links;
        return !held.isEmpty() && held.get(0) == l;
    }

    /**
     * The status line, each desktop's state its own: "connected · studio" with one link,
     * "studio connected · zenbook reconnecting…" with several — never folded into one word that
     * hides a desktop not answering.
     */
    private static String statusLine(List<Link> held) {
        if (held.isEmpty()) return "no desktop saved";
        if (held.size() == 1) {
            Link l = held.get(0);
            String paused = l.pausedWord();
            if (paused != null) return paused;
            if ("connected".equals(l.status)) return "connected · " + l.spec.label;
            return "reconnecting…";
        }
        StringBuilder b = new StringBuilder();
        for (Link l : held) {
            if (b.length() > 0) b.append(" · ");
            String paused = l.pausedWord();
            String word = paused != null ? paused : "connected".equals(l.status) ? "connected" : "reconnecting…";
            b.append(l.spec.label).append(' ').append(word);
        }
        return b.toString();
    }

    private OkHttpClient client() {
        if (client == null) {
            client = new OkHttpClient.Builder()
                    // Never hop between http and https on a redirect's say-so.
                    .followSslRedirects(false)
                    // **Liveness is a protocol ping, not a JSON heartbeat.** The
                    // host's ws library answers a control ping automatically, so
                    // this costs no protocol duplication — and at two minutes it
                    // is a fraction of the radio wakeups `ws.ts`'s twelve-second
                    // `{"t":"ping"}` costs. OkHttp tears the socket down itself
                    // when a pong does not come back, which is the failure this
                    // detects.
                    .pingInterval(PING_SECONDS, TimeUnit.SECONDS)
                    .readTimeout(0, TimeUnit.MILLISECONDS)
                    .retryOnConnectionFailure(true)
                    .build();
        }
        return client;
    }

    /**
     * One desktop's socket, with its own backoff, auth pause and status. Every field is touched
     * on the main thread ({@link #handler}) except the volatile ones {@link #describe} reads.
     */
    /** The links' own ring of ups and downs ({@link ShellLinkLog}), sent to each desktop on reconnect. */
    @Nullable private ShellLinkLog linkLog;

    private ShellLinkLog linkLog() {
        if (linkLog == null) linkLog = new ShellLinkLog(getFilesDir());
        return linkLog;
    }

    private final class Link {
        volatile ShellLinkSet.Spec spec;
        /**
         * The current socket — <b>from the moment it is asked for</b>, not from the
         * moment it opens. OkHttp hands the object back synchronously and connects
         * behind it, so holding it from the start is what makes two things possible
         * that a "connected socket only" field cannot: a reconnect that arrives
         * mid-handshake can CANCEL the attempt instead of racing a second one into
         * existence, and every listener callback can check {@code ws != socket} and
         * fall silent if it belongs to an attempt that has already been abandoned.
         */
        @Nullable WebSocket socket;
        volatile String status = "starting";
        @Nullable volatile String lastError;
        volatile long connectedAt = 0;
        /** When the current attempt was STARTED, as opposed to when it succeeded.
         *  A connect in flight is as young as a connect that just landed, and the
         *  network callback fires on registration — see {@link #FRESH_SOCKET_MS}. */
        long connectStartedAt = 0;
        volatile long lastFrameAt = 0;
        long backoffMs = BACKOFF_MIN_MS;
        /** The host said this connection needs the LAN password. Stop reconnecting —
         *  every retry would bounce the same way — and say so on the status line
         *  until the user opens the app and signs in. Per desktop: one gated host
         *  never silences the others. */
        volatile boolean authPaused = false;
        /** The host refused the token this link CARRIED (revoked, or its password changed): paused
         *  like {@link #authPaused}, worded "signed out there — pair again", and never cleared by
         *  an explicit start — only a new token (a new spec, so a new Link) dials again. */
        volatile boolean tokenRefused = false;
        /** The leaf was not the pinned key. A retry on the same network meets the same answer, so
         *  this waits, worded, for what can change it: a new network, an explicit start, a pin. */
        volatile boolean pinPaused = false;
        /** The status line's word for a TLS failure on a pinned address, or null. */
        @Nullable volatile String tlsWord;
        /** The last dial was refused: this desktop holds a pin and this address is not protected
         *  ({@link ShellRoute#mayDial}). Not a pause: {@link #connect} asks again, off the network,
         *  whenever anything wakes the link, and no timer is left behind to do so. */
        volatile boolean routeLocked = false;
        boolean closed = false;
        /** What the last summary alert said (its items), so a reconnect that finds the same
         *  cards waiting does not ring again. */
        @Nullable String lastSummaryKey;
        /** This desktop answered {@code /api/relay} with 404 (an older host) or 403 (a passive
         *  token): no relay here for this link's life; the old notice instead. */
        volatile boolean relayUnsupported = false;
        final Runnable connectRunnable = this::connect;
        /** {@link #DIAL_TIMEOUT_MS} after a dial: still not open, so give it up and retry. */
        final Runnable dialWatchdog = this::dialStuck;
        /** The retry's wake-up ({@link #WAKE_FAST_FOR_MS}); delivered on {@link #handler}. */
        final AlarmManager.OnAlarmListener wakeAlarm = this::onWakeAlarm;
        /** When this link lost its socket ({@code elapsedRealtime}, which runs through
         *  suspend), or 0 while it has one. Picks the alarm's pace. */
        long downSince = 0;
        /** Held only while an alarm-started dial is in flight. Per link and not reference
         *  counted: one desktop's answer never lets go of another's dial. */
        @Nullable PowerManager.WakeLock dialLock;

        Link(ShellLinkSet.Spec spec) {
            this.spec = spec;
            pauseIfLocked();
        }

        /** A locked link is paused like a tokenless gated one, and an explicit start clears that
         *  pause before the list is applied, so this runs on every apply: only a token reopens it. */
        void pauseIfLocked() {
            if (!spec.locked()) return;
            authPaused = true;
            status = "locked";
        }

        @Nullable
        String pausedWord() {
            String w = ShellLinkSet.pausedWord(tokenRefused, spec.locked(), authPaused);
            if (w != null) return w;
            return routeLocked ? ShellRoute.WORD_LOCKED : tlsWord;
        }

        /** This desktop's own client: its pin if it holds one, else {@link #client()} itself. */
        private OkHttpClient linkClient() {
            return ShellTlsClient.forUrl(ShellLinkService.this, client(), spec.hostId, spec.url);
        }

        /** A TLS failure on a pinned address, said on the status line. An address with no pin,
         *  and a failure that is not TLS, retry as they always did. */
        private void noteTlsFailure(Throwable t) {
            if (ShellTlsPins.pinFor(ShellLinkService.this, spec.hostId, spec.url) == null) return;
            String words = ShellTlsClient.words(t);
            if (words == null) return;
            lastError = words;
            boolean key = ShellTlsClient.isPinRefusal(t);
            tlsWord = key ? ShellTlsClient.WORD_KEY : ShellTlsClient.WORD_TLS;
            pinPaused = key;
        }

        void repinned(boolean changed) {
            if (!changed && !pinPaused) return;
            pinPaused = false;
            tlsWord = null;
            lastError = null;
            backoffMs = BACKOFF_MIN_MS;
            handler.removeCallbacks(connectRunnable);
            dropSocket();
            ensureSocket(250);
        }

        JSObject describe() {
            JSObject r = new JSObject();
            r.put("hostId", spec.hostId);
            r.put("label", spec.label);
            r.put("state", tokenRefused ? "signedOut" : spec.locked() ? "locked" : authPaused ? "auth" : pinPaused ? "keyChanged" : status);
            if (lastError != null) r.put("error", lastError);
            if (connectedAt > 0) r.put("connectedAt", connectedAt);
            return r;
        }

        /** One line in this desktop's link log ({@link ShellLinkLog}), on the phone's clock. */
        void log(String ev, @Nullable String detail) {
            linkLog().note(spec.hostId, System.currentTimeMillis(), ev, detail);
        }

        void close() {
            closed = true;
            handler.removeCallbacks(connectRunnable);
            disarmWake();
            dropSocket();
        }

        /** Set the retry's wake-up, at the backoff's pace while the loss is fresh. */
        private void armWake(long waitMs) {
            long now = SystemClock.elapsedRealtime();
            if (downSince == 0) downSince = now;
            long at = now - downSince < WAKE_FAST_FOR_MS ? waitMs : WAKE_SLOW_MS;
            AlarmManager am = getSystemService(AlarmManager.class);
            if (am == null) return;
            try {
                am.cancel(wakeAlarm);
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, now + at, "waterplane:link-retry", wakeAlarm, handler);
            } catch (RuntimeException e) {
                Log.w(TAG, spec.label + ": cannot set the retry alarm: " + e);
            }
        }

        private void disarmWake() {
            AlarmManager am = getSystemService(AlarmManager.class);
            if (am != null) {
                try { am.cancel(wakeAlarm); } catch (RuntimeException e) { Log.d(TAG, "alarm cancel: " + e); }
            }
        }

        /** The phone was woken for this link: dial now, and stay awake until it answers. */
        private void onWakeAlarm() {
            if (stopping || authPaused || pinPaused || closed || socket != null) return;
            Log.i(TAG, spec.label + ": woken to retry");
            log("wake", null);
            holdAwake();
            handler.removeCallbacks(connectRunnable);
            connect();
            if (socket == null) letSleep(); // refused before dialling (a locked route)
        }

        private void holdAwake() {
            try {
                if (dialLock == null) {
                    PowerManager pm = getSystemService(PowerManager.class);
                    if (pm == null) return;
                    dialLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "waterplane:link-dial");
                    dialLock.setReferenceCounted(false);
                }
                dialLock.acquire(DIAL_WAKE_MS);
            } catch (RuntimeException e) {
                Log.w(TAG, spec.label + ": no wake lock: " + e);
            }
        }

        private void letSleep() {
            PowerManager.WakeLock l = dialLock;
            if (l == null) return;
            try { if (l.isHeld()) l.release(); } catch (RuntimeException e) { Log.d(TAG, "wake lock release: " + e); }
        }

        void ensureSocket(long delayMs) {
            if (stopping || authPaused || pinPaused || closed) return;
            if (socket != null) return;
            handler.removeCallbacks(connectRunnable);
            handler.postDelayed(connectRunnable, delayMs);
        }

        private void connect() {
            if (stopping || authPaused || pinPaused || closed || socket != null) return;
            routeLocked = !ShellRoute.mayDial(spec.url, ShellTlsPins.pinOf(ShellLinkService.this, spec.hostId) != null,
                    ShellNetPlugin.tailnetNow(ShellLinkService.this));
            if (routeLocked) {
                // Its own word, not the "locked" of a token lost with the process: the page answers
                // that one by handing the token back, which would not help here.
                status = ShellRoute.WORD_LOCKED;
                lastError = null;
                refreshStatus();
                return;
            }
            status = "connecting";
            refreshStatus();
            Log.i(TAG, "connecting to " + spec);
            log("dial", null);
            connectStartedAt = System.currentTimeMillis();
            Request.Builder rb = new Request.Builder().url(spec.url);
            // That desktop's own token, to its own url only, as the subprotocol the page's socket
            // uses (`deviceToken.ts` `wsProtocols`). OkHttp sends the header verbatim.
            String protocols = ShellLinkSet.subprotocols(prefs(ShellLinkService.this).getString(KEY_WS_PROTOCOL, null), spec.token);
            if (protocols != null) rb.header("Sec-WebSocket-Protocol", protocols);
            socket = linkClient().newWebSocket(rb.build(), listener);
            handler.removeCallbacks(dialWatchdog);
            handler.postDelayed(dialWatchdog, DIAL_TIMEOUT_MS);
        }

        /** The dial in flight never answered (see {@link #DIAL_TIMEOUT_MS}): drop it, retry. */
        private void dialStuck() {
            if (closed || socket == null || "connected".equals(status)) return;
            Log.w(TAG, spec.label + ": no answer to the dial in " + (DIAL_TIMEOUT_MS / 1000) + " s");
            lastError = "no answer within " + (DIAL_TIMEOUT_MS / 1000) + " s — retrying";
            log("fail", "no answer in " + (DIAL_TIMEOUT_MS / 1000) + " s");
            dropSocket();
            scheduleRetry();
        }

        final WebSocketListener listener = new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                handler.post(() -> {
                    if (ws != socket) { ws.cancel(); return; } // an abandoned attempt
                    handler.removeCallbacks(dialWatchdog);
                    status = "connected";
                    lastError = null;
                    tlsWord = null;
                    connectedAt = System.currentTimeMillis();
                    lastFrameAt = connectedAt;
                    backoffMs = BACKOFF_MIN_MS;
                    downSince = 0;
                    disarmWake();
                    letSleep();
                    refreshStatus();
                    // The one frame this side sends. The version is the web layer's,
                    // handed over at `start()` — see the class comment. `role:notify`
                    // asks the host to send this link only the frames `onFrame` reads
                    // (`shared/wire/notifylink.ts`); every other frame is a radio
                    // wakeup thrown away. A host also infers it from OkHttp's UA, which
                    // is what covers an APK built before this line.
                    int protocol = prefs(ShellLinkService.this).getInt(KEY_PROTOCOL, 1);
                    ws.send("{\"t\":\"hello\",\"protocol\":" + protocol + ",\"role\":\"notify\"}");
                    // What this link saw while it was down, to the desktop's link log
                    // (`host/src/linklog.ts`); an older host ignores the frame.
                    log("open", null);
                    String saw = linkLog().drainFrame(spec.hostId, System.currentTimeMillis());
                    if (saw != null) ws.send(saw);
                    // The queue is the page's, and the page is the active desktop's. The
                    // plan's desktop gets the relay first; the alert is said once it is idle.
                    if (relayFor(Link.this)) {
                        relay(ShellLinkService.this).onConnect();
                        lastBacklogKey = null;
                        backlogDue = true;
                        pumpRelay();
                    } else if (isActive(Link.this)) {
                        lastBacklogKey = null;
                        reportQueueBacklog(Link.this);
                    }
                    // The notify link never replays: a card raised while this socket was
                    // down would never be seen. Ask once what is waiting there now.
                    fetchSummary();
                });
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                lastFrameAt = System.currentTimeMillis();
                handler.post(() -> { if (ws == socket) onFrame(text); });
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, @Nullable Response response) {
                handler.post(() -> {
                    if (ws != socket) return;
                    lastError = t.getMessage();
                    Log.w(TAG, spec.label + ": socket failed: " + t);
                    log("fail", t.getClass().getSimpleName() + (t.getMessage() != null ? ": " + t.getMessage() : ""));
                    noteTlsFailure(t);
                    dropSocket();
                    if (pinPaused) {
                        status = "keyChanged";
                        refreshStatus();
                        return;
                    }
                    scheduleRetry();
                });
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                handler.post(() -> {
                    if (ws != socket) return;
                    Log.i(TAG, spec.label + ": socket closed " + code + " " + reason);
                    log("closed", code + (reason != null && !reason.isEmpty() ? " " + reason : ""));
                    // 4403: a passive (kids') token never gets the socket (`host/passive.ts`).
                    // A retry is the same refusal, so it pauses instead of looping.
                    if (code == 4403) { refused(); return; }
                    dropSocket();
                    scheduleRetry();
                });
            }
        };

        /**
         * Three frames, and everything else on the floor.
         *
         * The wire is versioned and this APK does not update with the bundle, so a
         * frame type this build has never heard of is the expected case, not an
         * error — the same rule `main.ts`'s dispatcher follows for an unknown `t`.
         */
        private void onFrame(String text) {
            String t;
            JSONObject msg;
            try {
                msg = new JSONObject(text);
                t = msg.optString("t", "");
            } catch (org.json.JSONException e) {
                return; // Malformed: the WebView's socket is the one that has to care.
            }
            if (FRAME_AUTH_REQUIRED.equals(t)) {
                // The host is about to close this socket; retrying just bounces.
                refused();
                return;
            }
            if (FRAME_PULL_NEW.equals(t)) {
                // Auto-downloads are the ACTIVE desktop's: the page adopts the row into its
                // own queue, which holds that desktop's files only.
                if (isActive(this)) onPullNew(msg.optJSONObject("item"), this);
                return;
            }
            if (!FRAME_NOTIFICATION.equals(t)) return;
            JSONObject item = msg.optJSONObject("item");
            if (item != null) postAlert(item, this);
        }

        /** The desktop wants a sign-in: pause, no retry. Carrying a token, that token was refused.
         *  In memory mode there is no blob to forget and {@link #heldTokens} keeps its copy: the
         *  next apply then finds the same spec and this link stays "signed out". Dropping it would
         *  turn the row locked and tell the person to open the app, which cannot help. */
        void refused() {
            authPaused = true;
            if (offersToken()) {
                tokenRefused = true;
                ShellLinkTokens.forget(ShellLinkService.this, spec.hostId);
            }
            status = tokenRefused ? "signedOut" : "auth";
            dropSocket();
            refreshStatus();
        }

        /** Does this link actually offer its token (a token AND a base protocol to carry it)? */
        private boolean offersToken() {
            return ShellLinkSet.subprotocols(prefs(ShellLinkService.this).getString(KEY_WS_PROTOCOL, null), spec.token) != null;
        }

        void dropSocket() {
            WebSocket ws = socket;
            socket = null;
            handler.removeCallbacks(dialWatchdog);
            letSleep(); // a dial that failed, closed or was abandoned is answered
            if (ws != null) {
                try { ws.cancel(); } catch (RuntimeException e) { Log.d(TAG, "cancel: " + e); }
            }
            if (!"connected".equals(status)) return;
            status = "reconnecting";
        }

        private void scheduleRetry() {
            if (stopping || authPaused || pinPaused || closed) return;
            status = "reconnecting";
            refreshStatus();
            long wait = backoffMs;
            backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
            log("retry", wait + " ms");
            ensureSocket(wait);
            armWake(wait);
        }

        /** A network came back. Reset the backoff and go now — an exponential wait
         *  computed against a network that no longer exists is time spent offline
         *  for no reason. */
        void reconnectNow() {
            if (closed) return;
            backoffMs = BACKOFF_MIN_MS;
            pinPaused = false; // another network may not have whoever was in between
            tlsWord = null;
            handler.removeCallbacks(connectRunnable);
            long fresh = Math.max(connectedAt, connectStartedAt);
            if (socket != null && System.currentTimeMillis() - fresh < FRESH_SOCKET_MS) return;
            dropSocket();
            ensureSocket(250);
        }

        /**
         * {@code GET /api/attention} once, on each (re)open, and ONE summary alert when anything
         * waits there — the notify link never replays a feed, so without this a card raised while
         * the socket was down (the phone in a tunnel, the desktop asleep) is never seen.
         *
         * Same trust as the socket: that desktop's own token as {@code Authorization: Bearer}, to
         * this link's own origin only ({@link #httpBase} of its url), or none. A 401 says nothing in
         * the shade; carrying a token, it pauses the link as refused. A failed read says nothing
         * either: a number is never posted from a guess.
         */
        private void fetchSummary() {
            String base = httpBase(spec.url);
            if (base == null) return;
            Request.Builder rb = new Request.Builder().url(base + "/api/attention").get();
            final String auth = offersToken() ? ShellLinkSet.bearer(spec.token) : null;
            if (auth != null) rb.header("Authorization", auth);
            Request req = rb.build();
            OkHttpClient once = linkClient().newBuilder().callTimeout(10, TimeUnit.SECONDS).build();
            once.newCall(req).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, java.io.IOException e) {
                    Log.d(TAG, spec.label + ": attention read failed: " + e);
                }

                @Override
                public void onResponse(Call call, Response response) {
                    String body = null;
                    try (Response r = response) {
                        if (r.isSuccessful() && r.body() != null) body = r.body().string();
                        else {
                            Log.d(TAG, spec.label + ": attention read " + r.code());
                            if (r.code() == 401 && auth != null) handler.post(() -> { if (!closed && !authPaused) refused(); });
                        }
                    } catch (java.io.IOException | RuntimeException e) {
                        Log.d(TAG, spec.label + ": attention body: " + e);
                    }
                    if (body == null) return;
                    final String text = body;
                    handler.post(() -> { if (!closed) postSummary(text); });
                }
            });
        }

        private void postSummary(String text) {
            JSONObject s;
            try { s = new JSONObject(text); } catch (org.json.JSONException e) { return; }
            JSONObject sess = s.optJSONObject("sessions");
            JSONObject att = s.optJSONObject("attention");
            if (sess == null || att == null) return; // not a summary this build can read
            int sessionsN = Math.max(0, sess.optInt("n", 0));
            int attentionN = Math.max(0, att.optInt("n", 0));
            if (attentionN > 0) log("waiting", attentionN + " card(s) on reconnect");
            List<String> ids = new ArrayList<>();
            JSONArray idArr = sess.optJSONArray("ids");
            if (idArr != null) for (int i = 0; i < idArr.length(); i++) ids.add(idArr.optString(i, ""));
            List<ShellLinkSet.Waiting> items = new ArrayList<>();
            StringBuilder key = new StringBuilder();
            JSONArray arr = att.optJSONArray("items");
            if (arr != null) for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                items.add(new ShellLinkSet.Waiting(o.optString("kind", "info"), optStr(o, "plugin"), optStr(o, "sessionId")));
                key.append(o.optString("id", "")).append(',');
            }
            for (String id : ids) key.append(id).append(';');
            String tag = ShellLinkSet.tagFor(spec.hostId, "summary");
            int nid = tag.hashCode();
            NotificationManager nm = getSystemService(NotificationManager.class);
            int total = sessionsN + attentionN;
            if (total == 0) {
                // Nothing waits there now: an earlier summary of this desktop is out of date.
                lastSummaryKey = null;
                if (nm != null) nm.cancel(tag, nid);
                return;
            }
            String k = key.append('#').append(total).toString();
            if (k.equals(lastSummaryKey)) return; // the same cards, seen on a reconnect
            lastSummaryKey = k;
            if (APP_FOREGROUND.get()) return;
            String target = ShellLinkSet.summaryTarget(items, attentionN, ids, sessionsN);
            Notification n = new NotificationCompat.Builder(ShellLinkService.this, channelFor("prompt"))
                    .setSmallIcon(R.drawable.ic_stat_app)
                    .setContentTitle(ShellLinkSet.summaryTitle(spec.label, total))
                    .setContentText(ShellLinkSet.summaryBody(items, attentionN, sessionsN))
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setContentIntent(openAppIntent(ShellLinkSet.openTarget(spec.hostId, target), nid))
                    .build();
            if (nm == null) return;
            try {
                nm.notify(tag, nid, n);
            } catch (SecurityException e) {
                Log.d(TAG, "summary not shown: " + e);
            }
        }
    }

    @Nullable
    private static String optStr(JSONObject o, String k) {
        return o.isNull(k) ? null : o.optString(k, null);
    }

    // ── The network changed ──────────────────────────────────────────────

    /**
     * Two jobs on one signal.
     *
     * The native socket reconnects, obviously. Less obviously, <b>the WebView is
     * nudged</b>: {@code ws.ts} wakes on {@code visibilitychange}, {@code online},
     * {@code focus} and {@code pageshow} — every one of them a viewport event —
     * so a page that is alive but not on screen when the network flaps gets no
     * signal at all and sits on a zombie socket until the user next looks at the
     * phone.
     *
     * <b>What that is worth, measured rather than assumed.</b> The foreground
     * service does keep the process out of Android's freezer — with it running
     * the process sits at {@code procState=4}, {@code oom_score_adj=200},
     * {@code cgroup.freeze=0} indefinitely. But <b>Chromium freezes the DOCUMENT
     * on its own</b>, and on an API 34 emulator (WebView 113) it did so at 300 s
     * after {@code visibilitychange}, three times out of three, to the second —
     * with the timers running at a dead-on 1/s and no throttling whatsoever up
     * to that instant. Not a gradual stretch toward 1/min; a cliff. The
     * {@code freeze} event fires and `ws.ts` closes its own socket in response,
     * exactly as its handler is written to.
     *
     * So this nudge covers the first five minutes, which is the window in which
     * a page can still act on it. Past the freeze it cannot rescue the page:
     * {@code evaluateJavascript} from native DOES still execute on a frozen
     * document (measured, 72 s after the freeze), but only synchronously —
     * a {@code WebSocket} it constructs completes its handshake at the network
     * layer and then sits there, because {@code onopen} is a task and a frozen
     * document runs no tasks. Which is the honest reason this service holds a
     * socket of its own rather than trusting the page to keep holding one.
     */
    private void registerNetworkCallback() {
        if (netCallback != null) return;
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                handler.post(() -> {
                    Log.i(TAG, "network available");
                    for (Link l : links) { l.log("net-up", null); l.reconnectNow(); }
                    MainActivity.nudgeWebView("network");
                });
            }

            @Override
            public void onLost(Network network) {
                handler.post(() -> {
                    for (Link l : links) l.log("net-lost", null);
                    for (Link l : links) if (!l.authPaused && !l.routeLocked) l.status = "reconnecting";
                    refreshStatus();
                });
            }
        };
        try {
            cm.registerDefaultNetworkCallback(netCallback);
        } catch (RuntimeException e) {
            Log.w(TAG, "no network callback: " + e);
            netCallback = null;
        }
    }

    private void unregisterNetworkCallback() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm != null && netCallback != null) {
            try { cm.unregisterNetworkCallback(netCallback); } catch (RuntimeException e) { Log.d(TAG, "unregister: " + e); }
        }
        netCallback = null;
    }

    /**
     * A new auto-download, with nobody looking.
     *
     * The page's socket gets the same frame and its pump hands the row to
     * {@link ShellPullService} — while the page RUNS. Chromium freezes a hidden
     * document 300 s in, and from then on the frame reached only this socket,
     * which dropped it: the download started when the app was next opened.
     * So this side queues it, and the page adopts the row on its next wake.
     *
     * <b>Left to the page while the activity is in front</b> — it is running,
     * and one hand on a new row is fewer races than two. Obeys the page's
     * auto-download switch; the host's rules decided the rest.
     */
    private void onPullNew(@Nullable JSONObject item, Link from) {
        if (item == null || APP_FOREGROUND.get()) return;
        if (!ShellPullService.autoEnabled(this)) return;
        String base = httpBase(savedUrl(this));
        if (base == null) return;
        String refusal = ShellPullService.adoptRefusal(this, base, from.spec.hostId);
        if (refusal != null) {
            // The page takes the file on its own wake, under its own check.
            Log.w(TAG, from.spec.label + ": " + refusal);
            from.lastError = refusal;
            refreshStatus();
            return;
        }
        if (ShellPullService.adopt(this, item, base, from.spec.hostId)) Log.i(TAG, "queued " + item.optString("relPath"));
    }

    /** `wss://host:443/ws` → `https://host:443`. Null for anything else. */
    @Nullable
    static String httpBase(@Nullable String ws) {
        if (ws == null) return null;
        Uri u = Uri.parse(ws);
        String scheme = "wss".equals(u.getScheme()) ? "https" : "ws".equals(u.getScheme()) ? "http" : null;
        String auth = u.getEncodedAuthority();
        if (scheme == null || auth == null || auth.isEmpty()) return null;
        return scheme + "://" + auth;
    }

    // ── Posting an alert ─────────────────────────────────────────────────

    /**
     * One host notification, in the shade.
     *
     * <b>Suppressed while the activity is on screen.</b> The service is the only
     * poster of OS notifications, and the WebView keeps its own in-app feed —
     * duplicating a row the user is already looking at is noise, and the two
     * cannot both be the authority.
     *
     * <b>The tag is the dedupe.</b> Android replaces a notification posted with
     * the same tag, which is exactly the behaviour wanted for "the same session
     * is asking again". {@code NotificationItem} carries no {@code tag} field
     * yet (it is a separate, additive change on the host and in `shared`), so
     * one is derived here — kind plus session, falling back to the item id —
     * and {@code item.tag} is preferred the moment it starts arriving, so that
     * change needs nothing from this file.
     */
    private void postAlert(JSONObject item, Link from) {
        postAlert(item, from, null);
    }

    /** {@code action}: one button on the alert (the backlog's "Send N"); such an alert updates
     *  in place without ringing again. */
    private void postAlert(JSONObject item, Link from, @Nullable NotificationCompat.Action action) {
        String kind = item.optString("kind", "info");
        // When the alert reached the phone, against the desktop's `alert` row for the same card.
        String by = item.optString("plugin", "");
        from.log("alert", kind + (by.isEmpty() ? "" : " " + by) + (APP_FOREGROUND.get() ? " (app open, not shown)" : ""));
        if (APP_FOREGROUND.get()) return;
        // Several desktops: the title starts with whose it is, the tag is that desktop's own
        // (two desktops' equal tags must not replace each other), and the tap says which desktop
        // to open it on — the page switches only on that tap (`shellOpenTarget.ts`).
        String hostId = from.spec.hostId;
        String title = ShellLinkSet.titleFor(from.spec.label, item.optString("title", "waterplane"), links.size());
        String body = item.optString("body", "");
        String sessionId = item.optString("sessionId", null);
        // Filled by the host; a tap on an alert with no session opens this plugin's
        // screen (a vault fingerprint ask has no session to focus).
        String plugin = item.optString("plugin", null);
        String tag = item.optString("tag", null);
        if (tag == null || tag.isEmpty()) {
            String key = sessionId != null && !sessionId.isEmpty() ? sessionId : item.optString("id", "");
            tag = kind + "|" + key;
        }
        tag = ShellLinkSet.tagFor(hostId, tag);
        int id = tag.hashCode();
        NotificationCompat.Builder nb = new NotificationCompat.Builder(this, channelFor(kind))
                .setSmallIcon(R.drawable.ic_stat_app)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setWhen(item.optLong("ts", System.currentTimeMillis()))
                .setPriority(isUrgent(kind) ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(openAppIntent(ShellLinkSet.openTarget(hostId, tapTarget(sessionId, plugin, item)), id));
        if (action != null) nb.addAction(action).setOnlyAlertOnce(true);
        Notification n = nb.build();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        try {
            nm.notify(tag, id, n);
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS was refused. Everything else about this service
            // still works — the process stays unfrozen and the queue drains —
            // which is why the settings flow says so rather than refusing to run.
            Log.d(TAG, "alert not shown: " + e);
        }
    }

    // ── The background relay ─────────────────────────────────────────────

    /** Is {@code l} the desktop the relay's plan is for, and does it take relays? */
    private boolean relayFor(Link l) {
        String host = relay(this).hostId();
        return host != null && host.equals(l.spec.hostId) && !l.relayUnsupported;
    }

    @Nullable
    private Link linkOf(String hostId) {
        for (Link l : links) if (hostId.equals(l.spec.hostId)) return l;
        return null;
    }

    private boolean relayOwns(ShellRelay r) {
        long since = hiddenSince;
        long hiddenFor = since == 0 ? 0 : SystemClock.elapsedRealtime() - since;
        return ShellRelay.mayOwn(r.released(), APP_FOREGROUND.get(), MainActivity.hasLiveActivity(), hiddenFor);
    }

    /**
     * The relay's one loop, on the main thread: start each lane's next frame when this side owns
     * the queue, the app is not in front and the plan's desktop is CONNECTED (any other desktop is
     * never sent to). Idle again, it says what was sent and what waits.
     */
    private void pumpRelay() {
        handler.removeCallbacks(relayPump);
        if (stopping) return;
        ShellRelay r = relay(this);
        String host = r.hostId();
        Link l = host == null ? null : linkOf(host);
        if (l == null || l.closed || l.relayUnsupported || l.socket == null || !"connected".equals(l.status)) return;
        if (!relayOwns(r)) {
            reportRelayIdle(l, r);
            return;
        }
        long now = System.currentTimeMillis();
        for (ShellRelay.Send send : r.next(now)) postRelay(l, send);
        if (r.busy()) return;
        long at = r.nextRetryAt(now);
        if (at > 0) {
            handler.postDelayed(relayPump, at - now);
            return;
        }
        reportRelayIdle(l, r);
    }

    /** The relay is idle: say what happened — but only when it is news (see {@link #backlogDue}). */
    private void reportRelayIdle(Link l, ShellRelay r) {
        if (!backlogDue && r.sentCount() == 0) return;
        backlogDue = false;
        reportQueueBacklog(l);
    }

    /**
     * One frame, {@code POST /api/relay}: that desktop's own origin, its token as {@code Bearer}
     * (as {@link Link#fetchSummary}), through its own client — a pinned LAN address keeps its pin.
     * A partial wake lock holds the phone up for the call. The body is never logged: it is a
     * person's words.
     */
    private void postRelay(Link l, ShellRelay.Send send) {
        String base = httpBase(l.spec.url);
        if (base == null) {
            relay(this).onNoAnswer(send);
            return;
        }
        Request.Builder rb = new Request.Builder().url(base + "/api/relay").post(RequestBody.create(send.body, JSON_TYPE));
        final String auth = l.offersToken() ? ShellLinkSet.bearer(l.spec.token) : null;
        if (auth != null) rb.header("Authorization", auth);
        OkHttpClient once = l.linkClient().newBuilder()
                .callTimeout(RELAY_CALL_S, TimeUnit.SECONDS)
                .readTimeout(RELAY_CALL_S, TimeUnit.SECONDS)
                .build();
        final PowerManager.WakeLock lock = relayWakeLock();
        Log.i(TAG, l.spec.label + ": relay " + send.ackId);
        once.newCall(rb.build()).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, java.io.IOException e) {
                release(lock);
                Log.w(TAG, l.spec.label + ": relay " + send.ackId + " no answer: " + e);
                handler.post(() -> onRelayAnswer(l, send, -1, null, auth != null));
            }

            @Override
            public void onResponse(Call call, Response response) {
                int code;
                String body = null;
                try (Response r = response) {
                    code = r.code();
                    if (r.body() != null) body = r.body().string();
                } catch (java.io.IOException | RuntimeException e) {
                    code = -1;
                }
                release(lock);
                final int c = code;
                final String b = body;
                handler.post(() -> onRelayAnswer(l, send, c, b, auth != null));
            }
        });
    }

    /** The host's answer to one relay POST (main thread), then the next look. */
    private void onRelayAnswer(Link l, ShellRelay.Send send, int code, @Nullable String body, boolean carriedToken) {
        ShellRelay r = relay(this);
        boolean mine;
        if (code == 200 && body != null) {
            Map<String, Object> m = null;
            try {
                Object o = ShellRelay.Json.read(body);
                if (o instanceof Map) m = ShellRelay.asMap(o);
            } catch (IllegalArgumentException e) {
                m = null;
            }
            Object ack = m == null ? null : m.get("ack");
            if (ack instanceof Map) mine = r.onAck(send, ShellRelay.asMap(ack), System.currentTimeMillis());
            else if (m != null && Boolean.TRUE.equals(m.get("pending"))) mine = r.onPending(send);
            else mine = r.onNoAnswer(send);
        } else if (code == 422) {
            mine = r.onRefused(send);
        } else if (code == 404 || code == 403) {
            // An older host (no route) or a passive token: the old notice, for this link's life.
            l.relayUnsupported = true;
            mine = r.onRefused(send);
            Log.i(TAG, l.spec.label + ": relay unsupported (" + code + ")");
        } else {
            if (code == 401 && carriedToken && !l.closed && !l.authPaused) l.refused();
            mine = r.onNoAnswer(send);
        }
        if (!mine) Log.i(TAG, l.spec.label + ": relay " + send.ackId + " answered after a claim; the page has it");
        Log.i(TAG, l.spec.label + ": relay " + send.ackId + " → " + code);
        if (l.relayUnsupported) {
            reportQueueBacklog(l);
            return;
        }
        pumpRelay();
    }

    @Nullable
    private PowerManager.WakeLock relayWakeLock() {
        try {
            PowerManager pm = getSystemService(PowerManager.class);
            if (pm == null) return null;
            PowerManager.WakeLock w = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "waterplane:link-relay");
            w.setReferenceCounted(false);
            w.acquire((RELAY_CALL_S + 5) * 1000);
            return w;
        } catch (RuntimeException e) {
            Log.w(TAG, "relay: no wake lock: " + e);
            return null;
        }
    }

    private static void release(@Nullable PowerManager.WakeLock w) {
        if (w == null) return;
        try { if (w.isHeld()) w.release(); } catch (RuntimeException e) { Log.d(TAG, "wake lock release: " + e); }
    }

    /**
     * What the queue holds, said out loud once the link is back: what the relay SENT to this
     * desktop, and what still waits for the person ("Sent 2 to studio. 1 waits for you — open to
     * review"), with a "Send N" action for the rows held only by the reconnect question. With no
     * relay (an older host, the page still owning) it is the old notice: the prompts are safe in
     * localStorage and sit until someone opens the app. Never while the app is in front.
     */
    /** Whether a notification action can be made to ask for the phone's unlock (API 31+). */
    static boolean authActionSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
    }

    private void reportQueueBacklog(Link l) {
        if (APP_FOREGROUND.get()) return;
        int depth = prefs(this).getInt(KEY_QUEUE, 0);
        ShellRelay r = relay(this);
        boolean relayed = relayFor(l);
        if (!relayed && !isActive(l)) return;
        int sent = relayed ? r.sentCount() : 0;
        // "Send N" types held prompts into the desktop on one tap, and the app lock lives in the page
        // only: the action asks for the phone's own unlock (API 31+). Where that cannot be asked it is
        // not offered, and the notice says "open to review" instead.
        List<String> releasable = relayed && authActionSupported() ? r.releasable() : Collections.<String>emptyList();
        int waits = Math.max(0, depth - sent);
        if (sent == 0 && waits == 0) return;
        String key = sent + "|" + waits + "|" + releasable;
        if (key.equals(lastBacklogKey)) return;
        lastBacklogKey = key;
        JSONObject item = new JSONObject();
        try {
            // A report that only says what WAS sent is news, not an alarm: the quieter "info" channel.
            // Anything still waiting (or a Send N action) stays on the heads-up "undelivered" one.
            item.put("kind", waits == 0 && releasable.isEmpty() ? "info" : "undelivered");
            item.put("title", ShellRelay.backlogTitle(sent, waits));
            item.put("body", ShellRelay.backlogBody(sent, waits, releasable.size(), l.spec.label));
            item.put("tag", "queue-depth");
            item.put("id", "queue-depth");
        } catch (org.json.JSONException e) {
            return;
        }
        NotificationCompat.Action send = null;
        if (!releasable.isEmpty()) {
            // Exactly these ackIds: a row edited or re-aimed since has another id and stays.
            Intent i = new Intent(this, ShellLinkService.class).setAction(ACTION_RELAY_RELEASE)
                    .putExtra(EXTRA_ACK_IDS, releasable.toArray(new String[0]));
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? PendingIntent.getForegroundService(this, 4772, i, flags)
                    : PendingIntent.getService(this, 4772, i, flags);
            send = new NotificationCompat.Action.Builder(0, "Send " + releasable.size(), pi)
                    .setAuthenticationRequired(true).build();
        }
        postAlert(item, l, send);
    }

    /**
     * Tapping any of these opens the app, and — for an alert that names a
     * session — asks it to focus that session, which is the path
     * {@code sw.js}'s {@code notificationclick} already takes in the browser.
     * {@code MainActivity} is {@code singleTask}, so a live app gets this
     * through {@code onNewIntent} and a dead one through its launch intent;
     * both ends funnel into the same place.
     *
     * The request code is the notification's own, so two alerts do not share
     * one {@code PendingIntent} and hand the second one's tap the first one's
     * session.
     *
     * An alert with neither (a health move, a burning week, a full disk) hands
     * the page the WHOLE item as {@code notif:<json>}: the page's {@code openNotif}
     * decides where it lands, the same as a tap on its row in the feed, so a new
     * kind of target never needs a new APK. An older web bundle finds no session
     * by that string, which is harmless.
     */
    @Nullable
    private static String tapTarget(@Nullable String sessionId, @Nullable String plugin, @Nullable JSONObject item) {
        if (sessionId != null && !sessionId.isEmpty()) return sessionId;
        // MainActivity hands the extra to window.shellOpen unchanged; the web side reads
        // "plugin:<id>" as a plugin's screen (session ids never contain ':'). An older
        // web bundle finds no session by that name, which is harmless.
        if (plugin != null && !plugin.isEmpty()) return "plugin:" + plugin;
        if (item != null) return "notif:" + item.toString();
        return null;
    }

    /** {@code target} is what {@code window.shellOpen} is handed ({@link #tapTarget}, prefixed
     *  {@code host:<id>|} for a desktop of several — {@link ShellLinkSet#openTarget}); null opens
     *  the app and nothing else. */
    private PendingIntent openAppIntent(@Nullable String target, int requestCode) {
        Intent i = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (target != null && !target.isEmpty()) i.putExtra(MainActivity.EXTRA_OPEN_SESSION, target);
        // IMMUTABLE unconditionally: `minSdk` is 24, and nothing here wants the
        // receiver to be able to fill in fields of this intent.
        return PendingIntent.getActivity(this, requestCode, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * The Settings page for this app's battery treatment — where an exemption is
     * granted. Kept here so the plugin has one place to send the user.
     *
     * Lint's `BatteryLife` objection is aimed at apps that opt out of power
     * management to keep doing ordinary work, and at the direct-grant DIALOG.
     * This is neither: it opens the Settings screen and lets the user decide,
     * and the exemption is what makes the RECOVERY paths legal — an app the
     * system may doze cannot start a foreground service from the background,
     * which is exactly what {@link ShellBootReceiver} and {@link ShellLinkWorker}
     * do. It is offered, never demanded; without it the link degrades to "a
     * notification in the next Doze maintenance window", never to silence.
     */
    @android.annotation.SuppressLint("BatteryLife")
    static Intent batterySettingsIntent(Context ctx) {
        return new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + ctx.getPackageName()));
    }
}
