package org.harekrishnavizag.drm;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/** Runs CallSync in the background: every 15 minutes, and shortly after each call. */
public class SyncWorker extends Worker {
    public SyncWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        CallSync.run(getApplicationContext());
        // Errors are reported to DRM's Phones page; the next run tries again.
        return Result.success();
    }

    private static Constraints online() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    /** The every-15-minutes run. Safe to call on every start. */
    static void schedule(Context ctx) {
        PeriodicWorkRequest w = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(online())
            .build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("drm-sync", ExistingPeriodicWorkPolicy.KEEP, w);
    }

    /** A run soon: after a call ends (the recording needs a few seconds to be written), or when DRM opens. */
    static void soon(Context ctx, String name, long delaySeconds) {
        OneTimeWorkRequest w = new OneTimeWorkRequest.Builder(SyncWorker.class)
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .setConstraints(online())
            .build();
        WorkManager.getInstance(ctx).enqueueUniqueWork(name, ExistingWorkPolicy.REPLACE, w);
    }
}
