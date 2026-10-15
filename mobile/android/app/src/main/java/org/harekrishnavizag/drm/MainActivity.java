package org.harekrishnavizag.drm;

import android.content.Intent;
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
    /** A DRM page to open, e.g. from the "who is calling" notification. */
    static final String EXTRA_PATH = "drm_path";

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
        openPath(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openPath(intent);
    }

    /** Open a DRM page inside the app (the notification's "open their call screen"). */
    private void openPath(Intent intent) {
        if (intent == null || getBridge() == null || getBridge().getWebView() == null) return;
        String path = intent.getStringExtra(EXTRA_PATH);
        String base = new Store(this).baseUrl();
        if (path == null || !path.startsWith("/") || base == null) return;
        intent.removeExtra(EXTRA_PATH);
        final String url = base.replaceAll("/+$", "") + path;
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
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
