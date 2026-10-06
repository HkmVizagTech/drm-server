"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, currencyCompact, number, relativeDate, titleCase } from "@/lib/format";
import {
  Alert,
  Avatar,
  buttonClass,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  PageHeader,
  Skeleton,
  StatTile,
  Tbody,
  Td,
  Th,
  Thead,
  TableShell,
} from "@/components/ui";
import { CategoryBars, MonthlyTrendChart } from "@/components/charts";
import { SiteBadge, siteLabel } from "@/components/source";
import { SankalpamStrip } from "@/components/sankalpam/today-strip";

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

/**
 * A "see the rest of it" link.
 *
 * next/link carrying a button's classes rather than the shared LinkButton:
 * LinkButton renders a plain anchor, and a plain anchor to an internal route
 * reloads the whole admin instead of routing on the client. This keeps the
 * routing and still takes its look from the one button scale.
 */
function MoreLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className={buttonClass("ghost", "xs")}>
      {children}
      <Icon name="arrowRight" size={13} />
    </Link>
  );
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
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load. Try again."));
  }, [user]);

  if (error) {
    return (
      <div>
        <PageHeader eyebrow="Overview" title="Dashboard" />
        <Alert tone="danger" title="Could not load">
          {error}
        </Alert>
      </div>
    );
  }

  if (!data) {
    // The labels are known before the numbers are, so they are shown straight
    // away and only the figures shimmer - the screen does not rearrange itself
    // when the response lands.
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Overview" title="Dashboard" />
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatTile label="Total donated" value="" icon="rupee" accent="brand" loading />
          <StatTile label="This month" value="" icon="trendUp" loading />
          <StatTile label="Recurring / month" value="" icon="refresh" accent="good" loading />
          <StatTile label="Average donation" value="" icon="chart" loading />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <Skeleton className="h-64 w-full" />
          </Card>
          <Card>
            <Skeleton className="h-64 w-full" />
          </Card>
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
      hint: "waiting for a receipt",
    },
    {
      label: "Paused recurring",
      value: recurring.pausedCount,
      href: "/subscriptions",
      hint: "on hold",
    },
    {
      label: "Upcoming events",
      value: operations.upcomingEvents,
      href: "/events",
      hint: "coming up",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        subtitle={`${number(people.donors)} donors · ${number(giving.lifetimeCount)} donations`}
      />

      <SankalpamStrip className="mb-5" />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatTile
          label="Total donated"
          value={currency(giving.lifetimeTotal)}
          sub={`${number(giving.lifetimeCount)} donations`}
          icon="rupee"
          accent="brand"
        />
        <StatTile
          label="This month"
          value={currency(giving.thisMonth)}
          delta={{ current: giving.thisMonth, previous: giving.lastMonth, label: "vs last month" }}
          sub={giving.lastMonth ? undefined : `${number(giving.thisMonthCount)} donations`}
          icon="trendUp"
        />
        <StatTile
          label="Recurring / month"
          value={currency(recurring.monthlyValue)}
          sub={`${number(recurring.activeCount)} active`}
          icon="refresh"
          accent="good"
        />
        <StatTile
          label="Average donation"
          value={currency(giving.avgGift)}
          sub={`${number(people.newThisMonth)} new people this month`}
          icon="chart"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader
            icon="chart"
            title="Last 12 months"
            subtitle="Donations per month"
          />
          <MonthlyTrendChart data={data.monthlyTrend} />
        </Card>

        <Card>
          <CardHeader
            icon="tag"
            title="Where it goes"
            subtitle="By purpose"
          />
          <CategoryBars data={data.byPurpose} labelKey="purpose" valueKey="total" />
        </Card>
      </div>

      {/* Each site is run and reported separately, so each gets its own
          headline figure. Driven off bySite rather than a hardcoded pair, so a
          third site added later appears here without a code change. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {data.bySite.length === 0 ? (
          <Card className="sm:col-span-2">
            <EmptyState
              icon="rupee"
              title="No donations yet"
              message="Donations from HKMV and Annadan show here."
            />
          </Card>
        ) : (
          data.bySite.map((s) => (
            <Link key={s.site} href={`/donations?site=${encodeURIComponent(s.site)}`} className="block">
              <Card interactive className="h-full">
                <div className="flex items-start justify-between gap-2">
                  <SiteBadge site={s.site} />
                  <Icon name="arrowRight" size={16} className="mt-0.5 text-ink-faint" />
                </div>
                <p className="mt-3 text-3xl font-semibold tabular-nums text-ink">
                  {currency(s.total)}
                </p>
                <p className="mt-1 text-xs tabular-nums text-ink-muted">
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
            icon="list"
            title="HKM Vizag by page"
            subtitle="Main site pages"
            action={<MoreLink href="/pages">See all</MoreLink>}
          />

          {/* Tiles rather than nested Cards: these sit inside a card already,
              and a bordered, shadowed surface inside another one draws the
              double edge the design system exists to stop. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(data.pageGroups ?? []).map((g) => (
              <Link key={g.key} href={`/pages#${g.key}`} className="group block">
                <div
                  className={
                    "h-full rounded-card border p-3 transition-colors " +
                    (g.key === "other"
                      ? "border-line-soft bg-surface group-hover:border-brand-300"
                      : "border-brand-200 bg-brand-50 group-hover:border-brand-400")
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium text-brand-800">{g.label}</p>
                    <Icon
                      name="arrowRight"
                      size={14}
                      className="text-ink-faint transition-colors group-hover:text-brand-700"
                    />
                  </div>
                  <p className="mt-2 text-2xl font-semibold tabular-nums text-ink">
                    {currency(g.total)}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-ink-muted">
                    {number(g.count)} {g.count === 1 ? "donation" : "donations"} ·{" "}
                    {number(g.pageCount)} {g.pageCount === 1 ? "page" : "pages"}
                  </p>
                  <p className="mt-2 text-xs tabular-nums text-ink-muted">
                    {currency(g.thisMonth)} this month
                    <span className="text-ink-faint"> · {currency(g.lastMonth)} last</span>
                  </p>
                </div>
              </Link>
            ))}
          </div>

          <p className="mb-1 mt-5 text-2xs font-semibold uppercase tracking-[0.06em] text-ink-muted">
            Busiest pages
          </p>
          {(() => {
            const rest = data.bySourcePage.filter((r) => r.site === "hkmv");
            if (rest.length === 0) {
              return (
                <EmptyState
                  icon="list"
                  title="No pages yet"
                  message="Pages show here once donations come in."
                />
              );
            }
            return (
              <ul className="divide-y divide-line-soft">
                {rest.slice(0, 8).map((row) => (
                  <li key={`${row.site}${row.sourcePage}`}>
                    <Link
                      href={`/donations?site=${encodeURIComponent(row.site)}&page=${encodeURIComponent(row.sourcePage)}`}
                      className="group flex items-center justify-between gap-3 py-2"
                    >
                      <span className="truncate font-mono text-xs text-ink-soft group-hover:text-brand-700">
                        {row.sourcePage}
                      </span>
                      <span className="flex flex-none items-center gap-3">
                        <span className="text-xs tabular-nums text-ink-muted">
                          {number(row.count)}
                        </span>
                        <span className="text-sm font-semibold tabular-nums text-ink">
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
          <CardHeader
            icon="link"
            title="Other sites by page"
            subtitle="Outside the main site"
          />
          {(() => {
            const rest = data.bySourcePage.filter((r) => r.site !== "hkmv");
            if (rest.length === 0) {
              return (
                <EmptyState
                  icon="link"
                  title="No pages yet"
                  message="Pages show here once donations come in."
                />
              );
            }
            return (
              <ul className="divide-y divide-line-soft">
                {rest.slice(0, 10).map((row) => (
                  <li key={`${row.site}${row.sourcePage}`}>
                    <Link
                      href={`/donations?site=${encodeURIComponent(row.site)}&page=${encodeURIComponent(row.sourcePage)}`}
                      className="group flex items-center justify-between gap-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-xs text-ink-soft group-hover:text-brand-700">
                          {row.sourcePage}
                        </span>
                        <span className="block text-2xs text-ink-faint">
                          {siteLabel(row.site)} · {number(row.count)}
                        </span>
                      </span>
                      <span className="flex-none text-sm font-semibold tabular-nums text-ink">
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
          <Link key={q.label} href={q.href} className="block">
            <Card interactive className="h-full">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    {q.label}
                  </p>
                  <p
                    className={`mt-2 text-2xl font-semibold tabular-nums ${
                      q.value > 0 ? "text-ink" : "text-ink-faint"
                    }`}
                  >
                    {number(q.value)}
                  </p>
                  <p className="mt-1 truncate text-xs text-ink-muted">{q.hint}</p>
                </div>
                <Icon name="arrowRight" size={16} className="mt-0.5 flex-none text-ink-faint" />
              </div>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader
              icon="star"
              title="Top donors"
              subtitle="By total donated"
              action={<MoreLink href="/people?sort=lifetime">View all</MoreLink>}
            />
          </div>
          {data.topDonors.length === 0 ? (
            <EmptyState
              icon="users"
              title="No donors yet"
              message="Donors show here."
            />
          ) : (
            <ul className="divide-y divide-line-soft">
              {data.topDonors.map((d, i) => (
                <li key={d.id}>
                  <Link
                    href={`/people/${d.id}`}
                    className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-brand-50/60"
                  >
                    <span className="w-4 text-xs tabular-nums text-ink-faint">{i + 1}</span>
                    <Avatar name={d.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{d.name}</span>
                      <span className="block text-xs tabular-nums text-ink-muted">
                        {number(d.count)} {d.count === 1 ? "donation" : "donations"}
                      </span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-ink">
                      {currencyCompact(d.total)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* The header sits above the table rather than wrapping it in a Card:
            a TableShell already draws a bordered, shadowed surface, and putting
            one inside a card stacked two of them with a visible double edge. */}
        <div>
          <CardHeader
            icon="receipt"
            title="Recent donations"
            subtitle="Newest first"
            action={<MoreLink href="/donations">View all</MoreLink>}
          />
          {data.recentDonations.length === 0 ? (
            <Card>
              <EmptyState
                icon="rupee"
                title="No donations yet"
                message="New donations show here."
              />
            </Card>
          ) : (
            <TableShell>
              <Thead>
                <Th>Donor</Th>
                <Th>Purpose</Th>
                <Th align="right">Amount</Th>
                <Th align="right">When</Th>
              </Thead>
              <Tbody>
                {data.recentDonations.map((d) => (
                  <tr key={d.id}>
                    <Td>
                      <Link
                        href={`/people/${d.personId}`}
                        className="font-medium text-ink hover:text-brand-700"
                      >
                        {d.donorName}
                      </Link>
                    </Td>
                    <Td>{titleCase(d.purpose)}</Td>
                    <Td align="right" className="font-semibold tabular-nums text-ink">
                      {currency(d.amount)}
                    </Td>
                    <Td align="right" className="whitespace-nowrap text-xs text-ink-muted">
                      {relativeDate(d.createdAt)}
                    </Td>
                  </tr>
                ))}
              </Tbody>
            </TableShell>
          )}
        </div>
      </div>
    </div>
  );
}
