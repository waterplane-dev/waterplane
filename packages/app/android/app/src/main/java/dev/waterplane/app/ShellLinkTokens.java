package dev.waterplane.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.Nullable;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The background link's device tokens at rest — one per password-gated desktop, so
 * {@link ShellLinkService} can still sign in there after the app was swiped away, the phone
 * rebooted, or the process died (the service reads its configuration off disk, never off an
 * Intent).
 *
 * <b>Sealed, app-private, and nowhere else.</b> Each token is AES-256-GCM encrypted under ONE
 * Android Keystore key ({@link #ALIAS}) that is never exportable and needs NO user authentication —
 * the service runs with nobody holding the phone, so a biometric key ({@link ShellKeystorePlugin})
 * would make the link unusable by design. The ciphertext sits in its own MODE_PRIVATE preferences
 * file ({@link #PREFS}), never in the link list ({@code shell.link}), so the list can be logged,
 * diffed and described without a token near it. The associated data is the desktop's id and
 * address ({@link ShellLinkSet#tokenAad}): a blob does not open for another desktop. Backup is off
 * app-wide ({@code allowBackup=false}), and a restored blob would not open anyway — the key does not
 * travel.
 *
 * <b>That is no weaker than the page's own copy</b>, which lives in the WebView's localStorage
 * (app-private, plaintext). No new dependency: {@code EncryptedSharedPreferences} is not in this
 * build and is deprecated upstream; this is the same Keystore + GCM it wraps.
 *
 * <b>Kept exactly as long as the page names it</b>: every {@code start} rewrites the set
 * ({@link #replaceAll}), so a desktop removed from the list, or handed without a token, has its blob
 * deleted; switching the link off deletes them all ({@link #clear}). A blob that will not open
 * (key gone, data damaged) is deleted and read as absent — the link then asks as a tokenless one.
 *
 * <b>Memory mode writes nothing here.</b> A {@code start} with {@code tokensInMemory} deletes every
 * blob ({@link #clearNow}) and the service holds the tokens in its process alone; it never reads
 * this file in that mode, so a blob that outlived a crash opens for nobody and is swept at the next
 * service start.
 */
final class ShellLinkTokens {

    private ShellLinkTokens() {}

    private static final String TAG = "shell-link-tok";
    private static final String PREFS = "shell.link.tok";
    private static final String ALIAS = "waterplane.shell.link.tokens";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int TAG_BITS = 128;

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Make the stored set exactly the tokens these specs carry: sealed for each spec with one,
     * deleted for every other host id. A token that cannot be sealed is NOT stored in the clear —
     * that link runs without it (a gated desktop then pauses, as before this existed).
     */
    static void replaceAll(Context ctx, List<ShellLinkSet.Spec> specs) {
        SharedPreferences p = prefs(ctx);
        SharedPreferences.Editor e = p.edit();
        Set<String> keep = new HashSet<>();
        for (ShellLinkSet.Spec s : specs) {
            if (s.hostId == null || !ShellLinkSet.isToken(s.token)) continue;
            String blob = seal(s.token, ShellLinkSet.tokenAad(s.hostId, s.url));
            if (blob == null) continue;
            e.putString(s.hostId, blob);
            keep.add(s.hostId);
        }
        for (Map.Entry<String, ?> en : p.getAll().entrySet()) {
            if (!keep.contains(en.getKey())) e.remove(en.getKey());
        }
        e.apply();
    }

    /** That desktop's token, or null (none stored, or one that no longer opens — then deleted). */
    @Nullable
    static String read(Context ctx, String hostId, String url) {
        if (hostId == null) return null;
        SharedPreferences p = prefs(ctx);
        String blob = p.getString(hostId, null);
        if (blob == null) return null;
        String tok = open(blob, ShellLinkSet.tokenAad(hostId, url));
        if (!ShellLinkSet.isToken(tok)) {
            p.edit().remove(hostId).apply();
            return null;
        }
        return tok;
    }

    /** The desktop refused it: the copy at rest goes at once, so a process restart does not
     *  offer it again — only the page handing a token (a new pairing) stores one. */
    static void forget(Context ctx, @Nullable String hostId) {
        if (hostId != null) prefs(ctx).edit().remove(hostId).apply();
    }

    /** The link was switched off, or an old bundle sent no list: no token is kept. */
    static void clear(Context ctx) {
        prefs(ctx).edit().clear().apply();
    }

    /** {@link #clear}, on disk before it returns: memory mode's promise is that the blob is gone,
     *  not that it is queued to go. Off the main thread only. False: the sweep at the next service
     *  start tries again. */
    static boolean clearNow(Context ctx) {
        return prefs(ctx).edit().clear().commit();
    }

    // ── The key and the cipher ───────────────────────────────────────────

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        java.security.Key k = ks.getKey(ALIAS, null);
        if (k instanceof SecretKey) return (SecretKey) k;
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    /** "nonceB64.ctB64", or null. The Keystore picks the nonce. Never logs the input. */
    @Nullable
    private static String seal(String token, String aad) {
        try {
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.ENCRYPT_MODE, key());
            c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            byte[] ct = c.doFinal(token.getBytes(StandardCharsets.UTF_8));
            return b64(c.getIV()) + "." + b64(ct);
        } catch (Exception e) {
            Log.w(TAG, "token not kept: " + e.getClass().getSimpleName());
            return null;
        }
    }

    @Nullable
    private static String open(String blob, String aad) {
        int dot = blob.indexOf('.');
        if (dot <= 0) return null;
        try {
            byte[] iv = Base64.decode(blob.substring(0, dot), Base64.NO_WRAP);
            byte[] ct = Base64.decode(blob.substring(dot + 1), Base64.NO_WRAP);
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
            c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            return new String(c.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "stored token unreadable: " + e.getClass().getSimpleName());
            return null;
        }
    }

    private static String b64(byte[] b) {
        return Base64.encodeToString(b, Base64.NO_WRAP);
    }
}
