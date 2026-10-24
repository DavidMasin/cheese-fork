package cf.cheesefork.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.TimeUnit;

/**
 * Schedules the periodic Moodle check (MoodleCheckWorker) and stores what it
 * needs: site, token, the courses to watch and the snapshot the app last saw.
 */
@CapacitorPlugin(name = "MoodleBackground")
public class MoodleBackgroundPlugin extends Plugin {
    static final String PREFS = "cheesefork_moodle";
    static final String WORK_NAME = "cheesefork-moodle-check";

    @PluginMethod
    public void configure(PluginCall call) {
        Context context = getContext();
        SharedPreferences.Editor editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        editor.putString("siteUrl", call.getString("siteUrl", ""));
        editor.putString("token", call.getString("token", ""));
        editor.putString("courses", call.getArray("courses") != null ? call.getArray("courses").toString() : "[]");
        editor.putString("snapshot", call.getObject("snapshot") != null ? call.getObject("snapshot").toString() : "{}");
        editor.putBoolean("enabled", true);
        editor.apply();

        int minutes = call.getInt("intervalMinutes", 30);
        if (minutes < 15) {
            minutes = 15;
        }

        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(MoodleCheckWorker.class, minutes, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request);

        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        Context context = getContext();
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSObject result = new JSObject();
        result.put("enabled", prefs.getBoolean("enabled", false));
        result.put("lastCheck", prefs.getLong("lastCheck", 0));
        result.put("lastError", prefs.getString("lastError", ""));
        result.put("lastNewCount", prefs.getInt("lastNewCount", 0));
        call.resolve(result);
    }
}
