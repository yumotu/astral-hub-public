package app.astral.hub;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.os.Build;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.activity.OnBackPressedCallback;
import android.view.WindowManager;
import android.view.ViewGroup;
import androidx.core.graphics.Insets;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppUpdatesPlugin.class);
        registerPlugin(AppAppearancePlugin.class);
        registerPlugin(MailLinksPlugin.class);
        registerPlugin(SpeechInputPlugin.class);
        super.onCreate(savedInstanceState);
        restoreAppearance();
        configureKeyboardInsets();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                android.view.View decor = getWindow().getDecorView();
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
                if (insets != null && insets.isVisible(WindowInsetsCompat.Type.ime())) {
                    WindowCompat.getInsetsController(getWindow(), decor).hide(WindowInsetsCompat.Type.ime());
                    return;
                }
                // Consume one web layer; never finish or reload and lose drafts/tasks.
                getBridge().getWebView().evaluateJavascript(
                    "window.dispatchEvent(new Event('astral-native-back',{cancelable:true}))",
                    unhandled -> { if ("true".equals(unhandled)) moveTaskToBack(true); });
            }
        });
    }

    private Boolean keyboardVisible;
    private void configureKeyboardInsets() {
        if (Build.VERSION.SDK_INT < 35) {
            getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            return;
        }
        // Edge-to-edge windows do not reliably resize for IME. The app owns one
        // inset calculation; max(IME,bars) avoids adding the navigation bar twice.
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
        android.webkit.WebView web = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(web, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams margins = (ViewGroup.MarginLayoutParams)view.getLayoutParams();
            int bottom = Math.max(bars.bottom, ime.bottom);
            if (margins.leftMargin != bars.left || margins.topMargin != bars.top
                    || margins.rightMargin != bars.right || margins.bottomMargin != bottom) {
                margins.setMargins(bars.left, bars.top, bars.right, bottom);
                view.setLayoutParams(margins);
            }
            boolean visible = insets.isVisible(WindowInsetsCompat.Type.ime());
            if (keyboardVisible == null || keyboardVisible != visible) {
                keyboardVisible = visible;
                web.evaluateJavascript("window.dispatchEvent(new CustomEvent('astral-native-keyboard',{detail:{open:"
                    + visible + "}}))", null);
            }
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(web);
    }

    void applyAppearance(boolean dark) {
        applyAppearance(dark, dark ? "#17191c" : "#ffffff");
    }

    void applyAppearance(boolean dark, String background) {
        int color = Color.parseColor(background);
        getPreferences(MODE_PRIVATE).edit().putBoolean("astral.dark", dark).putString("astral.background", background).apply();
        getWindow().setBackgroundDrawable(new ColorDrawable(color));
        getWindow().getDecorView().setBackgroundColor(color);
        // Android 15 draws transparent system bars over this native background.
        if (Build.VERSION.SDK_INT < 35) {
            getWindow().setStatusBarColor(color);
            getWindow().setNavigationBarColor(color);
        }
        if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(
            getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(!dark);
        bars.setAppearanceLightNavigationBars(!dark);
    }

    private void restoreAppearance() {
        boolean dark = getPreferences(MODE_PRIVATE).getBoolean("astral.dark", true);
        String background = getPreferences(MODE_PRIVATE).getString("astral.background", dark ? "#17191c" : "#ffffff");
        applyAppearance(dark, background);
    }

    @Override public void onResume() {
        super.onResume();
        restoreAppearance();
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        restoreAppearance();
    }
}
