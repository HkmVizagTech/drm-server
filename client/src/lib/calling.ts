// The client side of a calling run. Every screen that starts one goes through
// startRun(), and every "Call" button anywhere goes through callHref(), so
// that a call made from any page lands on the call screen - where its outcome
// is recorded - instead of a bare tel: link that DRM never hears about.

import { api } from "./api";

export type SourceKind =
  | "everything"
  | "mine"
  | "list"
  | "follow_ups"
  | "reminders"
  | "nearly_gave"
  | "selection";

export interface RunSource {
  kind: SourceKind;
  list_id?: string;
  /** For a selection: these people, in this order. */
  lead_ids?: string[];
  /** For a selection: everybody the leads screen's filters find. */
  filters?: Record<string, string>;
  label?: string;
}

export interface RunCounts {
  total: number;
  pending: number;
  done: number;
  skipped: number;
  taken: number;
  /** 1-based place of the person on screen. */
  index: number;
  /** Still to ring after this one. */
  ahead: number;
}

export interface RunItem {
  position: number;
  state: "pending" | "done" | "skipped" | "taken";
  outcome: string | null;
  note: string | null;
  visited_at: string | null;
}

export interface RunState {
  session: {
    id: string;
    kind: SourceKind;
    label: string;
    list_id: string | null;
    position: number;
    started_at: string;
    paused_at: string | null;
    ended_at: string | null;
  } | null;
  item: RunItem | null;
  /** The lead row (as /leads/:id returns) plus open_reminders, nearly_gave, recent_activities. */
  lead: CallLead | null;
  counts: RunCounts;
  has_prev: boolean;
  finished: boolean;
  can_extend: boolean;
  /** Set by moves: people stepped past and why ("Rung by Arjun"). */
  passed?: { name: string | null; reason: string }[];
  message?: string | null;
  resumed?: boolean;
  empty?: boolean;
  adopted?: { created: number; already_yours: number; do_not_call: number } | null;
}

export interface RunSummary {
  calls: number;
  connected: number;
  promised: number;
  promised_amount: number;
  donated: number;
  donated_amount: number;
  credited: number;
  skipped: number;
  left_to_call: number;
  taken: number;
  outcomes: { disposition: string; label: string; n: number }[];
  started_at: string;
  ended_at: string | null;
}

/** Where the call screen lives. */
export const CALL_SCREEN = "/calling/queue";

/** The call screen for one run. */
export function runHref(sessionId: string) {
  return `${CALL_SCREEN}?session=${sessionId}`;
}

/**
 * The call screen for one person, outside any run - what every "Call" button
 * on the leads, follow-ups, reminders and Nearly gave screens opens. The
 * outcome is logged exactly as in a run; nothing is lost by calling from a
 * list.
 */
export function callHref(leadId: string, back?: string) {
  return `${CALL_SCREEN}?lead=${leadId}${back ? `&back=${encodeURIComponent(back)}` : ""}`;
}

/**
 * Start (or carry on with) a run. Resolves with the state, or with
 * `{ empty: true }` when the source finds nobody - the caller should say so
 * rather than open an empty call screen.
 */
export function startRun(source: RunSource, opts: { restart?: boolean; adopt_new?: boolean } = {}) {
  return api<RunState>("/api/crm/sessions", {
    method: "POST",
    body: JSON.stringify({ source, ...opts }),
  });
}

export function moveRun(sessionId: string, action: "next" | "skip" | "prev" | "jump" | "revisit", position?: number) {
  return api<RunState>(`/api/crm/sessions/${sessionId}/move`, {
    method: "POST",
    body: JSON.stringify({ action, position }),
  });
}

/* ------------------------------------------------------------ the start screen */

/** One fixed source on the start screen ("Nearly gave", "Promises due"…). */
export interface SourceCard {
  kind: SourceKind;
  key: string;
  label: string;
  /** Exactly the number a run started now would hold. */
  count: number;
  /** Nearly gave only: website attempts that are not leads yet and will be added first. */
  new_attempts?: number;
}

