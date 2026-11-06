package app.astral.hub;

import static org.junit.Assert.assertTrue;
import android.os.SystemClock;
import android.content.pm.ActivityInfo;
import android.view.View;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class MobileNavigationTest {
    @Test public void realKeyboardKeepsMultilineComposerVisibleAndBackOnlyHidesIme() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            await(scenario, "!!document.querySelector('.assistant-workspace')");
            // Emulator-only synthetic login renders the real composer without a remote
            // server or model. No credentials are copied and no task is submitted.
            js(scenario, "window.__qaReloadPending=true;localStorage.setItem('astral.settings',JSON.stringify({url:'',autoSync:false}));"
                + "sessionStorage.setItem('astral.account',JSON.stringify({server:location.origin,"
                + "token:'synthetic-device-qa-081-token-not-real',expiresAt:new Date(Date.now()+3600000).toISOString(),"
                + "user:{id:'081-device-fixture',username:'deviceqa',displayName:'设备合成账号',role:'owner'}}));true");
            scenario.onActivity(a -> a.getBridge().getWebView().reload());
            try {
                await(scenario, "!window.__qaReloadPending&&!!document.querySelector('.assistant-composer textarea')");
                for (int orientation : new int[]{ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE}) {
                    scenario.onActivity(a -> a.setRequestedOrientation(orientation));
                    js(scenario, "(()=>{const f=document.querySelector('.assistant-composer textarea');"
                        + "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(f,'合成草稿第一行\\n第二行\\n第三行');"
                        + "f.dispatchEvent(new Event('input',{bubbles:true}));f.focus();return true;})()");
                    scenario.onActivity(a -> {
                        a.getBridge().getWebView().requestFocus();
                        WindowCompat.getInsetsController(a.getWindow(), a.getWindow().getDecorView()).show(WindowInsetsCompat.Type.ime());
                    });
                    awaitIme(scenario, true);
                    await(scenario, "document.documentElement.dataset.keyboard==='open'");
                    await(scenario, "(()=>{const c=document.querySelector('.assistant-composer').getBoundingClientRect();"
                        + "const t=document.querySelector('.assistant-composer textarea').getBoundingClientRect();"
                        + "const s=document.querySelector('.composer-primary-action').getBoundingClientRect();"
                        + "const v=visualViewport;return c.bottom<=v.offsetTop+v.height+1&&t.top>=v.offsetTop&&t.height>=40&&s.bottom<=v.offsetTop+v.height+1;})()");
                    scenario.onActivity(a -> {
                        View root=a.getWindow().getDecorView(), web=a.getBridge().getWebView();
                        int ime=ViewCompat.getRootWindowInsets(root).getInsets(WindowInsetsCompat.Type.ime()).bottom;
                        int[] r=new int[2], w=new int[2];root.getLocationOnScreen(r);web.getLocationOnScreen(w);
                        assertTrue("WebView is behind the real IME",w[1]+web.getHeight()<=r[1]+root.getHeight()-ime+2);
                    });
                    back(scenario); awaitIme(scenario, false);
                    await(scenario, "document.querySelector('.assistant-composer textarea').value.includes('第三行')");
                    await(scenario, "(()=>{const c=document.querySelector('.assistant-composer').getBoundingClientRect();"
                        + "const s=document.querySelector('.composer-primary-action').getBoundingClientRect();"
                        + "return c.top>=0&&c.bottom<=visualViewport.height+1&&s.bottom<=visualViewport.height+1;})()");
                    scenario.onActivity(a -> assertTrue("Keyboard back finished the app", !a.isFinishing()));
                    System.out.println("Astral actual IME and multiline composer verified, orientation="+orientation);
                }
                js(scenario, "document.querySelector('.assistant-task-settings > button').click();true");
                await(scenario, "!!document.querySelector('.assistant-settings-panel')");
                js(scenario, "document.querySelector('.assistant-settings-panel .approval-trigger').click();true");
                await(scenario, "!!document.querySelector('.approval-dialog')");
                back(scenario);
                await(scenario, "!document.querySelector('.approval-dialog')&&document.querySelector('.assistant-composer textarea').value.includes('第三行')");
                await(scenario, "!!document.querySelector('.assistant-settings-panel')");
                back(scenario);
                await(scenario, "!document.querySelector('.assistant-settings-panel')&&document.querySelector('.assistant-composer textarea').value.includes('第三行')");
                System.out.println("Astral native back closed approval dialog and preserved composer draft");
            } finally {
                js(scenario, "sessionStorage.removeItem('astral.account');localStorage.removeItem('astral.settings');true");
                scenario.onActivity(a -> a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            }
        }
    }

    private void awaitIme(ActivityScenario<MainActivity> scenario, boolean expected) {
        long deadline=SystemClock.uptimeMillis()+10000;
        AtomicReference<Boolean> matches=new AtomicReference<>(false);
        while(SystemClock.uptimeMillis()<deadline&&!matches.get()) {
            scenario.onActivity(a->{WindowInsetsCompat i=ViewCompat.getRootWindowInsets(a.getWindow().getDecorView());
                matches.set(i!=null&&i.isVisible(WindowInsetsCompat.Type.ime())==expected);});
            if(!matches.get())SystemClock.sleep(100);
        }
        assertTrue("IME visible="+expected+" was not reached",matches.get());
    }
    @Test public void nativeBackClosesDrawerThenReturnsFromPageWithoutFinishing() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            await(scenario, "!!document.querySelector('.assistant-workspace .mobile-menu')");
            js(scenario, "document.querySelector('.assistant-workspace .mobile-menu').click();true");
            await(scenario, "!!document.querySelector('.sidebar.open')");
            back(scenario);
            await(scenario, "!document.querySelector('.sidebar.open')");
            js(scenario, "document.querySelector('.assistant-workspace .mobile-menu').click();true");
            await(scenario, "!!document.querySelector('.sidebar.open')");
            js(scenario, "document.querySelector('.sidebar-bottom > button').click();true");
            await(scenario, "!!document.querySelector('[aria-label=\"手机手势设置\"]')");
            back(scenario);
            await(scenario, "!!document.querySelector('.assistant-workspace')");
            scenario.onActivity(a -> assertTrue("Back finished the activity", !a.isFinishing()));
            System.out.println("Astral native back: drawer -> current page; settings -> assistant; activity retained");
        }
    }

    @Test public void touchDragFollowsFingerAndCancelsOrSettlesWithoutEdgeConflicts() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            await(scenario, "!!document.querySelector('.assistant-workspace')");
            js(scenario, "window.__qaReloadPending=true;localStorage.setItem('astral.settings',JSON.stringify({url:'',autoSync:false}));sessionStorage.setItem('astral.account',JSON.stringify({server:location.origin,token:'synthetic-swipe-qa-082-token-not-real',expiresAt:new Date(Date.now()+3600000).toISOString(),user:{id:'082-swipe-fixture',username:'swipeqa',displayName:'滑动合成账号',role:'owner'}}));true");
            scenario.onActivity(a -> a.getBridge().getWebView().reload());
            try {
            await(scenario, "!window.__qaReloadPending&&!!document.querySelector('.pi-message-area')");
            js(scenario, "window.__qaTouch=(type,x,y,selector='.assistant-workspace')=>{const target=document.querySelector(selector);"
                + "const touch=new Touch({identifier:1,target,clientX:x,clientY:y});"
                + "target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,"
                + "touches:type==='touchend'||type==='touchcancel'?[]:[touch],changedTouches:[touch]}));};true");
            js(scenario, "window.__qaTouch('touchstart',24,180);window.__qaTouch('touchmove',64,182);true");
            await(scenario, "!!document.querySelector('[data-panel-dragging] .sidebar.open')");
            assertTrue("Drawer did not follow the partial drag", "true".equals(js(scenario,
                "(()=>{const d=document.querySelector('.sidebar');const r=d.getBoundingClientRect();return r.left<0&&r.right>0;})()")));
            js(scenario, "window.__qaTouch('touchcancel',64,182);true");
            await(scenario, "!document.querySelector('.sidebar.open')");
            js(scenario, "window.__qaTouch('touchstart',24,180);window.__qaTouch('touchmove',144,182);window.__qaTouch('touchend',144,182);true");
            await(scenario, "!!document.querySelector('.sidebar.open')");
            back(scenario); await(scenario, "!document.querySelector('.sidebar.open')");
            js(scenario, "window.__qaTouch('touchstart',2,180);window.__qaTouch('touchmove',144,182);window.__qaTouch('touchend',144,182);true");
            assertTrue("OS edge must not open a drawer", "true".equals(js(scenario, "!document.querySelector('.sidebar.open')")));
            js(scenario, "window.__qaTouch('touchstart',160,180,'.pi-message-area');window.__qaTouch('touchmove',260,182,'.pi-message-area');window.__qaTouch('touchend',260,182,'.pi-message-area');true");
            await(scenario, "!!document.querySelector('.sidebar.open')");
            back(scenario); await(scenario, "!document.querySelector('.sidebar.open')");
            js(scenario, "window.__qaTouch('touchstart',160,180,'.pi-message-area');window.__qaTouch('touchmove',60,182,'.pi-message-area');window.__qaTouch('touchend',60,182,'.pi-message-area');true");
            await(scenario, "!!document.querySelector('#pi-project-navigation.is-open')");
            back(scenario); await(scenario, "!document.querySelector('#pi-project-navigation.is-open')");
            js(scenario, "window.__qaTouch('touchstart',160,180,'.pi-message-area');window.__qaTouch('touchmove',165,300,'.pi-message-area');window.__qaTouch('touchend',165,300,'.pi-message-area');true");
            assertTrue("Vertical content scroll opened a drawer", "true".equals(js(scenario,"!document.querySelector('.sidebar.open,#pi-project-navigation.is-open')")));
            System.out.println("Astral synthetic touch integration: follow, cancel, settle, reserved OS edge");
            } finally {
                js(scenario, "sessionStorage.removeItem('astral.account');localStorage.removeItem('astral.settings');true");
            }
        }
    }

    private void back(ActivityScenario<MainActivity> scenario) {
        scenario.onActivity(a -> a.getOnBackPressedDispatcher().onBackPressed());
    }
    private String js(ActivityScenario<MainActivity> scenario, String code) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>("");
        scenario.onActivity(a -> a.getBridge().getWebView().evaluateJavascript(code, value -> { result.set(value); latch.countDown(); }));
        assertTrue("JavaScript timed out", latch.await(8, TimeUnit.SECONDS));
        return result.get();
    }
    private void await(ActivityScenario<MainActivity> scenario, String code) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 12000;
        while (SystemClock.uptimeMillis() < deadline) {
            if ("true".equals(js(scenario, code))) return;
            SystemClock.sleep(100);
        }
        assertTrue("WebView condition not met: " + code + "; " + MobileTestDiagnostics.describe(scenario), false);
    }
}
