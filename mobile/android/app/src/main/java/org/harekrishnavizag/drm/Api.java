package org.harekrishnavizag.drm;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/** DRM's /api/app endpoints, signed with this phone's key. */
final class Api {
    static final class HttpError extends Exception {
        final int code;
        HttpError(int code, String message) {
            super(message);
            this.code = code;
        }
    }

    private final String base;
    private final String key;

    Api(String base, String key) {
        this.base = base.replaceAll("/+$", "");
        this.key = key;
    }

    JSONObject get(String path) throws Exception {
        return send("GET", path, null);
    }

    JSONObject post(String path, JSONObject body) throws Exception {
        return send("POST", path, body);
    }

    private JSONObject send(String method, String path, JSONObject body) throws Exception {
        HttpURLConnection c = open(path);
        c.setRequestMethod(method);
        if (body != null) {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream o = c.getOutputStream()) {
                o.write(bytes);
            }
        }
        return read(c);
    }

    /** Send a recording as the request body, streamed from the phone's storage. */
    JSONObject upload(String callId, InputStream in, long length, String type, String name, String folder) throws Exception {
        HttpURLConnection c = open("/api/app/calls/" + callId + "/recording");
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setReadTimeout(120_000);
        c.setRequestProperty("Content-Type", type == null ? "application/octet-stream" : type);
        if (name != null) c.setRequestProperty("X-File-Name", URLEncoder.encode(name, "UTF-8"));
        if (folder != null) c.setRequestProperty("X-File-Folder", folder);
        if (length > 0) c.setFixedLengthStreamingMode(length);
        else c.setChunkedStreamingMode(64 * 1024);
        try (OutputStream o = c.getOutputStream()) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        } finally {
            in.close();
        }
        return read(c);
    }

    private HttpURLConnection open(String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setConnectTimeout(20_000);
        c.setReadTimeout(30_000);
        c.setRequestProperty("X-Device-Key", key);
        c.setRequestProperty("Accept", "application/json");
        return c;
    }

    private static JSONObject read(HttpURLConnection c) throws Exception {
        int code = c.getResponseCode();
        InputStream s = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = "";
        if (s != null) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) > 0) b.write(buf, 0, n);
            s.close();
            text = b.toString("UTF-8");
        }
        c.disconnect();
        JSONObject json;
        try {
            json = text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } catch (Exception e) {
            json = new JSONObject();
        }
        if (code >= 400) throw new HttpError(code, json.optString("error", "DRM answered " + code));
        return json;
    }
}
