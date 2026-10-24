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

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Periodic check of the watched Moodle courses: fetches each course's
 * contents, compares with the snapshot the app last saw (plus what this
 * worker already reported), and notifies about new files and activities.
 */
public class MoodleCheckWorker extends Worker {
    private static final String CHANNEL_ID = "moodle-updates";
    private static final int NOTIFICATION_ID = 90001;

    public MoodleCheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = context.getSharedPreferences(MoodleBackgroundPlugin.PREFS, Context.MODE_PRIVATE);
        String siteUrl = prefs.getString("siteUrl", "");
        String token = prefs.getString("token", "");
        if (!prefs.getBoolean("enabled", false) || siteUrl.isEmpty() || token.isEmpty()) {
            return Result.success();
        }

        try {
            JSONArray courses = new JSONArray(prefs.getString("courses", "[]"));
            JSONObject snapshot = new JSONObject(prefs.getString("snapshot", "{}"));
            boolean firstRun = snapshot.length() == 0;
            JSONObject updated = new JSONObject();
            List<String> newLines = new ArrayList<>();
            int newCount = 0;

            for (int i = 0; i < courses.length(); i++) {
                JSONObject course = courses.getJSONObject(i);
                int courseId = course.getInt("id");
                String courseName = shortCourseName(course.optString("name", ""));

                JSONArray sections = fetchContents(siteUrl, token, courseId);
                if (sections == null) {
                    // Keep the old snapshot entries of a course that failed.
                    copyCourseEntries(snapshot, updated, courseId);
                    continue;
                }

                for (int s = 0; s < sections.length(); s++) {
                    JSONArray modules = sections.getJSONObject(s).optJSONArray("modules");
                    if (modules == null) {
                        continue;
                    }
                    for (int m = 0; m < modules.length(); m++) {
                        JSONObject module = modules.getJSONObject(m);
                        if ("label".equals(module.optString("modname"))) {
                            continue;
                        }
                        if (module.optInt("visible", 1) == 0 || !module.optBoolean("uservisible", true)) {
                            continue;
                        }
                        int cmid = module.getInt("id");
                        JSONArray contents = module.optJSONArray("contents");
                        boolean hasFiles = false;
                        if (contents != null && !"assign".equals(module.optString("modname"))) {
                            for (int c = 0; c < contents.length(); c++) {
                                JSONObject file = contents.getJSONObject(c);
                                if (!"file".equals(file.optString("type"))) {
                                    continue;
                                }
                                hasFiles = true;
                                String key = "f" + cmid + ":" + file.optString("filename");
                                long time = file.optLong("timemodified", 0) * 1000;
                                updated.put(key, time);
                                if (!firstRun && isNew(snapshot, key, time)) {
                                    newCount++;
                                    if (newLines.size() < 6) {
                                        newLines.add(courseName + ": " + module.optString("name") +
                                            (file.optString("filename").equals(module.optString("name")) ? "" : " (" + file.optString("filename") + ")"));
                                    }
                                }
                            }
                        }
                        if (!hasFiles) {
                            String key = "m" + cmid;
                            long time = module.optLong("timemodified", 0) * 1000;
                            updated.put(key, time);
                            if (!firstRun && isNew(snapshot, key, time)) {
                                newCount++;
                                if (newLines.size() < 6) {
                                    String label = "assign".equals(module.optString("modname")) ? "תרגיל בית: " : "";
                                    newLines.add(courseName + ": " + label + module.optString("name"));
                                }
                            }
                        }
                    }
                }
            }

            SharedPreferences.Editor editor = prefs.edit();
            editor.putString("snapshot", updated.toString());
            editor.putLong("lastCheck", System.currentTimeMillis());
            editor.putString("lastError", "");
            editor.putInt("lastNewCount", newCount);
            editor.apply();

            if (newCount > 0) {
                notifyNewItems(context, newCount, newLines);
            }
            return Result.success();
        } catch (Exception e) {
            prefs.edit().putString("lastError", String.valueOf(e.getMessage())).apply();
            return Result.retry();
        }
    }

    private static boolean isNew(JSONObject snapshot, String key, long time) {
        if (!snapshot.has(key)) {
            return true;
        }
        return time > snapshot.optLong(key, 0);
    }

    private static void copyCourseEntries(JSONObject from, JSONObject to, int courseId) throws Exception {
        // Keys don't carry the course id, so keep everything we can't re-check.
        Iterator<String> keys = from.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!to.has(key)) {
                to.put(key, from.getLong(key));
            }
        }
    }

    private static String shortCourseName(String name) {
        String trimmed = name.replaceFirst("^\\d{6,10}\\s*[-–:]\\s*", "");
        return trimmed.length() > 28 ? trimmed.substring(0, 27) + "…" : trimmed;
    }

    private static JSONArray fetchContents(String siteUrl, String token, int courseId) {
        HttpURLConnection connection = null;
        try {
            String url = siteUrl.replaceAll("/$", "") + "/webservice/rest/server.php" +
                "?wstoken=" + URLEncoder.encode(token, "UTF-8") +
                "&wsfunction=core_course_get_contents&moodlewsrestformat=json" +
                "&courseid=" + courseId +
                "&options[0][name]=excludemodules&options[0][value]=0";
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(30000);
            connection.setRequestProperty("Accept", "application/json");
            if (connection.getResponseCode() != 200) {
                return null;
            }
            BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), "UTF-8"));
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
            reader.close();
            String body = builder.toString().trim();
            if (body.startsWith("{")) {
                // An exception object (invalid token etc.).
                return null;
            }
            return new JSONArray(body);
        } catch (Exception e) {
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static void notifyNewItems(Context context, int count, List<String> lines) {
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

        Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(context.getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(lines.isEmpty() ? "" : lines.get(0))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text.toString()))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build();
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification);
    }
}
