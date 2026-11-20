package app.astral.hub;

import static org.junit.Assert.assertTrue;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.SystemClock;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real bundled React + WebView + image decoder; only HTTP/model data are synthetic. */
@RunWith(AndroidJUnit4.class)
public class ComputerFilesTest {
    private static final String DEVICE="9e6d387e-c518-41dd-b8ed-d4a093363ea1";
    private static final String PROJECT="2eb0b349-59f0-440b-bf22-2cc9ee9e2d65";
    private static final String CHAT="c62d42c5-7e12-4a99-9fe1-894f922253a3";
    private static final String FILE="5a64beeb-5afe-437b-bead-71324f508b30";
    private static final String DOC="0f37362b-3615-470e-a773-995d753ea2bc";
    private static final String TOKEN="synthetic-computer-files-085-token-never-real";

    @Test public void savedComputerImageRendersFromHistoryAndNativeBackClosesPreview() throws Exception {
        Bitmap bitmap=Bitmap.createBitmap(96,64,Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.rgb(42,133,120));
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG,100,out);bitmap.recycle();
        byte[] png=out.toByteArray();
        String sha=hex(MessageDigest.getInstance("SHA-256").digest(png));
        AtomicInteger downloads=new AtomicInteger();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            await(scenario,"!!document.querySelector('.assistant-workspace')");
            js(scenario,"window.__qaReloadPending=true;localStorage.setItem('astral.settings',JSON.stringify({url:'',autoSync:false}));"
                +"sessionStorage.setItem('astral.account',JSON.stringify({server:location.origin,token:'"+TOKEN+"',expiresAt:new Date(Date.now()+3600000).toISOString(),user:{id:'085-file-fixture',username:'filesqa',displayName:'附件合成账号',role:'owner'}}));"
                +"sessionStorage.setItem('astral.assistant.target:'+JSON.stringify([location.origin,'085-file-fixture']),JSON.stringify({deviceId:'"+DEVICE+"',projectId:'"+PROJECT+"',conversationId:'"+CHAT+"'}));true");
            scenario.onActivity(a->{
                a.getBridge().getWebView().setWebViewClient(new BridgeWebViewClient(a.getBridge()) {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView web,WebResourceRequest request) {
                        String path=request.getUrl().getPath();
                        if(path==null||!path.startsWith("/api/"))return super.shouldInterceptRequest(web,request);
                        if(path.equals("/api/pi/conversations/"+CHAT+"/files/"+FILE)) {
                            if(!request.getRequestHeaders().entrySet().stream().anyMatch(e->e.getKey().equalsIgnoreCase("Authorization")&&e.getValue().equals("Bearer "+TOKEN)))
                                return response(404,"application/json","{\"error\":\"not found\"}".getBytes(StandardCharsets.UTF_8));
                            downloads.incrementAndGet();return response(200,"application/octet-stream",png);
                        }
                        // Fail closed for APIs this fixture does not implement. A
                        // successful empty object violates the real notification
                        // contract and crashes the app before this test can run.
                        String data=null;
                        if(path.equals("/api/notifications"))data="{\"notifications\":[],\"unread\":0,\"cursor\":0}";
                        if(path.equals("/api/relay/devices"))data="{\"devices\":[{\"id\":\""+DEVICE+"\",\"name\":\"合成电脑\",\"online\":true,\"capabilities\":[\"chat_export\",\"computer_plugins\"]}]}";
                        if(path.equals("/api/relay/projects"))data="{\"projects\":[{\"id\":\""+PROJECT+"\",\"name\":\"图片验收项目\",\"readOnly\":true,\"allowExecute\":false}]}";
                        if(path.equals("/api/relay/conversations"))data="{\"conversations\":[{\"id\":\""+CHAT+"\",\"title\":\"历史图片\",\"version\":\"files-085\",\"active\":0}],\"next\":null}";
                        if(path.equals("/api/relay/conversations/"+CHAT))data="{\"conversation\":{\"id\":\""+CHAT+"\",\"title\":\"历史图片\",\"version\":\"files-085\"},\"jobs\":[{\"id\":\"24bfc702-171e-4909-89a3-55aa562a37b1\",\"conversationId\":\""+CHAT+"\",\"projectId\":\""+PROJECT+"\",\"parentId\":null,\"input\":\"发送图片\",\"output\":\"文件已保存，历史直接显示。\",\"thinking\":\"\",\"status\":\"done\",\"phase\":\"已完成\",\"tools\":[],\"access\":\"read\",\"execute\":false,\"createdAt\":\"2026-11-05T06:04:27Z\",\"artifacts\":[{\"id\":\""+FILE+"\",\"name\":\"历史图片.png\",\"bytes\":"+png.length+",\"sha256\":\""+sha+"\"},{\"id\":\""+DOC+"\",\"name\":\"说明.md\",\"bytes\":20}]}],\"next\":null}";
                        return data==null
                            ?response(404,"application/json","{\"error\":\"Not implemented by computer attachment fixture\"}".getBytes(StandardCharsets.UTF_8))
                            :response(200,"application/json",data.getBytes(StandardCharsets.UTF_8));
                    }
                });
                a.getBridge().getWebView().reload();
            });
            try {
                await(scenario,"!window.__qaReloadPending&&!!document.querySelector('.assistant-computer-view .chat-file-thumbnail img')");
                await(scenario,"document.querySelector('.chat-file-thumbnail img').naturalWidth===96&&!!document.querySelector('.chat-file-type.kind-text')");
                js(scenario,"document.querySelector('[aria-label=\"预览 历史图片.png\"]').click();true");
                await(scenario,"document.querySelector('.pi-image-preview')?.naturalWidth===96");
                scenario.onActivity(a->a.getOnBackPressedDispatcher().onBackPressed());
                await(scenario,"!document.querySelector('.pi-file-preview-dialog')&&!!document.querySelector('.chat-file-thumbnail img')");
                assertTrue("File did not use authenticated binary fetch",downloads.get()>=2);
                assertTrue("Credential leaked to image URL","true".equals(js(scenario,"![...document.images].some(i=>i.src.includes('"+TOKEN+"'))")));
                System.out.println("Astral bundled computer artifacts: authenticated history -> actual PNG thumbnail -> full preview -> native back; distinct document icon");
            } finally {
                js(scenario,"sessionStorage.removeItem('astral.account');localStorage.removeItem('astral.settings');sessionStorage.removeItem('astral.assistant.target:'+JSON.stringify([location.origin,'085-file-fixture']));true");
            }
        }
    }
    private static WebResourceResponse response(int status,String mime,byte[] bytes) {
        return new WebResourceResponse(mime,"UTF-8",status,status==200?"OK":"Not Found",Map.of("Cache-Control","no-store"),new ByteArrayInputStream(bytes));
    }
    private static String hex(byte[] bytes) {StringBuilder b=new StringBuilder();for(byte v:bytes)b.append(String.format("%02x",v));return b.toString();}
    private String js(ActivityScenario<MainActivity> scenario,String code)throws Exception {
        CountDownLatch latch=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>("");
        scenario.onActivity(a->a.getBridge().getWebView().evaluateJavascript(code,v->{value.set(v);latch.countDown();}));
        assertTrue("Computer JavaScript timed out",latch.await(8,TimeUnit.SECONDS));return value.get();
    }
    private void await(ActivityScenario<MainActivity> scenario,String code)throws Exception {
        long deadline=SystemClock.uptimeMillis()+15000;
        while(SystemClock.uptimeMillis()<deadline){if("true".equals(js(scenario,code)))return;SystemClock.sleep(100);}
        assertTrue("Computer WebView condition not met: "+code+"; "+MobileTestDiagnostics.describe(scenario),false);
    }
}
