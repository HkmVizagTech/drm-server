// A devotee's own leads: the shapes the API returns, the words the screens use for them, and the
// small helpers (call, WhatsApp, directions, follow-up presets) every devotee screen shares.
//
// The lists here mirror server/src/services/devoteeLeads.ts. A value the server does not know is
// refused there, so a list changed in one place and not the other fails loudly rather than quietly.

import { IST, currency, currencyCompact, istDayPlus, istInstant, istToday } from "./format";
import type { IconName } from "@/components/icons";

export type LeadStatus = "new" | "interested" | "call_later" | "not_answered" | "invalid_number" | "not_interested" | "donated";
export type Outcome = Exclude<LeadStatus, "new">;
export type Channel = "call" | "whatsapp" | "visit" | "other";
export type Priority = "hot" | "warm" | "cold";

export interface DevoteeLead {
  id: string;
  name: string;
  phone: string;
  alt_phone: string | null;
  email: string | null;
  occupation: string | null;
  organisation: string | null;
  interest: string | null;
  source: string | null;
  referred_by: string | null;
  priority: Priority;
  expected_amount: number | null;
  date_of_birth: string | null;
  anniversary_date: string | null;
  address_line: string | null;
  area: string | null;
  city: string | null;
  pincode: string | null;
  landmark: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  status: LeadStatus;
  next_follow_up_at: string | null;
  last_contacted_at: string | null;
  unanswered_count: number;
  total_donated: number;
  last_donated_on: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadActivity {
  id: string;
  lead_id: string;
  channel: Channel | null;
  outcome: Outcome | null;
  note: string | null;
  next_follow_up_at: string | null;
  amount: number | null;
  donated_on: string | null;
  payment_mode: string | null;
  purpose: string | null;
  reference: string | null;
  created_at: string;
  lead_name?: string;
}

/** A call the DRM app saw on the devotee's phone with this lead. */
export interface DevoteeCall {
  id: string;
  direction: "outbound" | "inbound" | "missed";
  started_at: string;
  duration_seconds: number;
  from_app: boolean;
  /** waiting: on its way from the phone. none: the phone had none. not_needed: nobody spoke. */
  recording_status: "waiting" | "uploaded" | "none" | "not_needed";
}

export interface DevoteeConfig {
  maps_key: string | null;
  map_id: string | null;
  push_key: string | null;
}

type Tone = "neutral" | "good" | "warn" | "info" | "danger" | "brand";

export const STATUS: Record<LeadStatus, { label: string; tone: Tone; icon: IconName }> = {
  new: { label: "New", tone: "info", icon: "sparkle" },
  interested: { label: "Interested", tone: "brand", icon: "star" },
  call_later: { label: "Call later", tone: "warn", icon: "clock" },
  not_answered: { label: "Not answered", tone: "neutral", icon: "phoneMissed" },
  invalid_number: { label: "Invalid number", tone: "danger", icon: "xCircle" },
  not_interested: { label: "Not interested", tone: "neutral", icon: "x" },
  donated: { label: "Donated", tone: "good", icon: "checkCircle" },
};
export const STATUS_ORDER: LeadStatus[] = ["new", "interested", "call_later", "not_answered", "donated", "not_interested", "invalid_number"];

/** The outcomes offered when logging a follow-up, in the order a devotee reaches for them. */
export const OUTCOME_ORDER: Outcome[] = ["not_answered", "call_later", "interested", "donated", "not_interested", "invalid_number"];
/** No one to ring after these: the follow-up time is hidden and dropped. */
export const CLOSED: Outcome[] = ["invalid_number", "not_interested"];

export const CHANNELS: { value: Channel; label: string; icon: IconName }[] = [
  { value: "call", label: "Call", icon: "phone" },
  { value: "whatsapp", label: "WhatsApp", icon: "message" },
  { value: "visit", label: "Visit", icon: "mapPin" },
  { value: "other", label: "Other", icon: "more" },
];

/** Chance of donating. Stored as hot / warm / cold; shown in plain words. */
export const PRIORITY: Record<Priority, { label: string; tone: Tone }> = {
  hot: { label: "High", tone: "danger" },
  warm: { label: "Medium", tone: "warn" },
  cold: { label: "Low", tone: "info" },
};

export const INTERESTS: { value: string; label: string }[] = [
  { value: "annadanam", label: "Annadanam" },
  { value: "temple_construction", label: "Temple construction" },
  { value: "gau_seva", label: "Gau seva" },
  { value: "festival_seva", label: "Festival seva" },
  { value: "nitya_seva", label: "Nitya seva" },
  { value: "general", label: "General donation" },
  { value: "volunteering", label: "Volunteering" },
  { value: "other", label: "Other" },
];

export const SOURCES: { value: string; label: string }[] = [
  { value: "personal", label: "Personal contact" },
  { value: "temple_visit", label: "Temple visit" },
  { value: "event", label: "Event or festival" },
  { value: "book_distribution", label: "Book distribution" },
  { value: "referral", label: "Referral" },
  { value: "social_media", label: "Social media" },
  { value: "other", label: "Other" },
];

export const PAYMENT_MODES: { value: string; label: string }[] = [
  { value: "upi", label: "UPI" },
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "card", label: "Card" },
  { value: "online", label: "Online (website)" },
  { value: "other", label: "Other" },
];

