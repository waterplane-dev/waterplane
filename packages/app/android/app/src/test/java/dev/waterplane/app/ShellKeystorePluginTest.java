package dev.waterplane.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricManager.Authenticators;
import androidx.biometric.BiometricPrompt;

import org.junit.Test;

import java.security.InvalidKeyException;
import java.security.UnrecoverableKeyException;

/** The static rules of {@link ShellKeystorePlugin}, on the JVM. The sheet itself needs a device. */
public class ShellKeystorePluginTest {

    @Test
    public void theCheckIsWeakBiometricWithTheCredentialUnlessTurnedOff() {
        assertEquals(Authenticators.BIOMETRIC_WEAK | Authenticators.DEVICE_CREDENTIAL,
                ShellKeystorePlugin.authenticatorsFor(true));
        assertEquals(Authenticators.BIOMETRIC_WEAK, ShellKeystorePlugin.authenticatorsFor(false));
    }

    @Test
    public void aNegativeButtonOnlyWithoutTheCredential() {
        assertFalse(ShellKeystorePlugin.needsNegativeButton(ShellKeystorePlugin.authenticatorsFor(true)));
        assertTrue(ShellKeystorePlugin.needsNegativeButton(ShellKeystorePlugin.authenticatorsFor(false)));
        assertTrue(ShellKeystorePlugin.needsNegativeButton(Authenticators.BIOMETRIC_STRONG));
    }

    @Test
    public void everyPromptErrorKeepsItsWord() {
        assertWord(ShellKeystorePlugin.LOCKOUT, BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT);
        assertWord(ShellKeystorePlugin.CANCELLED, BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_TIMEOUT);
        assertWord(ShellKeystorePlugin.NO_HARDWARE, BiometricPrompt.ERROR_HW_NOT_PRESENT, BiometricPrompt.ERROR_HW_UNAVAILABLE);
        assertWord(ShellKeystorePlugin.NONE_ENROLLED, BiometricPrompt.ERROR_NO_BIOMETRICS);
        assertWord(ShellKeystorePlugin.FAILED, BiometricPrompt.ERROR_UNABLE_TO_PROCESS, BiometricPrompt.ERROR_NO_SPACE,
                BiometricPrompt.ERROR_VENDOR, BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED, 9999);
    }

    /** A phone whose screen lock went away must not read as `failed`, which never opens the app lock. */
    @Test
    public void noCredentialOnThePhoneIsNoneEnrolled() {
        assertWord(ShellKeystorePlugin.NONE_ENROLLED, BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL);
    }

    @Test
    public void aSensorThatIsDownStillExists() {
        assertTrue(ShellKeystorePlugin.sensorExists(BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE, false));
        assertTrue(ShellKeystorePlugin.sensorExists(BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED, false));
        assertTrue(ShellKeystorePlugin.sensorExists(BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED, false));
        assertTrue(ShellKeystorePlugin.sensorExists(BiometricManager.BIOMETRIC_STATUS_UNKNOWN, false));
        assertTrue(ShellKeystorePlugin.sensorExists(BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED, false));
        assertTrue(ShellKeystorePlugin.sensorExists(BiometricManager.BIOMETRIC_SUCCESS, false));
    }

    @Test
    public void noHardwareOnlyCountsWhenThePhoneDeclaresNoSensor() {
        assertFalse(ShellKeystorePlugin.sensorExists(BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE, false));
        assertTrue(ShellKeystorePlugin.sensorExists(BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE, true));
    }

    @Test
    public void theMethodNamesWhatPassed() {
        assertEquals("biometric", ShellKeystorePlugin.methodFor(BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC));
        assertEquals("credential", ShellKeystorePlugin.methodFor(BiometricPrompt.AUTHENTICATION_RESULT_TYPE_DEVICE_CREDENTIAL));
        assertEquals("unknown", ShellKeystorePlugin.methodFor(BiometricPrompt.AUTHENTICATION_RESULT_TYPE_UNKNOWN));
    }

    /** Nothing sent means today's key: the vault never sends the word. */
    @Test
    public void noAuthWordIsTodaysKey() {
        assertEquals("biometric", ShellKeystorePlugin.authFor(null));
        assertEquals("biometric", ShellKeystorePlugin.authFor("biometric"));
        assertEquals("any", ShellKeystorePlugin.authFor("any"));
    }

    /** A word it does not know must not make a weaker key than the caller meant. */
    @Test
    public void anUnknownAuthWordIsRefused() {
        assertNull(ShellKeystorePlugin.authFor("pin"));
        assertNull(ShellKeystorePlugin.authFor(""));
        assertNull(ShellKeystorePlugin.authFor("ANY"));
    }

