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
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";

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
    "The /donations page and every festival page nested under it. A new /donations/<festival> is counted here automatically.",
  donate:
    "The seva campaign pages reached from /donate. A new seva page has to be added to the list in pageGroups.ts before it appears here.",
  other:
    "Every remaining page — festival and one-off pages that sit at the top level. Each keeps its own row.",
  unattributed:
    "Donations that arrived with no page recorded at all — usually older rows synced before attribution existed, or entered here by hand.",
};

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
        <PageHeader title="Donation pages" subtitle="Which page on which site produced the money" />
        <Card>
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-4 rounded bg-slate-100 animate-pulse" style={{ width: `${90 - i * 9}%` }} />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Donation pages" subtitle="Which page on which site produced the money" />
        <Card>
          <EmptyState title="Could not load the breakdown" message={error ?? "Unknown error"} />
        </Card>
      </div>
    );
  }

  const hkmvTotal = data.reconciliation.siteTotal;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Donation pages"
        subtitle="Which page on which site produced the money"
        actions={
          <Link href="/donations" className="text-xs text-[var(--accent)] hover:underline">
            All donations
          </Link>
        }
      />

      {/* A classification bug is the quiet kind - every total still looks
          plausible while money sits in a bucket nothing renders. The server
          states what the buckets add up to against what the site actually took,
          and this says so loudly if they ever disagree. */}
      {!data.reconciliation.balanced && (
        <Card className="border-amber-300 bg-amber-50">
          <p className="text-sm font-medium text-amber-900">
            These sections do not add up to the site total.
          </p>
          <p className="text-xs text-amber-800 mt-1 tabular-nums">
            Sections total {currency(data.reconciliation.bucketSum)}, but the main site took{" "}
            {currency(hkmvTotal)} — a difference of{" "}
            {currency(Math.abs(hkmvTotal - data.reconciliation.bucketSum))}. Some donations are
            being classified into a group this screen does not show, so the figures below are
            understating. Worth reporting rather than working around.
          </p>
        </Card>
      )}

      {data.groups.map((g) => (
        <Card key={g.key} id={g.key} className="scroll-mt-6">
          <CardHeader
            title={g.label}
            subtitle={GROUP_HELP[g.key]}
            action={
              <Link
                href={`/donations?site=hkmv&group=${encodeURIComponent(g.key)}`}
                className="text-xs text-[var(--accent)] hover:underline whitespace-nowrap"
              >
                View donations
              </Link>
            }
          />

          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 mb-4">
            <span className="text-2xl font-semibold tabular-nums text-slate-900">
              {currency(g.total)}
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              {share(g.total, hkmvTotal)}% of the main site
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              {number(g.count)} {g.count === 1 ? "donation" : "donations"}
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              {currency(g.thisMonth)} this month
              <span className="text-slate-400"> · {currency(g.lastMonth)} last</span>
            </span>
          </div>

          {g.pages.length === 0 ? (
            <p className="text-sm text-slate-400">No pages in this group yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {g.pages.map((p) => (
                <li key={`${p.site}${p.page}`}>
                  <Link
                    href={`/donations?site=${encodeURIComponent(p.site)}&page=${encodeURIComponent(p.page)}`}
                    className="flex items-start justify-between gap-4 py-2.5 group"
                  >
                    <span className="min-w-0">
                      <span className="block font-mono text-xs text-slate-800 truncate group-hover:text-[var(--accent)]">
                        {p.page}
                      </span>
                      <span className="block text-[11px] text-slate-400 tabular-nums mt-0.5">
                        {number(p.count)} {p.count === 1 ? "donation" : "donations"}
                        {p.lastGiftAt ? ` · last ${relativeDate(p.lastGiftAt)}` : ""}
                        {p.firstGiftAt ? ` · since ${shortDate(p.firstGiftAt)}` : ""}
                      </span>
                    </span>
                    <span className="flex-none text-right">
                      <span className="block text-sm font-semibold tabular-nums text-slate-900">
                        {currency(p.total)}
                      </span>
                      <span className="block text-[11px] text-slate-400 tabular-nums mt-0.5">
                        {share(p.total, g.total)}% of this group
                      </span>
                    </span>
                  </Link>
                  {/* Share bar - reading a column of rupee figures tells you
                      the order but not the shape; this shows how lopsided a
                      group is at a glance. */}
                  <div className="h-1 rounded-full bg-slate-100 overflow-hidden mb-2">
                    <div
                      className="h-full rounded-full bg-[var(--accent)]/50"
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
            subtitle="Run separately from the main site, so it keeps its own section rather than being folded into the groups above."
            action={
              <Link
                href={`/donations?site=${encodeURIComponent(s.site)}`}
                className="text-xs text-[var(--accent)] hover:underline whitespace-nowrap"
              >
                View donations
              </Link>
            }
          />
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 mb-4">
            <SiteBadge site={s.site} />
            <span className="text-2xl font-semibold tabular-nums text-slate-900">
              {currency(s.total)}
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              {number(s.count)} {s.count === 1 ? "donation" : "donations"}
            </span>
          </div>
          {s.pages.length === 0 ? (
            <p className="text-sm text-slate-400">No page attribution recorded.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {s.pages.map((p) => (
                <li key={`${p.site}${p.page}`}>
                  <Link
                    href={`/donations?site=${encodeURIComponent(p.site)}&page=${encodeURIComponent(p.page)}`}
                    className="flex items-center justify-between gap-4 py-2.5 group"
                  >
                    <span className="font-mono text-xs text-slate-800 truncate group-hover:text-[var(--accent)]">
                      {p.page}
                    </span>
                    <span className="flex items-center gap-3 flex-none">
                      <span className="text-xs text-slate-500 tabular-nums">{number(p.count)}</span>
                      <span className="text-sm font-semibold tabular-nums text-slate-900">
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
