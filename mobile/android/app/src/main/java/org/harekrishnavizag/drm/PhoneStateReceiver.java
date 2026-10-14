package org.harekrishnavizag.drm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.TelephonyManager;

/**
 * Hears the phone go back to idle after any call, so the call is reported -
 * and its recording sent - within a minute, not at the next 15-minute run.
 * A call-back that is missed is on the caller's reminders almost at once.
 */
public class PhoneStateReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) return;
        String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
        if (!TelephonyManager.EXTRA_STATE_IDLE.equals(state)) return;
        if (!new Store(ctx).isLinked()) return;
        // Once quickly, for the call itself; once later, for a recording some phones finish writing slowly.
        SyncWorker.soon(ctx, "drm-sync-after-call", 20);
        SyncWorker.soon(ctx, "drm-sync-after-call-late", 240);
    }
}
