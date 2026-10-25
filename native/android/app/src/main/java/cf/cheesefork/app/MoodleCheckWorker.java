package cf.cheesefork.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Periodic Moodle check with the user's session: new deadlines from the
 * calendar (homework, quizzes) and new files/activities from each watched
 * course's resources page, compared with what the app already saw.
 */
public class MoodleCheckWorker extends Worker {
    private static final String CHANNEL_ID = "moodle-updates";
    private static final int NOTIFICATION_ID = 90001;
    private static final int EXPIRED_NOTIFICATION_ID = 90002;

    private static final Pattern MODULE_LINK = Pattern.compile(
        "href=\"[^\"]*/mod/(\\w+)/view\\.php\\?id=(\\d+)[^\"]*\"[^>]*>(.*?)</a>", Pattern.DOTALL);

    public MoodleCheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = MoodleSession.prefs(context);
        String site = MoodleSession.site(context);
        if (!prefs.getBoolean("enabled", false) || site.isEmpty() || MoodleSession.sesskey(context).isEmpty()) {
            return Result.success();
        }

        try {
            JSONArray courses = new JSONArray(prefs.getString("courses", "[]"));
            Set<String> knownCmids = toSet(new JSONArray(prefs.getString("knownCmids", "[]")));
            Set<String> knownEvents = toSet(new JSONArray(prefs.getString("knownEvents", "[]")));
            List<String> lines = new ArrayList<>();
            int newCount = 0;

            // Deadlines (homework, quizzes) from the calendar.
            JSONObject args = new JSONObject();
            args.put("timesortfrom", System.currentTimeMillis() / 1000 - 86400);
            args.put("limitnum", 50);
            args.put("limittononsuspendedevents", true);
            JSONObject eventsData = new JSONObject(MoodleSession.ajax(context, "core_calendar_get_action_events_by_timesort", args.toString()));
            JSONArray events = eventsData.optJSONArray("events");
            boolean firstEvents = knownEvents.isEmpty();
            if (events != null) {
                for (int i = 0; i < events.length(); i++) {
                    JSONObject event = events.getJSONObject(i);
                    String id = String.valueOf(event.optLong("id"));
                    if (knownEvents.add(id) && !firstEvents) {
                        newCount++;
                        if (lines.size() < 6) {
                            String module = event.optString("modulename");
                            String label = "assign".equals(module) ? "תרגיל בית: " : "quiz".equals(module) ? "בוחן: " : "";
                            String name = event.optString("activityname", event.optString("name"));
                            JSONObject course = event.optJSONObject("course");
                            lines.add(shortCourseName(course != null ? course.optString("fullname") : "") + ": " + label + name);
                        }
                    }
                }
            }

            // Files and activities from each course's resources page.
            for (int i = 0; i < courses.length(); i++) {
                JSONObject course = courses.getJSONObject(i);
                MoodleSession.Response page = MoodleSession.get(site + "/course/resources.php?id=" + course.getInt("id"));
                if (MoodleSession.isLoginUrl(page.finalUrl)) {
                    throw new MoodleSession.SessionExpiredException();
                }
                if (page.status != 200) {
                    continue;
                }
                List<String[]> found = new ArrayList<>();
                Matcher matcher = MODULE_LINK.matcher(page.body);
                while (matcher.find()) {
                    found.add(new String[]{matcher.group(2), cleanName(matcher.group(3))});
                }
                boolean courseKnown = false;
                for (String[] item : found) {
                    if (knownCmids.contains(item[0])) {
                        courseKnown = true;
                        break;
                    }
                }
                for (String[] item : found) {
                    if (knownCmids.add(item[0]) && courseKnown) {
                        newCount++;
                        if (lines.size() < 6) {
                            lines.add(shortCourseName(course.optString("name")) + ": " + item[1]);
                        }
                    }
                }
            }

            prefs.edit()
                .putString("knownCmids", new JSONArray(knownCmids).toString())
                .putString("knownEvents", new JSONArray(knownEvents).toString())
                .putLong("lastCheck", System.currentTimeMillis())
                .putString("lastError", "")
                .putInt("lastNewCount", newCount)
                .putBoolean("expiredNotified", false)
                .apply();

            if (newCount > 0) {
                notifyNewItems(context, newCount, lines);
            }
            return Result.success();
        } catch (MoodleSession.SessionExpiredException e) {
            prefs.edit().putString("lastError", "expired").apply();
            if (!prefs.getBoolean("expiredNotified", false)) {
                prefs.edit().putBoolean("expiredNotified", true).apply();
                notify(context, EXPIRED_NOTIFICATION_ID, "ההתחברות ל-Moodle פגה",
                    "פתחו את CheeseFork והתחברו מחדש כדי להמשיך לקבל עדכונים.", null);
            }
            return Result.success();
        } catch (Exception e) {
            prefs.edit().putString("lastError", String.valueOf(e.getMessage())).apply();
            return Result.retry();
        }
    }

    private static Set<String> toSet(JSONArray array) {
        Set<String> set = new HashSet<>();
        for (int i = 0; i < array.length(); i++) {
            set.add(String.valueOf(array.opt(i)));
        }
        return set;
    }

    private static String cleanName(String html) {
        String text = html.replaceAll("<span[^>]*accesshide[^>]*>.*?</span>", "")
            .replaceAll("<[^>]+>", "")
            .replace("&amp;", "&").replace("&quot;", "\"").replace("&#039;", "'").replace("&nbsp;", " ")
            .trim();
        return text.isEmpty() ? "פריט חדש" : text;
    }

    private static String shortCourseName(String name) {
        String trimmed = name.replaceFirst("^\\d{6,10}\\s*[-–:]\\s*", "");
        return trimmed.length() > 28 ? trimmed.substring(0, 27) + "…" : trimmed;
    }

    private static void notifyNewItems(Context context, int count, List<String> lines) {
        String title = count == 1 ? "פריט חדש ב-Moodle" : count + " פריטים חדשים ב-Moodle";
        StringBuilder text = new StringBuilder();
        for (String line : lines) {
            if (text.length() > 0) {
                text.append("\n");
            }
            text.append(line);
        }
        if (count > lines.size()) {
            text.append("\nועוד ").append(count - lines.size()).append("...");
        }
        notify(context, NOTIFICATION_ID, title, lines.isEmpty() ? "" : lines.get(0), text.toString());
    }

    private static void notify(Context context, int id, String title, String text, String bigText) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "חומרים חדשים ב-Moodle", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("קבצים, פעילויות ותרגילי בית שעלו ל-Moodle");
            manager.createNotificationChannel(channel);
        }

        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("cheesefork://tasks"));
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(context, 1, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(context.getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        if (bigText != null) {
            builder.setStyle(new NotificationCompat.BigTextStyle().bigText(bigText));
        }
        Notification notification = builder.build();
        NotificationManagerCompat.from(context).notify(id, notification);
    }
}
