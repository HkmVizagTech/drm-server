"use client";

// The calling dashboard.
//
// Every tile here says what it counts, because this screen is read by the
// people whose work it measures and a number whose label is slightly wrong is
// worse than no number. The definitions live server-side in
// server/src/routes/crmReports.ts and the captions below repeat them in plain
// words rather than restating the label.
//
// THE CAVEAT THAT MATTERS
// Nobody is running a telephony switch, so call length and whether a call
// connected are what the caller reported, not what a system measured. The API
// returns `measured` alongside every call figure - how many rows came from a
// provider - and this screen says "self-reported" whenever that is zero. The
// day a provider is wired in, the caveat disappears on its own.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, number } from "@/lib/format";
import { Badge, Card, CardHeader, EmptyState, PageHeader, StatTile, buttonPrimary, buttonSecondary } from "@/components/ui";

interface Dashboard {
  range: { from: string; to: string; label: string };
  leads: { received: number; converted: number; conversion_rate: number; raised: number };
  calls: {
    made: number;
    connected: number;
    unanswered: number;
    connect_rate: number;
    leads_touched: number;
    avg_duration_seconds: number | null;
    with_duration: number;
    measured: number;
    self_reported: number;
  };
  pipeline: { value: number; open_leads: number };
  follow_ups: { overdue: number; today: number; next_7_days: number; unscheduled: number };
  by_status: { status: string; label: string; tone: string; n: number; value: string }[];
  by_source: { source: string; n: number; converted: number }[];
  callers_today: { id: string; name: string; calls: number; connected: number }[];
}

