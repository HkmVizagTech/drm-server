"use client";

// When something on a devotee screen breaks: say so in plain words, show what broke (so it can be
// reported), and offer ways out that work - instead of Next's default page, whose Reload and Back
// only lead to the same break. Sits above the devotee shell, so a fault in the shell itself (the
// reminders, the phone link) is caught here too.

import { useEffect } from "react";

export default function DevoteeError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Devotee portal error:", error);
  }, [error]);

  const signOut = () => {
    try {
      localStorage.removeItem("token");
    } catch {
      // Storage blocked: the sign-in page still opens.
    }
    // A full load on purpose: it starts the app afresh, past whatever broke.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  };

  const button = "w-full rounded-control px-4 py-3 text-sm font-semibold";
  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-sm rounded-panel border border-line-soft bg-surface p-6 text-center shadow-raised">
        <h1 className="text-lg font-semibold text-ink">Something went wrong on this screen</h1>
        <p className="mt-2 text-sm text-ink-muted">Please try again. If it keeps happening, send this to the temple office:</p>
        <p className="mt-3 break-words rounded-control bg-sunken px-3 py-2 font-mono text-xs text-ink-soft">
          {error.message || "Unknown error"}
          {error.digest ? ` (${error.digest})` : ""}
        </p>
        <div className="mt-5 space-y-2">
          <button type="button" onClick={reset} className={`${button} bg-brand-600 text-white`}>
            Try again
          </button>
          {/* A full load on purpose, as above. */}
          {/* eslint-disable-next-line @next/next/no-location-assign-relative-destination */}
          <button type="button" onClick={() => window.location.assign("/devotee/home")} className={`${button} text-ink-soft ring-1 ring-inset ring-line-soft`}>
            Go to Home
          </button>
          <button type="button" onClick={signOut} className={`${button} text-ink-muted`}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
