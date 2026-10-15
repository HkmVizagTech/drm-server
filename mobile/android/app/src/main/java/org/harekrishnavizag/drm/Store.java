package org.harekrishnavizag.drm;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * What the app remembers between runs: which DRM it is linked to, the phone's
 * key, the numbers to watch, and the calls still waiting for a recording.
 * Kept in the app's private storage; nothing here is readable by other apps.
 */
final class Store {
    private static final String NAME = "drm_phone";
    private final SharedPreferences p;

    Store(Context ctx) {
        p = ctx.getApplicationContext().getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    /** This installation's own id, made once. Reinstalling makes a new one. */
    String installId() {
        String id = p.getString("install_id", null);
        if (id == null) {
            id = UUID.randomUUID().toString();
            p.edit().putString("install_id", id).apply();
        }
        return id;
    }

    boolean isLinked() {
        return deviceKey() != null && baseUrl() != null;
    }

    String baseUrl() { return p.getString("base_url", null); }
    String deviceKey() { return p.getString("device_key", null); }
    String deviceId() { return p.getString("device_id", null); }
    String userId() { return p.getString("user_id", null); }

    void link(String baseUrl, String deviceId, String deviceKey, String userId) {
        SharedPreferences.Editor e = p.edit()
            .putString("base_url", baseUrl)
            .putString("device_id", deviceId)
            .putString("device_key", deviceKey);
        // A different caller on this phone: their numbers, not the last one's.
        if (userId != null && !userId.equals(userId())) {
            e.remove("numbers").putLong("numbers_at", 0);
        }
        e.putString("user_id", userId).apply();
    }

    /** Signed out (by an admin, or the caller left): stop syncing until DRM links it again. */
    void unlink() {
        p.edit().remove("device_key").remove("device_id").remove("numbers").putLong("numbers_at", 0).apply();
    }

    /* The numbers this phone reports calls for. */
    Set<String> numbers() { return new HashSet<>(p.getStringSet("numbers", new HashSet<>())); }
    long numbersAt() { return p.getLong("numbers_at", 0); }
    void setNumbers(Set<String> n) { p.edit().putStringSet("numbers", n).putLong("numbers_at", System.currentTimeMillis()).apply(); }

    /* How far through the phone's call log the app has reported. */
    long lastCallDate() { return p.getLong("last_call_date", 0); }
    void setLastCallDate(long ms) { p.edit().putLong("last_call_date", ms).apply(); }

    /* Calls dialled with DRM's Call button: [{phone, lead_id, at}] for the last day. */
    JSONArray appCalls() { return array("app_calls"); }
    void addAppCall(String phone, String leadId) {
        JSONArray old = appCalls();
        JSONArray kept = new JSONArray();
        long cutoff = System.currentTimeMillis() - 24L * 3600_000L;
        for (int i = 0; i < old.length(); i++) {
            JSONObject o = old.optJSONObject(i);
            if (o != null && o.optLong("at") > cutoff) kept.put(o);
        }
        try {
            JSONObject o = new JSONObject();
            o.put("phone", phone);
            o.put("lead_id", leadId == null ? JSONObject.NULL : leadId);
            o.put("at", System.currentTimeMillis());
            kept.put(o);
        } catch (Exception ignored) { }
        p.edit().putString("app_calls", kept.toString()).apply();
    }

    /* Calls whose recording is still to be found and sent: [{id, phone, start, end, added}]. */
    JSONArray pending() { return array("pending"); }
    void setPending(JSONArray a) { p.edit().putString("pending", a.toString()).apply(); }

    /* The DRM number ringing this phone right now, if any (see CallerId). */
    String ringingPhone() { return p.getString("ringing_phone", null); }
    long ringingAt() { return p.getLong("ringing_at", 0); }
    void setRinging(String phone) {
        p.edit().putString("ringing_phone", phone).putLong("ringing_at", System.currentTimeMillis()).apply();
    }
    void clearRinging() { p.edit().remove("ringing_phone").remove("ringing_at").apply(); }

    long lastSyncAt() { return p.getLong("last_sync_at", 0); }
    String lastError() { return p.getString("last_error", null); }
    void setLastSync(long at, String error) {
        p.edit().putLong("last_sync_at", at).putString("last_error", error).apply();
    }

    /* Recording files already sent, so one file is never sent for two calls. */
    String usedFiles() { return p.getString("used_files", "[]"); }
    void setUsedFiles(String json) { p.edit().putString("used_files", json).apply(); }

    String lastFolder() { return p.getString("last_folder", null); }
    void setLastFolder(String f) { p.edit().putString("last_folder", f).apply(); }

    private JSONArray array(String key) {
        try {
            return new JSONArray(p.getString(key, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }
}