export interface ListSourceCard {
  kind: "list";
  key: string;
  list_id: string;
  label: string;
  description: string | null;
  assigned_to_me: boolean;
  count: number;
}

/** A run the caller can carry on with. */
export interface OpenRun {
  id: string;
  key: string;
  kind: SourceKind;
  label: string;
  list_id: string | null;
  last_active_at: string;
  paused: boolean;
  total: number;
  done: number;
  skipped: number;
  pending: number;
}

export interface SourcesResponse {
  sources: SourceCard[];
  lists: ListSourceCard[];
  open: OpenRun[];
}

export function getSources() {
  return api<SourcesResponse>("/api/crm/sessions/sources");
}

/* -------------------------------------------------------------- the run itself */

export function getRun(sessionId: string) {
  return api<RunState>(`/api/crm/sessions/${sessionId}`);
}

/** One row of the "Up next" panel. */
export interface RunListItem {
  position: number;
  state: RunItem["state"];
  outcome: string | null;
  outcome_label: string | null;
  /** Why a "taken" person was stepped past ("Rung by Arjun"). */
  note: string | null;
  lead_id: string;
  name: string | null;
  phone: string;
  city: string | null;
  expected_amount: string | null;
  last_outcome: string | null;
  last_contacted_at: string | null;
  next_follow_up_at: string | null;
  call_attempts: number;
  nearly_gave: boolean;
}

export function getRunItems(sessionId: string) {
  return api<{ items: RunListItem[]; position: number }>(`/api/crm/sessions/${sessionId}/items`);
}

export function getRunSummary(sessionId: string) {
  return api<{ summary: RunSummary }>(`/api/crm/sessions/${sessionId}/summary`);
}

/**
 * Pause answers with the bare session row, not a RunState - so the caller
 * patches `paused_at` locally instead of re-reading the run, which would
 * re-claim the person on screen that pausing has just let go.
 */
export function pauseRun(sessionId: string, note?: string) {
  return api<{ session: { paused_at: string | null } }>(`/api/crm/sessions/${sessionId}/pause`, {
    method: "POST",
    body: JSON.stringify(note ? { note } : {}),
  });
}

export function resumeRun(sessionId: string) {
  return api<RunState>(`/api/crm/sessions/${sessionId}/resume`, { method: "POST", body: "{}" });
}

export function endRun(sessionId: string) {
  return api<{ summary: RunSummary }>(`/api/crm/sessions/${sessionId}/end`, { method: "POST", body: "{}" });
}

export function heartbeatRun(sessionId: string) {
  return api<{ held: boolean }>(`/api/crm/sessions/${sessionId}/heartbeat`, { method: "POST", body: "{}" });
}

/* ------------------------------------------------------------ the call screen */

export interface Disposition {
  slug: string;
  label: string;
  counts_connected: boolean;
  suggests_status: string | null;
  wants_follow_up: boolean;
}

/** A promise still open on the person on screen. */
export interface OpenReminder {
  id: string;
  title: string;
  occasion: string | null;
  due_at: string;
  expected_amount: string | null;
}

/** What they last tried to give on a website, from the abandoned attempts. */
export interface NearlyGave {
  amount: string | number | null;
  purpose: string | null;
  source_site: string | null;
  source_page: string | null;
  attempted_at: string;
  status: string | null;
}

export interface RecentActivity {
  id: string;
  kind: string;
  disposition: string | null;
  disposition_label: string | null;
  connected: boolean | null;
  note: string | null;
  occurred_at: string;
  created_at?: string;
  user_name: string | null;
  from_value: string | null;
  to_value: string | null;
}

/**
 * The person on the call screen. The same shape whether it came from a run
 * (GET /sessions/:id) or from one lead (GET /leads/:id, reshaped by
 * toCallLead), so the card and the outcome buttons never need to know which.
 */
