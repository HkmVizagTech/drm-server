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

export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// "3 days ago" reads faster than a date when scanning for staleness (when did
// this donor last give?), which is the common question in a donor list.
export function relativeDate(value: string | null | undefined): string {
  if (!value) return "Never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
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

// "2026-03" -> "Mar" / "Mar '26" for chart axes.
export function monthLabel(ym: string, withYear = false): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  const name = new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short" });
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
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - midnight.getTime()) / 86_400_000);
  if (days < -1) return `${Math.abs(days)} days late`;
  if (days === -1) return "1 day late";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days} days`;
  if (days < 14) return "next week";
  return `in ${Math.round(days / 7)} weeks`;
}
