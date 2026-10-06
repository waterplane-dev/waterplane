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
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.OkHttpClient;
import okhttp3.Request;
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
 * So this service does two jobs, and the first one it does merely by existing:
 *
 * <ol>
 *   <li><b>It keeps the process out of the freezer</b>, so the WebView's own
 *       {@code ws.ts} socket, {@code flushOutbox}, upload POSTs and reconnect
 *       logic keep running in the background, unchanged. That is the whole
 *       reason none of the app's protocol is reimplemented here.</li>
 *   <li><b>It holds a deliberately minimal socket of its own</b> for the one
 *       case the WebView can never cover: the app swiped away and the process
 *       gone — which is exactly when a waiting question matters most.</li>
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
 * <h2>The socket speaks three frames, not the protocol</h2>
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

    /** Live instance, or null. Only used to answer "is it up?" for the plugin's
     *  status call and the WorkManager backstop; never dereferenced for work. */
    @Nullable private static volatile ShellLinkService instance;

    /** A start has been asked for and the service has not come up yet.
     *  {@code startForegroundService} is asynchronous, so without this a status
     *  read immediately after `start()` says "stopped" about a service that is
     *  starting — a settings row would draw the switch as having failed at the
     *  exact moment it worked. */
    private static volatile boolean pendingStart;

    private final Handler handler = new Handler(Looper.getMainLooper());
    @Nullable private OkHttpClient client;
    /**
     * The current socket — <b>from the moment it is asked for</b>, not from the
     * moment it opens. OkHttp hands the object back synchronously and connects
     * behind it, so holding it from the start is what makes two things possible
     * that a "connected socket only" field cannot: a reconnect that arrives
     * mid-handshake can CANCEL the attempt instead of racing a second one into
     * existence, and every listener callback can check {@code ws != socket} and
     * fall silent if it belongs to an attempt that has already been abandoned.
     */
    @Nullable private WebSocket socket;
    @Nullable private ConnectivityManager.NetworkCallback netCallback;

    private volatile String status = "starting";
    @Nullable private volatile String lastError;
    private volatile long connectedAt = 0;
    /** When the current attempt was STARTED, as opposed to when it succeeded.
     *  A connect in flight is as young as a connect that just landed, and the
     *  network callback fires on registration — see {@link #FRESH_SOCKET_MS}. */
    private long connectStartedAt = 0;
    private volatile long lastFrameAt = 0;
    private long backoffMs = BACKOFF_MIN_MS;
    /** The host said this connection needs the LAN password. Stop reconnecting —
     *  every retry would bounce the same way — and say so on the status line
     *  until the user opens the app and signs in. */
    private boolean authPaused = false;
    private boolean stopping = false;

    // ── Static API for the rest of the shell ─────────────────────────────

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
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
    static void enable(Context ctx, String url, int protocol, String label) {
        prefs(ctx).edit()
                .putBoolean(KEY_ENABLED, true)
                .putString(KEY_URL, url)
                .putInt(KEY_PROTOCOL, protocol)
                .putString(KEY_LABEL, label)
                .apply();
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

    /** Called from {@link MainActivity}'s lifecycle. See {@link #APP_FOREGROUND}. */
    static void setAppForeground(boolean foreground) {
        APP_FOREGROUND.set(foreground);
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
        o.put("state", s != null ? s.status : (pendingStart ? "starting" : "stopped"));
        o.put("host", prefs(ctx).getString(KEY_LABEL, null));
        o.put("queueDepth", prefs(ctx).getInt(KEY_QUEUE, 0));
        if (s != null) {
            o.put("connectedAt", s.connectedAt);
            o.put("lastFrameAt", s.lastFrameAt);
            if (s.lastError != null) o.put("error", s.lastError);
        }
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
            authPaused = false;
            String url = intent != null ? intent.getStringExtra(EXTRA_URL) : null;
            if (url != null && !url.equals(url())) {
                Log.i(TAG, "re-pointed at " + url);
                dropSocket();
            }
        }

        registerNetworkCallback();
        ShellLinkWorker.schedule(this);
        ensureSocket(0);
        // START_STICKY, not START_REDELIVER_INTENT: the configuration is in
        // SharedPreferences precisely so the restart does not depend on an
        // Intent the platform may or may not have kept.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        unregisterNetworkCallback();
        dropSocket();
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
        dropSocket();
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
        String label = prefs(this).getString(KEY_LABEL, null);
        String line;
        if (authPaused) line = "sign-in needed";
        else if ("connected".equals(status)) line = "connected · " + (label != null ? label : "host");
        else if (stopping) line = "stopping";
        else line = "reconnecting…";
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return id;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return id;
        if (nm.getNotificationChannel(id) != null) return id;
        boolean urgent = "prompt".equals(kind) || "limit".equals(kind)
                || "cli".equals(kind) || "undelivered".equals(kind);
        NotificationChannel ch = new NotificationChannel(id, labelFor(kind),
                urgent ? NotificationManager.IMPORTANCE_HIGH : NotificationManager.IMPORTANCE_DEFAULT);
        nm.createNotificationChannel(ch);
        return id;
    }

    /** Human names for the host's `NOTIFICATION_KINDS`. An unknown kind — a host
     *  newer than this APK — gets its own channel named after itself rather than
     *  being dropped. */
    private static String labelFor(String kind) {
        switch (kind) {
            case "prompt": return "Waiting questions";
            case "limit": return "Usage limits";
            case "cli": return "CLI health";
            case "undelivered": return "Undelivered prompts";
            case "backlog": return "Backlog";
            case "artifact": return "Artifacts";
            case "image": return "Images";
            case "oracle": return "Oracle";
            case "autofire": return "Auto-fire";
            case "idle": return "Turn finished";
            case "info": return "Info";
            default: return kind;
        }
    }

    // ── The socket ───────────────────────────────────────────────────────

    @Nullable
    private String url() {
        return prefs(this).getString(KEY_URL, null);
    }

    private void ensureSocket(long delayMs) {
        if (stopping || authPaused) return;
        if (socket != null) return;
        handler.removeCallbacks(connectRunnable);
        handler.postDelayed(connectRunnable, delayMs);
    }

    private final Runnable connectRunnable = this::connect;

    private void connect() {
        if (stopping || authPaused || socket != null) return;
        String url = url();
        if (url == null || url.isEmpty()) {
            status = "unconfigured";
            refreshStatus();
            return;
        }
        status = "connecting";
        refreshStatus();
        if (client == null) {
            client = new OkHttpClient.Builder()
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
        Log.i(TAG, "connecting to " + url);
        connectStartedAt = System.currentTimeMillis();
        socket = client.newWebSocket(new Request.Builder().url(url).build(), listener);
    }

    private final WebSocketListener listener = new WebSocketListener() {
        @Override
        public void onOpen(WebSocket ws, Response response) {
            handler.post(() -> {
                if (ws != socket) { ws.cancel(); return; } // an abandoned attempt
                status = "connected";
                lastError = null;
                connectedAt = System.currentTimeMillis();
                lastFrameAt = connectedAt;
                backoffMs = BACKOFF_MIN_MS;
                refreshStatus();
                // The one frame this side sends. The version is the web layer's,
                // handed over at `start()` — see the class comment.
                int protocol = prefs(ShellLinkService.this).getInt(KEY_PROTOCOL, 1);
                ws.send("{\"t\":\"hello\",\"protocol\":" + protocol + "}");
                reportQueueBacklog();
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
                Log.w(TAG, "socket failed: " + t);
                dropSocket();
                scheduleRetry();
            });
        }

        @Override
        public void onClosed(WebSocket ws, int code, String reason) {
            handler.post(() -> {
                if (ws != socket) return;
                Log.i(TAG, "socket closed " + code + " " + reason);
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
            authPaused = true;
            status = "auth";
            dropSocket();
            refreshStatus();
            return;
        }
        if (FRAME_PULL_NEW.equals(t)) {
            onPullNew(msg.optJSONObject("item"));
            return;
        }
        if (!FRAME_NOTIFICATION.equals(t)) return;
        JSONObject item = msg.optJSONObject("item");
        if (item != null) postAlert(item);
    }

    private void dropSocket() {
        WebSocket ws = socket;
        socket = null;
        if (ws != null) {
            try { ws.cancel(); } catch (RuntimeException e) { Log.d(TAG, "cancel: " + e); }
        }
        if (!"connected".equals(status)) return;
        status = "reconnecting";
    }

    private void scheduleRetry() {
        if (stopping || authPaused) return;
        status = "reconnecting";
        refreshStatus();
        long wait = backoffMs;
        backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
        ensureSocket(wait);
    }

    /** A network came back. Reset the backoff and go now — an exponential wait
     *  computed against a network that no longer exists is time spent offline
     *  for no reason. */
    private void reconnectNow() {
        backoffMs = BACKOFF_MIN_MS;
        handler.removeCallbacks(connectRunnable);
        long fresh = Math.max(connectedAt, connectStartedAt);
        if (socket != null && System.currentTimeMillis() - fresh < FRESH_SOCKET_MS) return;
        dropSocket();
        ensureSocket(250);
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
                    reconnectNow();
                    MainActivity.nudgeWebView("network");
                });
            }

            @Override
            public void onLost(Network network) {
                handler.post(() -> {
                    status = "reconnecting";
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
    private void onPullNew(@Nullable JSONObject item) {
        if (item == null || APP_FOREGROUND.get()) return;
        if (!ShellPullService.autoEnabled(this)) return;
        String base = httpBase(url());
        if (base == null) return;
        if (ShellPullService.adopt(this, item, base)) Log.i(TAG, "queued " + item.optString("relPath"));
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
    private void postAlert(JSONObject item) {
        if (APP_FOREGROUND.get()) return;
        String kind = item.optString("kind", "info");
        String title = item.optString("title", "waterplane");
        String body = item.optString("body", "");
        String sessionId = item.optString("sessionId", null);
        String tag = item.optString("tag", null);
        if (tag == null || tag.isEmpty()) {
            String key = sessionId != null && !sessionId.isEmpty() ? sessionId : item.optString("id", "");
            tag = kind + "|" + key;
        }
        int id = tag.hashCode();
        Notification n = new NotificationCompat.Builder(this, channelFor(kind))
                .setSmallIcon(R.drawable.ic_stat_app)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setWhen(item.optLong("ts", System.currentTimeMillis()))
                .setContentIntent(openAppIntent(sessionId, id))
                .build();
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

    /**
     * The residual gap, said out loud: the app was swiped away with prompts
     * still queued, so nothing on the phone can send them. They are safe —
     * they are in localStorage and the queue is durable — but they sit until
     * someone opens the app. When this socket comes back and the persisted
     * depth is non-zero, say so once.
     */
    private void reportQueueBacklog() {
        if (APP_FOREGROUND.get()) return;
        int depth = prefs(this).getInt(KEY_QUEUE, 0);
        if (depth <= 0) return;
        JSONObject item = new JSONObject();
        try {
            item.put("kind", "undelivered");
            item.put("title", depth == 1 ? "1 prompt waiting" : depth + " prompts waiting");
            item.put("body", "The link is back. Open the app to send " + (depth == 1 ? "it" : "them") + ".");
            item.put("tag", "queue-depth");
            item.put("id", "queue-depth");
        } catch (org.json.JSONException e) {
            return;
        }
        postAlert(item);
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
     */
    private PendingIntent openAppIntent(@Nullable String sessionId, int requestCode) {
        Intent i = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (sessionId != null && !sessionId.isEmpty()) i.putExtra(MainActivity.EXTRA_OPEN_SESSION, sessionId);
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
