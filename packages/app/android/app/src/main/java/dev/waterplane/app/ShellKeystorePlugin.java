package dev.waterplane.app;

import android.content.pm.PackageManager;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
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
 * A key on this phone that only a fingerprint can use — generic, with no idea
 * what the bytes it wraps are for.
 *
 * <pre>
 *   Capacitor.Plugins.ShellKeystore
 *     .status()                                      → {hardware, enrolled, strongBox}
 *     .has({alias})                                  → {exists}
 *     .generate({alias, strongBox?, replace?})       → {strongBox}
 *     .wrap({alias, dataB64, aadB64?, title?, subtitle?, description?})          → {ctB64, nonceB64}
 *     .unwrap({alias, ctB64, nonceB64, aadB64?, title?, subtitle?, description?}) → {dataB64}
 *     .remove({alias})                               → {}
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
 * device-credential fallback: a PIN is not a biometric, and a key bound to
 * BIOMETRIC_STRONG would refuse it anyway.
 *
 * <b>Refusals are words</b>, in the rejection's {@code code}:
 * {@code noHardware}, {@code noneEnrolled}, {@code keyInvalidated}, {@code noKey},
 * {@code exists}, {@code cancelled}, {@code lockout}, {@code busy},
 * {@code badInput}, {@code failed}. The page words them; nothing here decides
 * what a refusal means for the caller.
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
            call.resolve();
        } catch (Exception e) {
            fail(call, FAILED, "could not remove the key: " + e.getMessage(), e);
        }
    }

    // ── Making the key ───────────────────────────────────────────────────

    @PluginMethod
    public void generate(PluginCall call) {
        String alias = alias(call);
        if (alias == null) return;
        if (!readyOrReject(call)) return;
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
            boolean useStrongBox = wantStrongBox && strongBoxPresent();
            if (useStrongBox) {
                try {
                    makeKey(alias, true);
                } catch (StrongBoxUnavailableException e) {
                    // Advertised but not usable for this key spec: the TEE is
                    // still hardware-backed, so fall back rather than refuse.
                    Log.i(TAG, "StrongBox unavailable, using the TEE: " + e);
                    useStrongBox = false;
                    makeKey(alias, false);
                }
            } else {
                makeKey(alias, false);
            }
            JSObject ret = new JSObject();
            ret.put("strongBox", useStrongBox);
            call.resolve(ret);
        } catch (IllegalStateException e) {
            // "At least one biometric must be enrolled" arrives as this.
            fail(call, NONE_ENROLLED, "no strong biometric is enrolled: " + e.getMessage(), e);
        } catch (Exception e) {
            fail(call, FAILED, "could not generate the key: " + e.getMessage(), e);
        }
    }

    private static void makeKey(String alias, boolean strongBox) throws Exception {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(
                alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        } else {
            setPerUseLegacy(b);
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

    // ── Using the key ────────────────────────────────────────────────────

    @PluginMethod
    public void wrap(PluginCall call) {
        String alias = alias(call);
        if (alias == null) return;
        byte[] data = b64(call, "dataB64", true);
        if (data == null) return;
        byte[] aad = b64(call, "aadB64", false);
        if (aad == null) { zero(data); return; }
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
            fail(call, FAILED, "could not prepare the cipher: " + e.getMessage(), e);
            return;
        }
        final byte[] nonce = cipher.getIV();
        prompt(call, cipher, unlocked -> {
            try {
                if (aad.length > 0) unlocked.updateAAD(aad);
                byte[] ct = unlocked.doFinal(data);
                JSObject ret = new JSObject();
                ret.put("ctB64", Base64.encodeToString(ct, Base64.NO_WRAP));
                ret.put("nonceB64", Base64.encodeToString(nonce, Base64.NO_WRAP));
                call.resolve(ret);
            } finally {
                zero(data);
            }
        }, () -> zero(data));
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
            fail(call, FAILED, "could not prepare the cipher: " + e.getMessage(), e);
            return;
        }
        prompt(call, cipher, unlocked -> {
            byte[] plain = null;
            try {
                if (aad.length > 0) unlocked.updateAAD(aad);
                plain = unlocked.doFinal(ct);
                JSObject ret = new JSObject();
                ret.put("dataB64", Base64.encodeToString(plain, Base64.NO_WRAP));
                call.resolve(ret);
            } finally {
                zero(plain);
            }
        }, null);
    }

    // ── The prompt ───────────────────────────────────────────────────────

    private interface Unlocked {
        void run(Cipher cipher) throws Exception;
    }

    /**
     * Show the system's biometric sheet for {@code cipher}, and on success run
     * {@code then} with the unlocked Cipher. Every terminal outcome settles
     * {@code call} exactly once; {@code cleanup} runs on every outcome that does
     * not reach {@code then} (which cleans up after itself).
     */
    private void prompt(PluginCall call, Cipher cipher, Unlocked then, @Nullable Runnable cleanup) {
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
                        .setNegativeButtonText("Cancel")
                        .setAllowedAuthenticators(AUTHENTICATORS);
                if (subtitle != null && !subtitle.isEmpty()) info.setSubtitle(subtitle);
                if (description != null && !description.isEmpty()) info.setDescription(description);
                BiometricPrompt bp = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
                        new BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                                prompting = false;
                                BiometricPrompt.CryptoObject co = result.getCryptoObject();
                                Cipher unlocked = co != null ? co.getCipher() : null;
                                if (unlocked == null) {
                                    if (cleanup != null) cleanup.run();
                                    fail(call, FAILED, "the prompt returned no cipher", null);
                                    return;
                                }
                                try {
                                    then.run(unlocked);
                                } catch (AEADBadTagException e) {
                                    fail(call, BAD_INPUT, "the ciphertext, nonce or aad does not authenticate under this key", e);
                                } catch (KeyPermanentlyInvalidatedException e) {
                                    fail(call, KEY_INVALIDATED, "the key was invalidated by a biometric enrolment change", e);
                                } catch (Exception e) {
                                    fail(call, FAILED, "the operation failed: " + e.getMessage(), e);
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
                bp.authenticate(info.build(), new BiometricPrompt.CryptoObject(cipher));
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
                return NONE_ENROLLED;
            default:
                return FAILED;
        }
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

    private static void fail(PluginCall call, String code, String message, @Nullable Exception e) {
        if (e != null) Log.w(TAG, code + ": " + message, e);
        call.reject(message, code, e);
    }
}
