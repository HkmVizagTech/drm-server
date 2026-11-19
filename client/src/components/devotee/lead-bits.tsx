"use client";

// Small pieces every devotee screen shows a lead with: its status, when to follow up, and the
// buttons to reach the person.

import Link from "next/link";
import { Badge } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { clockTime, currency, dueLabel, shortDate } from "@/lib/format";
import {
  PRIORITY,
  STATUS,
  addressLine,
  directionsHref,
  isOverdue,
  telHref,
  whatsappHref,
  type DevoteeLead,
  type LeadStatus,
  type Priority,
} from "@/lib/devotee";

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

export function PriorityDot({ priority }: { priority: Priority }) {
  const colour = { hot: "bg-danger", warm: "bg-warn", cold: "bg-info" }[priority];
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-muted" title={`${PRIORITY[priority].label} chance of donating`}>
      <span className={`h-2 w-2 rounded-full ${colour}`} aria-hidden />
      {PRIORITY[priority].label} chance
    </span>
  );
}

/** "Today, 4:30 pm" in red when late; nothing when no follow-up is set. */
export function FollowUpWhen({ at, compact = false }: { at: string | null; compact?: boolean }) {
  if (!at) return compact ? null : <span className="text-xs text-ink-faint">No follow-up set</span>;
  const late = isOverdue(at);
  const words = dueLabel(at);
  const when = words === "today" || words === "tomorrow" ? `${words[0].toUpperCase()}${words.slice(1)}, ${clockTime(at)}` : `${shortDate(at)}, ${clockTime(at)}`;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${late ? "text-danger" : "text-ink-soft"}`}>
      <Icon name={late ? "alert" : "clock"} size={13} />
      {late ? `Overdue · ${when}` : when}
    </span>
  );
}

function RoundAction({ href, icon, label, tone = "default", external = false, leadId }: { href: string; icon: IconName; label: string; tone?: "default" | "whatsapp" | "brand"; external?: boolean; leadId?: string }) {
  const tones = {
    default: "text-ink-soft ring-line-soft hover:bg-sunken",
    whatsapp: "text-[#1da851] ring-line-soft hover:bg-[#25D366]/10",
    brand: "text-brand-700 ring-brand-200 hover:bg-brand-50",
  }[tone];
  return (
    <a
      href={href}
      title={label}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      data-lead-id={leadId}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className={`inline-grid h-9 w-9 flex-none place-items-center rounded-full ring-1 ring-inset transition-colors ${tones}`}
    >
      <Icon name={icon} size={17} />
    </a>
  );
}

/** Call, WhatsApp and (when there is an address) directions, as round buttons. */
export function ContactActions({ lead }: { lead: Parameters<typeof directionsHref>[0] & Pick<DevoteeLead, "name" | "phone"> & { id?: string } }) {
  const directions = directionsHref(lead);
  return (
    <div className="flex items-center gap-1.5">
      <RoundAction href={telHref(lead.phone)} icon="phone" label={`Call ${lead.name}`} tone="brand" leadId={lead.id} />
      <RoundAction href={whatsappHref(lead.phone, `Hare Krishna ${lead.name.split(" ")[0]}!`)} icon="message" label={`WhatsApp ${lead.name}`} tone="whatsapp" external />
      {directions && <RoundAction href={directions} icon="route" label={`Directions to ${lead.name}`} external />}
    </div>
  );
}

/** One lead in a list: who, where they stand, when to follow up, and the quick actions. */
export function LeadRow({ lead, onLog, distance }: { lead: DevoteeLead; onLog?: (lead: DevoteeLead) => void; distance?: number | null }) {
  const place = [lead.area, lead.city].filter(Boolean).join(", ") || addressLine(lead);
  return (
    <li className="relative rounded-card border border-line-soft bg-surface p-3.5 shadow-card transition-shadow hover:shadow-raised sm:p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/devotee/leads/${lead.id}`} className="truncate text-sm font-semibold text-ink after:absolute after:inset-0 after:content-['']">
              {lead.name}
            </Link>
            <LeadStatusBadge status={lead.status} />
            {lead.priority === "hot" && <PriorityDot priority="hot" />}
          </div>
          <p className="mt-0.5 text-xs tabular-nums text-ink-muted">
            {lead.phone}
            {place && <span className="text-ink-faint"> · {place}</span>}
            {distance !== undefined && distance !== null && <span className="text-ink-faint"> · {distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(1)} km`}</span>}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <FollowUpWhen at={lead.next_follow_up_at} compact />
            {lead.unanswered_count > 0 && lead.status === "not_answered" && (
              <span className="text-xs text-ink-muted">{lead.unanswered_count} unanswered</span>
            )}
            {lead.total_donated > 0 && <span className="text-xs font-medium text-good">{currency(lead.total_donated)} given</span>}
          </div>
        </div>
        <div className="relative z-10 flex flex-col items-end gap-2">
          <ContactActions lead={lead} />
          {onLog && (
            <button
              type="button"
              onClick={() => onLog(lead)}
              className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-xs font-semibold text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-50"
            >
              <Icon name="edit" size={13} />
              Log follow-up
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
