// Shared formatting helpers. Centralised so money and dates read identically
// on every screen - previously each page hand-rolled its own
// `₹${Number(x).toLocaleString("en-IN")}`, which drifts the moment one of them
// forgets the Number() and silently concatenates strings instead of adding.

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

export function currency(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return INR.format(Number.isFinite(n) ? n : 0);
}

// Indian-numbering compact form for stat tiles and axis ticks, where the full
// figure would blow out the layout: 1.2L, 4.5Cr. Full precision still belongs
// in tables and tooltips.
export function currencyCompact(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "₹0";
  const abs = Math.abs(n);
  if (abs >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(abs >= 10_00_00_000 ? 0 : 1)}Cr`;
  if (abs >= 1_00_000) return `₹${(n / 1_00_000).toFixed(abs >= 10_00_000 ? 0 : 1)}L`;
  if (abs >= 1_000) return `₹${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `₹${Math.round(n)}`;
}

export function number(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat("en-IN").format(Number.isFinite(n) ? n : 0);
}

// The temple is in Visakhapatnam and every screen is read against the office's
// day: a caller whose phone is on the wrong zone, or an admin ringing from
// abroad, has to see the date the office sees. Nothing here may fall back to
// the device's own zone, so every date formatter below pins this one.
export const IST = "Asia/Kolkata";

// DATE columns - date_of_birth, anniversary_date, start_date, next_charge_date
// - arrive as a bare `YYYY-MM-DD` with no time on them. `new Date('1985-03-12')`
// is specified to parse that as UTC midnight, which is still the 11th anywhere
// west of UTC, so a birthday formatted on a laptop in London would read a day
// early. Anchoring the bare form at IST midnight instead keeps the calendar day
// the office entered, whatever zone the browser is in.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d =
    typeof value === "string" && DATE_ONLY.test(value)
      ? new Date(`${value}T00:00:00+05:30`)
      : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * An instant's IST calendar date as `YYYY-MM-DD`. en-CA is the locale that
 * already formats in exactly that order, so there is nothing to reassemble.
 *
 * This is the unit the day arithmetic below counts in: "yesterday" is a
 * different calendar date in Visakhapatnam, not a gap of 24 hours.
 */
export function istDateKey(value: string | number | Date | null | undefined): string {
  const d = parseDate(value);
  if (!d) return "";
  return d.toLocaleDateString("en-CA", { timeZone: IST });
}

/** Today's date at the temple, which is not always today's date on the device. */
export function istToday(): string {
  return istDateKey(new Date());
}

/** The IST calendar date `days` away from `from` (today by default). */
export function istDayPlus(days: number, from?: string | number | Date | null): string {
  const key = istDateKey(from ?? new Date());
  if (!key) return "";
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The instant at a wall-clock IST moment: `istInstant("2026-03-12", "10:00")`. */
export function istInstant(day: string, time = "00:00"): Date {
  return new Date(`${day}T${time.length === 5 ? `${time}:00` : time}+05:30`);
}

/**
 * What an `<input type="datetime-local">` gives back, as an instant.
 *
 * The value carries no offset at all, so `new Date(value)` reads it in the
 * device's zone and a promise entered as "6pm" would be stored as 6pm somewhere
 * else entirely. The caller meant 6pm at the temple, so say so.
 */
export function istInputToISO(value: string): string {
  const [day, time] = value.split("T");
  return istInstant(day, time || "00:00").toISOString();
}

/**
 * Whole days from `from` to `to`, counted as IST calendar days rather than as
 * elapsed milliseconds - so 10pm last night to 9am today is one day, not zero.
 */
function istDayDiff(from: Date, to: Date): number {
  const a = Date.parse(`${istDateKey(from)}T00:00:00Z`);
  const b = Date.parse(`${istDateKey(to)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Day of the week in IST, 0 = Sunday, as `Date#getDay` would read it at the temple. */
export function istWeekday(value?: string | number | Date | null): number {
  const key = istDateKey(value ?? new Date());
  return key ? new Date(`${key}T00:00:00Z`).getUTCDay() : 0;
}

/** The year an instant falls in at the temple, for "last gave in 2024". */
export function istYear(value: string | number | Date | null | undefined): string {
  return istDateKey(value).slice(0, 4);
}

export function shortDate(value: string | null | undefined): string {
  const d = parseDate(value);
  if (!d) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: IST });
}

/** Date and clock time together, for anything where the hour is the point. */
export function dateTime(value: string | null | undefined): string {
  const d = parseDate(value);
  if (!d) return "—";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: IST,
  });
}

/**
 * Just the clock time, in IST.
 *
 * Sits under a date in the money tables rather than being folded into it.
 * Reconciling a shift or matching a bank statement is a question about the
 * hour — "did that eleven hundred come in before or after I rang him" — and a
 * date alone cannot answer it. Kept separate from dateTime() because in a
 * narrow table column the date and the time want to be on two lines.
 */
export function clockTime(value: string | null | undefined): string {
  const d = parseDate(value);
  if (!d) return "";
  return d.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: IST,
  });
}

// "3 days ago" reads faster than a date when scanning for staleness (when did
// this donor last give?), which is the common question in a donor list.
//
// Counted in IST calendar days, not in elapsed time. The old version divided
// the millisecond gap by 86,400,000, which answers "within the last 24 hours"
// instead of "today": at 9am a donation logged at 10pm the night before came
// back as "Today", and the list showed nothing having gone quiet.
export function relativeDate(value: string | null | undefined): string {
  if (!value) return "Never";
  const d = parseDate(value);
  if (!d) return "—";
  const days = istDayDiff(d, new Date());
  if (days < 0) return shortDate(value);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

// "2026-03" -> "Mar" / "Mar '26" for chart axes. Built at UTC midnight rather
// than local midnight so that pinning IST below cannot drag the label back into
// the previous month for a reader east of the temple.
export function monthLabel(ym: string, withYear = false): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", timeZone: IST });
  return withYear ? `${name} '${String(y).slice(2)}` : name;
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Percent change, guarding the divide-by-zero case that a first month of
// giving would otherwise hit.
export function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * How a scheduled callback reads: how late a promise is, or how soon one is
 * due.
 *
 * relativeDate() above answers the opposite question ("how long ago") and falls
 * back to a plain date for anything in the future - which is every row on the
 * follow-ups board, so it ended up printing the date twice. This is the future
 * half of the same idea, kept here rather than in a page so the calling screen
 * and the follow-ups board cannot word it differently.
 */
export function dueLabel(value: string | null | undefined): string {
  if (!value) return "";
  const d = parseDate(value);
  if (!d) return "";
  // Counted from IST midnight rather than the browser's. A callback booked for
  // 10am Visakhapatnam time is "tomorrow" or "today" depending on which day it
  // is at the temple, not on which day it is wherever the laptop happens to be.
  const days = istDayDiff(new Date(), d);
  if (days < -1) return `${Math.abs(days)} days late`;
  if (days === -1) return "1 day late";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days} days`;
  if (days < 14) return "next week";
  return `in ${Math.round(days / 7)} weeks`;
}
