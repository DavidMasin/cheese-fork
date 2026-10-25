package cf.cheesefork.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Moodle login inside the app (Technion SSO through Microsoft). Every Moodle
 * page is asked for Moodle's own configuration (M.cfg: site root and session
 * key) and whether the user is logged in; as soon as it is, the activity
 * returns. The session cookies stay in the shared WebView cookie store for
 * MoodleSession. The check runs after each page load, every two seconds, and
 * on the "done" button (which also shows what it found).
 */
public class MoodleLoginActivity extends Activity {
    private static final long POLL_MS = 2000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private TextView status;
    private String site;
    private boolean finished;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (finished) {
                return;
            }
            check(false);
            handler.postDelayed(this, POLL_MS);
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        site = getIntent().getStringExtra("site");
        if (site == null || site.isEmpty()) {
            setResult(RESULT_CANCELED);
            finish();
            return;
        }
        site = site.replaceAll("/$", "");
        float density = getResources().getDisplayMetrics().density;
        int padding = (int) (8 * density);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#F8F9FA"));
        // Android 15 draws apps edge to edge; keep the bar below the status bar
        // and the page above the navigation bar / keyboard.
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int top;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(0, top, 0, bottom);
            return insets;
        });

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        bar.setPadding(padding * 2, padding, padding, padding);
        bar.setBackgroundColor(Color.parseColor("#F8F9FA"));

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(this);
        title.setText("התחברות ל-Moodle");
        title.setTextColor(Color.parseColor("#212529"));
        title.setTextSize(17);
        texts.addView(title);
        status = new TextView(this);
        String version = "";
        try {
            version = " · גרסה " + getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            // Ignore.
        }
        status.setText("התחברו כרגיל. המסך ייסגר מעצמו כשתיכנסו." + version);
        status.setTextColor(Color.parseColor("#6C757D"));
        status.setTextSize(12);
        texts.addView(status);
        bar.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        Button done = new Button(this);
        done.setText("סיימתי");
        done.setOnClickListener(v -> check(true));
        bar.addView(done);

        Button cancel = new Button(this);
        cancel.setText("ביטול");
        cancel.setOnClickListener(v -> {
            setResult(RESULT_CANCELED);
            finish();
        });
        bar.addView(cancel);
        root.addView(bar);

        ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (int) (4 * density)));

        webView = new WebView(this);
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (Exception e) {
                    // No app for this link.
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                check(false);
            }
        });

        // The dashboard needs a real login: it redirects to the login page
        // when needed, and comes back here after the SSO.
        webView.loadUrl(site + "/my/");
        handler.postDelayed(poll, POLL_MS);
    }

    private static boolean isIdentityProvider(String url) {
        if (url == null) {
            return true;
        }
        String lower = url.toLowerCase();
        return lower.contains("microsoftonline.com") || lower.contains("login.live.com") || lower.contains("microsoft.com");
    }

    // Asks the current page for Moodle's configuration and login state.
    private void check(boolean manual) {
        if (finished || webView == null) {
            return;
        }
        String url = webView.getUrl();
        if (!manual && isIdentityProvider(url)) {
            return;
        }
        String script = "(function(){try{" +
            "var c=(window.M&&M.cfg)||{};" +
            "var b=document.body;" +
            "return JSON.stringify({root:c.wwwroot||'',sesskey:c.sesskey||''," +
            "guest:b?b.classList.contains('notloggedin'):true," +
            "path:location.pathname,host:location.host});" +
            "}catch(e){return JSON.stringify({error:String(e)});}})()";
        webView.evaluateJavascript(script, value -> handleCheck(value, url, manual));
    }

    private void handleCheck(String value, String url, boolean manual) {
        if (finished) {
            return;
        }
        String root = "";
        String sesskey = "";
        boolean guest = true;
        String path = "";
        String host = url == null ? "" : String.valueOf(Uri.parse(url).getHost());
        try {
            // evaluateJavascript returns a JSON-encoded string.
            String json = new JSONArray("[" + value + "]").getString(0);
            JSONObject info = new JSONObject(json);
            root = info.optString("root", "");
            sesskey = info.optString("sesskey", "");
            guest = info.optBoolean("guest", true);
            path = info.optString("path", "");
            host = info.optString("host", host);
        } catch (Exception e) {
            // Not a Moodle page (or not loaded yet).
        }

        boolean loggedIn = !root.isEmpty() && !sesskey.isEmpty() && !guest && !path.contains("/login/");
        if (loggedIn) {
            finished = true;
            handler.removeCallbacks(poll);
            status.setText("מחובר! חוזר לאפליקציה...");
            String moodleRoot = root.replaceAll("/$", "");
            CookieManager.getInstance().flush();
            MoodleSession.saveLogin(this, moodleRoot, sesskey);
            Intent result = new Intent();
            result.putExtra("site", moodleRoot);
            result.putExtra("sesskey", sesskey);
            setResult(RESULT_OK, result);
            finish();
            return;
        }

        if (manual) {
            String reason;
            if (root.isEmpty()) {
                reason = "זה לא דף של Moodle (" + host + "). חוזר ל-Moodle...";
                webView.loadUrl(site + "/my/");
            } else if (guest || path.contains("/login/")) {
                reason = "עדיין לא מחוברים ב-" + host + ". התחברו ואז לחצו שוב.";
            } else {
                reason = "Moodle לא החזיר מפתח התחברות (" + host + path + ").";
            }
            status.setText(reason);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        setResult(RESULT_CANCELED);
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(poll);
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