export interface CallLead {
  id: string;
  phone: string;
  alt_phone: string | null;
  name: string | null;
  email: string | null;
  city: string | null;
  person_id: string | null;
  status: string;
  status_label: string | null;
  status_tone: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  tags: string[];
  remarks: string | null;
  next_follow_up_at: string | null;
  follow_up_note: string | null;
  last_contacted_at: string | null;
  last_outcome: string | null;
  call_attempts: number;
  expected_amount: string | null;
  do_not_call: boolean;
  converted_at: string | null;
  converted_amount: string | null;
  preacher_code: string | null;
  preacher_name: string | null;
  external_total_donated: string | null;
  external_account_count: number | null;
  external_last_donation_at: string | null;
  external_source?: string | null;
  total_donated: string | null;
  donation_count: number | null;
  last_donation_at: string | null;
  source: string;
  source_detail: string | null;
  source_site: string | null;
  open_reminders: OpenReminder[];
  nearly_gave: NearlyGave | null;
  recent_activities: RecentActivity[];
}

/**
 * GET /leads/:id answers `{ lead, activities, reminders, … }` rather than the
 * flattened shape a run carries. Reshaped here, once, so the call screen has
 * one kind of person to draw.
 *
 * `nearly_gave` comes with it too, so a call opened from a list shows the
 * website attempt exactly as a run does.
 */
export function toCallLead(d: {
  lead: Record<string, unknown>;
  activities?: RecentActivity[];
  reminders?: (OpenReminder & { status?: string })[];
  nearly_gave?: NearlyGave | null;
}): CallLead {
  const l = d.lead as unknown as CallLead;
  return {
    ...l,
    tags: Array.isArray(l.tags) ? l.tags : [],
    open_reminders: (d.reminders ?? []).filter((r) => (r.status ?? "open") === "open").slice(0, 5),
    nearly_gave: d.nearly_gave ?? null,
    recent_activities: (d.activities ?? []).slice(0, 8),
  };
}

/** "98765 43210" - how a number is read aloud, and so how it is read on screen. */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const d = phone.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : phone;
}

/** The dialler. Always +91: every number DRM stores is a 10-digit Indian mobile. */
export function telHref(phone: string) {
  return `tel:+91${phone.replace(/\D/g, "").slice(-10)}`;
}

/** A WhatsApp chat with them, with nothing typed - for "I'll send it on WhatsApp". */
export function whatsappHref(phone: string) {
  return `https://wa.me/91${phone.replace(/\D/g, "").slice(-10)}`;
}

/**
 * Which outcome sits on which number key.
 *
 * Fixed rather than "the first nine in the order shown", because that order
 * comes from Settings and moves - and a caller's fingers learn positions. It
 * also used to put "Asked not to be called" on 8, beside 9 for "No answer":
 * one slip of a finger and a donor was never rung again. That outcome, and the
 * other two that close a lead as unreachable, have no key at all; they are a
 * deliberate tap. Busy and Switched off do, because after No answer they are
 * the commonest outcome of the day.
 */
const KEYED_OUTCOMES = [
  "interested",
  "will_donate",
  "will_pay_qr",
  "donated",
  "call_back",
  "not_interested",
  "no_answer",
  "busy",
  "switched_off",
];
/** Never on a key, whatever Settings adds. */
const NEVER_KEYED = ["do_not_call", "wrong_number", "invalid_number"];

export function outcomeKeys(dispositions: Disposition[]): Map<string, number> {
  const bySlug = new Map(dispositions.map((d) => [d.slug, d]));
  const keyed = KEYED_OUTCOMES.filter((s) => bySlug.has(s));
  // A temple that renamed or added outcomes still gets nine keys, filled from
  // whatever is left - except anything that closes a lead for good.
  for (const d of dispositions) {
    if (keyed.length >= 9) break;
    if (keyed.includes(d.slug) || NEVER_KEYED.includes(d.slug)) continue;
    if (["dnc", "invalid"].includes(d.suggests_status ?? "")) continue;
    keyed.push(d.slug);
  }
  return new Map(keyed.slice(0, 9).map((slug, i) => [slug, i + 1]));
}
