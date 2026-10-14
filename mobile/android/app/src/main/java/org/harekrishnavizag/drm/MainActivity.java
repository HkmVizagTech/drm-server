package org.harekrishnavizag.drm;

import android.os.Bundle;
import android.webkit.WebSettings;

import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DrmPhonePlugin.class);
        super.onCreate(savedInstanceState);
        lookLikeTheWebsite();
        if (new Store(this).isLinked()) SyncWorker.schedule(this);
    }

    /**
     * Show DRM exactly as it looks in a browser.
     *
     * On a phone in dark mode Android darkens web pages by itself. DRM is a
     * light design that was never made for that, and the result was black
     * cards and grey-on-black text. The phone's text size is also kept from
     * scaling the pages, which pushed words and buttons into each other.
     */
    @SuppressWarnings("deprecation")
    private void lookLikeTheWebsite() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebSettings ws = getBridge().getWebView().getSettings();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(ws, false);
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
            WebSettingsCompat.setForceDark(ws, WebSettingsCompat.FORCE_DARK_OFF);
        }
        ws.setTextZoom(100);
    }

    @Override
    public void onResume() {
        super.onResume();
        // Back from a call, or DRM opened: report what happened straight away.
        if (new Store(this).isLinked()) SyncWorker.soon(this, "drm-sync-open", 3);
    }
}
