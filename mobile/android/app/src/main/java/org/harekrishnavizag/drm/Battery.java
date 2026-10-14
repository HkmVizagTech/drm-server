package org.harekrishnavizag.drm;

import android.content.Context;
import android.os.PowerManager;

/** Whether the phone lets the app run in the background without being put to sleep. */
final class Battery {
    private Battery() { }

    static boolean ignoring(Context ctx) {
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        } catch (Exception e) {
            return false;
        }
    }
}
