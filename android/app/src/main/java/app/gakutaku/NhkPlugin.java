package app.gakutaku;

import android.app.Dialog;
import android.graphics.Color;
import android.net.Uri;
import android.util.Base64;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;

/**
 * NHK's web news (news.web.nhk, including やさしいことばニュース) is only served once the reader has
 * agreed to NHK's terms on the site, which NHK records in cookies. `agree` shows NHK's page so the
 * user can do that, and `get` fetches NHK pages with the same cookie store, natively. The cookies
 * stay inside Android's WebView cookie store: nothing here hands their values to the web layer, and
 * `get` only talks to web.nhk hosts.
 */
@CapacitorPlugin(name = "Nhk")
public class NhkPlugin extends Plugin {
    private static final String START_URL = "https://news.web.nhk/news/easy/";

    private static boolean isNhk(String url) {
        String host = Uri.parse(url).getHost();
        return host != null && (host.equals("web.nhk") || host.endsWith(".web.nhk")) && url.startsWith("https://");
    }

    @PluginMethod
    public void agree(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            CookieManager cookies = CookieManager.getInstance();
            cookies.setAcceptCookie(true);

            Dialog dialog = new Dialog(getActivity(), android.R.style.Theme_DeviceDefault_Light_NoActionBar);
            LinearLayout root = new LinearLayout(getContext());
            root.setOrientation(LinearLayout.VERTICAL);

            LinearLayout bar = new LinearLayout(getContext());
            bar.setOrientation(LinearLayout.HORIZONTAL);
            bar.setGravity(Gravity.CENTER_VERTICAL);
            bar.setPadding(32, 16, 16, 16);
            bar.setBackgroundColor(Color.parseColor("#F4EFE6"));
            TextView title = new TextView(getContext());
            title.setText("Agree to NHK's terms (同意), then tap Done");
            title.setTextColor(Color.parseColor("#26221D"));
            title.setTextSize(15);
            bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            Button done = new Button(getContext());
            done.setText("Done");
            bar.addView(done, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

            WebView web = new WebView(getContext());
            WebSettings settings = web.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            web.setWebViewClient(new WebViewClient());
            root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

            done.setOnClickListener(v -> dialog.dismiss());
            dialog.setOnDismissListener(d -> {
                cookies.flush();
                web.destroy();
                call.resolve();
            });
            dialog.setContentView(root);
            dialog.show();
            web.loadUrl(START_URL);
        });
    }

    /** GET an NHK URL with the WebView cookie store (runs on the plugin's background thread). */
    @PluginMethod
    public void get(PluginCall call) {
        String url = call.getString("url", "");
        if (!isNhk(url)) {
            call.reject("Only NHK (web.nhk) addresses are allowed.");
            return;
        }
        CookieManager cookies = CookieManager.getInstance();
        HttpURLConnection conn = null;
        try {
            String current = url;
            for (int hop = 0; hop < 5; hop++) {
                conn = (HttpURLConnection) new URL(current).openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(15000);
                conn.setRequestProperty("Accept", "text/html,application/json,application/xml,*/*");
                conn.setRequestProperty("Accept-Language", "ja,en;q=0.8");
                String cookie = cookies.getCookie(current);
                if (cookie != null) conn.setRequestProperty("Cookie", cookie);
                int status = conn.getResponseCode();
                Map<String, List<String>> headers = conn.getHeaderFields();
                List<String> setCookies = headers.get("Set-Cookie");
                if (setCookies != null) for (String c : setCookies) cookies.setCookie(current, c);
                if (status >= 300 && status < 400 && conn.getHeaderField("Location") != null) {
                    String next = new URL(new URL(current), conn.getHeaderField("Location")).toString();
                    conn.disconnect();
                    if (!isNhk(next)) {
                        call.reject("NHK redirected outside web.nhk.");
                        return;
                    }
                    current = next;
                    continue;
                }
                InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                byte[] body = in == null ? new byte[0] : readAll(in);
                cookies.flush();
                JSObject ret = new JSObject();
                ret.put("status", status);
                ret.put("url", current);
                ret.put("contentType", conn.getContentType() == null ? "" : conn.getContentType());
                ret.put("data", Base64.encodeToString(body, Base64.NO_WRAP));
                call.resolve(ret);
                return;
            }
            call.reject("Too many redirects.");
        } catch (IOException e) {
            call.reject("Couldn't reach NHK: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }
}
