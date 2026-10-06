// Sankalpam: shared types and the small rules every screen of it uses.

import type { IconName } from "@/components/icons";

export type SankalpStatus = "todo" | "ready" | "sent" | "skipped";

/** One special day, in one year. */
export interface Occurrence {
  date_id: string;
  donor_id: string;
  occasion: string;
  month: number;
  day: number;
  orig_year: number | null;
  date_notes: string | null;
  year: number;
  due_on: string;
  /** The day it was added: a day that passed before it was added was never "missed". */
  added_on: string;
  donor_name: string;
  sevak_name: string | null;
  phone: string | null;
  alt_phone: string | null;
  preacher: string | null;
  preacher_name: string | null;
  patron_number: string | null;
  person_id: string | null;
  status: SankalpStatus;
  note: string | null;
  done_at: string | null;
  done_by_name: string | null;
}

export interface SankalpDate {
  id?: string;
  occasion: string;
  month: number;
  day: number;
  orig_year: number | null;
  notes?: string | null;
  active?: boolean;
}

export interface SankalpDonor {
  id: string;
  patron_number: string | null;
  donor_name: string;
  sevak_name: string | null;
  phone: string | null;
  alt_phone: string | null;
  preacher: string | null;
  preacher_name: string | null;
  gotram: string | null;
  address: string | null;
  notes: string | null;
  person_id: string | null;
  active: boolean;
  dates: SankalpDate[];
}

export interface SankalpSummary {
  today: number;
  missed: number;
  tomorrow: number;
}

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The kinds of day, for a colour and an icon. Worked out from the words. */
export type DayKind = "birthday" | "anniversary" | "remembrance" | "other";

export function dayKind(occasion: string): DayKind {
  const o = occasion.toLowerCase();
  if (/death|punya|tithi|remembrance|late |shraddh|varsh/.test(o)) return "remembrance";
  if (/anniversar|marriage|marrage|wedding|married/.test(o)) return "anniversary";
  if (/birth|b'?day|dob|jayanti/.test(o)) return "birthday";
  return "other";
}

export const KIND: Record<DayKind, { label: string; icon: IconName; chip: string; tile: string }> = {
  birthday: { label: "Birthday", icon: "sparkle", chip: "bg-amber-50 text-amber-800 ring-amber-200", tile: "bg-amber-100 text-amber-800" },
  anniversary: { label: "Anniversary", icon: "star", chip: "bg-rose-50 text-rose-700 ring-rose-200", tile: "bg-rose-100 text-rose-700" },
  remembrance: { label: "Remembrance", icon: "calendar", chip: "bg-slate-100 text-slate-700 ring-slate-200", tile: "bg-slate-200 text-slate-700" },
  other: { label: "Special day", icon: "calendar", chip: "bg-sky-50 text-sky-700 ring-sky-200", tile: "bg-sky-100 text-sky-700" },
};

/** Suggestions for the occasion box - what the office's sheet says most. */
export const OCCASIONS = [
  "Birthday",
  "Wife Birthday",
  "Husband Birthday",
  "Son Birthday",
  "Daughter Birthday",
  "Father Birthday",
  "Mother Birthday",
  "Marriage Anniversary",
  "Parents Marriage Anniversary",
  "Father Remembrance Day",
  "Mother Remembrance Day",
];

/** "Sevak" and donor are often the same person written the other way round. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const k = (s: string | null | undefined) =>
    String(s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
  return !a || !b || k(a) === k(b);
}

export const dayMonth = (day: number, month: number) => `${day} ${MONTHS[month - 1]}`;

/** "Tue, 6 Oct" for a YYYY-MM-DD day. */
export function dayLabel(iso: string, long = false): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", {
    weekday: long ? "long" : "short",
    day: "numeric",
    month: long ? "long" : "short",
    timeZone: "UTC",
  });
}

export function plusDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const isPending = (o: { status: SankalpStatus }) => o.status === "todo" || o.status === "ready";
