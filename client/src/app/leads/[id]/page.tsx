"use client";

// One lead, and everything that has ever happened to them.
//
// The calling screen is for working through a queue; this is for the moment
// someone asks "what's the story with this person" - before a big ask, or when
// a donor rings back and whoever answers has thirty seconds to catch up.
//
// The timeline is the point of the page. Calls, notes, stage changes and
// callbacks are one stream in one order, because a caller reading four separate
// panels has to assemble the story themselves and will get it wrong.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { currency, dateTime, istDateKey, istDayPlus, istInputToISO, istInstant, istYear, number, relativeDate, shortDate } from "@/lib/format";
import {
  Alert,
  AlertPicker,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Icon,
  Input,
  LinkButton,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { SendLink } from "@/components/send-link";
import { ALERT_OPTIONS, DEFAULT_ALERTS, alertSummary, cleanAlerts } from "@/lib/reminders";

interface Preacher { id: string; code: string; name: string | null }

interface Lead {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  city: string | null;
  person_id: string | null;
  status: string;
  status_label: string | null;
  source: string;
  source_detail: string | null;
  tags: string[];
  remarks: string | null;
  next_follow_up_at: string | null;
  follow_up_note: string | null;
  last_contacted_at: string | null;
  call_attempts: number;
  expected_amount: string | null;
  converted_amount: string | null;
  converted_at: string | null;
  do_not_call: boolean;
  invalid_reason: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  total_donated: string | null;
  donation_count: number | null;
  created_at: string;
  preacher_id: string | null;
  preacher_code: string | null;
  preacher_name: string | null;
  donor_code: string | null;
  converted_via: string | null;
  external_total_donated: string | null;
  external_account_count: number | null;
  external_last_donation_at: string | null;
  external_source: string | null;
}

interface Activity {
  id: string;
  kind: string;
  note: string | null;
  direction: string | null;
  disposition: string | null;
  disposition_label: string | null;
  connected: boolean | null;
  duration_seconds: number | null;
  source: string;
  recording_url: string | null;
  from_value: string | null;
  to_value: string | null;
  occurred_at: string;
  user_name: string | null;
}

/** A promise this donor made, at a moment they named. */
interface Reminder {
  id: string;
  title: string;
  note: string | null;
  occasion: string | null;
  due_at: string;
  expected_amount: string | null;
  lead_times: number[];
  status: string;
  snooze_count: number;
  assigned_to_name: string | null;
}

interface Donation {
  id: string;
  amount: string;
  purpose: string;
  source_page: string | null;
  source_site: string;
  receipt_number: string | null;
  created_at: string;
}

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  // Removing a lead is an admin's job, so the link is not shown to anyone
  // else. The server refuses it either way; this is so a caller is not
  // offered a button that answers 403.
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [remindOpen, setRemindOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [config, setConfig] = useState<{
    statuses: { slug: string; label: string }[];
    users: { id: string; name: string }[];
    settings?: Record<string, unknown>;
  } | null>(null);
  const [preachers, setPreachers] = useState<Preacher[]>([]);
  const [donatedOpen, setDonatedOpen] = useState(false);
  const [donatedAmount, setDonatedAmount] = useState("");
  const [donatedNote, setDonatedNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiClient.get<{
        lead: Lead;
        activities: Activity[];
        donations: Donation[];
        reminders: Reminder[];
      }>(`/api/crm/leads/${id}`);
      setLead(d.lead);
      setActivities(d.activities);
      setDonations(d.donations);
      setReminders(d.reminders ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load that lead");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    apiClient.get<typeof config>("/api/crm/config").then(setConfig).catch(() => undefined);
    apiClient
      .get<{ preachers: Preacher[] }>("/api/crm/preachers?counts=false")
      .then((d) => setPreachers(d.preachers))
      .catch(() => undefined);
  }, []);

  async function patch(body: Record<string, unknown>) {
    try {
      await apiClient.put(`/api/crm/leads/${id}`, body);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that");
    }
  }

  async function addNote() {
    if (!note.trim()) return;
    await apiClient.post(`/api/crm/leads/${id}/note`, { note: note.trim() });
    setNote("");
    await load();
  }

  // Shaped like the page it is about to become - header, then the two
  // columns - rather than one word. A caller opening a donor mid-call needs to
  // see that something is arriving, and where.
  if (loading)
    return (
      <div>
        <div className="mb-6 border-b border-line-soft pb-5">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="mt-2 h-4 w-72" />
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">
            <Skeleton className="h-28 w-full" rounded="rounded-card" />
            <Skeleton className="h-64 w-full" rounded="rounded-card" />
          </div>
          <Skeleton className="h-80 w-full" rounded="rounded-card" />
        </div>
      </div>
    );
  if (!lead) return <EmptyState title="Not found" message={error ?? "That lead no longer exists."} />;

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title={lead.name || "Name not known"}
        subtitle={`${lead.phone}${lead.city ? ` · ${lead.city}` : ""}${lead.email ? ` · ${lead.email}` : ""}`}
        actions={
          <>
            <Button variant="secondary" icon="arrowLeft" onClick={() => router.back()}>
              Back
            </Button>
            {/* THE BUTTON THAT WAS MISSING.
                AddReminderDialog has been in this file, fully built and
                commented as "the one that was missing", with nothing anywhere
                calling setRemindOpen(true) - so raising a promise from a
                donor's own record was unreachable, and the reminders the page
                already fetched were never drawn either. Both are wired now. */}
            <Button variant="secondary" icon="bell" onClick={() => setRemindOpen(true)}>
              Remind me
            </Button>
            <LinkButton href={`tel:+91${lead.phone}`} variant="primary" icon="phone">
              Call {lead.phone}
            </LinkButton>
          </>
        }
      />

      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      {lead.do_not_call && (
        <Alert
          tone="danger"
          title="This person asked not to be called."
          action={
            <Button variant="secondary" size="sm" onClick={() => void patch({ do_not_call: false })}>
              They have asked to be called again
            </Button>
          }
        >
          They will never appear in a calling queue. Clearing this is deliberate — only do it if they have said so
          themselves.
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* ------------------------------------------------------- the story */}
        <div className="space-y-5 lg:col-span-2">
          <Card padded={false} className="p-0">
            <SendLink leadId={lead.id} leadName={lead.name} expectedAmount={lead.expected_amount} onSent={load} />
          </Card>

          <Card>
            <CardHeader title="Add a note" subtitle="For anything that wasn't a call" />
            <div className="flex gap-2">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addNote()}
                placeholder="They replied on WhatsApp saying…"
                aria-label="Note"
              />
              <Button icon="plus" onClick={() => void addNote()} disabled={!note.trim()}>
                Add
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="History"
              subtitle={`${number(lead.call_attempts)} call${lead.call_attempts === 1 ? "" : "s"} · lead added ${shortDate(lead.created_at)}`}
            />
            {!activities.length ? (
              <EmptyState title="Nothing yet" message="No calls or notes have been recorded for this person." />
            ) : (
              <ol className="relative space-y-4 border-l border-line-soft pl-5">
                {activities.map((a) => (
                  <li key={a.id} className="relative">
                    {/* The ring is the card's own fill, so the dot reads as
                        sitting on the line rather than being pierced by it. */}
                    <span
                      className={`absolute -left-[1.44rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-surface ${
                        a.kind === "call"
                          ? a.connected
                            ? "bg-good"
                            : "bg-line"
                          : a.kind === "status_change"
                          ? "bg-info"
                          : "bg-line"
                      }`}
                    />
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium text-ink">{describe(a)}</span>
                      <span className="text-xs text-ink-faint">{relativeDate(a.occurred_at)}</span>
                      {a.user_name && <span className="text-xs text-ink-faint">· {a.user_name}</span>}
                      {a.kind === "call" && a.duration_seconds !== null && (
                        <span className="text-xs text-ink-faint">
                          · {Math.round(a.duration_seconds / 60)} min
                          {a.source === "manual" && <span title="Reported by the caller, not measured"> (reported)</span>}
                        </span>
                      )}
                    </div>
                    {a.note && <p className="mt-0.5 whitespace-pre-line text-sm text-ink-soft">{a.note}</p>}
                    {a.recording_url && (
                      <a href={a.recording_url} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline">
                        Listen to the recording
                      </a>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        {/* ------------------------------------------------------ the details */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="Where this lead stands" />
            <div className="space-y-3">
              <Field label="Stage">
                <Select value={lead.status} onChange={(v) => void patch({ status: v })} ariaLabel="Stage">
                  {config?.statuses.map((s) => (
                    <option key={s.slug} value={s.slug}>{s.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Assigned to">
                <Select
                  value={lead.assigned_to ?? ""}
                  onChange={(v) => void patch({ assigned_to: v || null })}
                  ariaLabel="Assigned to"
                >
                  <option value="">Nobody</option>
                  {config?.users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </Select>
              </Field>
              {/* The stored value is a UTC instant, so slicing its first ten
                  characters showed the UTC day: a callback at 20:00Z is half
                  past one the next morning at the temple, and the picker was
                  offering the day before the one the office booked. Going out,
                  the hour is pinned to IST too - without the offset it was
                  10am only on a device already set to the temple's zone. */}
              <Field label="Call back on" htmlFor="lead-follow-up">
                <Input
                  id="lead-follow-up"
                  type="date"
                  value={istDateKey(lead.next_follow_up_at)}
                  onChange={(e) =>
                    void patch({ next_follow_up_at: e.target.value ? istInstant(e.target.value, "10:00").toISOString() : null })
                  }
                />
              </Field>
              {/* Optional by design: plenty of donors have no preacher, and
                  forcing one would just get whoever was top of the list. */}
              <Field label="Known to (preacher)">
                <Select
                  value={lead.preacher_id ?? ""}
                  onChange={(v) => void patch({ preacher_id: v || null })}
                  ariaLabel="Known to (preacher)"
                  placeholder="Nobody in particular"
                  options={[
                    { value: "", label: "Nobody in particular" },
                    ...preachers.map((p) => ({
                      value: p.id,
                      label: p.name ? `${p.name} (${p.code})` : p.code,
                    })),
                  ]}
                />
              </Field>
              <Field label="Hoping for (₹)" htmlFor="lead-expected">
                <Input
                  id="lead-expected"
                  type="number"
                  defaultValue={lead.expected_amount ?? ""}
                  onBlur={(e) => e.target.value !== (lead.expected_amount ?? "") && void patch({ expected_amount: e.target.value })}
                />
              </Field>
            </div>

            {lead.tags.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {lead.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            )}

            <p className="mt-4 text-xs text-ink-faint">
              Came from {lead.source}
              {lead.source_detail && <> — {lead.source_detail}</>}
            </p>
          </Card>

          {/* ------------------------------------------------ promises made
            *
            * The page has always fetched these and never drawn them, so a
            * promise a donor made - "ring me after Diwali, I'll give 5,000" -
            * existed on the reminders board and was invisible on the record of
            * the person who made it. Anyone opening a donor to prepare for a
            * call could not see what that donor had already said.
            */}
          <Card>
            <CardHeader
              title="Promises"
              icon="bell"
              subtitle={
                reminders.length
                  ? `${reminders.filter((r) => r.status === "open").length} still open`
                  : "Nothing promised yet"
              }
              action={
                <Button variant="ghost" size="xs" icon="plus" onClick={() => setRemindOpen(true)}>
                  Add
                </Button>
              }
            />
            {reminders.length === 0 ? (
              <p className="text-sm text-ink-muted">
                When this donor names a time or an amount, record it here and DRM will warn you before it falls due.
              </p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {reminders.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{r.title}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {dateTime(r.due_at)}
                        {r.occasion && <> · {r.occasion}</>}
                        {r.assigned_to_name && <> · {r.assigned_to_name}</>}
                      </p>
                      {r.note && <p className="mt-1 text-xs text-ink-soft">{r.note}</p>}
                      {/* What will actually warn somebody, in words. A reminder
                          with no lead times is a date on a board that nothing
                          announces, and that is worth saying on the record
                          rather than leaving to be discovered. */}
                      <p className="mt-1 text-xs text-ink-faint">{alertSummary(r.lead_times)}</p>
                    </div>
                    <div className="flex flex-none items-center gap-2">
                      {r.expected_amount && (
                        <span className="text-sm font-semibold tabular-nums text-ink">
                          {currency(Number(r.expected_amount))}
                        </span>
                      )}
                      <Badge tone={r.status === "open" ? "warn" : "good"} dot>
                        {r.status === "open" ? "Open" : r.status}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ------------------------------------------- what they have given */}
          <Card>
            <CardHeader
              title="Giving"
              subtitle={
                lead.donation_count
                  ? `${currency(Number(lead.total_donated ?? 0))} across ${lead.donation_count} donation${lead.donation_count === 1 ? "" : "s"}`
                  : "Nothing on record"
              }
              action={
                lead.person_id ? (
                  <Link
                    href={`/people/${lead.person_id}`}
                    className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-brand-700 hover:underline"
                  >
                    Full record
                    <Icon name="arrowRight" size={13} />
                  </Link>
                ) : undefined
              }
            />
            {lead.external_total_donated && (
              <p className="mb-3 rounded-card bg-brand-50 px-3 py-2 text-sm text-ink-soft">
                {currency(Number(lead.external_total_donated))} on record in the temple accounts
                {Number(lead.external_account_count) > 1 && <> across {lead.external_account_count} accounts</>}
                {lead.external_last_donation_at && <> · last in {istYear(lead.external_last_donation_at)}</>}
                <span className="mt-0.5 block text-xs text-ink-muted">
                  From {lead.external_source || "an uploaded sheet"} — kept out of DRM&apos;s own totals.
                </span>
              </p>
            )}
            {lead.converted_at && (
              <p className="mb-3 rounded-card bg-good-wash px-3 py-2 text-sm text-emerald-900">
                Gave {currency(Number(lead.converted_amount ?? 0))} {relativeDate(lead.converted_at)} after being
                called.
                <span className="mt-0.5 block text-xs text-emerald-800">
                  {lead.converted_via === "manual"
                    ? "Recorded by a caller — DRM did not see this one arrive."
                    : "Matched automatically to a donation on the site."}
                </span>
              </p>
            )}

            {/* Money DRM cannot see: cash at the counter, a bank transfer, a
                cheque handed to a preacher. Without this the only conversions
                on record are the ones that happened to come through a website,
                and every report understates what the calling achieved. */}
            {!lead.converted_at && (
              donatedOpen ? (
                <div className="mb-3 rounded-card border border-line-soft p-3">
                  <p className="mb-2 text-xs font-medium text-ink-soft">They donated — how much?</p>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      autoFocus
                      value={donatedAmount}
                      onChange={(e) => setDonatedAmount(e.target.value)}
                      placeholder="₹"
                      aria-label="How much they donated"
                      className="w-28"
                    />
                    <Input
                      value={donatedNote}
                      onChange={(e) => setDonatedNote(e.target.value)}
                      placeholder="Cash at the counter, bank transfer…"
                      aria-label="How it arrived"
                      className="flex-1"
                    />
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      disabled={!donatedAmount}
                      onClick={async () => {
                        await apiClient.post(`/api/crm/leads/${id}/donated`, {
                          amount: Number(donatedAmount),
                          note: donatedNote || undefined,
                        });
                        setDonatedOpen(false);
                        setDonatedAmount("");
                        setDonatedNote("");
                        await load();
                      }}
                    >
                      Record it
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setDonatedOpen(false)}>
                      Cancel
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-ink-faint">
                    This records the donation against the lead. The receipt still comes from whichever site issues it —
                    DRM never mints one.
                  </p>
                </div>
              ) : (
                <Button variant="secondary" icon="rupee" onClick={() => setDonatedOpen(true)} className="mb-3">
                  They donated — record it
                </Button>
              )
            )}
            {!donations.length ? (
              <p className="text-sm text-ink-muted">
                {lead.person_id
                  ? "No donations recorded for this person."
                  : "Not linked to anyone in DRM — they will be linked automatically if they give."}
              </p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {donations.slice(0, 8).map((d) => (
                  <li key={d.id} className="flex items-baseline justify-between gap-2 py-2 text-sm">
                    <span className="truncate text-ink-soft">{d.purpose}</span>
                    <span className="whitespace-nowrap">
                      <span className="font-medium tabular-nums text-ink">{currency(Number(d.amount))}</span>
                      <span className="ml-2 text-xs text-ink-faint">{shortDate(d.created_at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ---------------------------------------------------- removal */}
          {/* Last thing in the column, quiet, and not a button: a plain link
              that opens something that tells you what you are about to lose.
              Mostly used for a test lead somebody added to try the QR flow,
              or a wrong number typed in — not for tidying a queue. */}
          {isAdmin && (
            <Button
              variant="ghost"
              size="sm"
              block
              icon="trash"
              onClick={() => setRemoving(true)}
              className="text-ink-faint hover:bg-danger-wash hover:text-danger"
            >
              Remove this lead
            </Button>
          )}
        </div>
      </div>

      {removing && (
        <RemoveLeadDialog
          leadId={lead.id}
          onClose={() => setRemoving(false)}
          onDone={() => router.push("/leads")}
        />
      )}

      {remindOpen && (
        <AddReminderDialog
          leadId={lead.id}
          leadName={lead.name}
          expectedAmount={lead.expected_amount}
          users={config?.users ?? []}
          defaultAlerts={
            Array.isArray(config?.settings?.reminder_lead_times)
              ? cleanAlerts((config.settings.reminder_lead_times as number[]).map(Number))
              : DEFAULT_ALERTS
          }
          onClose={() => setRemindOpen(false)}
          onDone={async () => {
            setRemindOpen(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Recording a promise from the lead's own page.
 *
 * The third place a reminder can be raised, after the calling screen and the
 * follow-ups board - and the one that was missing. It is the case where
 * somebody is reading a donor's history rather than working a queue: a donor
 * rang back, or a preacher passed word along, and the person with the
 * information is not on a call.
 *
 * Deliberately the same fields and the same alert chips as the other two. A
 * reminder that means something different depending on which screen raised it
 * would be worse than not having this at all.
 */
function AddReminderDialog({
  leadId,
  leadName,
  expectedAmount,
  users,
  defaultAlerts,
  onClose,
  onDone,
}: {
  leadId: string;
  leadName: string | null;
  expectedAmount: string | null;
  users: { id: string; name: string }[];
  defaultAlerts: number[];
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [title, setTitle] = useState("");
  const [occasion, setOccasion] = useState("");
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState(expectedAmount ? String(Math.round(Number(expectedAmount))) : "");
  const [assignee, setAssignee] = useState("");
  const [when, setWhen] = useState(() => `${istDayPlus(7)}T10:00`);
  const [alerts, setAlerts] = useState<number[]>(defaultAlerts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={leadName ? `A promise from ${leadName}` : "Add a reminder"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!when}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await apiClient.post(`/api/crm/leads/${leadId}/reminders`, {
                  // The server needs a title; if nobody typed one, the occasion
                  // or a plain statement of the fact is better than refusing to
                  // save a promise somebody just heard.
                  title: title.trim() || (occasion.trim() ? `Said they would give at ${occasion.trim()}` : "Said they would donate"),
                  occasion: occasion.trim() || undefined,
                  note: note.trim() || undefined,
                  // The picker hands back a wall-clock time with no zone on it.
                  // It is the hour at the temple, not the hour wherever this is
                  // being filled in.
                  due_at: istInputToISO(when),
                  expected_amount: amount ? Number(amount) : undefined,
                  assigned_to: assignee || undefined,
                  lead_times: alerts,
                });
                await onDone();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not save that reminder");
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Add it"}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="mb-4 text-sm text-ink-soft">
        For a moment this donor named — a festival, a salary date, after a family event. It will reach whoever is to
        ring them, before the day arrives.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What to remember" htmlFor="reminder-title" className="sm:col-span-2">
          <Input
            id="reminder-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Said he would give at Govardhan Puja"
          />
        </Field>

        <Field label="When" htmlFor="reminder-when" required>
          <Input
            id="reminder-when"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </Field>
        <Field label="How much they said" htmlFor="reminder-amount">
          <Input
            id="reminder-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            placeholder="Optional"
            inputMode="numeric"
            className="tabular-nums"
          />
        </Field>

        <Field label="The occasion they named" htmlFor="reminder-occasion">
          <Input
            id="reminder-occasion"
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
            placeholder="e.g. Govardhan Puja"
          />
        </Field>
        <Field label="Who should ring them">
          <Select
            value={assignee}
            onChange={setAssignee}
            ariaLabel="Who should ring them"
            options={[
              { value: "", label: "Whoever this lead belongs to" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
        </Field>

        <Field label="What they said, in their words" htmlFor="reminder-note" className="sm:col-span-2">
          <Textarea
            id="reminder-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Read back on the call — worth the extra few seconds now."
          />
        </Field>

        <Field label="Warn me" className="sm:col-span-2">
          <div className="mt-1.5">
            <AlertPicker value={alerts} onChange={setAlerts} options={ALERT_OPTIONS} />
          </div>
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Confirming the removal of a lead.
 *
 * WHY IT ASKS THE SERVER FIRST
 * "This cannot be undone" is a sentence people click past. The counts are
 * fetched before the question is put, so what somebody reads is four calls and
 * a promise they are about to lose, or nothing at all - which is the ordinary
 * case for a test lead, and worth saying, because knowing there is nothing to
 * lose is as useful as knowing there is.
 */
function RemoveLeadDialog({
  leadId,
  onClose,
  onDone,
}: {
  leadId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [what, setWhat] = useState<{
    name: string | null;
    phone: string;
    activities: number;
    reminders: number;
    qr_shares: number;
    qr_paid: number;
    has_donation: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<typeof what>(`/api/crm/leads/${leadId}/removal`)
      .then(setWhat)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not check that lead"));
  }, [leadId]);

  const nothing =
    what && !what.activities && !what.reminders && !what.qr_shares && !what.has_donation;

  return (
    <Modal
      title="Remove this lead?"
      onClose={onClose}
      tone="danger"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep them
          </Button>
          <Button
            variant="danger"
            icon="trash"
            loading={busy}
            disabled={!what}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await apiClient.delete(`/api/crm/leads/${leadId}`);
                onDone();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not remove that lead");
                setBusy(false);
              }
            }}
          >
            {busy ? "Removing…" : "Remove"}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      {!what ? (
        <Skeleton className="h-20 w-full" rounded="rounded-card" />
      ) : (
        <>
          <p className="text-sm text-ink-soft">
            {what.name || what.phone} will be removed from DRM. This cannot be undone.
          </p>

          {nothing ? (
            <p className="mt-2 text-sm text-ink-muted">
              Nothing has been recorded against them yet, so there is nothing else to lose.
            </p>
          ) : (
            <ul className="mt-3 space-y-1 text-sm text-ink-soft">
              {what.activities > 0 && (
                <li>
                  {number(what.activities)} call{what.activities === 1 ? "" : "s"} and note
                  {what.activities === 1 ? "" : "s"} go with them
                </li>
              )}
              {what.reminders > 0 && (
                <li>
                  {number(what.reminders)} promise{what.reminders === 1 ? "" : "s"} they made will stop
                  reminding anybody
                </li>
              )}
            </ul>
          )}

          {/* What survives, said plainly. People assume deletion takes the
              money with it, and the money is the part that must not move. */}
          {(what.has_donation || what.qr_paid > 0 || what.qr_shares > 0) && (
            <div className="mt-3 rounded-card bg-sunken px-3 py-2.5 text-xs text-ink-soft">
              <p className="font-medium text-ink-soft">What stays</p>
              {what.has_donation && (
                <p className="mt-0.5">
                  Their donation and its receipt are untouched — those belong to the site that issued them.
                </p>
              )}
              {what.qr_shares > 0 && (
                <p className="mt-0.5">
                  {number(what.qr_shares)} QR{what.qr_shares === 1 ? "" : "s"} shared with them
                  {what.qr_paid > 0 ? `, ${number(what.qr_paid)} of which was paid,` : ""} stay on the QR
                  payments screen. Money that arrived is never removed.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// One line per activity, written the way a person would say it.
function describe(a: Activity): string {
  if (a.kind === "call") {
    const outcome = a.disposition_label ?? a.disposition ?? "Called";
    if (a.direction === "inbound") return `They rang in — ${outcome}`;
    if (a.direction === "missed") return "Missed call from them";
    return outcome;
  }
  if (a.kind === "status_change") return `Moved to ${a.to_value?.replace(/_/g, " ") ?? "a new stage"}`;
  if (a.kind === "assignment") return a.to_value ? "Assigned to a caller" : "Unassigned";
  if (a.kind === "follow_up") return a.to_value ? `Callback booked for ${shortDate(a.to_value)}` : "Callback cleared";
  if (a.kind === "reminder") return a.to_value ? `Reminder set for ${shortDate(a.to_value)}` : "Reminder set";
  if (a.kind === "import") return "Added to the list";
  if (a.kind === "whatsapp") return "Opened WhatsApp with a link";
  if (a.kind === "qr_share") return "Sent a QR on WhatsApp";
  return "Note";
}
