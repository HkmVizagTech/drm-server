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
  source?: SankalpSource | null;
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
  /** 'site': taken from what the donor filled in on a donation form. */
  origin?: "sheet" | "manual" | "site" | null;
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
  source: SankalpSource;
  /** What they have given, for a donor DRM knows. */
  total_given?: string | number | null;
  call_count?: number;
  last_call_at?: string | null;
  last_call_outcome?: CallOutcome | null;
  last_call_note?: string | null;
  last_caller_name?: string | null;
  next_call_at?: string | null;
}

/** Where a donor came from - kept apart by a switch and a colour. */
export type SankalpSource = "sheet" | "donors" | "manual";

export const SOURCE: Record<SankalpSource, { label: string; short: string; chip: string; dot: string }> = {
  sheet: { label: "Uploaded sheet", short: "Sheet", chip: "bg-violet-50 text-violet-700 ring-violet-200", dot: "bg-violet-400" },
  donors: { label: "From donations", short: "Donor", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
  manual: { label: "Added by hand", short: "Added", chip: "bg-sky-50 text-sky-700 ring-sky-200", dot: "bg-sky-400" },
};

export type CallOutcome = "no_answer" | "busy" | "call_back" | "got_details" | "verified" | "not_interested" | "wrong_number";

export const OUTCOME_WORDS: Record<CallOutcome, string> = {
  no_answer: "No answer",
  busy: "Busy",
  call_back: "Call back",
  got_details: "Got the details",
  verified: "Details correct",
  not_interested: "Not interested",
  wrong_number: "Wrong number",
};

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
