"use client";

// Who is about to be rung, and everything worth knowing before they answer.
//
// THE ORDER ON THE CARD IS THE ORDER OF THE CALL
// The number comes first and biggest, because on a phone the next thing the
// caller does is tap it. Then the two things that change the opening line -
// money they tried to give on a website this week, and anything they already
// promised - because "you were giving two thousand towards Annadan on Tuesday,
// did something go wrong?" is a warm call and "Hare Krishna, I am calling from
// the temple" is a cold one. History and the small print come last.
//
// Nothing here needs a second screen. A caller with a donor on the line has
// thirty seconds, and a detour to the full record costs most of them.

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { clockTime, currency, dueLabel, istYear, relativeDate, shortDate } from "@/lib/format";
import { Alert, Badge, Card, Icon, IconButton, LinkButton } from "@/components/ui";
import {
  callsHref,
  convertedViaLabel,
  formatPhone,
  telHref,
  whatsappHref,
  type CallLead,
  type RecentActivity,
} from "@/lib/calling";

/** The id of the name heading - focus moves here when a new person comes on screen. */
export const LEAD_HEADING_ID = "call-lead-name";

/** How the caller reached out, as far as this screen can know. */
export type DialVia = "call" | "alt" | "whatsapp" | "copy";

type BadgeTone = "neutral" | "good" | "warn" | "info" | "danger" | "brand";

/** crm_statuses.tone is a colour name chosen in Settings; this is what each one means here. */
export function statusTone(tone: string | null | undefined): BadgeTone {
  switch (tone) {
    case "emerald":
    case "green":
      return "good";
    case "amber":
    case "orange":
    case "yellow":
      return "warn";
    case "blue":
    case "sky":
    case "cyan":
      return "info";
    case "rose":
    case "red":
      return "danger";
    case "violet":
    case "purple":
      return "brand";
    default:
      return "neutral";
  }
}

/** "Tried to give ₹2,000 for Annadan on hkmv · 3 days ago". */
export function nearlyGaveLine(ng: NonNullable<CallLead["nearly_gave"]>): string {
  const amount = ng.amount ? ` ${currency(Number(ng.amount))}` : "";
  const purpose = ng.purpose ? ` for ${ng.purpose}` : "";
  return `Tried to give${amount}${purpose} · ${relativeDate(ng.attempted_at).toLowerCase()}`;
}

function activityLine(a: RecentActivity): string {
  if (a.kind === "call") return a.disposition_label ?? a.disposition ?? "Called";
  if (a.kind === "status_change") return `Moved to ${a.to_value?.replace(/_/g, " ") ?? "a new stage"}`;
  if (a.kind === "follow_up") return a.to_value ? `Follow-up on ${shortDate(a.to_value)}` : "Follow-up removed";
  if (a.kind === "reminder") return a.to_value ? `Promise for ${shortDate(a.to_value)}` : "Promise added";
  if (a.kind === "whatsapp") return "Sent a link on WhatsApp";
  if (a.kind === "qr_share") return "Sent a QR on WhatsApp";
  if (a.kind === "assignment") return a.to_value ? "Assigned to a caller" : "Unassigned";
  if (a.kind === "import") return a.note && /^Started a donation/.test(a.note) ? "Nearly gave online" : "Added from a sheet";
  if (a.kind === "link_donation") return "Linked a donation";
  return "Note";
}

