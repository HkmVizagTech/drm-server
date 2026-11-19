"use client";

// One lead: reach them, log what happened, change when to follow up, see everything so far.

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiClient } from "@/lib/api";
import { useDevotee } from "@/lib/devotee-context";
import { clockTime, currency, dateTime, istInputToISO, relativeDate, shortDate } from "@/lib/format";
import {
  CHANNELS,
  FOLLOW_UP_PRESETS,
  INTERESTS,
  PAYMENT_MODES,
  SOURCES,
  STATUS,
  addressLine,
  directionsHref,
  isOverdue,
  labelOf,
  leadsChanged,
  telHref,
  toIstInput,
  whatsappHref,
  type DevoteeCall,
  type DevoteeLead,
  type LeadActivity,
} from "@/lib/devotee";
import { RecordingPlayer } from "@/components/calls/recording-player";
import { useInApp } from "@/lib/phone-app";
import { Alert, Button, Card, EmptyState, Input, LinkButton, Modal, Skeleton } from "@/components/ui";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { FollowUpWhen, LeadStatusBadge, PriorityDot } from "@/components/devotee/lead-bits";
import { LogFollowUpDialog } from "@/components/devotee/log-follow-up";
import { LeadForm } from "@/components/devotee/lead-form";
import { DevoteeReceiptDialog } from "@/components/devotee/receipt-dialog";

function Detail({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "" || children === false) return null;
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <dt className="w-28 flex-none text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

function Reschedule({ lead, onClose, onSaved }: { lead: DevoteeLead; onClose: () => void; onSaved: (l: DevoteeLead) => void }) {
  const [value, setValue] = useState(toIstInput(lead.next_follow_up_at));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(clear = false) {
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.patch<{ lead: DevoteeLead }>(`/api/devotee/leads/${lead.id}`, {
        next_follow_up_at: clear || !value ? null : istInputToISO(value),
      });
      leadsChanged();
      toast.success(clear || !value ? "Follow-up removed" : "Follow-up moved");
      onSaved(r.lead);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Change follow-up time"
      onClose={onClose}
      footer={
        <div className="flex justify-between gap-2">
          {lead.next_follow_up_at ? (
            <Button variant="ghost" onClick={() => void save(true)} disabled={busy}>
              Remove
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={() => void save()} loading={busy} disabled={!value}>
            Save
          </Button>
        </div>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FOLLOW_UP_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setValue(toIstInput(p.at().toISOString()))}
            className="rounded-full px-2.5 py-1 text-xs font-medium text-ink-soft ring-1 ring-inset ring-line-soft hover:bg-sunken"
          >
            {p.label}
          </button>
        ))}
      </div>
      <Input type="datetime-local" value={value} min={toIstInput(new Date().toISOString())} onChange={(e) => setValue(e.target.value)} aria-label="Follow-up date and time" />
    </Modal>
  );
}

const talk = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);

/**
 * The calls the DRM app saw on this devotee's phone with the lead, each with the phone's
 * recording to play. Kept for this devotee alone - nobody else in DRM can hear them.
 */
