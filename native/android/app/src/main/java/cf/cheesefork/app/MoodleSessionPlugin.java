package cf.cheesefork.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.CookieManager;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Moodle with a browser session: login screen, AJAX calls, page fetches and
 * opening files, all with the session cookies of MoodleLoginActivity.
 */
@CapacitorPlugin(name = "MoodleSession")
public class MoodleSessionPlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void login(PluginCall call) {
        String site = call.getString("siteUrl", "");
        if (site == null || site.isEmpty()) {
            call.reject("siteUrl is required");
            return;
        }
        Intent intent = new Intent(getContext(), MoodleLoginActivity.class);
        intent.putExtra("site", site);
        startActivityForResult(call, intent, "onLoginResult");
    }

    @ActivityCallback
    private void onLoginResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        JSObject response = new JSObject();
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            response.put("loggedIn", true);
            response.put("site", result.getData().getStringExtra("site"));
        } else {
            response.put("loggedIn", false);
        }
        call.resolve(response);
    }

    @PluginMethod
    public void status(PluginCall call) {
        Context context = getContext();
        String site = MoodleSession.site(context);
        String cookies = null;
        try {
            cookies = site.isEmpty() ? null : CookieManager.getInstance().getCookie(site);
        } catch (Exception e) {
            // Ignore.
        }
        JSObject response = new JSObject();
        response.put("site", site);
        response.put("loggedIn", !MoodleSession.sesskey(context).isEmpty() && cookies != null && cookies.contains("MoodleSession"));
        call.resolve(response);
    }

    @PluginMethod
    public void ajax(PluginCall call) {
        String method = call.getString("methodname", "");
        String args = call.getString("args", "{}");
        executor.execute(() -> {
            try {
                String data = MoodleSession.ajax(getContext(), method, args);
                JSObject response = new JSObject();
                response.put("data", data);
                call.resolve(response);
            } catch (MoodleSession.SessionExpiredException e) {
                JSObject response = new JSObject();
                response.put("expired", true);
                call.resolve(response);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Moodle request failed" : e.getMessage());
            }
        });
    }

    @PluginMethod
    public void getPage(PluginCall call) {
        String url = call.getString("url", "");
        executor.execute(() -> {
            try {
                MoodleSession.Response page = MoodleSession.get(url);
                JSObject response = new JSObject();
                if (MoodleSession.isLoginUrl(page.finalUrl)) {
                    response.put("expired", true);
                } else {
                    response.put("status", page.status);
                    response.put("url", page.finalUrl);
                    response.put("body", page.body);
                }
                call.resolve(response);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Moodle request failed" : e.getMessage());
            }
        });
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        String url = call.getString("url", "");
        executor.execute(() -> {
            try {
                MoodleSession.Download download = MoodleSession.download(getContext(), url);
                JSObject response = new JSObject();
                if (download.html) {
                    response.put("html", true);
                    response.put("url", download.finalUrl);
                    call.resolve(response);
                    return;
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", download.file);
                Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(uri, download.mimeType);
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(view, download.name);
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().runOnUiThread(() -> {
                    try {
                        getActivity().startActivity(chooser);
                    } catch (ActivityNotFoundException e) {
                        // Nothing can open it; the JS side falls back to the browser.
                    }
                });
                response.put("opened", true);
                response.put("name", download.name);
                call.resolve(response);
            } catch (MoodleSession.SessionExpiredException e) {
                JSObject response = new JSObject();
                response.put("expired", true);
                call.resolve(response);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Download failed" : e.getMessage());
            }
        });
    }

    @PluginMethod
    public void logout(PluginCall call) {
        MoodleSession.logout(getContext());
        call.resolve();
    }
}
