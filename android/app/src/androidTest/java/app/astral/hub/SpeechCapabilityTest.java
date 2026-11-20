package app.astral.hub;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import android.Manifest;
import android.content.pm.PackageManager;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.Arrays;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SpeechCapabilityTest {
    @Test public void nativeSpeechIsRegisteredWithoutStartingMicrophoneOnLaunch() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            SystemClock.sleep(800);
            scenario.onActivity(activity -> {
                com.getcapacitor.PluginHandle plugin = activity.getBridge().getPlugin("AstralSpeech");
                assertNotNull("Native speech bridge was not registered", plugin);
                try {
                    String[] permissions = activity.getPackageManager().getPackageInfo(activity.getPackageName(), PackageManager.GET_PERMISSIONS).requestedPermissions;
                    assertTrue("Microphone permission is missing from manifest", Arrays.asList(permissions).contains(Manifest.permission.RECORD_AUDIO));
                } catch (PackageManager.NameNotFoundException e) { throw new AssertionError(e); }
                assertTrue("Launching the feature must not activate microphone or request permission", !((SpeechInputPlugin) plugin.getInstance()).isCapturing());
            });
        }
    }
}