function Calls({ calls }: { calls: DevoteeCall[] }) {
  const app = useInApp();
  if (!calls.length) {
    return (
      <p className="text-sm text-ink-muted">
        {app
          ? "Calls you make or get from this person on this phone appear here, with their recording."
          : "Calls are saved, with their recording, when you call from the DRM app on your Android phone."}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line-soft">
      {calls.map((c) => {
        const missed = c.direction === "missed";
        return (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={`grid h-8 w-8 flex-none place-items-center rounded-full ${missed ? "bg-danger-wash text-danger" : "bg-brand-50 text-brand-700"}`}
                aria-hidden
              >
                <Icon name={missed ? "phoneMissed" : c.direction === "inbound" ? "phoneIncoming" : "phoneOutgoing"} size={15} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {missed ? "Missed call" : c.direction === "inbound" ? "They called" : "You called"}
                  {!missed && c.duration_seconds > 0 && <span className="font-normal text-ink-muted"> · {talk(c.duration_seconds)}</span>}
                  {!missed && c.duration_seconds === 0 && <span className="font-normal text-ink-muted"> · not answered</span>}
                </p>
                <p className="text-xs text-ink-faint">
                  {relativeDate(c.started_at)}, {clockTime(c.started_at)}
                </p>
              </div>
            </div>
            {c.recording_status === "uploaded" ? (
              <RecordingPlayer url={`/api/devotee/calls/${c.id}/recording`} seconds={c.duration_seconds} size="sm" />
            ) : c.recording_status === "waiting" ? (
              <span className="text-xs text-ink-muted">Recording on its way from the phone…</span>
            ) : c.recording_status === "none" ? (
              <span className="text-xs text-ink-faint">No recording on the phone</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Timeline({ items }: { items: LeadActivity[] }) {
  if (!items.length) {
    return <EmptyState icon="clock" title="No follow-ups yet" message="Log each call, message or visit here to keep track of the conversation." />;
  }
  return (
    <ol className="relative space-y-4 border-l border-line-soft pl-5">
      {items.map((a) => {
        const st = a.outcome ? STATUS[a.outcome] : null;
        const via = CHANNELS.find((c) => c.value === a.channel);
        return (
          <li key={a.id} className="relative">
            <span className="absolute -left-[27px] top-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-surface ring-2 ring-brand-500" aria-hidden />
            <div className="flex flex-wrap items-center gap-2">
              {st ? <LeadStatusBadge status={a.outcome!} /> : <span className="text-sm font-medium text-ink">Note</span>}
              {via && (
                <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                  <Icon name={via.icon} size={12} />
                  {via.label}
                </span>
              )}
              <span className="text-xs text-ink-faint" title={dateTime(a.created_at)}>
                {relativeDate(a.created_at)}, {clockTime(a.created_at)}
              </span>
            </div>
            {a.amount !== null && (
              <p className="mt-1 text-sm font-semibold text-good">
                {currency(a.amount)}
                <span className="font-normal text-ink-muted">
                  {" · "}
                  {shortDate(a.donated_on)}
                  {a.payment_mode ? ` · ${labelOf(PAYMENT_MODES, a.payment_mode)}` : ""}
                  {a.purpose ? ` · ${a.purpose}` : ""}
                  {a.reference ? ` · Ref ${a.reference}` : ""}
                </span>
              </p>
            )}
            {a.note && <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{a.note}</p>}
            {a.next_follow_up_at && <p className="mt-1 text-xs text-ink-muted">Next follow-up set for {dateTime(a.next_follow_up_at)}</p>}
          </li>
        );
      })}
    </ol>
  );
}

export default function DevoteeLeadPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { config } = useDevotee();
  const [lead, setLead] = useState<DevoteeLead | null>(null);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [calls, setCalls] = useState<DevoteeCall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "log" | "reschedule" | "delete" | "receipt">("view");
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    apiClient
      .get<{ lead: DevoteeLead; activities: LeadActivity[]; calls: DevoteeCall[] }>(`/api/devotee/leads/${id}`)
      .then((r) => {
        setLead(r.lead);
        setActivities(r.activities);
        setCalls(r.calls ?? []);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove() {
    setDeleting(true);
    try {
      await apiClient.delete(`/api/devotee/leads/${id}`);
      leadsChanged();
      toast.success(`${lead?.name ?? "Lead"} deleted`);
      router.replace("/devotee/leads");
    } catch (e) {
      toast.error("Could not delete", e instanceof Error ? e.message : undefined);
      setDeleting(false);
    }
  }

  if (error && !lead) {
    return (
      <Card>
        <EmptyState icon="user" title="Lead not found" message={error} action={<LinkButton href="/devotee/leads">Back to my leads</LinkButton>} />
      </Card>
    );
  }
  if (!lead) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full" rounded="rounded-panel" />
        <Skeleton className="h-64 w-full" rounded="rounded-panel" />
      </div>
    );
  }

  if (mode === "edit") {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-5 text-2xl font-semibold tracking-tight text-ink">Edit {lead.name}</h1>
        <LeadForm
          lead={lead}
          config={config}
          onCancel={() => setMode("view")}
          onSaved={(l) => {
            setLead(l);
            setMode("view");
            toast.success("Saved");
          }}
        />
      </div>
    );
  }

  const directions = directionsHref(lead);
  const address = addressLine(lead);
  const late = isOverdue(lead.next_follow_up_at);

  return (
    <div className="space-y-4">
      <Link href="/devotee/leads" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <Icon name="chevronLeft" size={15} />
        My leads
      </Link>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-ink">{lead.name}</h1>
              <LeadStatusBadge status={lead.status} />
              <PriorityDot priority={lead.priority} />
            </div>
            <p className="mt-1 text-sm tabular-nums text-ink-soft">
              {lead.phone}
              {lead.alt_phone && <span className="text-ink-muted"> · {lead.alt_phone}</span>}
            </p>
            {address && <p className="mt-0.5 text-sm text-ink-muted">{address}</p>}
          </div>
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" icon="edit" onClick={() => setMode("edit")}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" icon="trash" onClick={() => setMode("delete")} aria-label="Delete lead" />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <LinkButton href={telHref(lead.phone)} data-lead-id={lead.id} icon="phone" className="justify-center">
            Call
          </LinkButton>
          <LinkButton href={whatsappHref(lead.phone, `Hare Krishna ${lead.name.split(" ")[0]}!`)} target="_blank" rel="noreferrer" variant="secondary" icon="message" className="justify-center">
            WhatsApp
          </LinkButton>
          {directions ? (
            <LinkButton href={directions} target="_blank" rel="noreferrer" variant="secondary" icon="route" className="justify-center">
              Directions
            </LinkButton>
          ) : (
            <Button variant="secondary" icon="mapPin" onClick={() => setMode("edit")} className="justify-center">
              Add address
            </Button>
          )}
          <Button variant="secondary" icon="edit" onClick={() => setMode("log")} className="justify-center">
            Log follow-up
          </Button>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card tone={late ? "warn" : "default"}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Next follow-up</p>
                <div className="mt-1">
                  {lead.next_follow_up_at ? <FollowUpWhen at={lead.next_follow_up_at} /> : <span className="text-sm text-ink-muted">None set</span>}
                </div>
                {lead.unanswered_count > 0 && (
                  <p className="mt-1 text-xs text-ink-muted">
                    {lead.unanswered_count} call{lead.unanswered_count === 1 ? "" : "s"} not answered in a row
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" icon="calendar" onClick={() => setMode("reschedule")}>
                  {lead.next_follow_up_at ? "Change" : "Set"}
                </Button>
                <Button size="sm" icon="check" onClick={() => setMode("log")}>
                  Log
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">Calls</h2>
              <span className="inline-flex items-center gap-1 text-xs text-ink-faint">
                <Icon name="shield" size={13} />
                Only you can hear these
              </span>
            </div>
            <Calls calls={calls} />
          </Card>

          <Card>
            <h2 className="mb-4 text-sm font-semibold text-ink">History</h2>
            <Timeline items={activities} />
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">Giving</h2>
              <Button size="sm" variant="secondary" icon="receipt" onClick={() => setMode("receipt")}>
                Raise receipt
              </Button>
            </div>
            <p className="text-2xl font-semibold tabular-nums text-ink">{currency(lead.total_donated)}</p>
            <p className="text-xs text-ink-muted">
              {lead.last_donated_on ? `Last gave ${shortDate(lead.last_donated_on)}` : "No donation recorded yet"}
              {lead.expected_amount ? ` · expecting ${currency(lead.expected_amount)}` : ""}
            </p>
          </Card>

          <Card>
            <h2 className="mb-2 text-sm font-semibold text-ink">Details</h2>
            <dl className="divide-y divide-line-soft">
              <Detail label="Email">{lead.email && <a className="text-brand-700 hover:underline" href={`mailto:${lead.email}`}>{lead.email}</a>}</Detail>
              <Detail label="Interested in">{labelOf(INTERESTS, lead.interest)}</Detail>
              <Detail label="How you met">{labelOf(SOURCES, lead.source)}</Detail>
              <Detail label="Referred by">{lead.referred_by}</Detail>
              <Detail label="Occupation">{[lead.occupation, lead.organisation].filter(Boolean).join(", ")}</Detail>
              <Detail label="Birthday">{lead.date_of_birth && shortDate(lead.date_of_birth)}</Detail>
              <Detail label="Anniversary">{lead.anniversary_date && shortDate(lead.anniversary_date)}</Detail>
              <Detail label="Location">
                {lead.latitude !== null && lead.longitude !== null && (
                  <Link className="text-brand-700 hover:underline" href={`/devotee/map?focus=${lead.id}`}>
                    See on my map
                  </Link>
                )}
              </Detail>
              <Detail label="Added">{shortDate(lead.created_at)}</Detail>
            </dl>
            {lead.notes && <p className="mt-3 whitespace-pre-wrap rounded-control bg-sunken p-3 text-sm text-ink-soft">{lead.notes}</p>}
          </Card>
        </aside>
      </div>

      {mode === "log" && (
        <LogFollowUpDialog
          lead={lead}
          onClose={() => setMode("view")}
          onSaved={(r) => {
            setLead(r.lead);
            setActivities((a) => [r.activity, ...a]);
          }}
        />
      )}
      {mode === "receipt" && <DevoteeReceiptDialog lead={lead} onClose={() => { setMode("view"); load(); }} />}
      {mode === "reschedule" && <Reschedule lead={lead} onClose={() => setMode("view")} onSaved={setLead} />}
      {mode === "delete" && (
        <Modal
          title={`Delete ${lead.name}?`}
          tone="danger"
          onClose={() => setMode("view")}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setMode("view")}>
                Keep
              </Button>
              <Button variant="danger" loading={deleting} onClick={() => void remove()}>
                Delete
              </Button>
            </div>
          }
        >
          <p className="text-sm text-ink-soft">This removes the lead and all of its follow-ups and donation entries. It cannot be undone.</p>
        </Modal>
      )}
    </div>
  );
}
