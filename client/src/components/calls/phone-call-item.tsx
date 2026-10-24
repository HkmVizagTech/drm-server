"use client";

// One call the phone app saw: who, when, how long, what the caller logged,
// and the recording. Used by the Recordings list and the lead's card, so a
// call looks the same wherever it is met.

import Link from "next/link";
import { clockTime, dateTime } from "@/lib/format";
import { formatPhone } from "@/lib/calling";
import { DIRECTION, answered, recordingWords, talk, type PhoneCallRow } from "@/lib/phone-calls";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icons";
import { RecordingPlayer } from "./recording-player";

const CHIP = {
  brand: "bg-brand-50 text-brand-700 ring-brand-100",
  info: "bg-info-wash text-info ring-sky-100",
  warn: "bg-warn-wash text-warn ring-amber-100",
} as const;

export function PhoneCallItem({
  call: c,
  showDonor = true,
  showCaller = false,
  timeOnly = false,
}: {
  call: PhoneCallRow;
  showDonor?: boolean;
  showCaller?: boolean;
  /** Under a day heading: the clock time is enough. */
  timeOnly?: boolean;
}) {
  const d = DIRECTION[c.direction];
  const spoke = answered(c);
  const href = `/calling/recordings/${c.id}`;
  return (
    <li className="flex gap-3 py-3.5">
      <span className={`mt-0.5 grid h-9 w-9 flex-none place-items-center rounded-full ring-1 ring-inset ${CHIP[d.tone]}`}>
        <Icon name={d.icon} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href={href} className="block truncate font-medium text-ink hover:text-brand-700">
              {showDonor ? c.lead_name || formatPhone(c.phone) : d.label}
            </Link>
            <p className="mt-0.5 text-xs text-ink-muted">
              {[
                showDonor ? d.label : null,
                timeOnly ? clockTime(c.started_at) : dateTime(c.started_at),
                spoke ? talk(c.duration_seconds) : c.direction === "outbound" ? "Not answered" : null,
                showCaller ? c.caller_name : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <Link
            href={href}
            aria-label="Open this call"
            className="grid h-8 w-8 flex-none place-items-center rounded-control text-ink-faint hover:bg-sunken hover:text-brand-700"
          >
            <Icon name="chevronRight" size={16} />
          </Link>
        </div>

        {c.added_by_hand && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone="info">Added from a recording</Badge>
            {/* What the caller wrote when adding it, for the caller and the admin alike. */}
            {c.outcome_note?.replace(/^Added from a recording:?\s*/, "") && (
              <span className="min-w-0 text-xs text-ink-soft">{c.outcome_note.replace(/^Added from a recording:?\s*/, "")}</span>
            )}
          </div>
        )}

        {!c.added_by_hand && (c.disposition_label || c.disposition || (c.direction === "outbound" && spoke)) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {c.disposition_label || c.disposition ? (
              <Badge tone="neutral">{c.disposition_label ?? c.disposition}</Badge>
            ) : (
              <Badge tone="warn">No outcome saved</Badge>
            )}
            {c.outcome_note && <span className="min-w-0 truncate text-xs text-ink-soft">{c.outcome_note}</span>}
          </div>
        )}

        {c.recording_status === "uploaded" && c.can_listen ? (
          <div className="mt-2 max-w-md">
            <RecordingPlayer url={`/api/app/calls/${c.id}/recording`} seconds={c.duration_seconds} size="sm" />
          </div>
        ) : spoke ? (
          <p
            className={`mt-1.5 flex items-center gap-1.5 text-xs ${
              c.recording_status === "none" ? "text-warn" : "text-ink-faint"
            }`}
          >
            <Icon name={c.recording_status === "none" ? "alert" : c.recording_status === "uploaded" ? "mic" : "clock"} size={13} />
            {c.recording_status === "uploaded" ? "Recorded. Only the caller and admins can listen." : recordingWords(c.recording_status)}
          </p>
        ) : null}
      </div>
    </li>
  );
}
