package app.gakutaku;

import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Edge-to-edge layout on every Android version (Android 15 enforces it anyway): the app draws
 * behind the status and navigation bars, and this plugin tells the page how big they are so it
 * can pad its bars, in CSS pixels. The keyboard is handled here instead: the WebView is shortened
 * by the keyboard's height, as adjustResize did before edge-to-edge.
 */
@CapacitorPlugin(name = "SystemBars")
public class SystemBarsPlugin extends Plugin {

    private JSObject last = insetsObject(0, 0, 0, 0);

    @Override
    public void load() {
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.setNavigationBarContrastEnforced(false);
            }

            View webView = getBridge().getWebView();
            ViewCompat.setOnApplyWindowInsetsListener(webView, (v, windowInsets) -> {
                Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                boolean keyboard = ime.bottom > bars.bottom;

                // Keyboard up: shrink the WebView so focused inputs stay visible above it.
                ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
                int bottomMargin = keyboard ? ime.bottom : 0;
                if (lp.bottomMargin != bottomMargin) {
                    lp.bottomMargin = bottomMargin;
                    v.setLayoutParams(lp);
                }

                float d = v.getResources().getDisplayMetrics().density;
                JSObject next = insetsObject(
                    Math.round(bars.top / d),
                    keyboard ? 0 : Math.round(bars.bottom / d),
                    Math.round(bars.left / d),
                    Math.round(bars.right / d)
                );
                if (!next.toString().equals(last.toString())) {
                    last = next;
                    notifyListeners("change", next, true);
                }
                return windowInsets;
            });
            ViewCompat.requestApplyInsets(webView);
        });
    }

    private static JSObject insetsObject(int top, int bottom, int left, int right) {
        JSObject o = new JSObject();
        o.put("top", top);
        o.put("bottom", bottom);
        o.put("left", left);
        o.put("right", right);
        return o;
    }

    /** The current bar sizes in CSS pixels. */
    @PluginMethod
    public void get(PluginCall call) {
        call.resolve(last);
    }

    /** Dark app theme → light status/navigation bar icons, and vice versa. */
    @PluginMethod
    public void setStyle(PluginCall call) {
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(!dark);
            controller.setAppearanceLightNavigationBars(!dark);
            call.resolve();
        });
    }
}
