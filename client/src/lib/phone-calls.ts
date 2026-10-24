// Calls the callers' phones saw (the DRM app): shared by the Recordings list,
// one call's page, the lead's card and the calling overview.

import type { IconName } from "@/components/icons";

export type CallDirection = "outbound" | "inbound" | "missed";
export type RecordingStatus = "waiting" | "uploaded" | "none" | "not_needed";

export interface PhoneCallRow {
  id: string;
  direction: CallDirection;
  phone: string;
  started_at: string;
  duration_seconds: number;
  from_app: boolean;
  /** Added by a caller from a recording, not reported by a phone. */
  added_by_hand?: boolean;
  recording_status: RecordingStatus;
  recording_bytes: number | null;
  user_id: string | null;
  caller_name: string | null;
  lead_id: string | null;
  lead_name: string | null;
  lead_phone: string | null;
  disposition: string | null;
  disposition_label: string | null;
  outcome_note: string | null;
  phone_model: string | null;
  phone_maker: string | null;
  can_listen: boolean;
}

export interface PhoneCallTotals {
  calls: number;
  outbound: number;
  answered_out: number;
  inbound: number;
  missed: number;
  talk_seconds: number;
  spoke: number;
  recorded: number;
  waiting: number;
  no_recording: number;
}

/** "3m 05s", "45s". */
export function talk(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "2:05", for a player. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const DIRECTION: Record<CallDirection, { label: string; short: string; icon: IconName; tone: "brand" | "info" | "warn" }> = {
  outbound: { label: "Called them", short: "Called", icon: "phoneOutgoing", tone: "brand" },
  inbound: { label: "They rang back", short: "Rang back", icon: "phoneIncoming", tone: "info" },
  missed: { label: "Missed their call", short: "Missed", icon: "phoneMissed", tone: "warn" },
};

/** Did anybody speak? An outgoing call with no talk time was not answered. */
export function answered(c: Pick<PhoneCallRow, "direction" | "duration_seconds">): boolean {
  return c.direction !== "missed" && c.duration_seconds > 0;
}

/** The recording's state, in words. */
export function recordingWords(status: RecordingStatus): string {
  switch (status) {
    case "uploaded":
      return "Recorded";
    case "waiting":
      return "Recording on its way from the phone";
    case "none":
      return "No recording found on the phone";
    default:
      return "Not answered - nothing to record";
  }
}

/** "Today", "Yesterday", "Mon 12 Oct" - a heading over a day's calls. */
export function dayHeading(key: string, today: string, yesterday: string): string {
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  const d = new Date(`${key}T12:00:00+05:30`);
  return d
    .toLocaleDateString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
      timeZone: "Asia/Kolkata",
    })
    .replace(/,/g, "");
}
