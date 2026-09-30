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
import { currency, number, relativeDate, shortDate } from "@/lib/format";
import { AlertPicker, Badge, buttonPrimary, buttonSecondary, Card, CardHeader, EmptyState, inputClass, Modal, PageHeader, Select } from "@/components/ui";
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

  if (loading) return <div className="text-sm text-slate-500">Loading…</div>;
  if (!lead) return <EmptyState title="Not found" message={error ?? "That lead no longer exists."} />;

  return (
    <div>
      <PageHeader
        title={lead.name || "Name not known"}
        subtitle={`${lead.phone}${lead.city ? ` · ${lead.city}` : ""}${lead.email ? ` · ${lead.email}` : ""}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <button onClick={() => router.back()} className={buttonSecondary}>
              Back
            </button>
            <a href={`tel:+91${lead.phone}`} className={buttonPrimary}>
              Call {lead.phone}
            </a>
          </div>
        }
      />

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {lead.do_not_call && (
        <Card className="mb-4 border-red-200 bg-red-50/60">
          <p className="text-sm font-medium text-red-900">This person asked not to be called.</p>
          <p className="text-xs text-red-800 mt-0.5">
            They will never appear in a calling queue. Clearing this is deliberate — only do it if they have said so
            themselves.
          </p>
          <button onClick={() => void patch({ do_not_call: false })} className={`${buttonSecondary} mt-3`}>
            They have asked to be called again
          </button>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* ------------------------------------------------------- the story */}
        <div className="lg:col-span-2 space-y-5">
          <Card padded={false} className="p-0">
            <SendLink leadId={lead.id} leadName={lead.name} expectedAmount={lead.expected_amount} onSent={load} />
          </Card>

          <Card>
            <CardHeader title="Add a note" subtitle="For anything that wasn't a call" />
            <div className="flex gap-2">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addNote()}
                placeholder="They replied on WhatsApp saying…"
                className={`${inputClass} w-full`}
              />
              <button onClick={() => void addNote()} disabled={!note.trim()} className={buttonPrimary}>
                Add
              </button>
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
              <ol className="relative space-y-4 border-l border-slate-200 pl-5">
                {activities.map((a) => (
                  <li key={a.id} className="relative">
                    <span
                      className={`absolute -left-[1.44rem] top-1.5 w-2.5 h-2.5 rounded-full ring-4 ring-white ${
                        a.kind === "call"
                          ? a.connected
                            ? "bg-emerald-500"
                            : "bg-slate-300"
                          : a.kind === "status_change"
                          ? "bg-sky-400"
                          : "bg-slate-300"
                      }`}
                    />
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium text-slate-900">{describe(a)}</span>
                      <span className="text-xs text-slate-400">{relativeDate(a.occurred_at)}</span>
                      {a.user_name && <span className="text-xs text-slate-400">· {a.user_name}</span>}
                      {a.kind === "call" && a.duration_seconds !== null && (
                        <span className="text-xs text-slate-400">
                          · {Math.round(a.duration_seconds / 60)} min
                          {a.source === "manual" && <span title="Reported by the caller, not measured"> (reported)</span>}
                        </span>
                      )}
                    </div>
                    {a.note && <p className="mt-0.5 text-sm text-slate-600 whitespace-pre-line">{a.note}</p>}
                    {a.recording_url && (
                      <a href={a.recording_url} target="_blank" rel="noreferrer" className="text-xs text-[var(--accent)] hover:underline">
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
              <label className="block">
                <span className="block text-xs text-slate-500 mb-1">Stage</span>
                <Select value={lead.status} onChange={(v) => void patch({ status: v })} className="w-full">
                  {config?.statuses.map((s) => (
                    <option key={s.slug} value={s.slug}>{s.label}</option>
                  ))}
                </Select>
              </label>
              <label className="block">
                <span className="block text-xs text-slate-500 mb-1">Assigned to</span>
                <Select
                  value={lead.assigned_to ?? ""}
                  onChange={(v) => void patch({ assigned_to: v || null })}
                  className="w-full"
                >
                  <option value="">Nobody</option>
                  {config?.users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </Select>
              </label>
              <label className="block">
                <span className="block text-xs text-slate-500 mb-1">Call back on</span>
                <input
                  type="date"
                  value={lead.next_follow_up_at ? lead.next_follow_up_at.slice(0, 10) : ""}
                  onChange={(e) =>
                    void patch({ next_follow_up_at: e.target.value ? new Date(`${e.target.value}T10:00:00`).toISOString() : null })
                  }
                  className={`${inputClass} w-full`}
                />
              </label>
              <label className="block">
                {/* Optional by design: plenty of donors have no preacher, and
                    forcing one would just get whoever was top of the list. */}
                <span className="block text-xs text-slate-500 mb-1">Known to (preacher)</span>
                <Select
                  value={lead.preacher_id ?? ""}
                  onChange={(v) => void patch({ preacher_id: v || null })}
                  className="w-full"
                  placeholder="Nobody in particular"
                  options={[
                    { value: "", label: "Nobody in particular" },
                    ...preachers.map((p) => ({
                      value: p.id,
                      label: p.name ? `${p.name} (${p.code})` : p.code,
                    })),
                  ]}
                />
              </label>
              <label className="block">
                <span className="block text-xs text-slate-500 mb-1">Hoping for (₹)</span>
                <input
                  type="number"
                  defaultValue={lead.expected_amount ?? ""}
                  onBlur={(e) => e.target.value !== (lead.expected_amount ?? "") && void patch({ expected_amount: e.target.value })}
                  className={`${inputClass} w-full`}
                />
              </label>
            </div>

            {lead.tags.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {lead.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            )}

            <p className="mt-4 text-xs text-slate-400">
              Came from {lead.source}
              {lead.source_detail && <> — {lead.source_detail}</>}
            </p>
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
                  <Link href={`/people/${lead.person_id}`} className="text-xs text-[var(--accent)] hover:underline">
                    Full record →
                  </Link>
                ) : undefined
              }
            />
            {lead.external_total_donated && (
              <p className="mb-3 rounded-lg bg-[var(--accent-wash)] px-3 py-2 text-sm text-slate-800">
                {currency(Number(lead.external_total_donated))} on record in the temple accounts
                {Number(lead.external_account_count) > 1 && <> across {lead.external_account_count} accounts</>}
                {lead.external_last_donation_at && <> · last in {new Date(lead.external_last_donation_at).getFullYear()}</>}
                <span className="block text-[11px] text-slate-500 mt-0.5">
                  From {lead.external_source || "an uploaded sheet"} — kept out of DRM&apos;s own totals.
                </span>
              </p>
            )}
            {lead.converted_at && (
              <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                Gave {currency(Number(lead.converted_amount ?? 0))} {relativeDate(lead.converted_at)} after being
                called.
                <span className="block text-[11px] text-emerald-800 mt-0.5">
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
                <div className="mb-3 rounded-lg border border-[var(--line-soft)] p-3">
                  <p className="text-xs font-medium text-slate-700 mb-2">They donated — how much?</p>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      autoFocus
                      value={donatedAmount}
                      onChange={(e) => setDonatedAmount(e.target.value)}
                      placeholder="₹"
                      className={`${inputClass} w-28`}
                    />
                    <input
                      value={donatedNote}
                      onChange={(e) => setDonatedNote(e.target.value)}
                      placeholder="Cash at the counter, bank transfer…"
                      className={`${inputClass} flex-1`}
                    />
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
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
                      className={buttonPrimary}
                    >
                      Record it
                    </button>
                    <button onClick={() => setDonatedOpen(false)} className={buttonSecondary}>
                      Cancel
                    </button>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-400">
                    This records the donation against the lead. The receipt still comes from whichever site issues it —
                    DRM never mints one.
                  </p>
                </div>
              ) : (
                <button onClick={() => setDonatedOpen(true)} className={`${buttonSecondary} mb-3`}>
                  They donated — record it
                </button>
              )
            )}
            {!donations.length ? (
              <p className="text-sm text-slate-500">
                {lead.person_id
                  ? "No donations recorded for this person."
                  : "Not linked to anyone in DRM — they will be linked automatically if they give."}
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {donations.slice(0, 8).map((d) => (
                  <li key={d.id} className="py-2 flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate text-slate-600">{d.purpose}</span>
                    <span className="whitespace-nowrap">
                      <span className="tabular-nums font-medium text-slate-900">{currency(Number(d.amount))}</span>
                      <span className="ml-2 text-xs text-slate-400">{shortDate(d.created_at)}</span>
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
            <button
              onClick={() => setRemoving(true)}
              className="w-full rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-red-50 hover:text-red-700"
            >
              Remove this lead
            </button>
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
  const [when, setWhen] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    d.setHours(10, 0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [alerts, setAlerts] = useState<number[]>(defaultAlerts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title={leadName ? `A promise from ${leadName}` : "Add a reminder"} onClose={onClose}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <p className="mb-4 text-sm text-slate-600">
        For a moment this donor named — a festival, a salary date, after a family event. It will reach whoever is to
        ring them, before the day arrives.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-500 sm:col-span-2">
          What to remember
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Said he would give at Govardhan Puja"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>

        <label className="text-xs text-slate-500">
          When <span className="text-red-600">*</span>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
        <label className="text-xs text-slate-500">
          How much they said
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            placeholder="Optional"
            inputMode="numeric"
            className={`${inputClass} mt-1 w-full tabular-nums`}
          />
        </label>

        <label className="text-xs text-slate-500">
          The occasion they named
          <input
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
            placeholder="e.g. Govardhan Puja"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
        <label className="text-xs text-slate-500">
          Who should ring them
          <Select
            value={assignee}
            onChange={setAssignee}
            className="mt-1 w-full"
            options={[
              { value: "", label: "Whoever this lead belongs to" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
        </label>

        <label className="text-xs text-slate-500 sm:col-span-2">
          What they said, in their words
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Read back on the call — worth the extra few seconds now."
            className={`${inputClass} mt-1 w-full`}
          />
        </label>

        <div className="text-xs text-slate-500 sm:col-span-2">
          Warn me
          <div className="mt-1.5">
            <AlertPicker value={alerts} onChange={setAlerts} options={ALERT_OPTIONS} />
          </div>
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={buttonSecondary}>
          Cancel
        </button>
        <button
          disabled={busy || !when}
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
                due_at: new Date(when).toISOString(),
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
          className={buttonPrimary}
        >
          {busy ? "Saving…" : "Add it"}
        </button>
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
    <Modal title="Remove this lead?" onClose={onClose}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      {!what ? (
        <div className="h-20 animate-pulse rounded-lg bg-slate-100" />
      ) : (
        <>
          <p className="text-sm text-slate-700">
            {what.name || what.phone} will be removed from DRM. This cannot be undone.
          </p>

          {nothing ? (
            <p className="mt-2 text-sm text-slate-500">
              Nothing has been recorded against them yet, so there is nothing else to lose.
            </p>
          ) : (
            <ul className="mt-3 space-y-1 text-sm text-slate-600">
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
            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
              <p className="font-medium text-slate-700">What stays</p>
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

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={buttonSecondary}>
          Keep them
        </button>
        <button
          disabled={busy || !what}
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
          className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
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
