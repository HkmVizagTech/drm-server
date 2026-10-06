"use client";

// Where the calling has got to with one person, as a colour and a few words.
//
// A caller searching a number, or scanning a list, needs to know at a glance
// whether they have rung this person before - and what came of it - without
// opening them. One rule, used everywhere a lead appears, so the colour means
// the same thing on every screen:
//
//   green   Donated
//   red     Do not call, or a closed stage (not interested, wrong number)
//   amber   Call back due - today or overdue
//   blue    Called (today in a stronger blue), or a call back booked later
//   grey    Not called yet

import { dueLabel, relativeDate } from "@/lib/format";

export type CallTone = "good" | "danger" | "warn" | "info" | "called" | "none";

export interface CallStateInput {
  converted_at?: string | null;
  do_not_call?: boolean | null;
  status_is_open?: boolean | null;
  status_label?: string | null;
  next_follow_up_at?: string | null;
  last_contacted_at?: string | null;
  last_outcome_label?: string | null;
  last_caller_id?: string | null;
  last_caller_name?: string | null;
}

export interface CallState {
  tone: CallTone;
  label: string;
  /** "No answer · by you" - the last call, when there was one. */
  detail: string | null;
}

const endOfToday = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};
const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

export function callState(l: CallStateInput, meId?: string | null): CallState {
  const who =
    l.last_caller_id && meId && l.last_caller_id === meId ? "by you" : l.last_caller_name ? `by ${l.last_caller_name}` : null;
  const detail = l.last_contacted_at
    ? [l.last_outcome_label, relativeDate(l.last_contacted_at).toLowerCase(), who].filter(Boolean).join(" · ")
    : null;

  if (l.converted_at) return { tone: "good", label: "Donated", detail };
  if (l.do_not_call) return { tone: "danger", label: "Do not call", detail };
  if (l.status_is_open === false) return { tone: "danger", label: l.status_label || "Closed", detail };
  if (l.next_follow_up_at && new Date(l.next_follow_up_at).getTime() <= endOfToday()) {
    const late = dueLabel(l.next_follow_up_at);
    return { tone: "warn", label: late === "today" ? "Call back today" : `Call back · ${late}`, detail };
  }
  if (l.next_follow_up_at) {
    return {
      tone: "info",
      label: `Call back ${dueLabel(l.next_follow_up_at)}`,
      detail,
    };
  }
  if (l.last_contacted_at) {
    return { tone: isToday(l.last_contacted_at) ? "info" : "called", label: isToday(l.last_contacted_at) ? "Called today" : "Called", detail };
  }
  return { tone: "none", label: "Not called yet", detail: null };
}

const DOT: Record<CallTone, string> = {
  good: "bg-good",
  danger: "bg-danger",
  warn: "bg-warn",
  info: "bg-info",
  called: "bg-sky-300",
  none: "bg-line-strong",
};
const CHIP: Record<CallTone, string> = {
  good: "bg-good-wash text-good ring-emerald-200",
  danger: "bg-danger-wash text-danger ring-red-200",
  warn: "bg-warn-wash text-warn ring-amber-200",
  info: "bg-info-wash text-info ring-sky-200",
  called: "bg-sky-50 text-sky-700 ring-sky-200",
  none: "bg-sunken text-ink-muted ring-line-soft",
};
/** A coloured left edge for a row or card. */
export const CALL_EDGE: Record<CallTone, string> = {
  good: "border-l-good",
  danger: "border-l-danger",
  warn: "border-l-warn",
  info: "border-l-info",
  called: "border-l-sky-300",
  none: "border-l-transparent",
};

export function CallDot({ tone, className = "" }: { tone: CallTone; className?: string }) {
  return <span aria-hidden className={`inline-block h-2 w-2 flex-none rounded-full ${DOT[tone]} ${className}`} />;
}

/** The chip: dot and words, e.g. "● Called today". The detail goes under it where there is room. */
export function CallStateChip({ state, withDetail = false }: { state: CallState; withDetail?: boolean }) {
  return (
    <span className="inline-flex min-w-0 flex-col">
      <span
        className={`inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${CHIP[state.tone]}`}
      >
        <CallDot tone={state.tone} />
        {state.label}
      </span>
      {withDetail && state.detail && <span className="mt-0.5 truncate text-xs text-ink-muted">{state.detail}</span>}
    </span>
  );
}
