package cf.cheesefork.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * Moodle login inside the app (Technion SSO through Microsoft). When a
 * Moodle page loads for a logged-in user, the session key is read from the
 * page and the activity returns; the session cookies stay in the shared
 * WebView cookie store for MoodleSession.
 */
public class MoodleLoginActivity extends Activity {
    private WebView webView;
    private String siteHost;
    private boolean finished;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String site = getIntent().getStringExtra("site");
        if (site == null || site.isEmpty()) {
            setResult(RESULT_CANCELED);
            finish();
            return;
        }
        site = site.replaceAll("/$", "");
        siteHost = Uri.parse(site).getHost();

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        int padding = (int) (8 * getResources().getDisplayMetrics().density);
        bar.setPadding(padding * 2, padding, padding, padding);
        bar.setBackgroundColor(Color.parseColor("#F8F9FA"));

        TextView title = new TextView(this);
        title.setText("התחברות ל-Moodle");
        title.setTextColor(Color.parseColor("#212529"));
        title.setTextSize(17);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

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
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (int) (4 * getResources().getDisplayMetrics().density)));

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
                checkLoggedIn(url);
            }
        });

        // The dashboard needs a real login: it redirects to the login page
        // when needed, and comes back here after the SSO.
        webView.loadUrl(site + "/my/");
    }

    private void checkLoggedIn(String url) {
        if (finished || url == null) {
            return;
        }
        Uri uri = Uri.parse(url);
        if (siteHost == null || !siteHost.equalsIgnoreCase(uri.getHost()) || MoodleSession.isLoginUrl(url)) {
            return;
        }
        String script = "(function(){try{" +
            "if(document.body.classList.contains('notloggedin'))return '';" +
            "return (window.M&&M.cfg&&M.cfg.sesskey)||'';" +
            "}catch(e){return '';}})()";
        webView.evaluateJavascript(script, value -> {
            if (finished || value == null) {
                return;
            }
            String sesskey = value.replace("\"", "").trim();
            if (sesskey.isEmpty() || sesskey.equals("null")) {
                return;
            }
            finished = true;
            String site = uri.getScheme() + "://" + uri.getHost();
            CookieManager.getInstance().flush();
            MoodleSession.saveLogin(this, site, sesskey);
            Intent result = new Intent();
            result.putExtra("site", site);
            result.putExtra("sesskey", sesskey);
            setResult(RESULT_OK, result);
            finish();
        });
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
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
