"use client";

import { Fragment, useCallback, useEffect, useRef, useState, FormEvent } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { clockTime, currency, dateTime, number, shortDate, titleCase } from "@/lib/format";
import { SourceCell, siteLabel } from "@/components/source";
import { ExportButton } from "@/components/export-button";
import {
  Alert,
  Badge,
  Button,
  buttonSecondary,
  Checkbox,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  SegmentedControl,
  Select,
  SkeletonRows,
  StatTile,
  TableShell,
  Tbody,
  Td,
  Textarea,
  Th,
  Thead,
  Toolbar,
} from "@/components/ui";

interface Donation {
  id: string;
  person_id: string;
  amount: number;
  type: string;
  purpose: string;
  payment_mode: string;
  source: string;
  receipt_generated: boolean;
  receipt_number?: string | null;
  external_ref?: string | null;
  created_at: string;
  donor_name?: string;
  donor_phone?: string;
  source_site?: string | null;
  source_page?: string | null;
  // Server-computed readable label: the real seva, or the page it came from
  // when the stored purpose is a content-free placeholder like
  // "Donate any other Amount". The raw purpose is still available above.
  display_purpose?: string | null;
  campaign?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  payment_ref?: string | null;
  receipt_issued_at?: string | null;
}

interface SourceOptions {
  sites: { site: string; count: number; total: number }[];
  pages: { site: string; page: string; count: number; total: number }[];
}

interface DonationsResponse {
  donations: Donation[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  filteredAmount: number;
}

// Purposes used by the "record a donation" form. The FILTER dropdown is
// populated from the data instead (see purposeOptions below) - donations synced
// from hkmsite2.0 carry free-text seva names, so a hardcoded list would fail to
// filter most real rows.
const purposes = ["annadan", "temple_maintenance", "festival", "general"];

/**
 * The named date windows the server resolves, in the order the office thinks
 * in. These values are exactly what GET /api/donations and both export routes
 * accept; the arithmetic behind each one lives in resolvePeriod() on the
 * server and is deliberately not repeated here.
 *
 * A FINANCIAL YEAR HERE IS THE INDIAN ONE, 1 April to 31 March. This temple
 * issues 80G receipts, so that is the only year its accountants and its donors
 * ever mean - which is why the calendar year is labelled as the calendar year
 * rather than left as "This year" for someone to mistake for the other one.
 */
const PERIODS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "This week" },
  { value: "last_7", label: "Last 7 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_quarter", label: "This quarter" },
  { value: "this_fy", label: "This financial year" },
  { value: "last_fy", label: "Last financial year" },
  { value: "this_year", label: "This calendar year" },
  { value: "all", label: "All time" },
];

// The four the office reaches for without thinking: today's takings, the month
// being reconciled, and the two financial years every 80G question is about.
// The rest are one click further away in the dropdown beside them.
const QUICK_PERIODS = PERIODS.filter((p) =>
  ["today", "this_month", "this_fy", "last_fy"].includes(p.value)
);

// Mirrors GROUP_LABELS in server/src/utils/pageGroups.ts - shown when the list
// arrives filtered to a whole bucket from the Donation pages screen.
const GROUP_FILTER_LABELS: Record<string, string> = {
  donations: "Donations page (and pages nested under it)",
  donate: "Donate — seva campaigns",
  other: "Other pages",
  unattributed: "Donations with no page recorded",
};

