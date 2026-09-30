// How far ahead of a reminder to raise an alert.
//
// WHY THIS IS ONE LIST IN ONE FILE
// The same offsets appear in three places - the calling screen where a caller
// books a promise mid-call, the follow-ups screen where somebody records a
// promise made over the phone, and Calling setup where the temple sets its
// default. Three copies would drift, and the drift would be invisible: a
// caller ticking "2 days before" in one screen and getting something else in
// another is the kind of bug nobody reports because nobody can prove it.
//
// The values are minutes before the due time, which is what lead_reminders
// stores. They run out to a week because a promise made at Janmashtami for
// Govardhan Puja is nine weeks away, and a single alert on the morning is no
// use to anybody.

export interface AlertOption {
  minutes: number;
  label: string;
}

export const ALERT_OPTIONS: AlertOption[] = [
  { minutes: 10080, label: "A week before" },
  { minutes: 4320, label: "3 days before" },
  { minutes: 2880, label: "2 days before" },
  { minutes: 1440, label: "The day before" },
  { minutes: 180, label: "3 hours before" },
  { minutes: 60, label: "An hour before" },
  { minutes: 15, label: "15 minutes before" },
];

/**
 * A default for a promise made well in advance: two days, a day, an hour.
 *
 * Wider than the old built-in of a day/hour/quarter-hour, because that one was
 * written for a reminder booked during a call for later the same week.
 */
export const DEFAULT_ALERTS = [2880, 1440, 60];

/** One offset in words, for anywhere a saved reminder is displayed. */
export function alertLabel(minutes: number): string {
  const known = ALERT_OPTIONS.find((o) => o.minutes === minutes);
  if (known) return known.label;
  if (minutes === 0) return "at the time";
  if (minutes < 60) return `${minutes} min before`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hr before`;
  return `${Math.round(minutes / 1440)} days before`;
}

/** A whole set of offsets, shortened: "2 days, 1 day, 1 hr before". */
export function alertSummary(minutes: number[]): string {
  if (!minutes.length) return "no alerts";
  const short = (m: number) =>
    m === 0 ? "at the time" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} hr` : `${Math.round(m / 1440)} day`;
  return `${[...minutes].sort((a, b) => b - a).map(short).join(", ")} before`;
}

/** Sorted, de-duplicated, and inside what the server will accept (30 days). */
export function cleanAlerts(minutes: number[]): number[] {
  return [...new Set(minutes.map((m) => Math.round(m)))]
    .filter((m) => Number.isFinite(m) && m >= 0 && m <= 43200)
    .sort((a, b) => b - a);
}
