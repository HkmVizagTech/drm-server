"use client";

// Call recording for a devotee, inside the DRM Android app.
//
// DevoteePhoneBridge (mounted once by the devotee shell) links the phone to the devotee and sends
// every Call button through the app, so the call is placed from the SIM and tied to the lead.
// CallRecordingCard (on Home) walks the devotee through the phone's permissions.
//
// The phone then reports calls with the devotee's own leads - and only those - with the phone's
// recording of each. They are kept apart from DRM's call log: only this devotee can hear them.
// In a browser none of this renders or runs.

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { dialerHidesRecordings, ensureLinked, missing, phone, placeCall, useInApp, type PhoneInfo } from "@/lib/phone-app";
import { Alert, Button } from "@/components/ui";

/** Links the phone and routes Call buttons through the app. Renders nothing. */
export function DevoteePhoneBridge() {
  const app = useInApp();
  const { user } = useAuth();
  const path = usePathname();

  useEffect(() => {
    if (!app || !user?.id) return;
    void ensureLinked(user.id).catch(() => undefined);
  }, [app, user?.id, path]);

  useEffect(() => {
    if (!app) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="tel:"]') as HTMLAnchorElement | null;
      if (!a) return;
      const number = a.getAttribute("href")!.slice(4).replace(/\D/g, "").slice(-10);
      if (number.length !== 10) return;
      e.preventDefault();
      void placeCall(number, a.dataset.leadId ?? null);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [app]);

  return null;
}

/** Home: what the phone still needs before calls and recordings can be saved. */
export function CallRecordingCard() {
  const app = useInApp();
  const { user } = useAuth();
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to read the phone's permissions again.
  const [tick, setTick] = useState(0);
  const userId = user?.id;

  useEffect(() => {
    if (!app || !userId) return;
    let live = true;
    ensureLinked(userId)
      .then((i) => live && setInfo(i))
      // Not linked yet (offline): the card stays hidden and the bridge tries again.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [app, userId, tick]);

  // Back from the phone's settings: read the permissions again.
  useEffect(() => {
    if (!app) return;
    const again = () => document.visibilityState === "visible" && setTick((t) => t + 1);
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [app]);

  if (!app || !info) return null;
  const todo = missing(info);
  const p = phone();

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  };

  if (todo.includes("calls")) {
    return (
      <Alert
        tone="info"
        title="Save your calls with your leads"
        action={<Button size="sm" icon="phone" loading={busy} onClick={() => void run(() => p!.requestPermissions())}>Allow</Button>}
      >
        Let the DRM app make calls and read the call log. Only calls with your own leads are saved - never your personal calls - and only you can see them.
      </Alert>
    );
  }
  if (todo.includes("recordings")) {
    return (
      <Alert
        tone="info"
        title="Keep the recording of each call"
        action={<Button size="sm" icon="mic" loading={busy} onClick={() => void run(() => p!.openAllFilesSettings())}>Allow</Button>}
      >
        Turn on “Allow access to manage all files” for DRM, so it can find your phone’s recording of each call with a lead. Only you can listen to them.
      </Alert>
    );
  }
  if (dialerHidesRecordings(info.dialer)) {
    return (
      <Alert tone="warn" title="This phone keeps its recordings private">
        Your phone’s dialer (Google Phone) does not share call recordings with other apps. Your calls with leads are still saved, with their talk time, but without the recording.
      </Alert>
    );
  }
  if (!info.permissions?.battery) {
    return (
      <Alert
        tone="info"
        title="Let DRM save calls in the background"
        action={<Button size="sm" variant="secondary" loading={busy} onClick={() => void run(() => p!.openBatterySettings())}>Open settings</Button>}
      >
        Set DRM’s battery use to “No restrictions”, so calls and reminders are not held back while the app is closed.
      </Alert>
    );
  }
  return null;
}
