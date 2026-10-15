package org.harekrishnavizag.drm;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * What DRM's web pages can ask the phone to do, as window.Capacitor.Plugins.DrmPhone
 * (see client/src/lib/phone-app.ts):
 *   getInfo, link, unlink, signIn, signOut, requestPermissions, call, syncNow, findRecording,
 *   openAllFilesSettings, openBatterySettings, openAppSettings.
 */
@CapacitorPlugin(
    name = "DrmPhone",
    permissions = {
        @Permission(alias = "phone", strings = { Manifest.permission.CALL_PHONE, Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_PHONE_STATE }),
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
    }
)
public class DrmPhonePlugin extends Plugin {

    private Context ctx() {
        return getContext().getApplicationContext();
    }

    private JSObject info() {
        Context ctx = ctx();
        Store s = new Store(ctx);
        JSObject o = new JSObject();
        o.put("installId", s.installId());
        o.put("linked", s.isLinked());
        o.put("deviceId", s.deviceId());
        o.put("userId", s.userId());
        o.put("baseUrl", s.baseUrl());
        o.put("manufacturer", Build.MANUFACTURER);
        o.put("model", Build.MODEL);
        o.put("androidVersion", Build.VERSION.RELEASE);
        o.put("appVersion", CallSync.appVersion(ctx));
        o.put("dialer", CallSync.dialer(ctx));
        try {
            o.put("permissions", JSObject.fromJSONObject(CallSync.status(ctx, s)));
        } catch (Exception e) {
            o.put("permissions", new JSObject());
        }
        o.put("lastSyncAt", s.lastSyncAt());
        o.put("lastError", s.lastError());
        o.put("pendingRecordings", s.pending().length());
        o.put("recordingsFolder", s.lastFolder());
        return o;
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        call.resolve(info());
    }

    /** DRM, signed in, hands the phone its key: { baseUrl, deviceId, deviceKey, userId }. */
    @PluginMethod
    public void link(PluginCall call) {
        String base = call.getString("baseUrl");
        String key = call.getString("deviceKey");
        if (base == null || key == null) {
            call.reject("baseUrl and deviceKey are needed");
            return;
        }
        Store s = new Store(ctx());
        s.link(base, call.getString("deviceId"), key, call.getString("userId"));
        SyncWorker.schedule(ctx());
        SyncWorker.soon(ctx(), "drm-sync-link", 1);
        call.resolve(info());
    }

    /**
     * A fresh DRM login for whoever this phone is linked to: { token, user }.
     *
     * The login DRM keeps in the WebView is not always written to disk before
     * the app is closed, so callers were asked to sign in every time they opened
     * it. The phone's key is kept here, safely, so the app signs back in with it.
     */
    @PluginMethod
    public void signIn(PluginCall call) {
        Store s = new Store(ctx());
        if (!s.isLinked()) {
            call.reject("not linked");
            return;
        }
        new Thread(() -> {
            try {
                org.json.JSONObject r = new Api(s.baseUrl(), s.deviceKey()).post("/api/app/session", new org.json.JSONObject());
                call.resolve(JSObject.fromJSONObject(r));
            } catch (Api.HttpError e) {
                if (e.code == 401) s.unlink();
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("offline");
            }
        }).start();
    }

    /** The caller signed out: this phone's key stops working, here and in DRM. */
    @PluginMethod
    public void signOut(PluginCall call) {
        Store s = new Store(ctx());
        if (!s.isLinked()) {
            call.resolve(info());
            return;
        }
        String base = s.baseUrl();
        String key = s.deviceKey();
        s.unlink();
        new Thread(() -> {
            try {
                new Api(base, key).post("/api/app/sign-out", new org.json.JSONObject());
            } catch (Exception ignored) {
                // Offline: the key is already gone from the phone, which is what matters.
            }
            call.resolve(info());
        }).start();
    }

    @PluginMethod
    public void unlink(PluginCall call) {
        new Store(ctx()).unlink();
        call.resolve(info());
    }

    /** Ask for the phone and call-log permissions, and to read recordings. */
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        String audio = Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
        requestPermissionForAliases(new String[] { "phone", audio }, call, "afterPermissions");
    }

    @PermissionCallback
    private void afterPermissions(PluginCall call) {
        if (getPermissionState("phone") == PermissionState.GRANTED) {
            SyncWorker.schedule(ctx());
            SyncWorker.soon(ctx(), "drm-sync-permissions", 1);
        }
        call.resolve(info());
    }

    /**
     * Ring a number from this phone's SIM: { phone, leadId? }. Straight to the
     * call when allowed; otherwise the dialer opens with the number typed in.
     */
    @PluginMethod
    public void call(PluginCall call) {
        String phone = CallSync.phone10(call.getString("phone"));
        if (phone.length() != 10) {
            call.reject("Not a 10-digit number");
            return;
        }
        new Store(ctx()).addAppCall(phone, call.getString("leadId"));
        boolean direct = getPermissionState("phone") == PermissionState.GRANTED;
        Intent i = new Intent(direct ? Intent.ACTION_CALL : Intent.ACTION_DIAL, Uri.parse("tel:+91" + phone));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
        } catch (SecurityException | ActivityNotFoundException e) {
            Intent dial = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:+91" + phone));
            dial.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(dial);
            direct = false;
        }
        JSObject r = new JSObject();
        r.put("placed", true);
        r.put("direct", direct);
        call.resolve(r);
    }

    /** Report calls and send recordings now. Resolves when done, with any error. */
    @PluginMethod
    public void syncNow(PluginCall call) {
        new Thread(() -> {
            String error = CallSync.run(ctx());
            JSObject r = info();
            r.put("error", error);
            call.resolve(r);
        }).start();
    }

    /** The newest call recording of the last week: can the app see this phone's recordings at all? */
    @PluginMethod
    public void findRecording(PluginCall call) {
        new Thread(() -> {
            RecordingFinder.Found f = RecordingFinder.latest(ctx());
            JSObject r = new JSObject();
            r.put("found", f != null);
            if (f != null) {
                r.put("name", f.name);
                r.put("folder", f.folder);
                r.put("modifiedAt", f.modifiedMs);
                r.put("size", f.size);
                if (f.folder != null && !f.folder.isEmpty()) new Store(ctx()).setLastFolder(f.folder);
            }
            call.resolve(r);
        }).start();
    }

    /** "All files" access: for phones whose recordings are not in the media index. */
    @PluginMethod
    public void openAllFilesSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            open(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName())),
                new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
        }
        call.resolve();
    }

    /** Let the app run in the background, so call-backs are saved even when DRM is closed. */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        open(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName())),
            new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        call.resolve();
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())), null);
        call.resolve();
    }

    /**
     * Keep the screen on while the Laptop dialer screen is open (added in app
     * 1.0.4). A locked phone cannot hear the laptop, so the screen must not
     * sleep while the caller is working from the laptop.
     */
    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        if (getActivity() == null) {
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    private void open(Intent first, Intent fallback) {
        first.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(first);
        } catch (Exception e) {
            if (fallback != null) {
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    getContext().startActivity(fallback);
                } catch (Exception ignored) { }
            }
        }
    }
}
