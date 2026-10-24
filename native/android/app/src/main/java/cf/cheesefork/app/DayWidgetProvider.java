package cf.cheesefork.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

/** Home screen widget with today's lessons (what, where, with whom). */
public class DayWidgetProvider extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            appWidgetManager.updateAppWidget(appWidgetId, buildViews(context, appWidgetId));
        }
        appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetIds, R.id.widget_list);
    }

    /** Re-renders every placed widget (called after the app sends new data). */
    public static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, DayWidgetProvider.class));
        if (ids.length == 0) {
            return;
        }
        for (int id : ids) {
            manager.updateAppWidget(id, buildViews(context, id));
        }
        manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    private static RemoteViews buildViews(Context context, int appWidgetId) {
        DayWidgetData.Content content = DayWidgetData.load(context);

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_day);
        views.setTextViewText(R.id.widget_title, content.title);
        views.setTextViewText(R.id.widget_subtitle, content.subtitle);
        views.setTextViewText(R.id.widget_tasks, content.tasks);
        views.setViewVisibility(R.id.widget_tasks, content.tasks.isEmpty() ? android.view.View.GONE : android.view.View.VISIBLE);

        Intent serviceIntent = new Intent(context, DayWidgetService.class);
        serviceIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        // A unique data URI so that the host doesn't reuse the factory between widgets.
        serviceIntent.setData(Uri.parse(serviceIntent.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.widget_list, serviceIntent);
        views.setEmptyView(R.id.widget_list, R.id.widget_empty);

        // Tapping anywhere opens the app.
        Intent launch = new Intent(context, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_root, pendingIntent);
        views.setPendingIntentTemplate(R.id.widget_list, pendingIntent);

        return views;
    }
}
