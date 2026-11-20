package app.astral.hub;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import androidx.core.content.FileProvider;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;

@CapacitorPlugin(name = "AppUpdates")
public class AppUpdatesPlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile boolean busy = false, cancelled = false;
    private volatile HttpURLConnection connection;
    private File ready;
    private String readyHash;
    private JSObject progress = new JSObject().put("state", "idle");
    private String digest(File file) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) { byte[] b = new byte[65536]; int n; while ((n=in.read(b))!=-1) hash.update(b,0,n); }
        StringBuilder text = new StringBuilder(); for (byte b:hash.digest()) text.append(String.format("%02x",b)); return text.toString();
    }
    private void report(String state, long received, long total) { progress = new JSObject().put("state",state).put("received",received).put("total",total); notifyListeners("progress",progress); }
    @PluginMethod public void status(PluginCall call) { call.resolve(progress); }
    @PluginMethod public void cancel(PluginCall call) { cancelled=true; if(connection!=null) connection.disconnect(); call.resolve(); }
    @PluginMethod public synchronized void download(PluginCall call) {
        if(busy) { call.reject("已有更新正在下载。"); return; }
        final String address=call.getString("url"); final JSObject asset=call.getObject("asset");
        if(address==null||asset==null) { call.reject("更新参数不正确。");return; }
        final String name=asset.getString("name"),sha=asset.getString("sha256"); final long total=asset.optLong("bytes",0);
        try {
            URL url=new URL(address); boolean local=Arrays.asList("127.0.0.1","localhost","[::1]").contains(url.getHost());
            if(!("https".equals(url.getProtocol())||("http".equals(url.getProtocol())&&local))||url.getUserInfo()!=null||url.getQuery()!=null||url.getRef()!=null||!url.getPath().matches("/api/updates/download/[a-f0-9]{64}")) throw new Exception();
            if(name==null||!name.matches("Astral-Hub-[0-9]+\\.[0-9]+\\.[0-9]+-android-debug\\.apk")||sha==null||!sha.matches("[a-f0-9]{64}")||total<=0||total>512L*1024*1024||!"android".equals(asset.getString("platform"))) throw new Exception();
        } catch(Exception e) { call.reject("更新下载地址或安装包格式不正确。");return; }
        busy=true;cancelled=false;
        executor.execute(()->{
            File part=null;
            try {
                File dir=new File(getContext().getCacheDir(),"updates"); if(!dir.exists()&&!dir.mkdirs()) throw new Exception("无法创建更新目录。");
                File target=new File(dir,name);
                if(!(target.isFile()&&target.length()==total&&sha.equals(digest(target)))) {
                    part=new File(dir,name+".part"); if(part.exists()&&!part.delete()) throw new Exception("无法清理未完成的下载。");
                    connection=(HttpURLConnection)new URL(address).openConnection(); connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(30000);
                    if(connection.getResponseCode()!=200) throw new Exception("更新下载失败，请重新检查更新。");
                    long received=0,last=0; report("downloading",0,total);
                    try(InputStream in=connection.getInputStream(); OutputStream out=new FileOutputStream(part)) {
                        byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1){ if(cancelled) throw new Exception("下载已取消。");received+=n;if(received>total) throw new Exception("更新文件超出清单大小。");out.write(b,0,n);if(System.currentTimeMillis()-last>200){last=System.currentTimeMillis();report("downloading",received,total);} }
                    }
                    if(received!=total||!sha.equals(digest(part))) throw new Exception("更新文件校验失败，已阻止安装。");
                    if(target.exists()&&!target.delete()) throw new Exception("无法替换更新文件。");
                    if(!part.renameTo(target)) throw new Exception("无法保存更新文件。");part=null;
                }
                ready=target;readyHash=sha;report("ready",total,total);call.resolve(new JSObject().put("ready",true));
            } catch(Exception e) { report("error",0,total);call.reject(cancelled?"下载已取消。":e.getMessage()==null?"下载失败，请重试。":e.getMessage()); }
            finally { if(part!=null) part.delete();if(connection!=null) connection.disconnect();connection=null;busy=false; }
        });
    }
    @PluginMethod public void install(PluginCall call) {
        executor.execute(()->{try {
            if(ready==null||!ready.isFile()||!readyHash.equals(digest(ready))) throw new Exception("请先下载并校验更新。");
            PackageManager pm=getContext().getPackageManager();
            @SuppressWarnings("deprecation") PackageInfo next=pm.getPackageArchiveInfo(ready.getPath(),PackageManager.GET_SIGNATURES);
            @SuppressWarnings("deprecation") PackageInfo current=pm.getPackageInfo(getContext().getPackageName(),PackageManager.GET_SIGNATURES);
            if(next==null||!current.packageName.equals(next.packageName)||next.versionCode<current.versionCode) throw new Exception("安装包身份或版本不正确。");
            if(!Arrays.equals(current.signatures,next.signatures)) throw new Exception("安装包签名与当前应用不同，不能覆盖安装；请保留现有应用和数据。");
            Intent intent=new Intent(Intent.ACTION_VIEW);intent.setDataAndType(FileProvider.getUriForFile(getContext(),getContext().getPackageName()+".fileprovider",ready),"application/vnd.android.package-archive");intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().runOnUiThread(()->{try{getContext().startActivity(intent);call.resolve(new JSObject().put("opened",true));}catch(Exception e){call.reject("无法打开系统安装器，请检查允许安装未知应用的设置。");}});
        } catch(Exception e){call.reject(e.getMessage());}});
    }
    @Override protected void handleOnDestroy(){cancelled=true;if(connection!=null)connection.disconnect();executor.shutdownNow();super.handleOnDestroy();}
}
