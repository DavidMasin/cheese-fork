package cf.cheesefork.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Builds the content of the day widget from the schedule saved by
 * DayWidgetPlugin: today's lessons, or the next day with lessons once today
 * is over (or on days off / weekends).
 */
public class DayWidgetData {
    static final String PREFS = "cheesefork_widget";
    static final String KEY_DATA = "schedule";

    private static final String[] DAY_NAMES = {"ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"};

    public static class Row {
        public String time;
        public String name;
        public String details;
        public int color;
        public boolean current;
        public boolean done;
    }

    public static class Content {
        public String title = "";
        public String subtitle = "";
        public String tasks = "";
        public List<Row> rows = new ArrayList<>();
    }

    private static String tasksLine(JSONObject data) {
        JSONArray tasks = data.optJSONArray("tasks");
        if (tasks == null || tasks.length() == 0) {
            return "";
        }
        StringBuilder builder = new StringBuilder("מטלות: ");
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task == null) {
                continue;
            }
            if (i > 0) {
                builder.append(" · ");
            }
            builder.append(task.optString("title", ""));
            int daysLeft = task.optInt("daysLeft", -1);
            if (daysLeft == 0) {
                builder.append(" (היום)");
            } else if (daysLeft == 1) {
                builder.append(" (מחר)");
            } else if (daysLeft > 1) {
                builder.append(" (").append(daysLeft).append(" ימים)");
            }
        }
        return builder.toString();
    }

    public static Content load(Context context) {
        Content content = new Content();
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String json = prefs.getString(KEY_DATA, null);

        if (json == null) {
            content.title = "CheeseFork";
            content.subtitle = "פתחו את האפליקציה כדי לטעון את המערכת";
            return content;
        }

        try {
            JSONObject data = new JSONObject(json);
            content.tasks = tasksLine(data);
            JSONArray items = data.optJSONArray("items");
            if (items == null) {
                items = new JSONArray();
            }

            Set<String> daysOff = new HashSet<>();
            JSONArray daysOffArray = data.optJSONArray("daysOff");
            if (daysOffArray != null) {
                for (int i = 0; i < daysOffArray.length(); i++) {
                    daysOff.add(daysOffArray.optString(i));
                }
            }

            Calendar now = Calendar.getInstance();
            SimpleDateFormat isoDate = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            SimpleDateFormat shortDate = new SimpleDateFormat("dd/MM", Locale.US);
            String today = isoDate.format(now.getTime());

            String semesterStart = data.optString("semesterStart", "");
            String semesterEnd = data.optString("semesterEnd", "");
            if (!semesterEnd.isEmpty() && today.compareTo(semesterEnd) > 0) {
                content.title = "הסמסטר הסתיים";
                content.subtitle = "בהצלחה במבחנים!";
                return content;
            }
            if (!semesterStart.isEmpty() && today.compareTo(semesterStart) < 0) {
                content.title = "הסמסטר מתחיל ב-" + formatIso(semesterStart, isoDate, shortDate);
                content.subtitle = "";
                return content;
            }

            if (items.length() == 0) {
                content.title = "אין שיעורים במערכת";
                content.subtitle = "בחרו מקצועות באפליקציה";
                return content;
            }

            int todayDow = now.get(Calendar.DAY_OF_WEEK) - 1; // 0 = Sunday
            int nowMin = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);

            for (int offset = 0; offset < 8; offset++) {
                Calendar day = (Calendar) now.clone();
                day.add(Calendar.DAY_OF_MONTH, offset);
                int dow = (todayDow + offset) % 7;
                String dayKey = isoDate.format(day.getTime());

                if (daysOff.contains(dayKey)) {
                    continue;
                }

                List<JSONObject> dayItems = itemsOfDay(items, dow);
                if (dayItems.isEmpty()) {
                    continue;
                }

                boolean allDone = true;
                for (JSONObject item : dayItems) {
                    if (item.optInt("endMin") > nowMin) {
                        allDone = false;
                        break;
                    }
                }
                if (offset == 0 && allDone) {
                    continue;
                }

                if (offset == 0) {
                    content.title = "היום · יום " + DAY_NAMES[dow];
                } else if (offset == 1) {
                    content.title = "מחר · יום " + DAY_NAMES[dow];
                } else {
                    content.title = "יום " + DAY_NAMES[dow];
                }
                content.subtitle = shortDate.format(day.getTime()) +
                    (daysOff.contains(today) && offset > 0 ? " · היום אין לימודים" : "");

                for (JSONObject item : dayItems) {
                    Row row = new Row();
                    int startMin = item.optInt("startMin");
                    int endMin = item.optInt("endMin");
                    row.time = formatMinutes(startMin) + "-" + formatMinutes(endMin);
                    row.name = item.optString("name", "");

                    StringBuilder details = new StringBuilder();
                    appendDetail(details, item.optString("type", ""));
                    appendDetail(details, item.optString("location", ""));
                    appendDetail(details, item.optString("staff", ""));
                    row.details = details.toString();

                    row.color = parseColor(item.optString("color", ""));
                    row.current = offset == 0 && startMin <= nowMin && nowMin < endMin;
                    row.done = offset == 0 && endMin <= nowMin;
                    content.rows.add(row);
                }
                return content;
            }

            content.title = "אין שיעורים השבוע";
            content.subtitle = "";
        } catch (Exception e) {
            content.title = "CheeseFork";
            content.subtitle = "שגיאה בטעינת המערכת";
        }

        return content;
    }

    private static List<JSONObject> itemsOfDay(JSONArray items, int dow) {
        List<JSONObject> result = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item != null && item.optInt("day", -1) == dow) {
                result.add(item);
            }
        }
        Collections.sort(result, (a, b) -> {
            int diff = a.optInt("startMin") - b.optInt("startMin");
            return diff != 0 ? diff : a.optInt("endMin") - b.optInt("endMin");
        });
        return result;
    }

    private static void appendDetail(StringBuilder builder, String value) {
        if (value == null || value.isEmpty()) {
            return;
        }
        if (builder.length() > 0) {
            builder.append(" · ");
        }
        builder.append(value);
    }

    private static String formatMinutes(int minutes) {
        return String.format(Locale.US, "%02d:%02d", (minutes / 60) % 24, minutes % 60);
    }

    private static String formatIso(String iso, SimpleDateFormat parser, SimpleDateFormat formatter) {
        try {
            Date date = parser.parse(iso);
            return date == null ? iso : formatter.format(date);
        } catch (Exception e) {
            return iso;
        }
    }

    private static int parseColor(String color) {
        try {
            return android.graphics.Color.parseColor(color);
        } catch (Exception e) {
            return 0xFF999999;
        }
    }
}
