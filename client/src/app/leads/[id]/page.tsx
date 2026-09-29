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
import { currency, number, relativeDate, shortDate } from "@/lib/format";
import { Badge, buttonPrimary, buttonSecondary, Card, CardHeader, EmptyState, inputClass, PageHeader, Select } from "@/components/ui";
import { SendLink } from "@/components/send-link";

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

  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [config, setConfig] = useState<{ statuses: { slug: string; label: string }[]; users: { id: string; name: string }[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiClient.get<{ lead: Lead; activities: Activity[]; donations: Donation[] }>(`/api/crm/leads/${id}`);
      setLead(d.lead);
      setActivities(d.activities);
      setDonations(d.donations);
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
            {lead.converted_at && (
              <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                Gave {currency(Number(lead.converted_amount ?? 0))} {relativeDate(lead.converted_at)} after being
                called.
              </p>
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
        </div>
      </div>
    </div>
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
  return "Note";
}