    /** Android rejects a timeout of 0 with the credential; see the class comment. */
    @Test
    public void theAnyKeyHasARealTimeout() {
        assertEquals(10, ShellKeystorePlugin.ANY_KEY_SECONDS);
    }

    /** From 30 the key refuses WEAK, so the sheet must not offer it; below 30 STRONG|CREDENTIAL does not exist. */
    @Test
    public void theAnyKeySheetIsStrongFromApi30AndTheLocksOneBelow() {
        int strong = Authenticators.BIOMETRIC_STRONG | Authenticators.DEVICE_CREDENTIAL;
        assertEquals(strong, ShellKeystorePlugin.keyAuthenticatorsFor(30));
        assertEquals(strong, ShellKeystorePlugin.keyAuthenticatorsFor(36));
        for (int sdk : new int[] {24, 27, 28, 29}) {
            assertEquals(ShellKeystorePlugin.authenticatorsFor(true), ShellKeystorePlugin.keyAuthenticatorsFor(sdk));
        }
    }

    @Test
    public void theAnyKeySheetBringsItsOwnWayOut() {
        assertFalse(ShellKeystorePlugin.needsNegativeButton(ShellKeystorePlugin.keyAuthenticatorsFor(30)));
        assertFalse(ShellKeystorePlugin.needsNegativeButton(ShellKeystorePlugin.keyAuthenticatorsFor(29)));
    }

    /** The exact shape getKey leaves of an invalidated key: its message and no cause. */
    @Test
    public void getKeysInvalidatedShapeIsKeyInvalidated() {
        assertEquals(ShellKeystorePlugin.KEY_INVALIDATED, ShellKeystorePlugin.codeForKeyFailure(
                new UnrecoverableKeyException("User changed or deleted their auth credentials")));
    }

    /** The cause carries the Keystore's message, with the suffix it adds on newer platforms. */
    @Test
    public void aWrappedKeystoreMessageNamesTheDeadKey() {
        assertEquals(ShellKeystorePlugin.KEY_INVALIDATED, ShellKeystorePlugin.codeForKeyFailure(
                wrapped("Key permanently invalidated (internal Keystore code: 17 message: gone)")));
        assertEquals(ShellKeystorePlugin.KEY_INVALIDATED, ShellKeystorePlugin.codeForKeyFailure(
                wrapped("Key permanently invalidated")));
        assertEquals(ShellKeystorePlugin.NO_KEY, ShellKeystorePlugin.codeForKeyFailure(
                wrapped("Key not found (internal Keystore code: 7 message: gone)")));
    }

    /** `keyInvalidated` can drop the app lock and the sign-ins, so a fault that may pass must not read as it. */
    @Test
    public void aKeystoreFaultThatNamesNoDeadKeyStaysFailed() {
        for (String cause : new String[] {
                "System error", "Key blob corrupted", "Key user not authenticated",
                "User authentication required", "Keystore not initialized", "Permission denied"}) {
            assertEquals(cause, ShellKeystorePlugin.FAILED, ShellKeystorePlugin.codeForKeyFailure(wrapped(cause)));
            assertEquals(cause, ShellKeystorePlugin.FAILED, ShellKeystorePlugin.codeForKeyFailure(
                    new UnrecoverableKeyException("Failed to obtain information about key").initCause(new Exception(cause))));
        }
        assertEquals(ShellKeystorePlugin.FAILED, ShellKeystorePlugin.codeForKeyFailure(
                new UnrecoverableKeyException("Failed to obtain information about key")));
        assertEquals(ShellKeystorePlugin.FAILED, ShellKeystorePlugin.codeForKeyFailure(new RuntimeException((String) null)));
    }

    /** A cause that points back at itself must end in an answer, not a hang. */
    @Test
    public void aLoopInTheCausesEnds() {
        Exception a = new Exception("a");
        Exception b = new Exception("b", a);
        a.initCause(b);
        assertEquals(ShellKeystorePlugin.FAILED, ShellKeystorePlugin.codeForKeyFailure(a));
    }

    /** The same exception follows a PIN whose seconds ran out, so the sentence must hold after a PIN too. */
    @Test
    public void theRefusalAfterAPassedPromptOffersATryAgain() {
        assertTrue(ShellKeystorePlugin.USE_THE_PIN.endsWith("use the phone's PIN or try again"));
    }

    private static InvalidKeyException wrapped(String keystoreMessage) {
        return new InvalidKeyException("Keystore operation failed", new Exception(keystoreMessage));
    }

    private static void assertWord(String word, int... errors) {
        for (int e : errors) assertEquals("error " + e, word, ShellKeystorePlugin.codeForPromptError(e));
    }
}