const PRESETS = [
  { key: "today", label: "Today" },
  { key: "week", label: "7 days" },
  { key: "month", label: "This month" },
  { key: "quarter", label: "90 days" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
];

const SOURCE_LABELS: Record<string, string> = {
  donor: "Existing donors",
  csv: "Uploaded lists",
  website: "Website enquiries",
  walk_in: "Walk-ins",
  referral: "Referrals",
  event: "Events",
  manual: "Added by hand",
};

function mins(seconds: number | null): string {
  if (seconds === null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

export default function CallingDashboardPage() {
  const [preset, setPreset] = useState("month");
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiClient.get<Dashboard>(`/api/crm/dashboard?preset=${preset}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the dashboard");
    } finally {
      setLoading(false);
    }
  }, [preset]);

  useEffect(() => {
    void load();
  }, [load]);

  const c = data?.calls;
  const f = data?.follow_ups;
  const maxStatus = Math.max(1, ...(data?.by_status ?? []).map((s) => s.n));

  return (
    <div>
      <PageHeader
        title="Calling"
        subtitle="Phone outreach to donors — what has been done, and what is owed"
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/calling/reports" className={buttonSecondary}>
              Reports
            </Link>
            <Link href="/calling/settings" className={buttonSecondary}>
              Settings
            </Link>
            <Link href="/calling/queue" className={buttonPrimary}>
              Start calling
            </Link>
          </div>
        }
      />

      {/* ------------------------------------------------------ date filter */}
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

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {/* ----------------------------------------------- what is owed today */}
      {f && (f.overdue > 0 || f.today > 0) && (
        <Card className="mb-5 border-amber-200 bg-amber-50/60">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-amber-900">
                {f.overdue > 0 && (
                  <>
                    {number(f.overdue)} callback{f.overdue === 1 ? "" : "s"} overdue
                    {f.today > 0 && " · "}
                  </>
                )}
                {f.today > 0 && <>{number(f.today)} due today</>}
              </p>
              <p className="text-xs text-amber-800 mt-0.5">
                Someone was told they would be rung. These are those calls.
              </p>
            </div>
            <Link href="/follow-ups" className={buttonPrimary}>
              Work through them
            </Link>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------ tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-5">
        <StatTile
          label="Leads received"
          value={loading ? "—" : number(data?.leads.received ?? 0)}
          sub="added in this period"
        />
        <StatTile
          label="Calls made"
          value={loading ? "—" : number(c?.made ?? 0)}
          sub={c ? `across ${number(c.leads_touched)} ${c.leads_touched === 1 ? "person" : "people"}` : undefined}
        />
        <StatTile
          label="Got through"
          value={loading ? "—" : `${c?.connect_rate ?? 0}%`}
          accent="good"
          sub={c ? `${number(c.connected)} of ${number(c.made)} calls` : undefined}
        />
        <StatTile
          label="Raised"
          value={loading ? "—" : currency(data?.leads.raised ?? 0)}
          accent="brand"
          sub={data ? `${number(data.leads.converted)} gave after being called` : undefined}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Conversion"
          value={loading ? "—" : `${data?.leads.conversion_rate ?? 0}%`}
          sub="of leads added in this period"
        />
        <StatTile
          label="Average call"
          value={loading ? "—" : mins(c?.avg_duration_seconds ?? null)}
          sub={
            c && c.with_duration
              ? `over the ${number(c.with_duration)} call${c.with_duration === 1 ? "" : "s"} with a length recorded`
              : "no call lengths recorded"
          }
        />
        <StatTile
          label="Pipeline"
          value={loading ? "—" : currency(data?.pipeline.value ?? 0)}
          accent="warn"
          sub={data ? `hoped for across ${number(data.pipeline.open_leads)} open leads` : undefined}
        />
        <StatTile
          label="Overdue"
          value={loading ? "—" : number(f?.overdue ?? 0)}
          accent={f && f.overdue > 0 ? "warn" : "default"}
          sub={f ? `${number(f.today)} due today, ${number(f.next_7_days)} this week` : undefined}
        />
      </div>

      {/* The honesty note. Renders only while nothing is measured. */}
      {c && c.made > 0 && c.measured === 0 && (
        <p className="mb-6 text-xs text-slate-500 rounded-lg bg-slate-50 px-4 py-3">
          <strong className="font-medium text-slate-700">About the call figures.</strong> Calls are placed from
          callers&apos; own phones and logged here afterwards, so &ldquo;got through&rdquo; and &ldquo;average
          call&rdquo; are what the caller reported — nothing is measuring them. A call nobody logs is not counted at
          all. Connecting a cloud telephony provider would make these measured instead; until then, read them as a
          record of what callers say happened.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ------------------------------------------------- where leads are */}
        <Card>
          <CardHeader title="Where the leads are" subtitle="Every lead, by stage" />
          {!data?.by_status.length ? (
            <EmptyState title="No leads yet" message="Add a list or pull some donors in to get started." />
          ) : (
            <ul className="space-y-2.5">
              {data.by_status.map((s) => (
                <li key={s.status}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-slate-700 truncate">{s.label}</span>
                    <span className="tabular-nums font-medium text-slate-900">{number(s.n)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--accent)]"
                      style={{ width: `${(s.n / maxStatus) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ------------------------------------------------ where they came from */}
        <Card>
          <CardHeader title="Where they came from" subtitle="Leads added in this period, and how many gave" />
          {!data?.by_source.length ? (
            <EmptyState title="Nothing in this period" message="Try a wider date range." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.by_source.map((s) => (
                <li key={s.source} className="py-2.5 flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-700">{SOURCE_LABELS[s.source] ?? s.source}</span>
                  <span className="flex items-center gap-2 text-sm">
                    <span className="tabular-nums text-slate-900">{number(s.n)}</span>
                    {s.converted > 0 && <Badge tone="good">{s.converted} gave</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ------------------------------------------------------ on the phone */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="On the phone today"
            subtitle="Calls logged since midnight — not affected by the date filter above"
            action={
              <Link href="/calling/reports" className="text-xs text-[var(--accent)] hover:underline">
                Full caller report →
              </Link>
            }
          />
          {!data?.callers_today.length ? (
            <EmptyState title="No calls logged today" message="Nothing has been recorded since midnight." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.callers_today.map((u) => (
                <li key={u.id} className="py-2.5 flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-700 truncate">{u.name}</span>
                  <span className="text-sm text-slate-600 tabular-nums whitespace-nowrap">
                    {number(u.calls)} call{u.calls === 1 ? "" : "s"}
                    <span className="text-slate-400"> · {number(u.connected)} got through</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
