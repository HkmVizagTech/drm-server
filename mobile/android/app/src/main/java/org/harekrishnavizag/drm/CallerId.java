package org.harekrishnavizag.drm;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

/**
 * "Ramesh Kumar is calling" - for a number already in DRM, while it rings.
 *
 * The phone tells DRM (so the laptop can show it too) and shows DRM's answer
 * as a notification: the name and the one thing worth knowing before picking
 * up ("Promised ₹2,500 today"). Tapping it opens their call screen in DRM with
 * "They rang me" already on.
 *
 * Only numbers on this phone's DRM list are ever reported - the same list the
 * app uses to save calls. A personal call never leaves the phone.
 */
final class CallerId {
    static final String CHANNEL = "drm_incoming";
    private static final int NOTE_ID = 7001;
    /** A ring older than this is stale (the phone was off, or a broadcast was lost). */
    private static final long STALE_MS = 10 * 60_000L;

    private CallerId() { }

    /** The phone is ringing with this number. Runs off the main thread. */
    static void ringing(Context ctx, Store s, String phone) {
        JSONObject r = report(s, phone, "ringing");
        if (r == null) return;
        String name = r.optString("name", "");
        if (name.isEmpty() || "null".equals(name)) return;
        String note = r.isNull("note") ? null : r.optString("note", null);
        String leadId = r.isNull("lead_id") ? null : r.optString("lead_id", null);
        show(ctx, name, note, leadId);
    }

    static void answered(Store s, String phone) {
        report(s, phone, "answered");
    }

    static void ended(Context ctx, Store s, String phone) {
        cancel(ctx);
        report(s, phone, "ended");
    }

    static boolean stale(long at) {
        return System.currentTimeMillis() - at > STALE_MS;
    }

    private static JSONObject report(Store s, String phone, String state) {
        if (!s.isLinked()) return null;
        try {
            JSONObject body = new JSONObject();
            body.put("phone", phone);
            body.put("state", state);
            return new Api(s.baseUrl(), s.deviceKey()).post("/api/app/ringing", body);
        } catch (Exception e) {
            return null;
        }
    }

    private static void show(Context ctx, String name, String note, String leadId) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (!nm.areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Who is calling", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Shows a DRM donor's name and notes while they ring this phone.");
            ch.setSound(null, null); // the phone is already ringing
            ch.enableVibration(false);
            ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        Intent open = new Intent(ctx, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (leadId != null) open.putExtra(MainActivity.EXTRA_PATH, "/calling/queue?lead=" + leadId + "&inbound=1");
        PendingIntent pi = PendingIntent.getActivity(ctx, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_drm)
            .setContentTitle(name)
            .setContentText(note != null && !note.isEmpty() ? note : "In DRM")
            .setSubText("DRM")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setTimeoutAfter(STALE_MS)
            .setContentIntent(pi);
        try {
            nm.notify(NOTE_ID, b.build());
        } catch (SecurityException ignored) {
            // Notifications not allowed after all; the laptop still shows it.
        }
    }

    static void cancel(Context ctx) {
        NotificationManagerCompat.from(ctx).cancel(NOTE_ID);
    }
}
