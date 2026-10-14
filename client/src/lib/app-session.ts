// Staying signed in inside the DRM Android app.
//
// The login is a token in the WebView's storage. Two things lost it in the
// app: Android does not always write WebView storage to disk before an app is
// closed, and the token itself lasts a day. The app keeps its own long-lived
// key for the phone (see mobile/ and routes/phoneApp.ts), so when the token is
// missing or refused, the page asks the app for a fresh one instead of sending
// the caller back to the sign-in screen.
//
// No imports from ./api on purpose: api.ts calls this when a request is
// refused, and the two must not depend on each other.

interface DrmPhoneSession {
  signIn?: () => Promise<{ token?: string }>;
}

function plugin(): DrmPhoneSession | null {
  if (typeof window === "undefined") return null;
  const cap = (window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> };
  }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return (cap.Plugins?.DrmPhone as DrmPhoneSession | undefined) ?? null;
}

let pending: Promise<boolean> | null = null;

/**
 * Ask the app for a fresh login. True if a new token is now stored. Several
 * refused requests at once share one attempt.
 */
export function restoreAppSession(): Promise<boolean> {
  const p = plugin();
  if (!p?.signIn) return Promise.resolve(false);
  if (!pending) {
    pending = p
      .signIn()
      .then((r) => {
        if (!r?.token) return false;
        try {
          localStorage.setItem("token", r.token);
        } catch {
          return false;
        }
        return true;
      })
      .catch(() => false)
      .finally(() => {
        setTimeout(() => (pending = null), 1000);
      });
  }
  return pending;
}
