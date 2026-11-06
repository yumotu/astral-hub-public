package app.astral.hub;

import android.view.View;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.core.app.ActivityScenario;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Geometry only: never include drafts, tokens, email addresses or settings. */
final class MobileTestDiagnostics {
    static String describe(ActivityScenario<MainActivity> scenario) throws Exception {
        AtomicReference<String> nativeInfo=new AtomicReference<>(""), dom=new AtomicReference<>("");
        CountDownLatch latch=new CountDownLatch(1);
        scenario.onActivity(a -> {
            View root=a.getWindow().getDecorView(), web=a.getBridge().getWebView();
            WindowInsetsCompat i=ViewCompat.getRootWindowInsets(root);
            int[] pos=new int[2];web.getLocationOnScreen(pos);
            nativeInfo.set("orientation="+a.getResources().getConfiguration().orientation+", root="+root.getWidth()+"x"+root.getHeight()+", web="+web.getWidth()+"x"+web.getHeight()+"@"+pos[0]+","+pos[1]+", ime="+(i==null?"null":i.getInsets(WindowInsetsCompat.Type.ime()).bottom));
            a.getBridge().getWebView().evaluateJavascript("""
                JSON.stringify({width:innerWidth,height:innerHeight,scrollY,htmlHeight:document.documentElement.clientHeight,bodyHeight:document.body.scrollHeight,viewport:visualViewport&&{height:visualViewport.height,top:visualViewport.offsetTop,scale:visualViewport.scale},appHeight:getComputedStyle(document.documentElement).getPropertyValue('--app-viewport-height'),keyboard:document.documentElement.dataset.keyboard,active:document.activeElement?.tagName,elements:[...document.querySelectorAll('.assistant-workspace,.assistant-composer,.assistant-composer textarea,.composer-primary-action,.mail-composer,.mail-compose-content,.mail-compose-body,.mail-composer > footer')].map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {name:e.className||e.tagName,top:r.top,bottom:r.bottom,height:r.height,width:r.width,position:s.position,minHeight:s.minHeight,maxHeight:s.maxHeight,flexShrink:s.flexShrink,transform:s.transform}})})
                """, value -> {dom.set(value);latch.countDown();});
        });
        latch.await(8,TimeUnit.SECONDS);
        return nativeInfo.get()+"; DOM="+dom.get();
    }
}
