"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, currencyCompact, number, relativeDate, titleCase } from "@/lib/format";
import {
  Avatar,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  StatTile,
  Td,
  Th,
  TableShell,
} from "@/components/ui";
import { CategoryBars, MonthlyTrendChart } from "@/components/charts";
import { SiteBadge, siteLabel } from "@/components/source";

interface Dashboard {
  people: { total: number; donors: number; newThisMonth: number };
  giving: {
    lifetimeTotal: number;
    lifetimeCount: number;
    avgGift: number;
    thisMonth: number;
    thisMonthCount: number;
    lastMonth: number;
  };
  recurring: { activeCount: number; monthlyValue: number; pausedCount: number };
  operations: {
    prasadamPending: number;
    receiptsPending: number;
    upcomingEvents: number;
    pendingTriggers: number;
  };
  monthlyTrend: { month: string; total: number; count: number }[];
  byPurpose: { purpose: string; total: number; count: number }[];
  topDonors: { id: string; name: string; phone: string; total: number; count: number }[];
  recentDonations: {
    id: string;
    personId: string;
    donorName: string;
    donorPhone: string;
    amount: number;
    purpose: string;
    createdAt: string;
    receiptNumber: string | null;
    sourceSite?: string | null;
    sourcePage?: string | null;
    campaign?: string | null;
  }[];
  bySite: { site: string; total: number; count: number; thisMonth: number }[];
  pageGroups: {
    key: string;
    label: string;
    total: number;
    count: number;
    pageCount: number;
    thisMonth: number;
    lastMonth: number;
    lastGiftAt: string | null;
  }[];
  bySourcePage: {
    site: string;
    sourcePage: string;
    total: number;
    count: number;
    thisMonth: number;
  }[];
}

