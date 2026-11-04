package dev.waterplane.app;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.security.keystore.UserNotAuthenticatedException;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.Key;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * A key on this phone that only a fingerprint can use, or on request one the
 * phone's PIN opens too — generic, with no idea what the bytes it wraps are for
 * — and, apart from the keys, a plain "is this the phone's owner?" check that
 * guards no bytes at all.
 *
 * <pre>
 *   Capacitor.Plugins.ShellKeystore
 *     .status()                                      → {hardware, enrolled, strongBox}
 *     .has({alias})                                  → {exists}
 *     .generate({alias, strongBox?, replace?, auth?}) → {strongBox, auth?}
 *     .wrap({alias, dataB64, aadB64?, title?, subtitle?, description?})          → {ctB64, nonceB64}
 *     .unwrap({alias, ctB64, nonceB64, aadB64?, title?, subtitle?, description?}) → {dataB64}
 *     .remove({alias})                               → {}
 *     .lockStatus()                                  → {hardware, enrolled, screenLock}
 *     .authenticate({title?, subtitle?, description?, allowCredential?}) → {method}
 * </pre>
 *
 * <b>The key.</b> AES-256, GCM/NoPadding, generated inside the Android Keystore
 * (StrongBox when asked and present, else the TEE) and never exportable. It is
 * per-use bound to a STRONG biometric: from API 30
 * {@code setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)}, below it
 * {@code setUserAuthenticationValidityDurationSeconds(-1)}, which is the same
 * "every operation needs its own authentication" in the older words. Enrolling
 * a new fingerprint invalidates it ({@code keyInvalidated}) — someone who can
 * add a finger to the phone must not inherit the key.
 *
 * <b>Every crypto operation is one BiometricPrompt.</b> The Cipher is
 * initialised first (the Keystore picks the GCM IV for an encryption), handed
 * to the prompt as a {@link BiometricPrompt.CryptoObject}, and only the Cipher
 * the prompt hands back — now unlocked for exactly one operation — runs. No
 * device-credential fallback for the key: a PIN is not a biometric, and a key
 * bound to BIOMETRIC_STRONG would refuse it anyway.
 *
 * <b>{@code generate({auth: "any"})} is the other key.</b> Same AES-256-GCM, but
 * a fingerprint or the phone's PIN opens it for {@value #ANY_KEY_SECONDS}
 * seconds: {@code setUserAuthenticationParameters(10, AUTH_BIOMETRIC_STRONG |
 * AUTH_DEVICE_CREDENTIAL)}, below API 30 a validity of 10. Timeout 0 with the
 * credential is the shape Android rejects, which is why it is not per-use. So
 * the order is the other way round: one prompt with no CryptoObject, and only
 * then a fresh Cipher, used at once. Nothing but that prompt runs it; the 10
 * seconds are the Keystore's condition, not a window this class ever reuses.
 * The prompt is {@link #keyAuthenticatorsFor}, and a WEAK face on API 28-29
 * passes it without opening the key, hence the sentence {@link #USE_THE_PIN}.
 * It needs a screen lock, not a fingerprint, so {@code noneEnrolled} here means
 * no screen lock. Android documents this key as bound to the lock screen's
 * secret rather than to the enrolled fingers: a new finger leaves it alone,
 * removing the screen lock destroys it. {@code auth} absent or
 * {@code "biometric"} is the key above, and which of the two an alias is lives
 * in a small prefs map holding only the {@code any} aliases, so a key from before
 * the map reads as what it is. {@code auth} comes back only to a caller who sent
 * it, so a page reads its absence as a shell that ignored the word.
 *
 * <b>{@code authenticate} is not about the key.</b> A presence check: one
 * BiometricPrompt with no CryptoObject, BIOMETRIC_WEAK, and the phone's own
 * PIN, pattern or password as the fallback by design ({@code allowCredential},
 * on unless turned off). WEAK because BIOMETRIC_STRONG|DEVICE_CREDENTIAL does
 * not exist on API 28-29, and because nothing here unlocks a secret. Below API
 * 30 the library reaches the credential through KeyguardManager's own screen,
 * so the page goes hidden while it is up. Enrolment changes do not touch it.
 * {@code lockStatus} is the question to ask beside it: a fresh read, no prompt,
 * no state, which is what a caller re-reads to tell a sensor that is gone from
 * one that is having a bad moment.
 *
 * <b>Refusals are words</b>, in the rejection's {@code code}:
 * {@code noHardware}, {@code noneEnrolled}, {@code keyInvalidated}, {@code noKey},
 * {@code exists}, {@code cancelled}, {@code lockout}, {@code busy},
 * {@code badInput}, {@code failed}. The page words them; nothing here decides
 * what a refusal means for the caller. A key is called dead only on the shapes
 * {@link #codeForKeyFailure} can name, because a caller may give up on the key,
 * and what it wrapped, on that word; any other Keystore fault stays {@code failed}.
 *
 * Plaintext byte arrays are zeroed once used. The base64 strings that cross
 * the bridge are Java/JS strings and cannot be — that is the bridge's limit,
 * stated rather than hidden.
 */
@CapacitorPlugin(name = "ShellKeystore")
public class ShellKeystorePlugin extends Plugin {

    private static final String TAG = "shell-keystore";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int TAG_BITS = 128;
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG;
    private static final int LOCK_BIOMETRIC = BiometricManager.Authenticators.BIOMETRIC_WEAK;
    /** Aliases of {@code auth: "any"} keys, to tell wrap and unwrap which flow. Not secret. */
    private static final String KINDS = "shell.keystore.kind";

    // The code words — the contract with web/src/nativeKeystore.ts.
    static final String NO_HARDWARE = "noHardware";
    static final String NONE_ENROLLED = "noneEnrolled";
    static final String KEY_INVALIDATED = "keyInvalidated";
    static final String NO_KEY = "noKey";
    static final String EXISTS = "exists";
    static final String CANCELLED = "cancelled";
    static final String LOCKOUT = "lockout";
    static final String BUSY = "busy";
    static final String BAD_INPUT = "badInput";
    static final String FAILED = "failed";

    // What authenticate() says passed the check.
    static final String METHOD_BIOMETRIC = "biometric";
    static final String METHOD_CREDENTIAL = "credential";
    static final String METHOD_UNKNOWN = "unknown";

    /** What {@code generate} accepts as {@code auth}. */
    static final String AUTH_BIOMETRIC = "biometric";
    static final String AUTH_ANY = "any";

    /** How long a passed prompt opens an {@code any} key. Not 0: see the class comment. */
    static final int ANY_KEY_SECONDS = 10;

    /**
     * The prompt passed but the key was not opened by it; {@code failed}'s message.
     * Either that unlock cannot open the key, or the PIN's seconds ran out before
     * the Cipher was made, and the exception does not say which.
     */
    static final String USE_THE_PIN = "that unlock does not open this key: use the phone's PIN or try again";

    /** What the platform's getKey leaves of a KeyPermanentlyInvalidatedException: the message, no cause. */
    static final String AUTH_CHANGED_WORDS = "User changed or deleted their auth credentials";
    /** How android.security.KeyStoreException opens its message; a suffix may follow. */
    static final String INVALIDATED_WORDS = "Key permanently invalidated";
    static final String NOT_FOUND_WORDS = "Key not found";

    /** One prompt at a time: a second would stack a sheet over the first. */
    private volatile boolean prompting;

    // ── Questions that need no fingerprint ───────────────────────────────

    @PluginMethod
    public void status(PluginCall call) {
        int can = biometricManager().canAuthenticate(AUTHENTICATORS);
        JSObject ret = new JSObject();
        ret.put("hardware", hasHardware(can));
        ret.put("enrolled", can == BiometricManager.BIOMETRIC_SUCCESS);
        ret.put("strongBox", strongBoxPresent());
        call.resolve(ret);
    }

    @PluginMethod
    public void has(PluginCall call) {
        String alias = alias(call);
        if (alias == null) return;
        try {
            JSObject ret = new JSObject();
            ret.put("exists", keyStore().containsAlias(alias));
            call.resolve(ret);
        } catch (Exception e) {
            fail(call, FAILED, "could not read the keystore: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String alias = alias(call);
        if (alias == null) return;
        try {
            KeyStore ks = keyStore();
            if (ks.containsAlias(alias)) ks.deleteEntry(alias);
            rememberKind(alias, AUTH_BIOMETRIC);
            call.resolve();
        } catch (Exception e) {
            fail(call, FAILED, "could not remove the key: " + e.getMessage(), e);
        }
    }

    /**
     * What {@link #authenticate} has to work with, read fresh on every call and
     * changing nothing, so it is safe to ask while a prompt is up. A caller
     * re-reads it to confirm a refusal, so each field leans away from "gone":
     * {@code hardware} is false only when no sensor exists, and {@code enrolled}
     * is true only on a clean reading, so a sensor that is down reads
     * {@code hardware: true, enrolled: false}. {@code enrolled: false} proves
     * nothing alone; beside {@code screenLock: false} it does, since Android
     * keeps no biometric on a phone without a screen lock. Rejects {@code failed}
     * rather than guess when a reading cannot be made.
     */
    @PluginMethod
    public void lockStatus(PluginCall call) {
        try {
            KeyguardManager keyguard = getContext().getSystemService(KeyguardManager.class);
            if (keyguard == null) {
                fail(call, FAILED, "this phone gave no keyguard service to read", null);
                return;
            }
            int can = biometricManager().canAuthenticate(LOCK_BIOMETRIC);
            JSObject ret = new JSObject();
            ret.put("hardware", sensorExists(can, sensorDeclared()));
            ret.put("enrolled", can == BiometricManager.BIOMETRIC_SUCCESS);
            // Not canAuthenticate(DEVICE_CREDENTIAL): below API 30 the library
            // answers UNSUPPORTED for that alone, whatever the phone has.
            ret.put("screenLock", keyguard.isDeviceSecure());
            call.resolve(ret);
        } catch (RuntimeException e) {
            fail(call, FAILED, "could not read the lock state: " + e.getMessage(), e);
        }
    }

    // ── Making the key ───────────────────────────────────────────────────

    @PluginMethod
    public void generate(PluginCall call) {
        String alias = alias(call);
        if (alias == null) return;
        String asked = call.getString("auth");
        String auth = authFor(asked);
        if (auth == null) {
            fail(call, BAD_INPUT, "auth is \"biometric\" or \"any\", not " + asked, null);
            return;
        }
        boolean any = AUTH_ANY.equals(auth);
        if (!(any ? lockReadyOrReject(call) : readyOrReject(call))) return;
        boolean wantStrongBox = call.getBoolean("strongBox", true);
        boolean replace = call.getBoolean("replace", false);
        try {
            KeyStore ks = keyStore();
            if (ks.containsAlias(alias)) {
                if (!replace) {
                    fail(call, EXISTS, "a key named " + alias + " already exists; pass replace:true to overwrite it", null);
                    return;
                }
                ks.deleteEntry(alias);
            }
            // Between the delete and the new key: a crash on either side of this
            // line leaves no key, or a key the map describes, never one it misreads.
            if (!rememberKind(alias, auth)) {
                fail(call, FAILED, "could not record which kind of key " + alias + " is", null);
                return;
            }
            boolean useStrongBox = wantStrongBox && strongBoxPresent();
            if (useStrongBox) {
                try {
                    makeKey(alias, true, any);
                } catch (StrongBoxUnavailableException e) {
                    // Advertised but not usable for this key spec: the TEE is
                    // still hardware-backed, so fall back rather than refuse.
                    Log.i(TAG, "StrongBox unavailable, using the TEE: " + e);
                    useStrongBox = false;
                    makeKey(alias, false, any);
                }
            } else {
                makeKey(alias, false, any);
            }
            JSObject ret = new JSObject();
            ret.put("strongBox", useStrongBox);
            if (asked != null) ret.put("auth", auth);
            call.resolve(ret);
        } catch (IllegalStateException e) {
            // "At least one biometric must be enrolled" arrives as this, and
            // "Secure lock screen must be enabled" for the any key.
            fail(call, NONE_ENROLLED, (any ? "this phone has no screen lock: " : "no strong biometric is enrolled: ")
                    + e.getMessage(), e);
        } catch (Exception e) {
            fail(call, FAILED, "could not generate the key: " + e.getMessage(), e);
        }
    }

    private static void makeKey(String alias, boolean strongBox, boolean any) throws Exception {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(
                alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true);
        if (any) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                b.setUserAuthenticationParameters(ANY_KEY_SECONDS,
                        KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
            } else {
                setTimeoutLegacy(b);
            }
        } else {
            b.setInvalidatedByBiometricEnrollment(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
            } else {
                setPerUseLegacy(b);
            }
        }
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            b.setIsStrongBoxBacked(true);
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        kg.init(b.build());
        kg.generateKey();
    }

    @SuppressWarnings("deprecation")
    private static void setPerUseLegacy(KeyGenParameterSpec.Builder b) {
        b.setUserAuthenticationValidityDurationSeconds(-1);
    }

    @SuppressWarnings("deprecation")
    private static void setTimeoutLegacy(KeyGenParameterSpec.Builder b) {
        b.setUserAuthenticationValidityDurationSeconds(ANY_KEY_SECONDS);
    }

    // ── Using the key ────────────────────────────────────────────────────

    @PluginMethod
    public void wrap(PluginCall call) {
        String alias = alias(call);
        if (alias == null) return;
        byte[] data = b64(call, "dataB64", true);
        if (data == null) return;
        byte[] aad = b64(call, "aadB64", false);
        if (aad == null) { zero(data); return; }
        if (isAnyKey(alias)) {
            promptThenCipher(call, alias, Cipher.ENCRYPT_MODE, null,
                    open -> sealed(call, open, open.getIV(), data, aad), () -> zero(data));
            return;
        }
        if (!readyOrReject(call)) { zero(data); return; }
        Cipher cipher;
        try {
            SecretKey key = secretKey(call, alias);
            if (key == null) { zero(data); return; }
            cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key);
        } catch (KeyPermanentlyInvalidatedException e) {
            zero(data);
            fail(call, KEY_INVALIDATED, "the key was invalidated by a biometric enrolment change", e);
            return;
        } catch (Exception e) {
            zero(data);
            failKey(call, "could not prepare the cipher: ", e);
            return;
        }
        final byte[] nonce = cipher.getIV();
        prompt(call, cipher, unlocked -> sealed(call, unlocked, nonce, data, aad), () -> zero(data));
    }

    private static void sealed(PluginCall call, Cipher open, byte[] nonce, byte[] data, byte[] aad) throws Exception {
        try {
            if (aad.length > 0) open.updateAAD(aad);
            byte[] ct = open.doFinal(data);
            JSObject ret = new JSObject();
            ret.put("ctB64", Base64.encodeToString(ct, Base64.NO_WRAP));
            ret.put("nonceB64", Base64.encodeToString(nonce, Base64.NO_WRAP));
            call.resolve(ret);
        } finally {
            zero(data);
        }
    }

    @PluginMethod
    public void unwrap(PluginCall call) {
        String alias = alias(call);
        if (alias == null) return;
        byte[] ct = b64(call, "ctB64", true);
        if (ct == null) return;
        byte[] nonce = b64(call, "nonceB64", true);
        if (nonce == null) return;
        byte[] aad = b64(call, "aadB64", false);
        if (aad == null) return;
        if (isAnyKey(alias)) {
            promptThenCipher(call, alias, Cipher.DECRYPT_MODE, nonce, open -> opened(call, open, ct, aad), null);
            return;
        }
        if (!readyOrReject(call)) return;
        Cipher cipher;
        try {
            SecretKey key = secretKey(call, alias);
            if (key == null) return;
            cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
        } catch (KeyPermanentlyInvalidatedException e) {
            fail(call, KEY_INVALIDATED, "the key was invalidated by a biometric enrolment change", e);
            return;
        } catch (java.security.InvalidAlgorithmParameterException e) {
            fail(call, BAD_INPUT, "the nonce is not one this key accepts: " + e.getMessage(), e);
            return;
        } catch (Exception e) {
            failKey(call, "could not prepare the cipher: ", e);
            return;
        }
        prompt(call, cipher, unlocked -> opened(call, unlocked, ct, aad), null);
    }

    private static void opened(PluginCall call, Cipher open, byte[] ct, byte[] aad) throws Exception {
        byte[] plain = null;
        try {
            if (aad.length > 0) open.updateAAD(aad);
            plain = open.doFinal(ct);
            JSObject ret = new JSObject();
            ret.put("dataB64", Base64.encodeToString(plain, Base64.NO_WRAP));
            call.resolve(ret);
        } finally {
            zero(plain);
        }
    }

    /** Is the owner here? No key, no bytes: see the class comment. */
    @PluginMethod
    public void authenticate(PluginCall call) {
        boolean allowCredential = call.getBoolean("allowCredential", true);
        showPrompt(call, authenticatorsFor(allowCredential), null, result -> {
            JSObject ret = new JSObject();
            ret.put("method", methodFor(result.getAuthenticationType()));
            call.resolve(ret);
        }, null);
    }

    // ── The prompt ───────────────────────────────────────────────────────

    private interface Unlocked {
        void run(Cipher cipher) throws Exception;
    }

    private interface Passed {
        void run(BiometricPrompt.AuthenticationResult result) throws Exception;
    }

    /**
     * Show the system's biometric sheet for {@code cipher}, and on success run
     * {@code then} with the unlocked Cipher. Every terminal outcome settles
     * {@code call} exactly once; {@code cleanup} runs on every outcome that does
     * not reach {@code then} (which cleans up after itself).
     */
    private void prompt(PluginCall call, Cipher cipher, Unlocked then, @Nullable Runnable cleanup) {
        showPrompt(call, AUTHENTICATORS, new BiometricPrompt.CryptoObject(cipher), result -> {
            BiometricPrompt.CryptoObject co = result.getCryptoObject();
            Cipher unlocked = co != null ? co.getCipher() : null;
            if (unlocked == null) {
                if (cleanup != null) cleanup.run();
                fail(call, FAILED, "the prompt returned no cipher", null);
                return;
            }
            then.run(unlocked);
        }, cleanup);
    }

    /**
     * The {@code any} key's flow: refuse what can be refused before anyone is
     * asked, show the sheet with no CryptoObject, then make a fresh Cipher and
     * run {@code then} with it. Same settling promise as {@link #prompt}.
     *
     * The trial Cipher only asks the Keystore about the key. It normally throws
     * UserNotAuthenticatedException, which is the good answer; a phone unlocked
     * seconds ago lets it through, and the sheet is shown all the same.
     */
    private void promptThenCipher(PluginCall call, String alias, int mode, @Nullable byte[] nonce,
                                  Unlocked then, @Nullable Runnable cleanup) {
        if (!lockReadyOrReject(call)) {
            if (cleanup != null) cleanup.run();
            return;
        }
        try {
            SecretKey key = secretKey(call, alias);
            if (key == null) {
                if (cleanup != null) cleanup.run();
                return;
            }
            cipherFor(key, mode, nonce);
        } catch (UserNotAuthenticatedException e) {
            // The good answer: go on to the sheet.
        } catch (KeyPermanentlyInvalidatedException e) {
            if (cleanup != null) cleanup.run();
            fail(call, KEY_INVALIDATED, "the key was invalidated by a screen lock change", e);
            return;
        } catch (java.security.InvalidAlgorithmParameterException e) {
            if (cleanup != null) cleanup.run();
            fail(call, BAD_INPUT, "the nonce is not one this key accepts: " + e.getMessage(), e);
            return;
        } catch (Exception e) {
            if (cleanup != null) cleanup.run();
            failKey(call, "could not prepare the cipher: ", e);
            return;
        }
        showPrompt(call, keyAuthenticatorsFor(Build.VERSION.SDK_INT), null, result -> {
            Cipher open;
            try {
                SecretKey fresh = secretKey(call, alias);
                if (fresh == null) {
                    if (cleanup != null) cleanup.run();
                    return;
                }
                open = cipherFor(fresh, mode, nonce);
            } catch (UserNotAuthenticatedException e) {
                if (cleanup != null) cleanup.run();
                fail(call, FAILED, USE_THE_PIN, e);
                return;
            } catch (Exception e) {
                if (cleanup != null) cleanup.run();
                throw e;
            }
            then.run(open);
        }, cleanup);
    }

    private static Cipher cipherFor(SecretKey key, int mode, @Nullable byte[] nonce) throws Exception {
        Cipher c = Cipher.getInstance(TRANSFORM);
        if (nonce == null) c.init(mode, key);
        else c.init(mode, key, new GCMParameterSpec(TAG_BITS, nonce));
        return c;
    }

    /**
     * The one sheet every kind of check goes through, and so the one busy latch
     * and the one error mapping. {@code crypto} is null for a check that has no
     * Cipher to hand over. Same settling promise as {@link #prompt}.
     */
    private void showPrompt(PluginCall call, int authenticators, @Nullable BiometricPrompt.CryptoObject crypto,
                            Passed then, @Nullable Runnable cleanup) {
        FragmentActivity activity = getActivity();
        if (activity == null) {
            if (cleanup != null) cleanup.run();
            fail(call, FAILED, "no activity to show the prompt in", null);
            return;
        }
        synchronized (this) {
            if (prompting) {
                if (cleanup != null) cleanup.run();
                fail(call, BUSY, "another fingerprint prompt is already showing", null);
                return;
            }
            prompting = true;
        }
        String title = nonEmpty(call.getString("title"), "Confirm it's you");
        String subtitle = call.getString("subtitle");
        String description = call.getString("description");
        activity.runOnUiThread(() -> {
            try {
                BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle(title)
                        .setAllowedAuthenticators(authenticators);
                // build() throws if the two disagree: the credential screen brings its own way out.
                if (needsNegativeButton(authenticators)) info.setNegativeButtonText("Cancel");
                if (subtitle != null && !subtitle.isEmpty()) info.setSubtitle(subtitle);
                if (description != null && !description.isEmpty()) info.setDescription(description);
                BiometricPrompt bp = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
                        new BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                                prompting = false;
                                try {
                                    then.run(result);
                                } catch (AEADBadTagException e) {
                                    fail(call, BAD_INPUT, "the ciphertext, nonce or aad does not authenticate under this key", e);
                                } catch (KeyPermanentlyInvalidatedException e) {
                                    fail(call, KEY_INVALIDATED, "the key was invalidated by a biometric enrolment change", e);
                                } catch (Exception e) {
                                    failKey(call, "the operation failed: ", e);
                                }
                            }

                            @Override
                            public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                                prompting = false;
                                if (cleanup != null) cleanup.run();
                                fail(call, codeForPromptError(errorCode), String.valueOf(errString), null);
                            }

                            // onAuthenticationFailed (a finger that did not match)
                            // is not terminal: the sheet stays up for another try.
                        });
                if (crypto != null) bp.authenticate(info.build(), crypto);
                else bp.authenticate(info.build());
            } catch (RuntimeException e) {
                prompting = false;
                if (cleanup != null) cleanup.run();
                fail(call, FAILED, "could not show the prompt: " + e.getMessage(), e);
            }
        });
    }

    static String codeForPromptError(int errorCode) {
        switch (errorCode) {
            case BiometricPrompt.ERROR_LOCKOUT:
            case BiometricPrompt.ERROR_LOCKOUT_PERMANENT:
                return LOCKOUT;
            case BiometricPrompt.ERROR_USER_CANCELED:
            case BiometricPrompt.ERROR_NEGATIVE_BUTTON:
            case BiometricPrompt.ERROR_CANCELED:
            case BiometricPrompt.ERROR_TIMEOUT:
                return CANCELLED;
            case BiometricPrompt.ERROR_HW_NOT_PRESENT:
            case BiometricPrompt.ERROR_HW_UNAVAILABLE:
                return NO_HARDWARE;
            case BiometricPrompt.ERROR_NO_BIOMETRICS:
            case BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL:
                return NONE_ENROLLED;
            default:
                return FAILED;
        }
    }

    /**
     * The word for an exception no narrower catch took: {@code keyInvalidated} or
     * {@code noKey} when something in its cause chain says the key is dead, else
     * {@code failed}. The chain is read because the platform wraps: getKey turns an
     * invalidated key into an UnrecoverableKeyException, and an OEM's Cipher.init can
     * leave it as an InvalidKeyException around a KeyStoreException.
     *
     * UnrecoverableKeyException alone proves nothing: it is also what getKey throws
     * for every other Keystore error, a system error included. A caller may drop the
     * app lock and the sign-ins on these two words, so whatever cannot be named here
     * stays {@code failed}, where the caller keeps the key and can try again.
     */
    static String codeForKeyFailure(Throwable e) {
        Throwable t = e;
        for (int depth = 0; t != null && depth < 8; depth++, t = t.getCause()) {
            if (t instanceof KeyPermanentlyInvalidatedException) return KEY_INVALIDATED;
            String word = codeForKeystoreMessage(t.getMessage());
            if (word != null) return word;
            // Public from 33, and one number for both a missing and an invalidated key.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && t instanceof android.security.KeyStoreException
                    && ((android.security.KeyStoreException) t).getNumericErrorCode()
                            == android.security.KeyStoreException.ERROR_KEY_DOES_NOT_EXIST) {
                return NO_KEY;
            }
        }
        return FAILED;
    }

    /** The word one of the platform's own dead-key messages stands for, or null. */
    @Nullable
    static String codeForKeystoreMessage(@Nullable String message) {
        if (message == null) return null;
        if (message.equals(AUTH_CHANGED_WORDS) || message.startsWith(INVALIDATED_WORDS)) return KEY_INVALIDATED;
        if (message.startsWith(NOT_FOUND_WORDS)) return NO_KEY;
        return null;
    }

    /** No CryptoObject, so WEAK is enough; see the class comment. */
    static int authenticatorsFor(boolean allowCredential) {
        return allowCredential ? LOCK_BIOMETRIC | BiometricManager.Authenticators.DEVICE_CREDENTIAL : LOCK_BIOMETRIC;
    }

    /**
     * The sheet for an {@code any} key. STRONG from API 30, because the key takes
     * nothing weaker and a WEAK face would pass the sheet and then be refused.
     * Below it WEAK, because BIOMETRIC_STRONG|DEVICE_CREDENTIAL does not exist on
     * API 28-29 ({@link #USE_THE_PIN} is the cost).
     */
    static int keyAuthenticatorsFor(int sdk) {
        return sdk >= Build.VERSION_CODES.R
                ? BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL
                : LOCK_BIOMETRIC | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    }

    /** The key {@code generate} was asked for; null for a word it does not know. Absent is today's key. */
    @Nullable
    static String authFor(@Nullable String asked) {
        if (asked == null || AUTH_BIOMETRIC.equals(asked)) return AUTH_BIOMETRIC;
        return AUTH_ANY.equals(asked) ? AUTH_ANY : null;
    }

    /** PromptInfo requires a negative button without DEVICE_CREDENTIAL and forbids one with it. */
    static boolean needsNegativeButton(int authenticators) {
        return (authenticators & BiometricManager.Authenticators.DEVICE_CREDENTIAL) == 0;
    }

    static String methodFor(int authenticationType) {
        switch (authenticationType) {
            case BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC:
                return METHOD_BIOMETRIC;
            case BiometricPrompt.AUTHENTICATION_RESULT_TYPE_DEVICE_CREDENTIAL:
                return METHOD_CREDENTIAL;
            default:
                return METHOD_UNKNOWN;
        }
    }

    /**
     * Only NO_HARDWARE says a sensor is absent; HW_UNAVAILABLE and the rest say
     * it is down right now. And NO_HARDWARE alone is not enough: below API 29 it
     * is what the library reports when FingerprintManager stops seeing its
     * sensor, so a sensor the phone declares as a feature still counts. Unlike
     * {@link #hasHardware}, which answers "can a key be made now?".
     */
    static boolean sensorExists(int can, boolean sensorDeclared) {
        return can != BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE || sensorDeclared;
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private BiometricManager biometricManager() {
        return BiometricManager.from(getContext());
    }

    private static boolean hasHardware(int can) {
        return can != BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE
                && can != BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE
                && can != BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED
                && can != BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED;
    }

    /** Rejects with noHardware / noneEnrolled unless a strong biometric can be used now. */
    private boolean readyOrReject(PluginCall call) {
        int can = biometricManager().canAuthenticate(AUTHENTICATORS);
        if (can == BiometricManager.BIOMETRIC_SUCCESS) return true;
        if (!hasHardware(can)) {
            fail(call, NO_HARDWARE, "this phone has no usable strong biometric (" + can + ")", null);
        } else if (can == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) {
            fail(call, NONE_ENROLLED, "no strong biometric is enrolled", null);
        } else {
            fail(call, FAILED, "biometrics cannot be used right now (" + can + ")", null);
        }
        return false;
    }

    /** The {@code any} key's {@link #readyOrReject}: a screen lock is all it needs. */
    private boolean lockReadyOrReject(PluginCall call) {
        KeyguardManager keyguard = getContext().getSystemService(KeyguardManager.class);
        if (keyguard == null) {
            fail(call, FAILED, "this phone gave no keyguard service to read", null);
            return false;
        }
        if (keyguard.isDeviceSecure()) return true;
        fail(call, NONE_ENROLLED, "this phone has no screen lock", null);
        return false;
    }

    private SharedPreferences kinds() {
        return getContext().getSharedPreferences(KINDS, Context.MODE_PRIVATE);
    }

    private boolean isAnyKey(String alias) {
        return AUTH_ANY.equals(kinds().getString(alias, null));
    }

    /** Only {@code any} aliases are kept, so today's key writes nothing unless it replaces one. */
    private boolean rememberKind(String alias, String auth) {
        SharedPreferences kinds = kinds();
        if (AUTH_ANY.equals(auth)) return kinds.edit().putString(alias, AUTH_ANY).commit();
        return !kinds.contains(alias) || kinds.edit().remove(alias).commit();
    }

    private boolean sensorDeclared() {
        PackageManager pm = getContext().getPackageManager();
        if (pm.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)) return true;
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && (pm.hasSystemFeature(PackageManager.FEATURE_FACE) || pm.hasSystemFeature(PackageManager.FEATURE_IRIS));
    }

    private boolean strongBoxPresent() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE);
    }

    private static KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        return ks;
    }

    /** The key, or null after rejecting with noKey. */
    @Nullable
    private SecretKey secretKey(PluginCall call, String alias) throws Exception {
        Key k = keyStore().getKey(alias, null);
        if (!(k instanceof SecretKey)) {
            fail(call, NO_KEY, "no key named " + alias, null);
            return null;
        }
        return (SecretKey) k;
    }

    /** The alias, or null after rejecting with badInput. */
    @Nullable
    private String alias(PluginCall call) {
        String a = call.getString("alias");
        if (a == null || a.trim().isEmpty()) {
            fail(call, BAD_INPUT, "alias is required", null);
            return null;
        }
        return a;
    }

    /**
     * Decoded base64 field. Missing + optional ⇒ an empty array; missing +
     * required, or not base64 ⇒ null after rejecting with badInput.
     */
    @Nullable
    private byte[] b64(PluginCall call, String field, boolean required) {
        String s = call.getString(field);
        if (s == null || s.isEmpty()) {
            if (!required) return new byte[0];
            fail(call, BAD_INPUT, field + " is required", null);
            return null;
        }
        try {
            return Base64.decode(s, Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            fail(call, BAD_INPUT, field + " is not base64", null);
            return null;
        }
    }

    private static String nonEmpty(@Nullable String s, String fallback) {
        return s == null || s.isEmpty() ? fallback : s;
    }

    private static void zero(@Nullable byte[] b) {
        if (b != null) Arrays.fill(b, (byte) 0);
    }

    /** A catch-all's refusal: {@link #codeForKeyFailure}'s word, with {@code doing} when it is {@code failed}. */
    private static void failKey(PluginCall call, String doing, Exception e) {
        String code = codeForKeyFailure(e);
        fail(call, code, (FAILED.equals(code) ? doing : "the keystore says this key is gone: ") + e.getMessage(), e);
    }

    private static void fail(PluginCall call, String code, String message, @Nullable Exception e) {
        if (e != null) Log.w(TAG, code + ": " + message, e);
        call.reject(message, code, e);
    }
}
