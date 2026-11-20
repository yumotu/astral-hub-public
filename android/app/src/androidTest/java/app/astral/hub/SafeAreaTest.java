package app.astral.hub;

import static org.junit.Assert.assertTrue;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Rect;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.os.SystemClock;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SafeAreaTest {
    @Test public void originalSagePalettePersistsAndColorsNativeBars() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitJavascript(scenario, "!!document.querySelector('.mobile-menu')");
            javascript(scenario, "document.querySelector('.mobile-menu').click();true");
            awaitJavascript(scenario, "!!document.querySelector('.sidebar.open')");
            javascript(scenario, "document.querySelector('.sidebar-bottom > button').click();true");
            awaitJavascript(scenario, "!!document.querySelector('#theme-appearance')");
            try {
                javascript(scenario, "(()=>{const mode=document.querySelector('#theme-appearance');mode.value='light';"
                    + "mode.dispatchEvent(new Event('change',{bubbles:true}));"
                    + "[...document.querySelectorAll('.theme-preset')].find(b=>b.textContent.includes('原版护眼')).click();return true;})()");
                awaitJavascript(scenario, "document.documentElement.dataset.palette==='sage'&&document.documentElement.dataset.theme==='light'");
                long deadline=SystemClock.uptimeMillis()+8000;
                AtomicReference<Boolean> matches=new AtomicReference<>(false);
                while(SystemClock.uptimeMillis()<deadline&&!matches.get()) {
                    scenario.onActivity(a->{View decor=a.getWindow().getDecorView();
                        matches.set(decor.getBackground() instanceof ColorDrawable
                            &&((ColorDrawable)decor.getBackground()).getColor()==Color.parseColor("#fffefb")
                            &&WindowCompat.getInsetsController(a.getWindow(),decor).isAppearanceLightStatusBars());});
                    if(!matches.get())SystemClock.sleep(100);
                }
                assertTrue("Sage palette did not reach the native window",matches.get());
                scenario.onActivity(a->a.getBridge().getWebView().reload());
                awaitJavascript(scenario, "document.documentElement.dataset.palette==='sage'&&document.documentElement.dataset.theme==='light'");
                System.out.println("Astral original sage theme: native color #fffefb, light icons and reload persistence verified");
            } finally {
                javascript(scenario, "localStorage.setItem('astral.palette','blue');localStorage.setItem('astral.appearanceMode','dark');"
                    + "localStorage.setItem('astral.appearance','dark');true");
                scenario.onActivity(a->a.getBridge().getWebView().reload());
                awaitJavascript(scenario, "document.documentElement.dataset.palette==='blue'&&document.documentElement.dataset.theme==='dark'");
            }
        }
    }
    @Test public void webThemeControlsNativeSystemBars() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitJavascript(scenario, "!!document.querySelector('.global-theme-toggle')");
            for (String theme : new String[]{"dark", "light", "dark"}) {
                javascript(scenario, "if(document.documentElement.dataset.theme!=='" + theme
                    + "')document.querySelector('.global-theme-toggle').click();true");
                final boolean dark = theme.equals("dark");
                AtomicReference<Boolean> matches = new AtomicReference<>(false);
                long deadline = SystemClock.uptimeMillis() + 8000;
                while (SystemClock.uptimeMillis() < deadline && !matches.get()) {
                    scenario.onActivity(a -> {
                        View decor = a.getWindow().getDecorView();
                        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(a.getWindow(), decor);
                        matches.set(decor.getBackground() instanceof ColorDrawable
                            && ((ColorDrawable) decor.getBackground()).getColor() == Color.parseColor(dark ? "#17191c" : "#ffffff")
                            && bars.isAppearanceLightStatusBars() == !dark
                            && bars.isAppearanceLightNavigationBars() == !dark);
                    });
                    if (!matches.get()) SystemClock.sleep(100);
                }
                assertTrue("Web theme did not reach native system bars: " + theme, matches.get());
                System.out.println("Astral system-bar theme verified: " + theme);
            }
        }
    }

    @Test public void nativeNotificationBridgeReachesSystemNotificationTray() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(
            context.getPackageName(), Manifest.permission.POST_NOTIFICATIONS);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitJavascript(scenario, "!!window.Capacitor?.Plugins?.LocalNotifications");
            javascript(scenario, "window.__astralNoticeTest='pending';(async()=>{try{"
                + "const p=window.Capacitor.Plugins.LocalNotifications;"
                + "await p.createChannel({id:'astral-tasks',name:'星屿任务通知',importance:4,visibility:0,vibration:true});"
                + "await p.schedule({notifications:[{id:735,title:'星屿通知验收',body:'Synthetic device test',channelId:'astral-tasks',smallIcon:'ic_stat_astral',largeIcon:'ic_notification_astral'}]});"
                + "const deadline=Date.now()+8000;while(Date.now()<deadline){const d=await p.getDeliveredNotifications();"
                + "if(d.notifications.some(n=>n.id===735)){window.__astralNoticeTest='received';return;}await new Promise(r=>setTimeout(r,100));}"
                + "window.__astralNoticeTest='missing after delivery wait';"
                + "}catch(e){window.__astralNoticeTest=String(e);}})();true");
            try { awaitJavascript(scenario, "window.__astralNoticeTest==='received'"); }
            catch (AssertionError e) { throw new AssertionError(e.getMessage()+"; native status="+javascript(scenario,"String(window.__astralNoticeTest)")); }
            NotificationManager manager = (NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
            assertTrue("System channel is disabled", manager.getNotificationChannel("astral-tasks").getImportance() > 0);
            boolean found = false;
            for (android.service.notification.StatusBarNotification n : manager.getActiveNotifications())
                if (n.getId() == 735) { found = true; assertTrue("Notification uses another icon", n.getNotification().getSmallIcon().getResId()==R.drawable.ic_stat_astral); }
            assertTrue("Notification did not reach Android system tray", found);
            manager.cancel(735);
            System.out.println("Astral notification verified: registered JS bridge -> Android system tray");
        }
    }

    private String javascript(ActivityScenario<MainActivity> scenario, String code) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>("");
        scenario.onActivity(a -> a.getBridge().getWebView().evaluateJavascript(code, value -> {
            result.set(value); latch.countDown();
        }));
        assertTrue("WebView JavaScript timed out", latch.await(8, TimeUnit.SECONDS));
        return result.get();
    }

    private void awaitJavascript(ActivityScenario<MainActivity> scenario, String code) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 12000;
        String result = "";
        while (SystemClock.uptimeMillis() < deadline) {
            result = javascript(scenario, code);
            if ("true".equals(result)) return;
            SystemClock.sleep(100);
        }
        assertTrue("WebView condition not met: " + code + " -> " + result, false);
    }

    @Test public void webViewAvoidsSystemBarsInPortraitAndLandscape() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(a -> a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            verifyBounds(scenario, Configuration.ORIENTATION_PORTRAIT);
            scenario.onActivity(a -> a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            verifyBounds(scenario, Configuration.ORIENTATION_LANDSCAPE);
        }
    }

    private void verifyBounds(ActivityScenario<MainActivity> scenario, int orientation) {
        AtomicReference<String> details = new AtomicReference<>("Window insets not available");
        AtomicReference<Boolean> safe = new AtomicReference<>(false);
        long deadline = SystemClock.uptimeMillis() + 8000;
        while (SystemClock.uptimeMillis() < deadline && !safe.get()) {
            scenario.onActivity(activity -> {
                View root = activity.getWindow().getDecorView();
                View web = activity.getBridge().getWebView();
                WindowInsetsCompat window = ViewCompat.getRootWindowInsets(root);
                if (window == null || web.getWidth() == 0 || web.getHeight() == 0) return;
                Insets insets = window.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                int[] rootPosition = new int[2], webPosition = new int[2];
                root.getLocationOnScreen(rootPosition);
                web.getLocationOnScreen(webPosition);
                Rect available = new Rect(rootPosition[0] + insets.left,
                    rootPosition[1] + insets.top,
                    rootPosition[0] + root.getWidth() - insets.right,
                    rootPosition[1] + root.getHeight() - insets.bottom);
                Rect content = new Rect(webPosition[0], webPosition[1],
                    webPosition[0] + web.getWidth(), webPosition[1] + web.getHeight());
                boolean matches = activity.getResources().getConfiguration().orientation == orientation;
                boolean hasStatusBar = orientation != Configuration.ORIENTATION_PORTRAIT || insets.top > 0;
                details.set("orientation=" + orientation + ", safe=" + available.toShortString()
                    + ", WebView=" + content.toShortString() + ", statusTop=" + insets.top);
                safe.set(matches && hasStatusBar && available.contains(content));
            });
            if (!safe.get()) SystemClock.sleep(100);
        }
        assertTrue(details.get(), safe.get());
        System.out.println("Astral safe-area verified: " + details.get());
    }
}
