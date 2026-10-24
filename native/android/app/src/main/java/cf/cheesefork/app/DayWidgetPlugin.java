package cf.cheesefork.app;

import android.content.Context;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Receives the schedule from the web app and stores it for the home screen
 * widget. Called from mobile/cheesefork-mobile.js on every schedule change.
 */
@CapacitorPlugin(name = "DayWidget")
public class DayWidgetPlugin extends Plugin {

    @PluginMethod
    public void update(PluginCall call) {
        Context context = getContext();
        context.getSharedPreferences(DayWidgetData.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(DayWidgetData.KEY_DATA, call.getData().toString())
            .apply();
        DayWidgetProvider.refreshAll(context);
        call.resolve();
    }
}
