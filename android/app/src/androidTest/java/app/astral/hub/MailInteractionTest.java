package app.astral.hub;

import static org.junit.Assert.assertTrue;
import android.content.pm.ActivityInfo;
import android.os.SystemClock;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class MailInteractionTest {
    @Test public void nativeMailLinksRejectExecutableSchemesAndCredentials() {
        for (String url : new String[]{"https://example.com/schedule?id=7", "http://example.com/", "mailto:recipient@example.com"})
            assertTrue("Safe external link rejected", MailLinksPlugin.validLink(url));
        for (String url : new String[]{"file:///etc/passwd", "javascript:alert(1)", "data:text/html,bad", "//example.com", "https://user:pass@example.com/", "/api/private", "mailto:x@example.com?body=%0aInjected", "https://example.com/\n"})
            assertTrue("Unsafe link allowed: "+url, !MailLinksPlugin.validLink(url));
    }
    @Test public void mailDraftAgentAndBackWorkAboveRealImeWithoutSending() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            await(scenario, "!!document.querySelector('.assistant-workspace')");
            // Cache-only synthetic mail: no IMAP, SMTP, model or real credentials.
            js(scenario, """
                (()=>{
                  window.__qaReloadPending=true;
                  localStorage.setItem('astral.settings',JSON.stringify({url:'',autoSync:false}));
                  sessionStorage.setItem('astral.account',JSON.stringify({server:location.origin,
                    token:'synthetic-mail-qa-081-token-never-real',expiresAt:new Date(Date.now()+3600000).toISOString(),
                    user:{id:'081-mail-device-fixture',username:'maildeviceqa',displayName:'邮件合成账号',role:'owner'}}));
                  const entry=value=>({value,at:Date.now()}), cache={};
                  const qaMail=Array.from({length:5}).reduce(html=>'<table><tr><td>'+html+'</td></tr></table>',
                    '<h1>合成安排</h1><table><tr><td>任务图标</td><td><strong>Build applications / web-and-tests</strong></td><td>查看详情</td></tr><tr><td>任务图标</td><td>第二个任务</td><td>查看详情</td></tr></table><table><thead><tr><th>阶段</th><th>数量</th></tr></thead><tbody><tr><td>网页</td><td>267</td></tr></tbody></table><p><a href="https://example.com/schedule?tracking=synthetic">查看日程</a></p>');
                  cache.account=entry({provider:'gmail',address:'deviceqa@example.com',providerLabel:'Gmail',createdAt:'2026-11-04',updatedAt:'2026-11-04'});
                  cache.folders=entry([{path:'INBOX',name:'收件箱',specialUse:null},{path:'Work',name:'工作',specialUse:null}]);
                  cache.view=entry({mailbox:'INBOX',query:'',selected:null,unread:false});
                  cache[JSON.stringify(['list','INBOX','',false,'','','history-v1'])]=entry({messages:[{uid:101,subject:'设备合成邮件',from:'QA <sender@example.com>',to:'deviceqa@example.com',date:'2026-11-04T02:00:00Z',seen:false,flagged:false,size:100}],uidValidity:'1',hasMore:false,nextCursor:null,scannedFrom:101,total:1});
                  cache[JSON.stringify(['body','INBOX',101,'rich-v1'])]=entry({uid:101,subject:'设备合成邮件',from:'QA',fromAddress:'sender@example.com',replyTo:'sender@example.com',to:'deviceqa@example.com',date:null,text:'仅供界面验收',hasHtml:true,html:qaMail,remoteImageCount:0,attachments:[]});
                  localStorage.setItem('astral.mail.cache.v2:'+JSON.stringify([location.origin,'081-mail-device-fixture']),JSON.stringify(cache));
                  return true;
                })()
                """);
            scenario.onActivity(a -> {
                // Only the reversible read-flag protocol is synthesized. Cached mail
                // still renders through the real reader; no live mailbox is touched.
                a.getBridge().getWebView().setWebViewClient(new BridgeWebViewClient(a.getBridge()) {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView web,WebResourceRequest request) {
                        String p=request.getUrl().getPath();
                        if(p!=null&&p.startsWith("/api/mail/actions/")) {
                            String state=p.endsWith("/prepare")?"prepared":"done";
                            byte[] data=("{\"id\":\"87ea95f2-f334-47d0-9cf4-18e89157a706\",\"state\":\""+state+"\",\"action\":\"read\",\"messages\":[]}").getBytes(StandardCharsets.UTF_8);
                            return new WebResourceResponse("application/json","UTF-8",200,"OK",Map.of("Cache-Control","no-store"),new ByteArrayInputStream(data));
                        }
                        return super.shouldInterceptRequest(web,request);
                    }
                });
                a.getBridge().getWebView().reload();
            });
            try {
                // The old document also has this menu; wait for a new JS world
                // before clicking a drawer that reload() would otherwise discard.
                await(scenario, "!window.__qaReloadPending&&!!document.querySelector('.assistant-workspace .mobile-menu')");
                js(scenario, "document.querySelector('.assistant-workspace .mobile-menu').click();true");
                await(scenario, "!!document.querySelector('.sidebar.open')");
                js(scenario, "[...document.querySelectorAll('.sidebar nav button')].find(b=>b.textContent.trim()==='邮件').click();true");
                await(scenario, "!!document.querySelector('.mail-page')");
                js(scenario, "document.querySelector('.mail-heading .primary').click();true");
                await(scenario, "!!document.querySelector('.mail-composer')");
                setField(scenario, ".mail-compose-edit label:first-child input", "recipient@example.com");
                setField(scenario, ".mail-compose-edit label:nth-child(2) input", "设备验收，不发送");
                setField(scenario, ".mail-compose-body", "设备邮件草稿第一行\n第二行\n第三行");
                for (int orientation : new int[]{ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE}) {
                    scenario.onActivity(a -> a.setRequestedOrientation(orientation));
                    js(scenario, "document.querySelector('.mail-compose-body').focus();true");
                    showIme(scenario);
                    await(scenario, "document.documentElement.dataset.keyboard==='open'");
                    await(scenario, "(()=>{const t=document.querySelector('.mail-compose-body').getBoundingClientRect(),f=document.querySelector('.mail-composer > footer').getBoundingClientRect(),v=visualViewport;return t.height>=40&&t.top>=v.offsetTop&&t.bottom<=f.top+1&&f.bottom<=v.offsetTop+v.height+1;})()");
                    back(scenario); awaitIme(scenario, false);
                    await(scenario, "!!document.querySelector('.mail-composer')&&document.querySelector('.mail-compose-body').value.includes('第三行')");
                    System.out.println("Astral mail composer above real IME, orientation="+orientation);
                }
                back(scenario); await(scenario, "!document.querySelector('.mail-composer')");
                js(scenario, "document.querySelector('.mail-heading .primary').click();true");
                await(scenario, "document.querySelector('.mail-compose-body')?.value.includes('第三行')");
                back(scenario); await(scenario, "!document.querySelector('.mail-composer')");
                scenario.onActivity(a -> a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
                js(scenario, "document.querySelector('.mail-row strong').click();true");
                await(scenario, "!!document.querySelector('iframe[title=\"邮件网页正文\"]')");
                await(scenario, "!document.querySelector('.mail-row.unread')&&!document.querySelector('.mail-action-dialog')");
                System.out.println("Astral opening cached mail directly marks read without a confirmation dialog");
                await(scenario, "(()=>{const d=document.querySelector('.mail-body iframe').contentDocument,b=d.body,h=d.querySelector('h1'),c=[...d.querySelectorAll('td[data-mail-layout]')].find(n=>n.textContent==='查看详情');return !!c&&c.getBoundingClientRect().width>=b.clientWidth*.9&&h.getBoundingClientRect().width>=b.clientWidth*.9&&d.querySelectorAll('table[data-mail-table=data]').length===1&&d.querySelectorAll('[data-mail-cell]').length===4&&b.scrollWidth<=b.clientWidth+1;})()");
                System.out.println("Astral cached nested mail: full-width layout cells, one real data table, no overflow");
                js(scenario, "document.querySelector('.mail-reader-actions button:last-child').click();true");
                await(scenario, "document.querySelector('.mail-compose-edit input')?.readOnly===true");
                setField(scenario, ".mail-compose-body", "回复合成草稿\n不能发送");
                showIme(scenario); back(scenario); awaitIme(scenario, false);
                back(scenario); await(scenario, "!document.querySelector('.mail-composer')&&!!document.querySelector('.mail-detail-heading')");
                back(scenario); await(scenario, "!document.querySelector('.mail-detail-heading')&&!!document.querySelector('.mail-list')");
                js(scenario, "document.querySelector('.mail-agent-open').click();true");
                await(scenario, "!!document.querySelector('#mail-manage-instruction')");
                setField(scenario, "#mail-manage-instruction", "验收输入\n保留草稿\n不提交模型任务");
                for (int orientation : new int[]{ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE}) {
                    scenario.onActivity(a -> a.setRequestedOrientation(orientation));
                    js(scenario, "document.querySelector('#mail-manage-instruction').focus();true");
                    showIme(scenario);
                    await(scenario, "(()=>{const t=document.querySelector('#mail-manage-instruction').getBoundingClientRect(),b=document.querySelector('.mail-agent-dialog footer button.primary').getBoundingClientRect(),v=visualViewport;return t.height>=40&&t.top>=v.offsetTop&&t.bottom<=v.offsetTop+v.height+1&&t.left>=0&&t.right<=v.width+1&&b.bottom<=v.offsetTop+v.height+1&&(t.bottom<=b.top+1||t.right<=b.left+1);})()");
                    back(scenario); awaitIme(scenario, false);
                    await(scenario, "document.querySelector('#mail-manage-instruction').value.includes('保留草稿')");
                }
                back(scenario); await(scenario, "!document.querySelector('.mail-agent-dialog')&&!!document.querySelector('.mail-page')");
                scenario.onActivity(a -> assertTrue("Mail Back finished the app", !a.isFinishing()));
                System.out.println("Astral synthetic mail: drafts retained; reply -> reader -> list; Agent keyboard; no send/model call");
            } finally {
                js(scenario, "sessionStorage.removeItem('astral.account');localStorage.removeItem('astral.settings');localStorage.removeItem('astral.mail.cache.v2:'+JSON.stringify([location.origin,'081-mail-device-fixture']));for(const k of Object.keys(localStorage)){if(k.startsWith('astral.mail.compose:deviceqa@example.com'))localStorage.removeItem(k);}true");
                scenario.onActivity(a -> a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            }
        }
    }
    private void setField(ActivityScenario<MainActivity> scenario, String selector, String value) throws Exception {
        js(scenario, "(()=>{const f=document.querySelector("+JSONObject.quote(selector)+");const p=f instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(f,"+JSONObject.quote(value)+");f.dispatchEvent(new Event('input',{bubbles:true}));f.focus();return true;})()");
    }
    private void showIme(ActivityScenario<MainActivity> scenario) {
        scenario.onActivity(a -> {a.getBridge().getWebView().requestFocus();WindowCompat.getInsetsController(a.getWindow(),a.getWindow().getDecorView()).show(WindowInsetsCompat.Type.ime());});
        awaitIme(scenario, true);
    }
    private void awaitIme(ActivityScenario<MainActivity> scenario, boolean expected) {
        AtomicReference<Boolean> matches=new AtomicReference<>(false);
        long deadline=SystemClock.uptimeMillis()+10000;
        while(SystemClock.uptimeMillis()<deadline&&!matches.get()) {
            scenario.onActivity(a->{WindowInsetsCompat i=ViewCompat.getRootWindowInsets(a.getWindow().getDecorView());matches.set(i!=null&&i.isVisible(WindowInsetsCompat.Type.ime())==expected);});
            if(!matches.get())SystemClock.sleep(100);
        }
        assertTrue("Mail IME visible="+expected+" was not reached",matches.get());
    }
    private void back(ActivityScenario<MainActivity> scenario) { scenario.onActivity(a -> a.getOnBackPressedDispatcher().onBackPressed()); }
    private String js(ActivityScenario<MainActivity> scenario, String code) throws Exception {
        CountDownLatch latch=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>("");
        scenario.onActivity(a -> a.getBridge().getWebView().evaluateJavascript(code, v->{value.set(v);latch.countDown();}));
        assertTrue("Mail JavaScript timed out",latch.await(8,TimeUnit.SECONDS));return value.get();
    }
    private void await(ActivityScenario<MainActivity> scenario, String code) throws Exception {
        long deadline=SystemClock.uptimeMillis()+12000;
        while(SystemClock.uptimeMillis()<deadline){if("true".equals(js(scenario,code)))return;SystemClock.sleep(100);}
        assertTrue("Mail WebView condition not met: "+code+"; "+MobileTestDiagnostics.describe(scenario),false);
    }
}