/** A total for a stat tile: exact up to ₹99,999, then "₹1.3L" so it fits a phone (the exact figure goes underneath). */
export const tileMoney = (n: number) => (Math.abs(n) >= 1_00_000 ? currencyCompact(n) : currency(n));

export const labelOf = (list: { value: string; label: string }[], v: string | null | undefined) =>
  list.find((x) => x.value === v)?.label ?? "";

/* --------------------------------------------------------------- reaching people */

const digits = (v: string | null | undefined) => String(v ?? "").replace(/\D/g, "");
/** A 10-digit Indian mobile as +91; anything longer is taken as already international. */
const international = (v: string | null | undefined) => {
  const d = digits(v);
  return d.length === 10 ? `91${d}` : d;
};

export const telHref = (phone: string | null | undefined) => `tel:+${international(phone)}`;
export const whatsappHref = (phone: string | null | undefined, text?: string) =>
  `https://wa.me/${international(phone)}${text ? `?text=${encodeURIComponent(text)}` : ""}`;

/** What an address is made of. Map pins carry no landmark, so it is optional. */
type Place = Pick<DevoteeLead, "address_line" | "area" | "city" | "pincode"> & { landmark?: string | null };

/** The address on one line, for a card or a map search. */
export function addressLine(l: Place): string {
  return [l.address_line, l.landmark, l.area, l.city, l.pincode].filter((x) => x && String(x).trim()).join(", ");
}

/** Google Maps directions to the lead: to the pin if there is one, else to the address text. Needs no API key. */
export function directionsHref(l: Place & Pick<DevoteeLead, "latitude" | "longitude">): string | null {
  if (l.latitude !== null && l.longitude !== null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${l.latitude},${l.longitude}`;
  }
  const text = addressLine(l);
  return text ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(text)}` : null;
}

/** One trip through several leads, in the order given. Google allows up to 9 stops plus the destination. */
export function routeHref(stops: { latitude: number; longitude: number }[]): string | null {
  if (!stops.length) return null;
  const pts = stops.slice(0, 10).map((s) => `${s.latitude},${s.longitude}`);
  const destination = pts[pts.length - 1];
  const waypoints = pts.slice(0, -1).join("|");
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${destination}${waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : ""}`;
}

/** Straight-line distance in km. Good enough to put the nearest leads first. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/* --------------------------------------------------------------- follow-up times */

/** An instant as the value an <input type="datetime-local"> shows, in IST. */
export function toIstInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // sv-SE formats as "YYYY-MM-DD HH:mm:ss", the order the input wants.
  return d.toLocaleString("sv-SE", { timeZone: IST, hour12: false }).slice(0, 16).replace(" ", "T");
}

const istHour = () => Number(new Date().toLocaleString("en-GB", { timeZone: IST, hour: "2-digit", hour12: false }));

export interface FollowUpPreset {
  key: string;
  label: string;
  at: () => Date;
}

/** Quick picks for the next follow-up, worked out at the temple's clock. */
export const FOLLOW_UP_PRESETS: FollowUpPreset[] = [
  { key: "1h", label: "In 1 hour", at: () => new Date(Date.now() + 60 * 60_000) },
  { key: "3h", label: "In 3 hours", at: () => new Date(Date.now() + 3 * 60 * 60_000) },
  {
    key: "evening",
    label: "This evening",
    at: () => (istHour() < 18 ? istInstant(istToday(), "18:00") : istInstant(istDayPlus(1), "18:00")),
  },
  { key: "tomorrow", label: "Tomorrow 10 AM", at: () => istInstant(istDayPlus(1), "10:00") },
  { key: "3d", label: "In 3 days", at: () => istInstant(istDayPlus(3), "10:00") },
  { key: "week", label: "Next week", at: () => istInstant(istDayPlus(7), "10:00") },
];

/** What the follow-up time starts as for each outcome. The devotee can change or clear it. */
export function defaultFollowUp(outcome: Outcome | null): string {
  const pick = (key: string) => FOLLOW_UP_PRESETS.find((p) => p.key === key)!.at().toISOString();
  switch (outcome) {
    case "not_answered":
      return istHour() < 18 ? pick("3h") : pick("tomorrow");
    case "interested":
      return pick("3d");
    default:
      return "";
  }
}

/** Is this follow-up already late? */
export const isOverdue = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() < Date.now();

/** Tell the other devotee screens (the reminder bell, lists) that a lead changed. */
export const LEADS_CHANGED = "devotee-leads-changed";
export const leadsChanged = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LEADS_CHANGED));
};