export default function DonationsPage() {
  const { user } = useAuth();
  const [data, setData] = useState<DonationsResponse | null>(null);
  const [purposeOptions, setPurposeOptions] = useState<{ purpose: string; count: number }[]>([]);
  const [sources, setSources] = useState<SourceOptions>({ sites: [], pages: [] });
  const [siteFilter, setSiteFilter] = useState("");
  const [pageFilter, setPageFilter] = useState("");
  // A whole bucket rather than one page: "donations" covers /donations and
  // everything nested under it, "donate" the seva campaign pages. Classified
  // server-side so this screen and the dashboard always agree.
  const [groupFilter, setGroupFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  // Deep links from the dashboard ("show me just /janmashtami") arrive with
  // site/page in the query string, so seed the filters from it on first load.
  //
  // Read from window.location rather than useSearchParams: this page is fully
  // client-rendered, and useSearchParams forces the whole route under a
  // Suspense boundary at build time or prerendering fails.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const qs = new URLSearchParams(window.location.search);
    const s = qs.get("site");
    const pg = qs.get("page");
    const grp = qs.get("group");
    if (s) setSiteFilter(s);
    if (pg) setPageFilter(pg);
    if (grp) setGroupFilter(grp);
    // First load only - re-running would fight the user's own dropdowns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [purpose, setPurpose] = useState("");
  const [receipt, setReceipt] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  // Empty means no preset, which the server reads as an open window - the same
  // list this screen has always opened on.
  const [period, setPeriod] = useState("");
  const [page, setPage] = useState(1);
  const [showModal, setShowModal] = useState(false);
  const [showOffline, setShowOffline] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setPage(1), [debouncedSearch, purpose, receipt, period, fromDate, toDate, siteFilter, pageFilter, groupFilter]);
  // Changing site invalidates a page or group filter that belongs to the other
  // site. Skipped on the very first run: this effect and the deep-link seeding
  // effect both fire on mount, and without the guard this one would wipe the
  // filter the link had just set - the /pages links would all land on an
  // unfiltered list.
  const firstSiteRun = useRef(true);
  useEffect(() => {
    if (firstSiteRun.current) {
      firstSiteRun.current = false;
      return;
    }
    setPageFilter("");
    setGroupFilter("");
  }, [siteFilter]);

  /**
   * The filters, described once.
   *
   * The list request and the download both read this. A second builder for the
   * export drifts from this one the first time a filter is added to only one of
   * them, and the result is a spreadsheet that does not hold what the person
   * had on screen when they pressed Download - which the temple office then
   * reconciles against.
   */
  const filterParams = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (purpose) params.set("purpose", purpose);
    if (receipt) params.set("receipt_generated", receipt);
    // The preset rides in the same object as everything else, so the download
    // covers the period on screen rather than whatever the export route would
    // have defaulted to. The two are never both set - see choosePeriod below -
    // but the server would ignore this one if they were.
    if (period) params.set("period", period);
    if (fromDate) params.set("from_date", fromDate);
    if (toDate) params.set("to_date", toDate);
    if (siteFilter) params.set("source_site", siteFilter);
    if (pageFilter) params.set("source_page", pageFilter);
    if (groupFilter) params.set("group", groupFilter);
    return params;
  }, [page, debouncedSearch, purpose, receipt, period, fromDate, toDate, siteFilter, pageFilter, groupFilter]);

  /**
   * Picking a preset clears the custom range, and typing a custom date clears
   * the preset.
   *
   * AN EXPLICIT from_date/to_date BEATS period on the server (resolveDateWindow
   * in routes/donations.ts), so a screen holding both would show "This
   * financial year" selected while the list - and the file downloaded from it -
   * covered the two dates in the boxes instead. The office reconciles those
   * files against a bank statement and sends them to auditors, so a spreadsheet
   * whose period is not the one the person picked is wrong in somebody else's
   * hands. Only one of the two can be on screen at a time.
   */
  const choosePeriod = (next: string) => {
    setPeriod(next);
    // Not when the preset is being cleared: "no preset" while a range is typed
    // is the normal state of this control, and wiping the range there would
    // throw away dates nobody asked to lose.
    if (next) {
      setFromDate("");
      setToDate("");
    }
  };

  const chooseFrom = (value: string) => {
    setFromDate(value);
    if (value) setPeriod("");
  };

  const chooseTo = (value: string) => {
    setToDate(value);
    if (value) setPeriod("");
  };

  const fetchDonations = useCallback(() => {
    setLoading(true);
    apiClient
      .get<DonationsResponse>(`/api/donations?${filterParams()}`)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      // An empty table is what a failed request used to look like. The screen
      // said "no records" when the truth was "the server refused", or "the
      // server broke" - indistinguishable to anybody without DevTools open,
      // and the reason a permissions bug can sit unnoticed for weeks.
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load this list"))
      .finally(() => setLoading(false));
  }, [filterParams]);

  useEffect(fetchDonations, [fetchDonations]);

  useEffect(() => {
    apiClient
      .get<{ purpose: string; count: number }[]>("/api/donations/purposes")
      .then(setPurposeOptions)
      .catch(() => setPurposeOptions([]));
    apiClient
      .get<SourceOptions>("/api/donations/sources")
      .then(setSources)
      .catch(() => setSources({ sites: [], pages: [] }));
  }, []);

  const clearFilters = () => {
    setSearch("");
    setPurpose("");
    setReceipt("");
    setPeriod("");
    setFromDate("");
    setToDate("");
    setSiteFilter("");
    setPageFilter("");
    setGroupFilter("");
  };

  const donations = data?.donations ?? [];
  const activeFilters = [
    debouncedSearch,
    purpose,
    receipt,
    period,
    fromDate,
    toDate,
    siteFilter,
    pageFilter,
    groupFilter,
  ].filter(Boolean).length;
  const hasFilters = activeFilters > 0;
  const customRange = Boolean(fromDate || toDate);
  /**
   * What the list on screen covers, in words.
   *
   * A preset is NAMED rather than resolved into two dates. Working out what
   * "this financial year" means is resolvePeriod()'s job on the server, and a
   * second copy of that arithmetic here would eventually disagree with the file
   * people download - and a date range is the one claim about an export that
   * gets forwarded to an auditor without the screen it came from.
   */
  const windowLabel = customRange
    ? `${fromDate ? shortDate(fromDate) : "the first donation"} to ${toDate ? shortDate(toDate) : "today"}`
    : PERIODS.find((p) => p.value === period)?.label ?? "All time";
  // Only offer pages belonging to the selected site - a /janmashtami filter
  // combined with the annadan site returns nothing and looks broken.
  const visiblePages = siteFilter ? sources.pages.filter((p) => p.site === siteFilter) : sources.pages;
  // The two roles /api/donations/export lets through. A caller can read this
  // screen to answer "did my donor's money arrive", so without this check the
  // button would sit in their header and answer 403 every single time.
  const canExport = user?.role === "admin" || user?.role === "accountant";

  return (
    <div>
      <PageHeader
        eyebrow="Donors"
        title="Donations"
        subtitle={data ? `${number(data.total)} donations${hasFilters ? " matching your filters" : ""}` : undefined}
        actions={
          <>
            <Button variant="secondary" icon="receipt" onClick={() => setShowOffline(true)}>
              Record offline donation
            </Button>
            {canExport && (
              <ExportButton
                path="/api/donations/export"
                params={filterParams()}
                filename="donations"
                // The period is named on the button itself: this file gets
                // emailed on, and by then nobody can see which dates were
                // selected when it was taken.
                hint={data ? `${number(data.total)} donations · ${windowLabel}` : undefined}
              />
            )}
            <Button icon="plus" onClick={() => setShowModal(true)}>
              Record Donation
            </Button>
          </>
        }
      />

      {loadError && <Alert tone="danger">{loadError}</Alert>}

      {/* The filtered sum is the number staff actually want when they slice by
          purpose or date - without it the page shows rows but never a total. */}
      {data && (
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {/* The period sits under the money, which is where the eye already
              is - the number and what it covers should never be read apart. */}
          <StatTile
            label={hasFilters ? "Filtered total" : "All-time total"}
            value={currency(data.filteredAmount)}
            sub={`${number(data.total)} donations · ${windowLabel}`}
            accent="brand"
          />
          <StatTile
            label="Average donation"
            value={currency(data.total ? data.filteredAmount / data.total : 0)}
          />
          <StatTile label="Showing" value={`Page ${number(data.page)} of ${number(data.totalPages)}`} sub={`${data.limit} per page`} />
        </div>
      )}

      <Toolbar onClear={clearFilters} activeCount={activeFilters}>
        {/* The date comes first and takes the whole row. Every question this
            screen is opened with starts with a period - the day's takings, the
            month being reconciled, the financial year on an 80G query - and
            everything below only narrows it. */}
        <div className="w-full">
          <div className="flex flex-wrap items-end gap-2.5">
            <Field label="Period">
              <div className="flex flex-wrap items-center gap-2">
                {/* A segmented control rather than buttons, because these show
                    which filter is on rather than offering an action. */}
                <SegmentedControl
                  options={QUICK_PERIODS}
                  value={period}
                  onChange={choosePeriod}
                  size="sm"
                />
                <Select
                  value={period}
                  onChange={choosePeriod}
                  className="min-w-[13rem]"
                  ariaLabel="Date period"
                  options={[
                    // The empty value is both "no preset" and what a typed
                    // range leaves behind, so it says which of the two is in
                    // force - a dropdown reading "All time" over a list
                    // showing one week is the thing this screen must not do.
                    { value: "", label: customRange ? "Custom range" : "No preset" },
                    ...PERIODS,
                  ]}
                />
              </div>
            </Field>
            {/* A bare YYYY-MM-DD is what the server wants and what the date
                input gives, so these two never go near new Date() on the way
                out. */}
            <Field label="From" htmlFor="donations-from" className="w-40">
              <Input
                id="donations-from"
                type="date"
                value={fromDate}
                onChange={(e) => chooseFrom(e.target.value)}
              />
            </Field>
            <Field label="To" htmlFor="donations-to" className="w-40">
              <Input
                id="donations-to"
                type="date"
                value={toDate}
                onChange={(e) => chooseTo(e.target.value)}
              />
            </Field>
          </div>
          <p className="mt-1.5 text-xs text-ink-faint">
            A financial year here is the Indian one, 1 April to 31 March — the year an 80G receipt is counted
            in. Picking a preset clears the dates, and typing a date clears the preset: sent both, the server
            uses the dates and ignores the preset, so only one of the two is ever on screen.
          </p>
        </div>

        <Field label="Search" htmlFor="donations-search" className="flex-1 min-w-[15rem]">
          <SearchInput
            id="donations-search"
            value={search}
            onChange={setSearch}
            placeholder="Donor, phone or receipt no…"
          />
        </Field>
        <Field label="Purpose" className="flex-1 min-w-[9rem]">
          <Select value={purpose} onChange={(v) => setPurpose(v)} ariaLabel="Purpose">
            <option value="">All purposes</option>
            {(purposeOptions.length ? purposeOptions : purposes.map((p) => ({ purpose: p, count: 0 }))).map((p) => (
              <option key={p.purpose} value={p.purpose}>
                {titleCase(p.purpose)}
                {p.count ? ` (${p.count})` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Receipt" className="flex-1 min-w-[9rem]">
          <Select value={receipt} onChange={(v) => setReceipt(v)} ariaLabel="Receipt status">
            <option value="">Any receipt status</option>
            <option value="true">Receipt issued</option>
            <option value="false">Receipt pending</option>
          </Select>
        </Field>
        <Field label="Site" className="flex-1 min-w-[9rem]">
          <Select value={siteFilter} onChange={(v) => setSiteFilter(v)} ariaLabel="Site">
            <option value="">All sites</option>
            {sources.sites.map((s) => (
              <option key={s.site} value={s.site}>
                {siteLabel(s.site)} ({s.count})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Page" className="flex-1 min-w-[9rem]">
          <Select value={pageFilter} onChange={(v) => setPageFilter(v)} ariaLabel="Page">
            <option value="">All pages</option>
            {visiblePages.map((p) => (
              <option key={`${p.site}${p.page}`} value={p.page}>
                {p.page} ({p.count})
              </option>
            ))}
          </Select>
        </Field>
        {/* A group filter arrives from a link and has no dropdown of its own,
            so say so plainly - otherwise the list looks mysteriously short. */}
        {groupFilter && (
          <div className="flex w-full flex-wrap items-center gap-2 border-t border-line-soft pt-2.5">
            <span className="text-xs text-ink-muted">Showing only</span>
            <Badge tone="brand">{GROUP_FILTER_LABELS[groupFilter] ?? groupFilter}</Badge>
            <IconButton
              name="x"
              label="Remove group filter"
              size="xs"
              onClick={() => setGroupFilter("")}
            />
            <Link href="/pages" className="text-xs text-brand-700 hover:underline">
              Back to the breakdown
            </Link>
          </div>
        )}
      </Toolbar>

      <TableShell>
        <Thead>
          <Th>Donor</Th>
          <Th align="right">Amount</Th>
          <Th>Purpose</Th>
          <Th>Type</Th>
          <Th>Receipt</Th>
          <Th>Came from</Th>
          <Th align="right">Date</Th>
          <Th align="right"> </Th>
        </Thead>

        {loading && !data ? (
          <SkeletonRows rows={8} cols={8} />
        ) : (
          <Tbody>
            {donations.map((d) => (
              <Fragment key={d.id}>
                <tr
                  className={`cursor-pointer ${expanded === d.id ? "bg-brand-50" : ""}`}
                  onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                >
                  <Td>
                    <Link
                      href={`/people/${d.person_id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-medium text-ink hover:text-brand-700"
                    >
                      {d.donor_name || "—"}
                    </Link>
                    {d.donor_phone && (
                      <span className="block text-xs tabular-nums text-ink-muted">{d.donor_phone}</span>
                    )}
                  </Td>
                  <Td align="right" className="font-semibold tabular-nums text-ink">
                    {currency(d.amount)}
                  </Td>
                  <Td>{titleCase(d.display_purpose || d.purpose)}</Td>
                  <Td>
                    <Badge tone={d.type === "recurring" ? "good" : "neutral"}>{titleCase(d.type)}</Badge>
                  </Td>
                  <Td>
                    {d.receipt_generated ? (
                      <span className="text-xs tabular-nums text-ink-soft">{d.receipt_number || "Issued"}</span>
                    ) : (
                      <Badge tone="warn">Pending</Badge>
                    )}
                  </Td>
                  <Td>
                    <SourceCell site={d.source_site} page={d.source_page} campaign={d.campaign} />
                  </Td>
                  <Td align="right" className="whitespace-nowrap text-xs text-ink-muted">
                    {shortDate(d.created_at)}
                    {/* The hour matters here: the office reconciles this list
                        against a bank statement, and two donations from the
                        same donor on the same day are told apart by nothing
                        else. All times are IST. */}
                    <div className="text-ink-faint">{clockTime(d.created_at)}</div>
                  </Td>
                  <Td align="right">
                    <Icon
                      name="chevronRight"
                      size={15}
                      className={`inline-block text-ink-faint transition-transform ${
                        expanded === d.id ? "rotate-90" : ""
                      }`}
                    />
                  </Td>
                </tr>
                {expanded === d.id && (
                  <tr className="row-expand">
                    <td colSpan={8} className="border-y border-line-soft bg-sunken px-4 py-4">
                      <DonationDetail donation={d} onChanged={fetchDonations} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </Tbody>
        )}

        {!loading && donations.length === 0 && (
          <tbody>
            <tr>
              <td colSpan={8}>
                <EmptyState
                  icon="rupee"
                  title={hasFilters ? "No matching donations" : "No donations yet"}
                  message={
                    hasFilters
                      ? "Try widening your date range or clearing the filters."
                      : "Donations made on the HKMV site arrive here automatically. You can also record one manually."
                  }
                  action={
                    hasFilters ? (
                      <Button variant="secondary" icon="x" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              </td>
            </tr>
          </tbody>
        )}

        {data && (
          <tfoot>
            <tr>
              <td colSpan={8} className="p-0">
                <Pagination
                  page={data.page}
                  limit={data.limit}
                  total={data.total}
                  totalPages={data.totalPages}
                  onPage={setPage}
                  unit="donations"
                />
              </td>
            </tr>
          </tfoot>
        )}
      </TableShell>

      {showModal && <RecordDonationModal onClose={() => setShowModal(false)} onSaved={fetchDonations} />}
      {showOffline && (
        <OfflineDonationModal onClose={() => setShowOffline(false)} onSaved={fetchDonations} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- detail */

// Named DetailField rather than Field: the shared Field is a labelled form
// control and this is a read-only dt/dd pair, and the filter row above now uses
// the shared one.
function DetailField({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className={`mt-0.5 truncate text-sm text-ink-soft ${mono ? "font-mono text-xs" : ""}`}>
        {value || <span className="text-ink-faint">—</span>}
      </dd>
    </div>
  );
}

// Expanded row: everything about one donation, plus the two actions staff actually
// need on it - download the real receipt PDF, and ask the originating site to
// re-send it on WhatsApp.
function DonationDetail({ donation, onChanged }: { donation: Donation; onChanged: () => void }) {
  const [busy, setBusy] = useState<"resend" | "download" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // A donation keyed in here directly has no upstream record, so there is no
  // site receipt to fetch or resend - the buttons are hidden rather than
  // offered and then failing.
  const fromSite = Boolean(donation.external_ref);

  const resend = async () => {
    setBusy("resend");
    setMessage(null);
    try {
      const r = await apiClient.post<{ sentTo?: string; receiptNumber?: string; site?: string }>(
        `/api/donations/${donation.id}/resend-receipt`,
        {}
      );
      setMessage({
        tone: "ok",
        text: `Receipt ${r.receiptNumber ?? ""} re-sent${r.sentTo ? ` to ${r.sentTo}` : ""} via ${siteLabel(r.site)}.`,
      });
      onChanged();
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof Error ? err.message : "Could not resend the receipt." });
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    setBusy("download");
    setMessage(null);
    try {
      const blob = await apiClient.getBlob(`/api/donations/${donation.id}/receipt-file`);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof Error ? err.message : "Could not fetch the receipt." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        <DetailField label="Donor" value={donation.donor_name} />
        <DetailField label="Phone" value={donation.donor_phone} />
        <DetailField label="Amount" value={currency(donation.amount)} />
        <DetailField label="Purpose" value={titleCase(donation.display_purpose || donation.purpose)} />
        {donation.display_purpose &&
          donation.display_purpose.toLowerCase() !== (donation.purpose ?? "").toLowerCase() && (
            /* The donor's site recorded something that describes the input box
               rather than the donation, so the label above shows the page instead.
               The original is kept visible - it is what that site still holds. */
            <DetailField label="As recorded on the site" value={donation.purpose} />
          )}
        <DetailField label="Type" value={titleCase(donation.type)} />

        <DetailField label="Came from" value={siteLabel(donation.source_site)} />
        <DetailField label="Page" value={donation.source_page} mono />
        <DetailField label="Campaign" value={donation.campaign} />
        <DetailField label="Payment mode" value={titleCase(donation.payment_mode)} />
        <DetailField label="Payment ref" value={donation.payment_ref} mono />

        <DetailField label="Receipt no." value={donation.receipt_number} mono />
        <DetailField label="Receipt issued" value={donation.receipt_issued_at ? dateTime(donation.receipt_issued_at) : null} />
        <DetailField label="Received on" value={dateTime(donation.created_at)} />
        <DetailField label="UTM source" value={donation.utm_source} />
        <DetailField label="UTM campaign" value={donation.utm_campaign} />
      </dl>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {/* A next/link anchor wearing the button class rather than LinkButton:
            LinkButton is a plain <a>, which would drop out of the client router
            and make opening a donor a full page load. */}
        <Link href={`/people/${donation.person_id}`} className={buttonSecondary}>
          Open donor
        </Link>
        {fromSite && donation.receipt_generated && (
          <>
            <Button
              variant="secondary"
              icon="download"
              onClick={download}
              disabled={busy !== null}
              loading={busy === "download"}
            >
              {busy === "download" ? "Fetching…" : "Download receipt"}
            </Button>
            <Button
              variant="whatsapp"
              icon="message"
              onClick={resend}
              disabled={busy !== null}
              loading={busy === "resend"}
            >
              {busy === "resend" ? "Sending…" : "Resend receipt on WhatsApp"}
            </Button>
          </>
        )}
        {fromSite && !donation.receipt_generated && (
          <span className="text-xs text-ink-muted">
            No receipt issued for this donation yet, so there is nothing to resend.
          </span>
        )}
        {!fromSite && (
          <span className="text-xs text-ink-muted">
            Recorded directly in DRM — receipts are issued by the donation sites, so there is none to resend.
          </span>
        )}
      </div>

      {message && (
        <Alert tone={message.tone === "ok" ? "good" : "danger"}>{message.text}</Alert>
      )}
    </div>
  );
}

function RecordDonationModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: "",
    phone: "",
    amount: "",
    type: "one-time",
    purpose: "general",
    payment_mode: "cash",
    source: "offline",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // Find-or-create by phone: the same number always resolves to the same
      // person, so repeat donations stack onto one donor record rather than
      // creating a second "person" with the same phone.
      const lookup = await apiClient.get<{ found: boolean; person?: { id: string } }>(
        `/api/people/lookup?phone=${encodeURIComponent(form.phone)}`
      );
      let personId = lookup.person?.id;
      if (!personId) {
        const person = await apiClient.post<{ id: string }>("/api/people", {
          name: form.name,
          phone: form.phone,
          roles: ["donor"],
        });
        personId = person.id;
      }
      await apiClient.post("/api/donations", {
        person_id: personId,
        amount: Number(form.amount),
        type: form.type,
        purpose: form.purpose,
        payment_mode: form.payment_mode,
        source: form.source,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record donation");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Record Donation"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {/* The footer sits outside the <form> element, so the submit button
              is tied back to it by id - otherwise it belongs to no form and
              pressing it does nothing at all. */}
          <Button type="submit" form="record-donation" loading={loading}>
            {loading ? "Saving…" : "Record Donation"}
          </Button>
        </>
      }
    >
      <form id="record-donation" onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-ink-muted">
          Matched to an existing donor by phone number, or a new one is created.
        </p>

        {error && <Alert tone="danger">{error}</Alert>}

        <Field label="Donor name" htmlFor="donation-name" required>
          <Input
            id="donation-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </Field>
        <Field label="Phone number" htmlFor="donation-phone" required>
          <Input
            id="donation-phone"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            required
          />
        </Field>
        <Field label="Amount (₹)" htmlFor="donation-amount" required>
          <Input
            id="donation-amount"
            type="number"
            step="0.01"
            min="0"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            required
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select
              value={form.type}
              onChange={(v) => setForm({ ...form, type: v })}
              ariaLabel="Donation type"
            >
              <option value="one-time">One-time</option>
              <option value="recurring">Recurring</option>
              <option value="in-kind">In-kind</option>
              <option value="event-sponsorship">Event sponsorship</option>
            </Select>
          </Field>
          <Field label="Purpose">
            <Select
              value={form.purpose}
              onChange={(v) => setForm({ ...form, purpose: v })}
              ariaLabel="Purpose"
            >
              {purposes.map((p) => (
                <option key={p} value={p}>
                  {titleCase(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payment mode">
            <Select
              value={form.payment_mode}
              onChange={(v) => setForm({ ...form, payment_mode: v })}
              ariaLabel="Payment mode"
            >
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="card">Card</option>
              <option value="netbanking">Net banking</option>
              <option value="bank_transfer">Bank transfer</option>
            </Select>
          </Field>
          <Field label="Source">
            <Select
              value={form.source}
              onChange={(v) => setForm({ ...form, source: v })}
              ariaLabel="Source"
            >
              <option value="offline">Offline</option>
              <option value="website">Website</option>
              <option value="event">Event</option>
            </Select>
          </Field>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Recording a donation taken offline — cash at the counter, a cheque, a bank
// transfer, a UPI payment made outside the website.
//
// DRM does not issue receipts. The admin picks which site should, and that
// site's existing offline path runs: DCC is called, the 80G number comes from
// that site's own series, the PDF is made and WhatsApp goes out. Identical to
// using that site's own admin form — which is the point, because there is then
// still exactly one receipt series per site and DCC sees every donation.
//
// What this form adds over those two forms is the thing only DRM can do: type
// the donor's phone and it fills in the rest from the people already here.
function OfflineDonationModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [site, setSite] = useState<"hkmv" | "annadan">("hkmv");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("cash");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [seva, setSeva] = useState("");
  const [wantCertificate, setWantCertificate] = useState(false);
  const [pan, setPan] = useState("");
  const [wantPrasadam, setWantPrasadam] = useState(false);
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");

  const [matched, setMatched] = useState<{ name: string; lifetime_total: number; donation_count: number } | null>(null);
  const [looking, setLooking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ receiptNumber: string | null; message: string } | null>(null);

  // Look the donor up once there are enough digits to be a real number. Fills
  // name, email, PAN and address so a regular donor is two fields and a button,
  // and so their details stay consistent instead of being retyped slightly
  // differently every time.
  useEffect(() => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) {
      setMatched(null);
      return;
    }
    let cancelled = false;
    setLooking(true);
    const t = setTimeout(() => {
      apiClient
        .get<{ people: Record<string, unknown>[] }>(`/api/people?search=${encodeURIComponent(digits.slice(-10))}&limit=1`)
        .then((r) => {
          if (cancelled) return;
          const p = r.people?.[0];
          if (!p) {
            setMatched(null);
            return;
          }
          setMatched({
            name: String(p.name ?? ""),
            lifetime_total: Number(p.lifetime_total ?? 0),
            donation_count: Number(p.donation_count ?? 0),
          });
          // Only fill blanks — never overwrite something already typed.
          setName((v) => v || String(p.name ?? ""));
          setEmail((v) => v || String(p.email ?? ""));
          setPan((v) => v || String(p.pan ?? ""));
          setAddress((v) => v || String(p.prasadam_address ?? p.address ?? ""));
        })
        .catch(() => undefined)
        .finally(() => !cancelled && setLooking(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
      setLooking(false);
    };
  }, [phone]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await apiClient.post<{ receiptNumber: string | null; message: string }>(
        "/api/donations/offline",
        {
          site,
          donor_name: name,
          donor_mobile: phone,
          donor_email: email || undefined,
          amount: Number(amount),
          payment_mode: mode,
          reference_no: reference,
          payment_date: paidOn || undefined,
          seva_name: seva || undefined,
          pan_number: pan || undefined,
          want_certificate: wantCertificate,
          want_prasadam: wantPrasadam,
          prasadam_address: wantPrasadam ? address : undefined,
          note: note || undefined,
        }
      );
      setDone(r);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // The receipt is already issued and the WhatsApp already sent by the time
  // this shows, so there is nothing to undo — the screen confirms and gets out
  // of the way rather than offering an edit that would do nothing.
  if (done) {
    return (
      <Modal
        title="Donation recorded"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button
              icon="plus"
              onClick={() => {
                // Same donor, next donation — keep who they are, clear the money.
                setDone(null);
                setAmount("");
                setReference("");
                setSeva("");
                setNote("");
              }}
            >
              Record another
            </Button>
          </>
        }
      >
        <div className="text-center">
          <p className="text-sm text-ink-muted">
            Recorded on the {site === "annadan" ? "annadan" : "main"} site
          </p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-ink">{currency(Number(amount))}</p>
          {done.receiptNumber && (
            <p className="mt-1 font-mono text-sm text-brand-700">{done.receiptNumber}</p>
          )}
          <p className="mt-3 text-xs text-ink-muted">{done.message}</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Record an offline donation"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {/* Tied to the form by id because the footer renders outside it. */}
          <Button type="submit" form="offline-donation" loading={saving}>
            {saving ? "Issuing receipt…" : "Record and issue receipt"}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-xs text-ink-muted">
        Cash, cheque, bank transfer or a UPI payment taken outside the website. The receipt is
        issued by the site you choose, exactly as if it had been entered there.
      </p>

      {error && <Alert tone="danger">{error}</Alert>}

      <form id="offline-donation" onSubmit={submit} className="space-y-4">
        <Field label="Which site issues the receipt">
          <SegmentedControl
            options={[
              { value: "hkmv", label: "HKM Vizag site" },
              { value: "annadan", label: "Annadan site" },
            ]}
            value={site}
            onChange={(v) => setSite(v)}
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Mobile number"
            htmlFor="offline-phone"
            // The lookup result lives in the hint slot so it sits under the
            // field it describes, and the row does not jump as it appears.
            hint={
              looking
                ? "Looking up…"
                : matched
                ? `Known donor · ${number(matched.donation_count)} donations · ${currency(matched.lifetime_total)} lifetime`
                : phone.replace(/\D/g, "").length >= 10
                ? "New donor — they will be created"
                : " "
            }
          >
            <Input
              id="offline-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              placeholder="98765 43210"
            />
          </Field>
          <Field label="Donor name" htmlFor="offline-name" required>
            <Input
              id="offline-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </Field>
          <Field label="Email" hint="Optional" htmlFor="offline-email">
            <Input
              id="offline-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Seva / purpose" hint="Optional" htmlFor="offline-seva">
            <Input
              id="offline-seva"
              value={seva}
              onChange={(e) => setSeva(e.target.value)}
              placeholder="Gau Seva, Annadan…"
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Amount" htmlFor="offline-amount" required>
            <Input
              id="offline-amount"
              type="number"
              min="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
          <Field label="How it was paid">
            <Select value={mode} onChange={(v) => setMode(v)} ariaLabel="How it was paid">
              <option value="cash">Cash</option>
              <option value="cheque">Cheque</option>
              <option value="upi">UPI</option>
              <option value="bank">Bank transfer</option>
            </Select>
          </Field>
          <Field
            label={
              mode === "cash"
                ? "Receipt book no."
                : mode === "cheque"
                ? "Cheque number"
                : "UTR / reference"
            }
            htmlFor="offline-reference"
            required
          >
            <Input
              id="offline-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              required
            />
          </Field>
          {/* The date input's own YYYY-MM-DD string is what the site expects,
              so it is sent through untouched. */}
          <Field label="Received on" htmlFor="offline-paid-on">
            <Input
              id="offline-paid-on"
              type="date"
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
            />
          </Field>
        </div>
        <p className="-mt-2 text-xs text-ink-faint">
          The reference has to be unique — both sites refuse a second entry against the same one,
          which is what stops the same donation being recorded twice.
        </p>

        <div className="space-y-2 border-t border-line-soft pt-3">
          <Checkbox
            checked={wantCertificate}
            onChange={setWantCertificate}
            label="80G certificate wanted"
          />
          {wantCertificate && (
            <Input
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              placeholder="PAN (required for 80G)"
              aria-label="PAN"
              required
            />
          )}

          <Checkbox checked={wantPrasadam} onChange={setWantPrasadam} label="Prasadam to be sent" />
          {wantPrasadam && (
            <Textarea
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Delivery address"
              aria-label="Delivery address"
              required
              rows={2}
            />
          )}
        </div>

        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional) — who handed it in, anything worth remembering"
          aria-label="Note"
        />
      </form>
    </Modal>
  );
}