export default function DashboardPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");

  // A caller who lands here - from a stale bookmark, or the browser restoring
  // yesterday's tab - is sent to their own screen rather than shown a
  // dashboard whose every request the server will refuse.
  useEffect(() => {
    if (user?.role === "caller") router.replace("/calling/start");
  }, [user, router]);

  useEffect(() => {
    if (user?.role === "caller") return;
    apiClient
      .get<Dashboard>("/api/reports/dashboard")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load dashboard"));
  }, [user]);

  if (error) {
    return (
      <Card>
        <EmptyState title="Dashboard unavailable" message={error} />
      </Card>
    );
  }

  if (!data) {
    return (
      <div>
        <PageHeader title="Dashboard" subtitle="Loading…" />
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <div className="h-3 w-24 bg-slate-100 rounded animate-pulse" />
              <div className="h-7 w-32 bg-slate-100 rounded animate-pulse mt-3" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const { people, giving, recurring, operations } = data;

  // Operational counts that mean "someone needs to do something" - surfaced as
  // links straight to the queue rather than as dead numbers.
  const queues = [
    {
      label: "Prasadam to dispatch",
      value: operations.prasadamPending,
      href: "/prasadam",
      hint: "pending or packed",
    },
    {
      label: "Receipts not issued",
      value: operations.receiptsPending,
      href: "/donations?receipt=false",
      hint: "donations awaiting a receipt",
    },
    {
      label: "Paused subscriptions",
      value: recurring.pausedCount,
      href: "/subscriptions",
      hint: "recurring donations on hold",
    },
    {
      label: "Upcoming events",
      value: operations.upcomingEvents,
      href: "/events",
      hint: "scheduled ahead",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle={`${number(people.donors)} donors · ${number(giving.lifetimeCount)} recorded donations`}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatTile
          label="Total donated"
          value={currency(giving.lifetimeTotal)}
          sub={`${number(giving.lifetimeCount)} donations`}
          accent="brand"
        />
        <StatTile
          label="This month"
          value={currency(giving.thisMonth)}
          delta={{ current: giving.thisMonth, previous: giving.lastMonth, label: "vs last month" }}
          sub={giving.lastMonth ? undefined : `${number(giving.thisMonthCount)} donations`}
        />
        <StatTile
          label="Recurring / month"
          value={currency(recurring.monthlyValue)}
          sub={`${number(recurring.activeCount)} active`}
          accent="good"
        />
        <StatTile
          label="Average donation"
          value={currency(giving.avgGift)}
          sub={`${number(people.newThisMonth)} new people this month`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Donations over the last 12 months"
            subtitle="Hover a month for its total and number of donations"
          />
          <MonthlyTrendChart data={data.monthlyTrend} />
        </Card>

        <Card>
          <CardHeader title="Where it goes" subtitle="Share of total donations by purpose" />
          <CategoryBars data={data.byPurpose} labelKey="purpose" valueKey="total" />
        </Card>
      </div>

      {/* Each site is run and reported separately, so each gets its own
          headline figure. Driven off bySite rather than a hardcoded pair, so a
          third site added later appears here without a code change. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {data.bySite.length === 0 ? (
          <Card className="sm:col-span-2">
            <p className="text-sm text-slate-400">No donations recorded yet.</p>
          </Card>
        ) : (
          data.bySite.map((s) => (
            <Link
              key={s.site}
              href={`/donations?site=${encodeURIComponent(s.site)}`}
              className="block group"
            >
              <Card className="h-full transition-colors group-hover:border-[var(--accent)]/40">
                <div className="flex items-start justify-between gap-2">
                  <SiteBadge site={s.site} />
                  <span
                    className="text-slate-300 group-hover:text-[var(--accent)] transition-colors"
                    aria-hidden
                  >
                    →
                  </span>
                </div>
                <p className="text-3xl font-semibold mt-3 tabular-nums text-slate-900">
                  {currency(s.total)}
                </p>
                <p className="text-xs text-slate-500 mt-1 tabular-nums">
                  {number(s.count)} {s.count === 1 ? "donation" : "donations"} ·{" "}
                  {currency(s.thisMonth)} this month
                </p>
              </Card>
            </Link>
          ))
        )}
      </div>

      {/* The main site's pages roll up into three buckets, defined once in
          server/src/utils/pageGroups.ts:
            Donations  - /donations and everything nested under it, so a new
                         /donations/<festival> is counted from day one.
            Donate     - the seva campaign pages reached from /donate.
            Other      - every remaining page, each keeping its own row.
          Every rupee lands in exactly one bucket; the detail screen checks the
          three add back up to the site total. Clicking a bucket opens the full
          breakdown rather than dumping the whole donation list on you. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader
            title="HKM Vizag — by page"
            subtitle="Where on the main site the donation came from"
            action={
              <Link href="/pages" className="text-xs text-[var(--accent)] hover:underline">
                Full breakdown
              </Link>
            }
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(data.pageGroups ?? []).map((g) => (
              <Link key={g.key} href={`/pages#${g.key}`} className="block group">
                <div
                  className={
                    "h-full rounded-lg border p-3 transition-colors " +
                    (g.key === "other"
                      ? "border-[var(--line)]/60 bg-white group-hover:border-[var(--accent)]/40"
                      : "border-[var(--accent)]/30 bg-[var(--accent-soft)]/20 group-hover:border-[var(--accent)]/60")
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium text-[var(--accent-ink)]">{g.label}</p>
                    <span
                      className="text-[var(--accent)]/40 group-hover:text-[var(--accent)] transition-colors flex-none"
                      aria-hidden
                    >
                      →
                    </span>
                  </div>
                  <p className="text-2xl font-semibold mt-2 tabular-nums text-slate-900">
                    {currency(g.total)}
                  </p>
                  <p className="text-xs text-slate-600 mt-1 tabular-nums">
                    {number(g.count)} {g.count === 1 ? "donation" : "donations"} across{" "}
                    {number(g.pageCount)} {g.pageCount === 1 ? "page" : "pages"}
                  </p>
                  <p className="text-xs text-slate-600 mt-2 tabular-nums">
                    {currency(g.thisMonth)} this month
                    <span className="text-slate-500"> · {currency(g.lastMonth)} last</span>
                  </p>
                </div>
              </Link>
            ))}
          </div>

          <p className="text-[11px] uppercase tracking-wide text-slate-400 mt-5 mb-1">
            Busiest pages
          </p>
          {(() => {
            const rest = data.bySourcePage.filter((r) => r.site === "hkmv");
            if (rest.length === 0) {
              return <p className="text-sm text-slate-400">No page attribution recorded yet.</p>;
            }
            return (
              <ul className="divide-y divide-slate-100">
                {rest.slice(0, 8).map((row) => (
                  <li key={`${row.site}${row.sourcePage}`}>
                    <Link
                      href={`/donations?site=${encodeURIComponent(row.site)}&page=${encodeURIComponent(row.sourcePage)}`}
                      className="flex items-center justify-between gap-3 py-2 group"
                    >
                      <span className="font-mono text-xs text-slate-700 truncate group-hover:text-[var(--accent)]">
                        {row.sourcePage}
                      </span>
                      <span className="flex items-center gap-3 flex-none">
                        <span className="text-xs text-slate-500 tabular-nums">
                          {number(row.count)}
                        </span>
                        <span className="text-sm font-semibold tabular-nums text-slate-900">
                          {currency(row.total)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            );
          })()}
        </Card>

        <Card className="lg:col-span-1">
          <CardHeader title="Other sites — by page" subtitle="Everything outside the main site" />
          {(() => {
            const rest = data.bySourcePage.filter((r) => r.site !== "hkmv");
            if (rest.length === 0) {
              return <p className="text-sm text-slate-400">No page attribution recorded yet.</p>;
            }
            return (
              <ul className="divide-y divide-slate-100">
                {rest.slice(0, 10).map((row) => (
                  <li key={`${row.site}${row.sourcePage}`}>
                    <Link
                      href={`/donations?site=${encodeURIComponent(row.site)}&page=${encodeURIComponent(row.sourcePage)}`}
                      className="flex items-center justify-between gap-3 py-2 group"
                    >
                      <span className="min-w-0">
                        <span className="block font-mono text-xs text-slate-700 truncate group-hover:text-[var(--accent)]">
                          {row.sourcePage}
                        </span>
                        <span className="block text-[11px] text-slate-400">
                          {siteLabel(row.site)} · {number(row.count)}
                        </span>
                      </span>
                      <span className="text-sm font-semibold tabular-nums text-slate-900 flex-none">
                        {currency(row.total)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            );
          })()}
        </Card>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {queues.map((q) => (
          <Link key={q.label} href={q.href} className="block group">
            <Card className="transition-colors group-hover:border-[var(--accent)]/40">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{q.label}</p>
                  <p
                    className={`text-2xl font-semibold mt-2 tabular-nums ${
                      q.value > 0 ? "text-slate-900" : "text-slate-300"
                    }`}
                  >
                    {number(q.value)}
                  </p>
                  <p className="text-xs text-slate-500 mt-1 truncate">{q.hint}</p>
                </div>
                <span className="text-slate-300 group-hover:text-[var(--accent)] transition-colors" aria-hidden>
                  →
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader
                title="Top donors"
                subtitle="By total donated"
                action={
                  <Link href="/people?sort=lifetime" className="text-xs text-[var(--accent)] hover:underline">
                    View all
                  </Link>
                }
              />
            </div>
            {data.topDonors.length === 0 ? (
              <EmptyState title="No donors yet" message="Import from HKMV or record a donation to get started." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.topDonors.map((d, i) => (
                  <li key={d.id}>
                    <Link
                      href={`/people/${d.id}`}
                      className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors"
                    >
                      <span className="w-4 text-xs tabular-nums text-slate-400">{i + 1}</span>
                      <Avatar name={d.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-slate-900 truncate">{d.name}</span>
                        <span className="block text-xs text-slate-500 tabular-nums">
                          {number(d.count)} {d.count === 1 ? "donation" : "donations"}
                        </span>
                      </span>
                      <span className="text-sm font-semibold tabular-nums text-slate-900">
                        {currencyCompact(d.total)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div>
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader
                title="Recent donations"
                subtitle="Newest donations, including ones pushed live from the website"
                action={
                  <Link href="/donations" className="text-xs text-[var(--accent)] hover:underline">
                    View all
                  </Link>
                }
              />
            </div>
            {data.recentDonations.length === 0 ? (
              <EmptyState title="No donations yet" message="Donations made on the HKMV site appear here automatically." />
            ) : (
              <TableShell>
                <thead className="bg-slate-50/80">
                  <tr>
                    <Th>Donor</Th>
                    <Th>Purpose</Th>
                    <Th align="right">Amount</Th>
                    <Th align="right">When</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.recentDonations.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <Td>
                        <Link href={`/people/${d.personId}`} className="font-medium text-slate-900 hover:text-[var(--accent)]">
                          {d.donorName}
                        </Link>
                      </Td>
                      <Td className="text-slate-600">{titleCase(d.purpose)}</Td>
                      <Td align="right" className="font-semibold tabular-nums">
                        {currency(d.amount)}
                      </Td>
                      <Td align="right" className="text-slate-500 text-xs whitespace-nowrap">
                        {relativeDate(d.createdAt)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
