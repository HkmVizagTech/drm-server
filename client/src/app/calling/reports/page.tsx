"use client";

// Calling reports.
//
// Four questions, in the order a temple actually asks them:
//   Who has been on the phone, and what came of it        (caller report)
//   What is happening on the calls themselves             (call report)
//   Which lists are worth the time                        (conversion report)
//   Are we keeping our promises                           (follow-up report)
//
// The caveat about self-reported figures is repeated here rather than left on
// the dashboard, because a report is the thing that gets screenshotted and sent
// to someone who never saw the dashboard.

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { currency, number, shortDate } from "@/lib/format";
import { Badge, Card, CardHeader, EmptyState, PageHeader, TableShell, Td, Th, buttonSecondary } from "@/components/ui";

const PRESETS = [
  { key: "week", label: "7 days" },
  { key: "month", label: "This month" },
  { key: "quarter", label: "90 days" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
];

interface Caller {
  id: string | null;
  name: string;
  calls: number;
  connected: number;
  unanswered: number;
  leads_touched: number;
  total_seconds: number;
  with_duration: number;
  measured: number;
  active_days: number;
  conversions: number;
  raised: string;
}

interface CallReport {
  totals: { made: number; connected: number; inbound: number; missed: number; measured: number; recorded: number };
  by_disposition: { disposition: string; label: string; counts_connected: boolean; n: number; avg_seconds: number }[];
  by_hour: { hour: number; calls: number; connected: number }[];
}

interface ConversionRow {
  bucket: string;
  leads: number;
  conversions: number;
  raised: string;
  pipeline: string;
  avg_attempts: string;
  rate: number;
  value_per_lead: number;
}

interface FollowUpRow {
  caller: string;
  over_a_week: number;
  this_week: number;
  due_today: number;
  upcoming: number;
  unscheduled: number;
  oldest_due: string | null;
}

const BY_OPTIONS = [
  { key: "source", label: "Where they came from" },
  { key: "source_detail", label: "Which list" },
  { key: "assigned_to", label: "Which caller" },
  { key: "status", label: "Stage" },
];

// The conversion table groups by a raw column, so a source arrives as its
// stored slug. Showing "csv" to someone reading a report is a small rudeness
// that makes the whole screen feel unfinished.
const BUCKET_LABELS: Record<string, string> = {
  donor: "Existing donors",
  csv: "Uploaded lists",
  website: "Website enquiries",
  walk_in: "Walk-ins",
  referral: "Referrals",
  event: "Events",
  manual: "Added by hand",
};

function hhmm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export default function CallingReportsPage() {
  const [preset, setPreset] = useState("month");
  const [by, setBy] = useState("source");
  const [callers, setCallers] = useState<Caller[]>([]);
  const [calls, setCalls] = useState<CallReport | null>(null);
  const [conversion, setConversion] = useState<ConversionRow[]>([]);
  const [followUps, setFollowUps] = useState<FollowUpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, k, v, f] = await Promise.all([
        apiClient.get<{ callers: Caller[] }>(`/api/crm/reports/callers?preset=${preset}`),
        apiClient.get<CallReport>(`/api/crm/reports/calls?preset=${preset}`),
        apiClient.get<{ rows: ConversionRow[] }>(`/api/crm/reports/conversion?preset=${preset}&by=${by}`),
        apiClient.get<{ rows: FollowUpRow[] }>(`/api/crm/reports/follow-ups`),
      ]);
      setCallers(c.callers);
      setCalls(k);
      setConversion(v.rows);
      setFollowUps(f.rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the reports");
    } finally {
      setLoading(false);
    }
  }, [preset, by]);

  useEffect(() => {
    void load();
  }, [load]);

  const peakHour = calls?.by_hour.length
    ? calls.by_hour.reduce((best, h) => (h.calls >= 8 && h.connected / h.calls > best.connected / (best.calls || 1) ? h : best))
    : null;
  const maxHourCalls = Math.max(1, ...(calls?.by_hour ?? []).map((h) => h.calls));

  return (
    <div>
      <PageHeader title="Calling reports" subtitle="Who called, what happened, and what it was worth" />

      <div className="mb-5 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPreset(p.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium border transition-colors ${
              preset === p.key
                ? "border-[var(--accent)] bg-[var(--accent-wash)] text-[var(--accent)]"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {calls && calls.totals.made > 0 && calls.totals.measured === 0 && (
        <p className="mb-5 rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-500">
          <strong className="font-medium text-slate-700">Read these as reported, not measured.</strong> Calls are made
          from callers&apos; own phones and logged here afterwards, so the counts, the connected split and the call
          lengths are what callers recorded — a call nobody logs does not appear at all. These become measured figures
          the day a cloud telephony provider is connected.
        </p>
      )}

      <div className="space-y-6">
        {/* ------------------------------------------------------- callers */}
        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title="Caller activity" subtitle="Conversions are credited to whoever the lead was assigned to when the donation arrived" />
          </div>
          <TableShell>
            <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
              <tr>
                <Th>Caller</Th>
                <Th align="right">Calls</Th>
                <Th align="right">Got through</Th>
                <Th align="right">People</Th>
                <Th align="right">On the phone</Th>
                <Th align="right">Days active</Th>
                <Th align="right">Gave</Th>
                <Th align="right">Raised</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-400">Loading…</td></tr>
              ) : !callers.length ? (
                <tr><td colSpan={8}><EmptyState title="No calls in this period" message="Try a wider date range." /></td></tr>
              ) : (
                callers.map((c) => (
                  <tr key={c.id ?? "unassigned"} className="hover:bg-slate-50/60">
                    <Td className="font-medium text-slate-900">
                      {c.name}
                      {c.id === null && <span className="ml-1 text-xs font-normal text-slate-400">(no caller recorded)</span>}
                    </Td>
                    <Td align="right" className="tabular-nums">{number(c.calls)}</Td>
                    <Td align="right" className="tabular-nums">
                      {number(c.connected)}
                      {c.calls > 0 && (
                        <span className="ml-1 text-xs text-slate-400">{Math.round((c.connected / c.calls) * 100)}%</span>
                      )}
                    </Td>
                    <Td align="right" className="tabular-nums">{number(c.leads_touched)}</Td>
                    <Td align="right" className="tabular-nums text-slate-600">
                      {c.with_duration ? hhmm(c.total_seconds) : <span className="text-slate-300">—</span>}
                    </Td>
                    <Td align="right" className="tabular-nums text-slate-600">{number(c.active_days)}</Td>
                    <Td align="right" className="tabular-nums">{number(c.conversions)}</Td>
                    <Td align="right" className="tabular-nums font-medium text-slate-900">{currency(Number(c.raised))}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </TableShell>
        </Card>

        {/* --------------------------------------------------------- calls */}
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="How calls ended" subtitle="The outcome breakdown — usually the first thing that explains a low conversion rate" />
            {!calls?.by_disposition.length ? (
              <EmptyState title="No calls logged" message="Nothing to break down in this period." />
            ) : (
              <ul className="space-y-2.5">
                {calls.by_disposition.map((d) => {
                  const pct = calls.totals.made ? (d.n / calls.totals.made) * 100 : 0;
                  return (
                    <li key={d.disposition}>
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="flex items-center gap-1.5 truncate">
                          <span className="text-slate-700">{d.label}</span>
                          {d.counts_connected && <Badge tone="good">got through</Badge>}
                        </span>
                        <span className="tabular-nums text-slate-900 whitespace-nowrap">
                          {number(d.n)} <span className="text-xs text-slate-400">{pct.toFixed(0)}%</span>
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${d.counts_connected ? "bg-emerald-500" : "bg-slate-300"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="When calls connect"
              subtitle={
                peakHour && peakHour.calls >= 8
                  ? `Best so far: around ${peakHour.hour}:00, ${Math.round((peakHour.connected / peakHour.calls) * 100)}% got through`
                  : "Not enough calls yet to say much"
              }
            />
            {!calls?.by_hour.length ? (
              <EmptyState title="No calls logged" message="This fills in as calls are recorded." />
            ) : (
              <div className="flex items-end gap-1" style={{ height: 128 }}>
                {Array.from({ length: 24 }).map((_, h) => {
                  const row = calls.by_hour.find((x) => x.hour === h);
                  const total = row?.calls ?? 0;
                  const got = row?.connected ?? 0;
                  // Heights in pixels, not percentages. A percentage height on a
                  // flex child resolves against a parent with no definite height
                  // and collapses to nothing - which rendered this chart as an
                  // empty box with an axis under it.
                  const barPx = Math.round((total / maxHourCalls) * 110);
                  return (
                    <div
                      key={h}
                      className="flex-1 flex flex-col justify-end items-center gap-0.5"
                      title={`${h}:00 — ${total} call${total === 1 ? "" : "s"}, ${got} got through`}
                    >
                      <div className="w-full bg-slate-200 rounded-t" style={{ height: barPx }}>
                        <div
                          className="w-full bg-emerald-500 rounded-t"
                          style={{ height: total ? Math.round(barPx * (got / total)) : 0 }}
                        />
                      </div>
                      {h % 6 === 0 && <span className="text-[9px] text-slate-400">{h}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* ---------------------------------------------------- conversion */}
        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader
              title="What converted"
              subtitle="Only donations that actually arrived after the lead was created — not a caller ticking a box"
              action={
                <div className="flex gap-1">
                  {BY_OPTIONS.map((o) => (
                    <button
                      key={o.key}
                      onClick={() => setBy(o.key)}
                      className={`rounded px-2 py-1 text-xs font-medium ${
                        by === o.key ? "bg-[var(--accent-wash)] text-[var(--accent)]" : "text-slate-500 hover:bg-slate-100"
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              }
            />
          </div>
          <TableShell>
            <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
              <tr>
                <Th>Group</Th>
                <Th align="right">Leads</Th>
                <Th align="right">Gave</Th>
                <Th align="right">Rate</Th>
                <Th align="right">Raised</Th>
                <Th align="right">Per lead</Th>
                <Th align="right">Avg attempts</Th>
                <Th align="right">Still hoped for</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!conversion.length ? (
                <tr><td colSpan={8}><EmptyState title="No leads in this period" message="Try a wider date range." /></td></tr>
              ) : (
                conversion.map((r) => (
                  <tr key={r.bucket} className="hover:bg-slate-50/60">
                    <Td className="font-medium text-slate-900">{BUCKET_LABELS[r.bucket] ?? r.bucket}</Td>
                    <Td align="right" className="tabular-nums">{number(r.leads)}</Td>
                    <Td align="right" className="tabular-nums">{number(r.conversions)}</Td>
                    <Td align="right" className="tabular-nums">
                      <span className={r.rate >= 10 ? "text-emerald-700 font-medium" : "text-slate-600"}>{r.rate}%</span>
                    </Td>
                    <Td align="right" className="tabular-nums font-medium text-slate-900">{currency(Number(r.raised))}</Td>
                    <Td align="right" className="tabular-nums text-slate-600">{currency(r.value_per_lead)}</Td>
                    <Td align="right" className="tabular-nums text-slate-600">{r.avg_attempts}</Td>
                    <Td align="right" className="tabular-nums text-slate-500">{currency(Number(r.pipeline))}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </TableShell>
        </Card>

        {/* ----------------------------------------------------- follow-ups */}
        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title="Promises outstanding" subtitle="Current state, not affected by the date filter above" />
          </div>
          <TableShell>
            <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
              <tr>
                <Th>Caller</Th>
                <Th align="right">Over a week late</Th>
                <Th align="right">Late this week</Th>
                <Th align="right">Due today</Th>
                <Th align="right">Coming up</Th>
                <Th align="right">No date set</Th>
                <Th>Oldest owed</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!followUps.length ? (
                <tr><td colSpan={7}><EmptyState title="Nothing outstanding" message="No open leads have a callback booked." /></td></tr>
              ) : (
                followUps.map((r) => (
                  <tr key={r.caller} className="hover:bg-slate-50/60">
                    <Td className="font-medium text-slate-900">{r.caller}</Td>
                    <Td align="right" className="tabular-nums">
                      {r.over_a_week > 0 ? <span className="text-red-700 font-medium">{number(r.over_a_week)}</span> : <span className="text-slate-300">0</span>}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {r.this_week > 0 ? <span className="text-amber-700 font-medium">{number(r.this_week)}</span> : <span className="text-slate-300">0</span>}
                    </Td>
                    <Td align="right" className="tabular-nums">{number(r.due_today)}</Td>
                    <Td align="right" className="tabular-nums text-slate-600">{number(r.upcoming)}</Td>
                    <Td align="right" className="tabular-nums text-slate-500">{number(r.unscheduled)}</Td>
                    <Td className="text-sm text-slate-500">{r.oldest_due ? shortDate(r.oldest_due) : "—"}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </TableShell>
        </Card>
      </div>
    </div>
  );
}