export function LeadCard({
  lead,
  outcomeLabel,
  onEdit,
  isTouch,
  onDial,
  onLinkOther,
  directions,
}: {
  lead: CallLead;
  /** Turns a disposition slug (last_outcome) into the words the office uses. */
  outcomeLabel: (slug: string) => string;
  onEdit: () => void;
  /** On a desk a tel: link often does nothing, so a copy button sits beside it. */
  isTouch: boolean;
  /** The caller reached for the phone - so leaving without an outcome can be questioned. */
  onDial?: (via: DialVia) => void;
  /** Opens "They gave from another number". */
  onLinkOther?: () => void;
  /** activity id -> inbound | outbound | missed, for history that came without it. */
  directions?: Record<string, string>;
}) {
  const [copied, setCopied] = useState(false);
  const [allHistory, setAllHistory] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(lead.phone);
      onDial?.("copy");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Blocked outside a secure context. The number is on screen to read.
    }
  }

  const given = Number(lead.donation_count ?? 0) > 0;
  const history = allHistory ? lead.recent_activities : lead.recent_activities.slice(0, 4);
  const dirOf = (a: RecentActivity) => a.direction ?? directions?.[a.id] ?? null;

  return (
    <Card padded={false} className="p-4 sm:p-5">
      {/* ------------------------------------------------------------ dial */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 sm:order-1">
          <div className="flex items-start gap-1.5">
            {/* Focused (not scrolled to) when a new person comes on screen,
                so a screen reader announces who is next. */}
            <h2
              id={LEAD_HEADING_ID}
              tabIndex={-1}
              className="min-w-0 break-words text-xl font-semibold leading-tight text-ink outline-none"
            >
              {lead.name || "No name"}
            </h2>
            <IconButton name="edit" size="sm" label="Edit" onClick={onEdit} className="-mt-1 flex-none" />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {lead.status_label && <Badge tone={statusTone(lead.status_tone)}>{lead.status_label}</Badge>}
            {lead.call_attempts > 0 && (
              <Badge tone={lead.call_attempts >= 4 ? "warn" : "neutral"}>
                {lead.call_attempts} call{lead.call_attempts === 1 ? "" : "s"}
              </Badge>
            )}
            {lead.nearly_gave && (
              <Badge tone="warn" icon="sparkle">
                Nearly gave
              </Badge>
            )}
            {lead.converted_at && (
              <Badge tone="good" dot>
                Donated {lead.converted_amount ? currency(Number(lead.converted_amount)) : ""}
              </Badge>
            )}
          </div>
          <p className="mt-1.5 text-sm text-ink-muted">
            {[lead.city, lead.assigned_to_name ? `Caller: ${lead.assigned_to_name}` : "No caller", lead.email]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        {/* The number, full width on a phone: the one control on the screen
            that must never be missed or mis-tapped. Placed first in the DOM
            order on a phone (order-first) so it sits above the name - the
            caller already knows who is next, they need the button. */}
        <div className="order-first flex flex-col gap-1.5 sm:order-2 sm:w-auto sm:min-w-56">
          <div className="flex gap-1.5">
            <LinkButton
              href={telHref(lead.phone)}
              variant="primary"
              size="lg"
              icon="phone"
              className="h-13! flex-1 text-lg tabular-nums"
              onClick={() => onDial?.("call")}
            >
              Call {formatPhone(lead.phone)}
            </LinkButton>
            {!isTouch && (
              <IconButton
                name={copied ? "check" : "copy"}
                size="lg"
                variant="secondary"
                label={copied ? "Copied" : "Copy number (C)"}
                onClick={() => void copy()}
                className="h-13! w-13!"
              />
            )}
          </div>
          <div className="flex gap-1.5">
            {lead.alt_phone && (
              <LinkButton
                href={telHref(lead.alt_phone)}
                variant="secondary"
                icon="phone"
                className="flex-1 tabular-nums"
                onClick={() => onDial?.("alt")}
              >
                Other: {formatPhone(lead.alt_phone)}
              </LinkButton>
            )}
            <LinkButton
              href={whatsappHref(lead.phone)}
              target="_blank"
              rel="noreferrer"
              variant="secondary"
              icon="message"
              className={lead.alt_phone ? "" : "flex-1"}
              onClick={() => onDial?.("whatsapp")}
            >
              WhatsApp
            </LinkButton>
          </div>
        </div>
      </div>

      {lead.do_not_call && (
        <Alert tone="danger" title="Do not call" className="mt-3 mb-0" />
      )}

      {/* Already given: so nobody chases a donor for money that has arrived.
          Logging the call is still allowed - they may have rung to say so. */}
      {lead.converted_at && (
        <Alert tone="good" title={`Already donated${lead.converted_amount ? ` ${currency(Number(lead.converted_amount))}` : ""} on ${shortDate(lead.converted_at)}`} className="mt-3 mb-0">
          {convertedViaLabel(lead.converted_via)}. No need to ask again.
        </Alert>
      )}

      {/* ---------------------------------------- what changes the opening */}
      {lead.nearly_gave && (
        <div className="mt-3 rounded-card border border-amber-200 bg-warn-wash px-3.5 py-2.5 text-sm text-amber-900">
          <p className="flex items-start gap-2 font-medium">
            <Icon name="sparkle" size={15} className="mt-0.5 flex-none text-warn" />
            {nearlyGaveLine(lead.nearly_gave)}. Payment failed.
          </p>
          {onLinkOther && !lead.converted_at && (
            // Often they finished it on a son's or spouse's phone. Said here,
            // where the caller reads about the failed payment.
            <button
              type="button"
              onClick={onLinkOther}
              className="mt-2 ml-6 inline-flex min-h-11 items-center gap-1.5 rounded-control border border-amber-300 bg-surface px-3 py-2 text-left text-sm font-medium text-amber-900 hover:bg-amber-50"
            >
              <Icon name="link" size={14} className="flex-none" />
              <span>Gave from another number</span>
            </button>
          )}
        </div>
      )}

      {lead.open_reminders.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {lead.open_reminders.map((r) => (
            <li
              key={r.id}
              className="flex items-start gap-2 rounded-card border border-brand-200 bg-brand-50 px-3.5 py-2.5 text-sm text-ink-soft"
            >
              <Icon name="bell" size={15} className="mt-0.5 flex-none text-brand-700" />
              <span className="min-w-0">
                <span className="font-medium text-ink">
                  Promised{r.expected_amount ? ` ${currency(Number(r.expected_amount))}` : ""}
                  {r.occasion ? ` at ${r.occasion}` : ""}
                </span>{" "}
                · due {shortDate(r.due_at)} ({dueLabel(r.due_at)})
                {r.title && !r.occasion && <span className="block text-xs text-ink-muted">{r.title}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* ----------------------------------------------------- the facts */}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-card bg-sunken px-3.5 py-3 text-sm">
        <Fact label="Last call">
          {lead.last_outcome ? (
            <>
              {outcomeLabel(lead.last_outcome)}
              <span className="text-ink-muted"> · {relativeDate(lead.last_contacted_at)}</span>
            </>
          ) : (
            "Never called"
          )}
        </Fact>
        <Fact label="Follow-up">
          {lead.next_follow_up_at ? (
            <span className={dueLabel(lead.next_follow_up_at).endsWith("late") ? "font-medium text-warn" : ""}>
              {shortDate(lead.next_follow_up_at)} · {dueLabel(lead.next_follow_up_at)}
            </span>
          ) : (
            "None"
          )}
        </Fact>
        <Fact label="Hoped for">
          {lead.expected_amount ? currency(Number(lead.expected_amount)) : "—"}
        </Fact>
        <Fact label="Given">
          {given ? (
            <>
              {currency(Number(lead.total_donated ?? 0))}
              <span className="text-ink-muted">
                {" "}
                · {lead.donation_count}× · last {relativeDate(lead.last_donation_at).toLowerCase()}
              </span>
            </>
          ) : (
            "Nothing yet"
          )}
        </Fact>
        {lead.external_total_donated && Number(lead.external_total_donated) > 0 && (
          // From the office's own sheets, never added to anything DRM raised.
          <Fact label="Temple records" wide>
            {currency(Number(lead.external_total_donated))}
            {Number(lead.external_account_count) > 1 && (
              <span className="text-ink-muted"> · {lead.external_account_count} accounts</span>
            )}
            {lead.external_last_donation_at && (
              <span className="text-ink-muted"> · last in {istYear(lead.external_last_donation_at)}</span>
            )}
          </Fact>
        )}
        {lead.preacher_code && (
          // "Jagat Tarini Mataji gave us your name" is not a cold call.
          <Fact label="Known to" wide>
            {lead.preacher_name || lead.preacher_code}
          </Fact>
        )}
      </dl>

      {(lead.follow_up_note || lead.remarks) && (
        <div className="mt-3 space-y-1 text-sm">
          {lead.follow_up_note && (
            <p className="text-ink-soft">
              <span className="text-ink-muted">Follow-up note:</span> “{lead.follow_up_note}”
            </p>
          )}
          {lead.remarks && (
            <p className="text-ink-soft">
              <span className="text-ink-muted">Last note:</span> “{lead.remarks}”
            </p>
          )}
        </div>
      )}

      {lead.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {lead.tags.map((t) => (
            <Badge key={t} icon="tag">
              {t}
            </Badge>
          ))}
        </div>
      )}

      {/* --------------------------------------------------- what happened
          Every call to them, by anyone: who rang, when, what came of it, and
          which way - "they rang" matters, because a donor who called back is
          not the same conversation as a fourth unanswered attempt. */}
      {lead.recent_activities.length > 0 && (
        <div className="mt-4 border-t border-line-soft pt-3">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">Calls and notes</p>
            <Link
              href={callsHref(lead.id)}
              className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
            >
              See all calls
              <Icon name="arrowRight" size={12} />
            </Link>
          </div>
          <ol className="space-y-2.5">
            {history.map((a) => {
              const dir = a.kind === "call" ? dirOf(a) : null;
              return (
                <li key={a.id} className="flex gap-2.5 text-sm">
                  <span
                    className={`mt-1.5 h-2 w-2 flex-none rounded-full ${
                      a.kind === "call"
                        ? dir === "inbound"
                          ? "bg-info"
                          : a.connected
                          ? "bg-good"
                          : "bg-line-strong"
                        : a.kind === "link_donation"
                        ? "bg-good"
                        : "bg-brand-300"
                    }`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className="font-medium text-ink">{activityLine(a)}</span>
                      {dir === "inbound" && (
                        <Badge tone="info" icon="phone">
                          They called
                        </Badge>
                      )}
                      {dir === "missed" && <Badge tone="warn">Missed call</Badge>}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {relativeDate(a.occurred_at)} {clockTime(a.occurred_at)}
                      {a.kind === "call"
                        ? ` · ${dir === "inbound" ? "answered by" : "called by"} ${a.user_name ?? "someone"}`
                        : a.user_name
                        ? ` · ${a.user_name}`
                        : ""}
                    </span>
                    {a.note && <span className="mt-0.5 block whitespace-pre-line break-words text-ink-soft">{a.note}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            {lead.recent_activities.length > 4 ? (
              <button
                type="button"
                onClick={() => setAllHistory((v) => !v)}
                className="min-h-8 text-xs font-medium text-brand-700 hover:underline"
              >
                {allHistory ? "Show less" : `Show ${lead.recent_activities.length - 4} more`}
              </button>
            ) : (
              <span />
            )}
            <Link
              href={`/leads/${lead.id}`}
              className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
            >
              Open lead
              <Icon name="arrowRight" size={12} />
            </Link>
          </div>
        </div>
      )}
      {!lead.recent_activities.length && (
        <p className="mt-3 text-xs text-ink-muted">
          No calls yet.
          {lead.source_detail && <> From: {lead.source_detail}</>}{" "}
          <Link href={`/leads/${lead.id}`} className="font-medium text-brand-700 hover:underline">
            Open lead
          </Link>
        </p>
      )}
    </Card>
  );
}

function Fact({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2" : ""}`}>
      <dt className="text-2xs font-medium uppercase tracking-[0.06em] text-ink-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-ink">{children}</dd>
    </div>
  );
}
