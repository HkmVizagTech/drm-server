package org.harekrishnavizag.drm;

import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.splashscreen.SplashScreen;

import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    /** The longest the opening screen waits for DRM, on a slow connection. */
    private static final long OPENING_MAX_MS = 4000;

    private volatile boolean pageShown = false;
    private long openingUntil;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The temple stays up until DRM's first page has drawn (or four
        // seconds have passed), so opening the app goes temple -> DRM with no
        // blank white screen in between while the site loads.
        SplashScreen opening = SplashScreen.installSplashScreen(this);
        openingUntil = SystemClock.uptimeMillis() + OPENING_MAX_MS;
        opening.setKeepOnScreenCondition(() -> !pageShown && SystemClock.uptimeMillis() < openingUntil);

        registerPlugin(DrmPhonePlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    pageShown = true;
                }

                @Override
                public void onPageLoaded(WebView webView) {
                    pageShown = true;
                }
            });
        }
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
