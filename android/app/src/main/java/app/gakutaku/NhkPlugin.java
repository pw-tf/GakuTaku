package app.gakutaku;

import android.app.Dialog;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;

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
 *
 * NHK ONE builds its article pages with its own scripts, so `render` loads an article in a hidden
 * WebView (where NHK's page runs as in a browser, with the agreement already given) and returns the
 * finished page's HTML for the reader to take the text from. `open` shows an NHK page in a dialog.
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
        showDialog(call, START_URL, "Agree to NHK's terms (同意), then tap Done");
    }

    /** Show an NHK page (an article the reader couldn't take apart) in a dialog. */
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url", "");
        if (!isNhk(url)) {
            call.reject("Only NHK (web.nhk) addresses are allowed.");
            return;
        }
        showDialog(call, url, "NHK");
    }

    private void showDialog(PluginCall call, String startUrl, String heading) {
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
            title.setText(heading);
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
            web.loadUrl(startUrl);
        });
    }

    private static final int RENDER_TIMEOUT_MS = 20000;
    private static final int POLL_MS = 600;

    /**
     * Load an NHK page in a hidden WebView, wait until its text stops changing, and return the
     * page's HTML. The WebView sits behind the app (invisible, not touchable) and may only navigate
     * within web.nhk.
     */
    @PluginMethod
    public void render(PluginCall call) {
        String url = call.getString("url", "");
        if (!isNhk(url)) {
            call.reject("Only NHK (web.nhk) addresses are allowed.");
            return;
        }
        getActivity().runOnUiThread(() -> {
            ViewGroup root = getActivity().findViewById(android.R.id.content);
            WebView web = new WebView(getContext());
            WebSettings settings = web.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            web.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return !isNhk(request.getUrl().toString());
                }
            });
            web.setFocusable(false);
            root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

            Handler handler = new Handler(Looper.getMainLooper());
            long started = System.currentTimeMillis();
            int[] last = { -1 };
            int[] steady = { 0 };
            boolean[] done = { false };

            Runnable finish = () -> {
                if (done[0]) return;
                done[0] = true;
                web.evaluateJavascript("document.documentElement ? document.documentElement.outerHTML : ''", html -> {
                    JSObject ret = new JSObject();
                    ret.put("url", web.getUrl() == null ? url : web.getUrl());
                    ret.put("html", decodeJsString(html));
                    root.removeView(web);
                    web.destroy();
                    call.resolve(ret);
                });
            };
            Runnable poll = new Runnable() {
                @Override
                public void run() {
                    if (done[0]) return;
                    if (System.currentTimeMillis() - started > RENDER_TIMEOUT_MS) {
                        finish.run();
                        return;
                    }
                    web.evaluateJavascript("(function(){var b=document.body;return b?b.innerText.length:0})()", value -> {
                        int len;
                        try {
                            len = Integer.parseInt(value.trim());
                        } catch (NumberFormatException e) {
                            len = 0;
                        }
                        // Settled: some text, unchanged over two polls, and the page past its first moments.
                        steady[0] = len > 0 && len == last[0] ? steady[0] + 1 : 0;
                        last[0] = len;
                        if (steady[0] >= 2 && System.currentTimeMillis() - started > 2500) finish.run();
                        else handler.postDelayed(this, POLL_MS);
                    });
                }
            };
            web.loadUrl(url);
            handler.postDelayed(poll, POLL_MS);
        });
    }

    /** `evaluateJavascript` hands back a JSON value; a string result arrives quoted. */
    private static String decodeJsString(String json) {
        if (json == null || json.equals("null")) return "";
        try {
            return new JSONArray("[" + json + "]").getString(0);
        } catch (JSONException e) {
            return "";
        }
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
