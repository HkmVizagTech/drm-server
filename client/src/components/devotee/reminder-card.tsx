"use client";

// Ask once to turn reminders on for this device, and say plainly when they cannot be.

import { Alert, Button } from "@/components/ui";
import { useDevotee } from "@/lib/devotee-context";

export function ReminderCard() {
  const { push, enablePush } = useDevotee();
  if (push === "checking" || push === "on" || push === "app") return null;

  if (push === "denied") {
    return (
      <Alert tone="warn" title="Reminders are blocked on this device">
        Notifications for this site are turned off. Allow them in your phone or browser settings to be reminded of follow-ups.
      </Alert>
    );
  }
  if (push === "unsupported" || push === "not_configured") {
    return (
      <Alert tone="info" title="Reminders show while DRM is open">
        {push === "unsupported"
          ? "This browser cannot show reminders when DRM is closed. On Android, open DRM in Chrome; on iPhone, add it to the Home Screen first."
          : "Phone reminders are not switched on by the temple office yet. Keep DRM open to see follow-ups as they come due."}
      </Alert>
    );
  }
  return (
    <Alert
      tone="info"
      title="Get a reminder at each follow-up time"
      action={
        <Button size="sm" icon="bell" onClick={() => void enablePush()}>
          Turn on
        </Button>
      }
    >
      Your phone will notify you when it is time to call someone back, even when DRM is closed.
    </Alert>
  );
}
