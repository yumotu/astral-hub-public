package app.astral.hub;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.content.Intent;
import android.provider.Settings;

@CapacitorPlugin(name = "AppAppearance")
public class AppAppearancePlugin extends Plugin {
    @PluginMethod public void openNotificationSettings(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            getActivity().startActivity(intent);
            call.resolve();
        });
    }
    @PluginMethod public void setTheme(PluginCall call) {
        String appearance = call.getString("appearance");
        if (!"dark".equals(appearance) && !"light".equals(appearance)) {
            call.reject("主题应为 light 或 dark。");
            return;
        }
        String background = call.getString("background", "dark".equals(appearance) ? "#17191c" : "#ffffff");
        if (!background.matches("^#[0-9a-fA-F]{6}$")) { call.reject("背景颜色格式不正确。"); return; }
        getActivity().runOnUiThread(() -> {
            ((MainActivity) getActivity()).applyAppearance("dark".equals(appearance), background);
            call.resolve();
        });
    }
}
