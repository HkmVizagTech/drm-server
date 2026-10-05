"use client";

// Donation pages - the full attribution breakdown.
//
// The dashboard answers "how are the three buckets doing"; this screen answers
// "which exact page produced what". It is the drill-down target from the
// dashboard bucket tiles and its own entry in the nav.
//
// The three buckets are defined once, server-side, in
// server/src/utils/pageGroups.ts. This screen only renders what that
// classification returns - it never decides for itself which page belongs
// where, so the figures here and on the dashboard cannot drift apart.

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, number, relativeDate, shortDate } from "@/lib/format";
import { siteLabel, SiteBadge } from "@/components/source";
import { Alert, Card, CardHeader, EmptyState, PageHeader, Skeleton } from "@/components/ui";

interface PageRow {
  group: string;
  page: string;
  site: string;
  total: number;
  count: number;
  thisMonth: number;
  lastMonth: number;
  firstGiftAt: string | null;
  lastGiftAt: string | null;
}

interface GroupRow {
  key: string;
  label: string;
  total: number;
  count: number;
  thisMonth: number;
  lastMonth: number;
  pages: PageRow[];
}

interface PagesReport {
  groups: GroupRow[];
  otherSites: { site: string; total: number; count: number; pages: PageRow[] }[];
  reconciliation: { siteTotal: number; bucketSum: number; balanced: boolean };
}

// What each bucket means, in the words staff would use. Shown under the
// heading so nobody has to guess why a page landed where it did.
const GROUP_HELP: Record<string, string> = {
  donations:
    "The /donations page and its festival pages",
  donate:
    "Seva pages under /donate",
  other:
    "All other pages",
  unattributed:
    "Donations with no page",
};

// The link out of a section header. A plain text link rather than a Button:
// three of these stacked down the screen as buttons would read as the actions
// of the page, which they are not - the page is a report.
const SECTION_LINK = "whitespace-nowrap text-xs font-medium text-brand-700 hover:underline";

function share(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

export default function DonationPagesScreen() {
  const [data, setData] = useState<PagesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<PagesReport>("/api/reports/pages")
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader
          eyebrow="Donors"
          title="Donation pages"
          subtitle="Money raised by each page"
        />
        <Card>
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ width: `${90 - i * 9}%` }}>
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <PageHeader
          eyebrow="Donors"
          title="Donation pages"
          subtitle="Money raised by each page"
        />
        <Card padded={false}>
          <EmptyState title="Could not load" message={error ?? "Try again."} />
        </Card>
      </div>
    );
  }

  const hkmvTotal = data.reconciliation.siteTotal;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Donors"
        title="Donation pages"
        subtitle="Money raised by each page"
        actions={
          <Link href="/donations" className={SECTION_LINK}>
            All donations
          </Link>
        }
      />

      {/* A classification bug is the quiet kind - every total still looks
          plausible while money sits in a bucket nothing renders. The server
          states what the buckets add up to against what the site actually took,
          and this says so loudly if they ever disagree. */}
      {!data.reconciliation.balanced && (
        <Alert tone="warn" title="Totals do not match.">
          <p className="tabular-nums">
            Sections: {currency(data.reconciliation.bucketSum)}. Main site: {currency(hkmvTotal)}.
            Gap: {currency(Math.abs(hkmvTotal - data.reconciliation.bucketSum))}. Please report this.
          </p>
        </Alert>
      )}

      {data.groups.map((g) => (
        <Card key={g.key} id={g.key} className="scroll-mt-6">
          <CardHeader
            title={g.label}
            subtitle={GROUP_HELP[g.key]}
            action={
              <Link
                href={`/donations?site=hkmv&group=${encodeURIComponent(g.key)}`}
                className={SECTION_LINK}
              >
                View donations
              </Link>
            }
          />

          <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className="text-2xl font-semibold tabular-nums text-ink">
              {currency(g.total)}
            </span>
            <span className="text-xs tabular-nums text-ink-muted">
              {share(g.total, hkmvTotal)}% of the main site
            </span>
            <span className="text-xs tabular-nums text-ink-muted">
              {number(g.count)} {g.count === 1 ? "donation" : "donations"}
            </span>
            <span className="text-xs tabular-nums text-ink-muted">
              {currency(g.thisMonth)} this month
              <span className="text-ink-faint"> · {currency(g.lastMonth)} last</span>
            </span>
          </div>

          {g.pages.length === 0 ? (
            <p className="text-sm text-ink-faint">No pages yet.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {g.pages.map((p) => (
                <li key={`${p.site}${p.page}`}>
                  <Link
                    href={`/donations?site=${encodeURIComponent(p.site)}&page=${encodeURIComponent(p.page)}`}
                    className="group flex items-start justify-between gap-4 py-2.5"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs text-ink group-hover:text-brand-700">
                        {p.page}
                      </span>
                      <span className="mt-0.5 block text-2xs tabular-nums text-ink-faint">
                        {number(p.count)} {p.count === 1 ? "donation" : "donations"}
                        {p.lastGiftAt ? ` · last ${relativeDate(p.lastGiftAt)}` : ""}
                        {p.firstGiftAt ? ` · since ${shortDate(p.firstGiftAt)}` : ""}
                      </span>
                    </span>
                    <span className="flex-none text-right">
                      <span className="block text-sm font-semibold tabular-nums text-ink">
                        {currency(p.total)}
                      </span>
                      <span className="mt-0.5 block text-2xs tabular-nums text-ink-faint">
                        {share(p.total, g.total)}% of this group
                      </span>
                    </span>
                  </Link>
                  {/* Share bar - reading a column of rupee figures tells you
                      the order but not the shape; this shows how lopsided a
                      group is at a glance. */}
                  <div className="mb-2 h-1 overflow-hidden rounded-pill bg-sunken">
                    <div
                      className="h-full rounded-pill bg-brand-400"
                      style={{ width: `${Math.max(share(p.total, g.total), 1)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}

      {data.otherSites.map((s) => (
        <Card key={s.site}>
          <CardHeader
            title={siteLabel(s.site)}
            subtitle="Separate site"
            action={
              <Link href={`/donations?site=${encodeURIComponent(s.site)}`} className={SECTION_LINK}>
                View donations
              </Link>
            }
          />
          <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <SiteBadge site={s.site} />
            <span className="text-2xl font-semibold tabular-nums text-ink">
              {currency(s.total)}
            </span>
            <span className="text-xs tabular-nums text-ink-muted">
              {number(s.count)} {s.count === 1 ? "donation" : "donations"}
            </span>
          </div>
          {s.pages.length === 0 ? (
            <p className="text-sm text-ink-faint">No pages yet.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {s.pages.map((p) => (
                <li key={`${p.site}${p.page}`}>
                  <Link
                    href={`/donations?site=${encodeURIComponent(p.site)}&page=${encodeURIComponent(p.page)}`}
                    className="group flex items-center justify-between gap-4 py-2.5"
                  >
                    <span className="truncate font-mono text-xs text-ink group-hover:text-brand-700">
                      {p.page}
                    </span>
                    <span className="flex flex-none items-center gap-3">
                      <span className="text-xs tabular-nums text-ink-muted">{number(p.count)}</span>
                      <span className="text-sm font-semibold tabular-nums text-ink">
                        {currency(p.total)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}
