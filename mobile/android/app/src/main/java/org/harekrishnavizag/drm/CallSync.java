package org.harekrishnavizag.drm;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.os.Build;
import android.provider.CallLog;
import android.telecom.TelecomManager;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

/**
 * One pass of "tell DRM what happened on this phone":
 *   1. refresh the numbers to watch (the caller's leads, people they have rung);
 *   2. report new call-log entries for those numbers - calls made, call-backs
 *      answered, call-backs missed;
 *   3. find and upload the recording of each answered call.
 * Runs after every call, every 15 minutes, and when DRM is opened. Safe to run
 * twice: DRM saves each call once.
 */
final class CallSync {
    private static final long HOUR = 3600_000L;
    /** Look back this far behind the last reported call, in case one was logged late. */
    private static final long LOOKBACK = 3 * HOUR;
    /** Give up looking for a recording this long after the call. */
    private static final long GIVE_UP = 45 * 60_000L;

    private CallSync() { }

    static synchronized String run(Context ctx) {
        Store s = new Store(ctx);
        if (!s.isLinked()) return "This phone is not linked to DRM yet. Open DRM and sign in.";
        Api api = new Api(s.baseUrl(), s.deviceKey());
        String error = null;
        try {
            if (!can(ctx, Manifest.permission.READ_CALL_LOG)) {
                error = "Allow the app to read the call log.";
            } else {
                refreshNumbers(s, api, false);
                reportCalls(ctx, s, api);
                uploadRecordings(ctx, s, api);
            }
        } catch (Api.HttpError e) {
            if (e.code == 401) {
                s.unlink();
                error = "This phone was signed out of DRM. Open DRM to link it again.";
            } else {
                error = e.getMessage();
            }
        } catch (Exception e) {
            error = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
        s.setLastSync(System.currentTimeMillis(), error);
        if (s.isLinked()) {
            try {
                JSONObject st = new JSONObject();
                st.put("status", status(ctx, s));
                st.put("last_error", error == null ? JSONObject.NULL : error);
                st.put("app_version", appVersion(ctx));
                st.put("dialer", dialer(ctx));
                if (s.lastFolder() != null) st.put("recordings_folder", s.lastFolder());
                api.post("/api/app/status", st);
            } catch (Exception ignored) { }
        }
        return error;
    }

    static void refreshNumbers(Store s, Api api, boolean force) throws Exception {
        if (!force && System.currentTimeMillis() - s.numbersAt() < HOUR && !s.numbers().isEmpty()) return;
        JSONObject r = api.get("/api/app/numbers");
        JSONArray a = r.optJSONArray("numbers");
        Set<String> set = new HashSet<>();
        if (a != null) for (int i = 0; i < a.length(); i++) set.add(a.optString(i));
        s.setNumbers(set);
    }

    static String phone10(String raw) {
        if (raw == null) return "";
        String d = raw.replaceAll("[^0-9]", "");
        return d.length() >= 10 ? d.substring(d.length() - 10) : d;
    }

    private static void reportCalls(Context ctx, Store s, Api api) throws Exception {
        long now = System.currentTimeMillis();
        long last = s.lastCallDate();
        long since = last == 0 ? now - 48 * HOUR : last - LOOKBACK;
        Set<String> numbers = s.numbers();
        JSONArray appCalls = s.appCalls();

        String[] cols = { CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE,
            CallLog.Calls.DURATION, CallLog.Calls.PHONE_ACCOUNT_ID };
        List<JSONObject> calls = new ArrayList<>();
        long newest = last;
        try (Cursor c = ctx.getContentResolver().query(CallLog.Calls.CONTENT_URI, cols,
                CallLog.Calls.DATE + " > ?", new String[] { String.valueOf(since) }, CallLog.Calls.DATE + " ASC")) {
            if (c == null) return;
            while (c.moveToNext()) {
                long id = c.getLong(0);
                String phone = phone10(c.getString(1));
                int type = c.getInt(2);
                long date = c.getLong(3);
                long dur = c.getLong(4);
                newest = Math.max(newest, date);
                if (phone.length() != 10) continue;
                String lead = appCallLead(appCalls, phone, date);
                boolean fromApp = lead != null;
                // Only DRM's numbers. Everything else on this phone stays on this phone.
                if (!fromApp && !numbers.contains(phone)) continue;
                JSONObject o = new JSONObject();
                o.put("key", id + "-" + date);
                o.put("type", type);
                o.put("phone", phone);
                o.put("started_at", iso(date));
                o.put("duration_seconds", dur);
                o.put("sim", c.getString(5) == null ? JSONObject.NULL : c.getString(5));
                o.put("from_app", fromApp);
                if (fromApp && !lead.isEmpty()) o.put("lead_id", lead);
                o.put("_start", date);
                o.put("_end", date + dur * 1000L);
                calls.add(o);
            }
        }

        JSONArray pending = s.pending();
        Set<String> waiting = new HashSet<>();
        for (int i = 0; i < pending.length(); i++) waiting.add(pending.optJSONObject(i).optString("id"));

        for (int from = 0; from < calls.size(); from += 100) {
            List<JSONObject> batch = calls.subList(from, Math.min(calls.size(), from + 100));
            JSONArray body = new JSONArray();
            Map<String, JSONObject> byKey = new HashMap<>();
            for (JSONObject o : batch) {
                JSONObject send = new JSONObject(o.toString());
                send.remove("_start");
                send.remove("_end");
                body.put(send);
                byKey.put(o.getString("key"), o);
            }
            JSONObject req = new JSONObject();
            req.put("calls", body);
            JSONArray results = api.post("/api/app/calls", req).optJSONArray("results");
            if (results == null) continue;
            for (int i = 0; i < results.length(); i++) {
                JSONObject r = results.getJSONObject(i);
                String id = r.optString("id", "");
                if (id.isEmpty() || "null".equals(id) || !r.optBoolean("want_recording") || waiting.contains(id)) continue;
                JSONObject o = byKey.get(r.optString("key"));
                if (o == null) continue;
                JSONObject p = new JSONObject();
                p.put("id", id);
                p.put("phone", o.getString("phone"));
                p.put("start", o.getLong("_start"));
                p.put("end", o.getLong("_end"));
                p.put("added", System.currentTimeMillis());
                pending.put(p);
                waiting.add(id);
            }
        }
        s.setPending(pending);
        // Only moved on once DRM has them, so a failed sync is simply tried again.
        if (newest > last) s.setLastCallDate(newest);
    }

    /** The lead a call was dialled for with DRM's Call button: "" if dialled from DRM with no lead, null if not from DRM. */
    private static String appCallLead(JSONArray appCalls, String phone, long date) {
        for (int i = appCalls.length() - 1; i >= 0; i--) {
            JSONObject a = appCalls.optJSONObject(i);
            if (a == null || !phone.equals(a.optString("phone"))) continue;
            if (Math.abs(a.optLong("at") - date) <= 10 * 60_000L) {
                return a.isNull("lead_id") ? "" : a.optString("lead_id", "");
            }
        }
        return null;
    }

    private static void uploadRecordings(Context ctx, Store s, Api api) throws Exception {
        JSONArray pending = s.pending();
        JSONArray keep = new JSONArray();
        long now = System.currentTimeMillis();
        Set<String> used = usedFiles(s);
        boolean canLook = can(ctx, audioPermission()) || RecordingFinder.allFiles();
        for (int i = 0; i < pending.length(); i++) {
            JSONObject p = pending.getJSONObject(i);
            String id = p.getString("id");
            long end = p.getLong("end");
            // The dialer is still closing the file for a few seconds after the call.
            if (now < end + 15_000L) {
                keep.put(p);
                continue;
            }
            RecordingFinder.Found f = canLook ? RecordingFinder.find(ctx, p.getString("phone"), p.getLong("start"), end, used) : null;
            if (f != null) {
                try {
                    String folder = f.folder == null || f.folder.isEmpty() ? null : f.folder;
                    api.upload(id, f.open(ctx), f.size, f.type, f.name, folder);
                    used.add(f.id());
                    if (folder != null) s.setLastFolder(folder);
                } catch (Api.HttpError e) {
                    if (e.code == 401) throw e;
                    if (e.code != 404 && e.code != 400) keep.put(p);
                }
                continue;
            }
            if (now - end > GIVE_UP && canLook) {
                try {
                    api.post("/api/app/calls/" + id + "/no-recording", new JSONObject());
                } catch (Api.HttpError e) {
                    if (e.code == 401) throw e;
                }
                continue;
            }
            // Without permission to look, wait (up to three days) rather than tell DRM there is none.
            if (now - p.optLong("added", now) < 72 * HOUR) keep.put(p);
        }
        s.setPending(keep);
        saveUsed(s, used);
    }

    private static Set<String> usedFiles(Store s) {
        Set<String> out = new HashSet<>();
        try {
            JSONArray a = new JSONArray(s.usedFiles());
            for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        } catch (Exception ignored) { }
        return out;
    }

    private static void saveUsed(Store s, Set<String> used) {
        JSONArray a = new JSONArray();
        List<String> list = new ArrayList<>(used);
        for (int i = Math.max(0, list.size() - 200); i < list.size(); i++) a.put(list.get(i));
        s.setUsedFiles(a.toString());
    }

    static String audioPermission() {
        return Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_AUDIO : Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    static boolean can(Context ctx, String permission) {
        return ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED;
    }

    static JSONObject status(Context ctx, Store s) {
        JSONObject o = new JSONObject();
        try {
            o.put("call", can(ctx, Manifest.permission.CALL_PHONE));
            o.put("call_log", can(ctx, Manifest.permission.READ_CALL_LOG));
            o.put("phone_state", can(ctx, Manifest.permission.READ_PHONE_STATE));
            o.put("audio", can(ctx, audioPermission()));
            o.put("all_files", RecordingFinder.allFiles());
            o.put("battery", Battery.ignoring(ctx));
            o.put("pending_recordings", s.pending().length());
            o.put("numbers", s.numbers().size());
        } catch (Exception ignored) { }
        return o;
    }

    static String dialer(Context ctx) {
        try {
            TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
            return tm == null ? null : tm.getDefaultDialerPackage();
        } catch (Exception e) {
            return null;
        }
    }

    static String appVersion(Context ctx) {
        try {
            return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return null;
        }
    }

    static String iso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }
}
