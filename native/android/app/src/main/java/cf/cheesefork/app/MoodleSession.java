package cf.cheesefork.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Talks to Moodle with the browser session the user created in
 * MoodleLoginActivity (cookies live in the shared WebView cookie store).
 * Used by MoodleSessionPlugin and by the background MoodleCheckWorker.
 */
final class MoodleSession {
    static final String PREFS = "cheesefork_moodle";
    private static final String USER_AGENT_SUFFIX = " CheeseForkApp";

    private MoodleSession() {
    }

    static class SessionExpiredException extends Exception {
        SessionExpiredException() {
            super("Moodle session expired");
        }
    }

    static class Response {
        int status;
        String body;
        String finalUrl;
        String contentType;
        String disposition;
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String site(Context context) {
        return prefs(context).getString("siteUrl", "");
    }

    static String sesskey(Context context) {
        return prefs(context).getString("sesskey", "");
    }

    static void saveLogin(Context context, String site, String sesskey) {
        prefs(context).edit()
            .putString("siteUrl", site)
            .putString("sesskey", sesskey)
            .putBoolean("expiredNotified", false)
            .apply();
    }

    static boolean isLoginUrl(String url) {
        if (url == null) {
            return false;
        }
        String lower = url.toLowerCase();
        return lower.contains("/login/") || lower.contains("/auth/") || lower.contains("login.microsoftonline.com");
    }

    private static String cookieHeader(String url) {
        try {
            return CookieManager.getInstance().getCookie(url);
        } catch (Exception e) {
            return null;
        }
    }

    private static void storeCookies(String url, HttpURLConnection connection) {
        Map<String, List<String>> headers = connection.getHeaderFields();
        if (headers == null) {
            return;
        }
        try {
            CookieManager manager = CookieManager.getInstance();
            for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
                if (entry.getKey() != null && entry.getKey().equalsIgnoreCase("Set-Cookie")) {
                    for (String value : entry.getValue()) {
                        manager.setCookie(url, value);
                    }
                }
            }
            manager.flush();
        } catch (Exception e) {
            // Not critical.
        }
    }

