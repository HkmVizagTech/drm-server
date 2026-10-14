package org.harekrishnavizag.drm;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DrmPhonePlugin.class);
        super.onCreate(savedInstanceState);
        if (new Store(this).isLinked()) SyncWorker.schedule(this);
    }

    @Override
    public void onResume() {
        super.onResume();
        // Back from a call, or DRM opened: report what happened straight away.
        if (new Store(this).isLinked()) SyncWorker.soon(this, "drm-sync-open", 3);
    }
}
