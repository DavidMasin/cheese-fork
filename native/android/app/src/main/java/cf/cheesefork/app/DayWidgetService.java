package cf.cheesefork.app;

import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import java.util.ArrayList;
import java.util.List;

/** Provides the lesson rows of the day widget's list. */
public class DayWidgetService extends RemoteViewsService {

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new DayWidgetFactory(getApplicationContext());
    }

    private static class DayWidgetFactory implements RemoteViewsFactory {
        private final Context context;
        private List<DayWidgetData.Row> rows = new ArrayList<>();

        DayWidgetFactory(Context context) {
            this.context = context;
        }

        @Override
        public void onCreate() {
            onDataSetChanged();
        }

        @Override
        public void onDataSetChanged() {
            rows = DayWidgetData.load(context).rows;
        }

        @Override
        public void onDestroy() {
            rows = new ArrayList<>();
        }

        @Override
        public int getCount() {
            return rows.size();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_day_item);
            if (position < 0 || position >= rows.size()) {
                return views;
            }
            DayWidgetData.Row row = rows.get(position);
            views.setTextViewText(R.id.widget_item_time, row.time);
            views.setTextViewText(R.id.widget_item_name, row.name);
            views.setTextViewText(R.id.widget_item_details, row.details);
            views.setInt(R.id.widget_item_color, "setBackgroundColor", row.color);
            views.setFloat(R.id.widget_item_root, "setAlpha", row.done ? 0.5f : 1f);
            views.setInt(R.id.widget_item_root, "setBackgroundResource",
                row.current ? R.drawable.widget_item_current : 0);
            views.setOnClickFillInIntent(R.id.widget_item_root, new Intent());
            return views;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public boolean hasStableIds() {
            return false;
        }
    }
}
