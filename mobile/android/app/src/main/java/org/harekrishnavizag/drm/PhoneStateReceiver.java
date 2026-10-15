package org.harekrishnavizag.drm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.TelephonyManager;

/**
 * Hears the phone's call state change.
 *
 * Ringing with a number already in DRM: says who it is (CallerId) - on this
 * phone as a notification, and to DRM so the laptop shows it. Picked up and
 * hung up are reported too, so the laptop can say "on the call" and "missed".
 *
 * Back to idle after any call: the call is reported - and its recording sent -
 * within a minute, not at the next 15-minute run. A call-back that is missed
 * is on the caller's reminders almost at once.
 */
public class PhoneStateReceiver extends BroadcastReceiver {
    @Override
    @SuppressWarnings("deprecation") // EXTRA_INCOMING_NUMBER: still delivered with the call-log permission
    public void onReceive(Context ctx, Intent intent) {
        if (!TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) return;
        final Context app = ctx.getApplicationContext();
        final Store s = new Store(app);
        if (!s.isLinked()) return;
        String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);

        if (TelephonyManager.EXTRA_STATE_RINGING.equals(state)) {
            // Android sends this twice; only one copy carries the number.
            String raw = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER);
            if (raw == null) return;
            final String phone = CallSync.phone10(raw);
            // Only DRM's numbers. Everything else on this phone stays on this phone.
            if (phone.length() != 10 || !s.numbers().contains(phone)) return;
            if (phone.equals(s.ringingPhone()) && !CallerId.stale(s.ringingAt())) return;
            s.setRinging(phone);
            background(() -> CallerId.ringing(app, s, phone));
            return;
        }

        if (TelephonyManager.EXTRA_STATE_OFFHOOK.equals(state)) {
            final String phone = s.ringingPhone();
            if (phone == null) return; // a call this phone made, not one it received
            if (CallerId.stale(s.ringingAt())) {
                s.clearRinging();
                return;
            }
            background(() -> CallerId.answered(s, phone));
            return;
        }

        if (!TelephonyManager.EXTRA_STATE_IDLE.equals(state)) return;
        final String rang = s.ringingPhone();
        if (rang != null) {
            s.clearRinging();
            background(() -> CallerId.ended(app, s, rang));
        }
        // Once quickly, for the call itself; once later, for a recording some phones finish writing slowly.
        SyncWorker.soon(app, "drm-sync-after-call", 20);
        SyncWorker.soon(app, "drm-sync-after-call-late", 240);
    }

    /** A network request may not run on the main thread; keep the receiver alive until it is done. */
    private void background(Runnable r) {
        final PendingResult done = goAsync();
        new Thread(() -> {
            try {
                r.run();
            } finally {
                done.finish();
            }
        }, "drm-caller-id").start();
    }
}