    private static HttpURLConnection open(String url, String method) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(20000);
        connection.setReadTimeout(40000);
        connection.setRequestMethod(method);
        connection.setRequestProperty("User-Agent", System.getProperty("http.agent", "Android") + USER_AGENT_SUFFIX);
        String cookies = cookieHeader(url);
        if (cookies != null && !cookies.isEmpty()) {
            connection.setRequestProperty("Cookie", cookies);
        }
        return connection;
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        int read;
        while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    /** GET with the session cookies, following redirects (max 8). */
    static Response get(String url) throws IOException {
        String current = url;
        for (int hop = 0; hop < 8; hop++) {
            HttpURLConnection connection = open(current, "GET");
            try {
                int status = connection.getResponseCode();
                storeCookies(current, connection);
                if (status >= 300 && status < 400 && connection.getHeaderField("Location") != null) {
                    current = new URL(new URL(current), connection.getHeaderField("Location")).toString();
                    continue;
                }
                Response response = new Response();
                response.status = status;
                response.finalUrl = current;
                response.contentType = connection.getContentType();
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                response.body = stream == null ? "" : new String(readAll(stream), StandardCharsets.UTF_8);
                return response;
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("Too many redirects");
    }

    /** A Moodle AJAX call (lib/ajax/service.php) with the session; returns the "data" JSON. */
    static String ajax(Context context, String method, String argsJson) throws IOException, SessionExpiredException {
        String site = site(context);
        String sesskey = sesskey(context);
        if (site.isEmpty() || sesskey.isEmpty()) {
            throw new SessionExpiredException();
        }
        String url = site + "/lib/ajax/service.php?sesskey=" + sesskey + "&info=" + method;
        JSONArray request = new JSONArray();
        try {
            JSONObject call = new JSONObject();
            call.put("index", 0);
            call.put("methodname", method);
            call.put("args", argsJson == null || argsJson.isEmpty() ? new JSONObject() : new JSONObject(argsJson));
            request.put(call);
        } catch (Exception e) {
            throw new IOException("Bad arguments: " + e.getMessage());
        }

        HttpURLConnection connection = open(url, "POST");
        String body;
        int status;
        try {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "application/json");
            OutputStream output = connection.getOutputStream();
            output.write(request.toString().getBytes(StandardCharsets.UTF_8));
            output.close();
            status = connection.getResponseCode();
            storeCookies(url, connection);
            if (status >= 300 && status < 400) {
                throw new SessionExpiredException();
            }
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            body = stream == null ? "" : new String(readAll(stream), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }

        String trimmed = body.trim();
        if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
            // An HTML login page.
            throw new SessionExpiredException();
        }
        try {
            if (trimmed.startsWith("{")) {
                JSONObject error = new JSONObject(trimmed);
                throw sessionOrError(error.optString("errorcode"), error.optString("error", error.optString("message")));
            }
            JSONObject first = new JSONArray(trimmed).getJSONObject(0);
            if (first.optBoolean("error", false)) {
                JSONObject exception = first.optJSONObject("exception");
                String code = exception != null ? exception.optString("errorcode") : "";
                String message = exception != null ? exception.optString("message") : "error";
                throw sessionOrError(code, message);
            }
            Object data = first.opt("data");
            return data == null ? "null" : data.toString();
        } catch (SessionExpiredException e) {
            throw e;
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("Bad response: " + e.getMessage());
        }
    }

    private static IOException sessionOrError(String code, String message) throws SessionExpiredException {
        if (code != null && (code.equals("servicerequireslogin") || code.equals("invalidsesskey") ||
            code.equals("requireloginerror") || code.equals("sessiontimedout"))) {
            throw new SessionExpiredException();
        }
        return new IOException(message + (code == null || code.isEmpty() ? "" : " (" + code + ")"));
    }

    static class Download {
        File file;
        String name;
        String mimeType;
        boolean html;
        String finalUrl;
    }

    private static final Pattern FILENAME_STAR = Pattern.compile("filename\\*=(?:UTF-8|utf-8)''([^;]+)");
    private static final Pattern FILENAME = Pattern.compile("filename=\"?([^\";]+)\"?");

    /** Downloads a Moodle file with the session into the app cache. */
    static Download download(Context context, String url) throws IOException, SessionExpiredException {
        String current = url;
        for (int hop = 0; hop < 8; hop++) {
            HttpURLConnection connection = open(current, "GET");
            try {
                int status = connection.getResponseCode();
                storeCookies(current, connection);
                if (status >= 300 && status < 400 && connection.getHeaderField("Location") != null) {
                    current = new URL(new URL(current), connection.getHeaderField("Location")).toString();
                    if (isLoginUrl(current)) {
                        throw new SessionExpiredException();
                    }
                    continue;
                }
                if (status >= 400) {
                    throw new IOException("HTTP " + status);
                }

                Download result = new Download();
                result.finalUrl = current;
                String contentType = connection.getContentType();
                result.mimeType = contentType == null ? "application/octet-stream" : contentType.split(";")[0].trim();
                if (result.mimeType.equals("text/html")) {
                    result.html = true;
                    return result;
                }

                String name = null;
                String disposition = connection.getHeaderField("Content-Disposition");
                if (disposition != null) {
                    Matcher star = FILENAME_STAR.matcher(disposition);
                    Matcher plain = FILENAME.matcher(disposition);
                    if (star.find()) {
                        name = URLDecoder.decode(star.group(1), "UTF-8");
                    } else if (plain.find()) {
                        name = plain.group(1);
                    }
                }
                if (name == null || name.isEmpty()) {
                    String path = new URL(current).getPath();
                    name = URLDecoder.decode(path.substring(path.lastIndexOf('/') + 1), "UTF-8");
                }
                if (name.isEmpty()) {
                    name = "moodle-file";
                }
                name = name.replaceAll("[\\\\/:*?\"<>|]", "_");

                File dir = new File(context.getCacheDir(), "moodle");
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new IOException("Cannot create cache directory");
                }
                File file = new File(dir, name);
                InputStream input = connection.getInputStream();
                OutputStream output = new FileOutputStream(file);
                byte[] buffer = new byte[65536];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                }
                output.close();
                input.close();

                result.file = file;
                result.name = name;
                return result;
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("Too many redirects");
    }

    /** Forgets the session (cookies of the Moodle site and the stored sesskey). */
    static void logout(Context context) {
        String site = site(context);
        try {
            CookieManager manager = CookieManager.getInstance();
            String cookies = site.isEmpty() ? null : manager.getCookie(site);
            if (cookies != null) {
                for (String cookie : cookies.split(";")) {
                    String name = cookie.split("=")[0].trim();
                    if (!name.isEmpty()) {
                        manager.setCookie(site, name + "=; Max-Age=0; path=/");
                    }
                }
            }
            manager.flush();
        } catch (Exception e) {
            // Ignore.
        }
        prefs(context).edit().remove("sesskey").apply();
    }
}
