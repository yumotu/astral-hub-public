package app.astral.hub;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URI;

@CapacitorPlugin(name = "AstralMailLinks")
public class MailLinksPlugin extends Plugin {
    static boolean validLink(String value) {
        if (value == null || value.length() > 4096) return false;
        for (char c : value.toCharArray()) if (c <= 32 || (c >= 127 && c <= 159)) return false;
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            if ("mailto".equalsIgnoreCase(scheme)) return !value.toLowerCase(java.util.Locale.ROOT).matches(".*%0[ad].*");
            return ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme))
                && uri.getHost() != null && uri.getUserInfo() == null;
        } catch (Exception e) { return false; }
    }
    @PluginMethod public void open(PluginCall call) {
        String value = call.getString("url");
        if (!validLink(value)) { call.reject("不支持此邮件链接。"); return; }
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(value)).addCategory(Intent.CATEGORY_BROWSABLE));
                JSObject result = new JSObject(); result.put("opened", true); call.resolve(result);
            } catch (Exception e) { call.reject("当前设备没有能够打开此链接的应用。"); }
        });
    }
}
