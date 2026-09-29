"use client";

import { Fragment, useCallback, useEffect, useRef, useState, FormEvent } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, number, shortDate, titleCase } from "@/lib/format";
import { SourceCell, siteLabel } from "@/components/source";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  SkeletonRows,
  StatTile,
  TableShell,
  Td,
  Th,
  buttonPrimary,
  buttonSecondary,
  inputClass,
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

// Mirrors GROUP_LABELS in server/src/utils/pageGroups.ts - shown when the list
// arrives filtered to a whole bucket from the Donation pages screen.
const GROUP_FILTER_LABELS: Record<string, string> = {
  donations: "Donations page (and pages nested under it)",
  donate: "Donate — seva campaigns",
  other: "Other pages",
  unattributed: "Donations with no page recorded",
};

export default function DonationsPage() {
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
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [purpose, setPurpose] = useState("");
  const [receipt, setReceipt] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);
  const [showModal, setShowModal] = useState(false);
  const [showOffline, setShowOffline] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setPage(1), [debouncedSearch, purpose, receipt, fromDate, toDate, siteFilter, pageFilter, groupFilter]);
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

  const fetchDonations = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (purpose) params.set("purpose", purpose);
    if (receipt) params.set("receipt_generated", receipt);
    if (fromDate) params.set("from_date", fromDate);
    if (toDate) params.set("to_date", toDate);
    if (siteFilter) params.set("source_site", siteFilter);
    if (pageFilter) params.set("source_page", pageFilter);
    if (groupFilter) params.set("group", groupFilter);
    apiClient
      .get<DonationsResponse>(`/api/donations?${params}`)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page, debouncedSearch, purpose, receipt, fromDate, toDate, siteFilter, pageFilter, groupFilter]);

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
    setFromDate("");
    setToDate("");
    setSiteFilter("");
    setPageFilter("");
    setGroupFilter("");
  };

  const donations = data?.donations ?? [];
  const hasFilters = Boolean(
    debouncedSearch || purpose || receipt || fromDate || toDate || siteFilter || pageFilter || groupFilter
  );
  // Only offer pages belonging to the selected site - a /janmashtami filter
  // combined with the annadan site returns nothing and looks broken.
  const visiblePages = siteFilter ? sources.pages.filter((p) => p.site === siteFilter) : sources.pages;

  return (
    <div>
      <PageHeader
        title="Donations"
        subtitle={data ? `${number(data.total)} donations${hasFilters ? " matching your filters" : ""}` : undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setShowOffline(true)} className={buttonSecondary}>
              Record offline donation
            </button>
            <button onClick={() => setShowModal(true)} className={buttonPrimary}>
              + Record Donation
            </button>
          </div>
        }
      />

      {/* The filtered sum is the number staff actually want when they slice by
          purpose or date - without it the page shows rows but never a total. */}
      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <StatTile
            label={hasFilters ? "Filtered total" : "All-time total"}
            value={currency(data.filteredAmount)}
            sub={`${number(data.total)} donations`}
            accent="brand"
          />
          <StatTile
            label="Average donation"
            value={currency(data.total ? data.filteredAmount / data.total : 0)}
          />
          <StatTile label="Showing" value={`Page ${number(data.page)} of ${number(data.totalPages)}`} sub={`${data.limit} per page`} />
        </div>
      )}

      <Card className="mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search donor, phone or receipt no…"
            className={`${inputClass} flex-1 min-w-[15rem]`}
          />
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)} className={inputClass}>
            <option value="">All purposes</option>
            {(purposeOptions.length ? purposeOptions : purposes.map((p) => ({ purpose: p, count: 0 }))).map((p) => (
              <option key={p.purpose} value={p.purpose}>
                {titleCase(p.purpose)}
                {p.count ? ` (${p.count})` : ""}
              </option>
            ))}
          </select>
          <select value={receipt} onChange={(e) => setReceipt(e.target.value)} className={inputClass}>
            <option value="">Any receipt status</option>
            <option value="true">Receipt issued</option>
            <option value="false">Receipt pending</option>
          </select>
          <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} className={inputClass}>
            <option value="">All sites</option>
            {sources.sites.map((s) => (
              <option key={s.site} value={s.site}>
                {siteLabel(s.site)} ({s.count})
              </option>
            ))}
          </select>
          <select value={pageFilter} onChange={(e) => setPageFilter(e.target.value)} className={inputClass}>
            <option value="">All pages</option>
            {visiblePages.map((p) => (
              <option key={`${p.site}${p.page}`} value={p.page}>
                {p.page} ({p.count})
              </option>
            ))}
          </select>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className={inputClass}
            aria-label="From date"
          />
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className={inputClass}
            aria-label="To date"
          />
          {hasFilters && (
            <button onClick={clearFilters} className={buttonSecondary}>
              Clear
            </button>
          )}
        </div>

        {/* A group filter arrives from a link and has no dropdown of its own,
            so say so plainly - otherwise the list looks mysteriously short. */}
        {groupFilter && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-xs text-slate-500">Showing only</span>
            <span className="inline-flex items-center gap-2 rounded-full border border-[var(--accent)]/30 bg-[var(--accent-soft)]/25 px-3 py-1 text-xs text-[var(--accent-ink)]">
              {GROUP_FILTER_LABELS[groupFilter] ?? groupFilter}
              <button
                onClick={() => setGroupFilter("")}
                className="text-[var(--accent)] hover:text-[var(--accent-ink)] leading-none"
                aria-label="Remove group filter"
              >
                ×
              </button>
            </span>
            <Link href="/pages" className="text-xs text-[var(--accent)] hover:underline">
              Back to the breakdown
            </Link>
          </div>
        )}
      </Card>

      <TableShell>
        <thead className="bg-slate-50/80">
          <tr>
            <Th>Donor</Th>
            <Th align="right">Amount</Th>
            <Th>Purpose</Th>
            <Th>Type</Th>
            <Th>Receipt</Th>
            <Th>Came from</Th>
            <Th align="right">Date</Th>
            <Th align="right"> </Th>
          </tr>
        </thead>

        {loading && !data ? (
          <SkeletonRows rows={8} cols={8} />
        ) : (
          <tbody className="divide-y divide-slate-100">
            {donations.map((d) => (
              <Fragment key={d.id}>
                <tr
                  className={`transition-colors cursor-pointer ${
                    expanded === d.id ? "bg-[var(--accent-wash)]" : "hover:bg-[var(--page)]"
                  }`}
                  onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                >
                  <Td>
                    <Link
                      href={`/people/${d.person_id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-medium text-slate-900 hover:text-[var(--accent)]"
                    >
                      {d.donor_name || "—"}
                    </Link>
                    {d.donor_phone && (
                      <span className="block text-xs text-slate-500 tabular-nums">{d.donor_phone}</span>
                    )}
                  </Td>
                  <Td align="right" className="font-semibold tabular-nums text-slate-900">
                    {currency(d.amount)}
                  </Td>
                  <Td className="text-slate-600">{titleCase(d.display_purpose || d.purpose)}</Td>
                  <Td>
                    <Badge tone={d.type === "recurring" ? "good" : "neutral"}>{titleCase(d.type)}</Badge>
                  </Td>
                  <Td>
                    {d.receipt_generated ? (
                      <span className="text-xs tabular-nums text-slate-700">{d.receipt_number || "Issued"}</span>
                    ) : (
                      <Badge tone="warn">Pending</Badge>
                    )}
                  </Td>
                  <Td>
                    <SourceCell site={d.source_site} page={d.source_page} campaign={d.campaign} />
                  </Td>
                  <Td align="right" className="text-xs text-slate-500 whitespace-nowrap">
                    {shortDate(d.created_at)}
                  </Td>
                  <Td align="right">
                    <span
                      className={`inline-block text-slate-400 transition-transform ${
                        expanded === d.id ? "rotate-90" : ""
                      }`}
                      aria-hidden
                    >
                      ›
                    </span>
                  </Td>
                </tr>
                {expanded === d.id && (
                  <tr className="row-expand">
                    <td colSpan={8} className="bg-[var(--page)] px-4 py-4 border-y border-[var(--line-soft)]">
                      <DonationDetail donation={d} onChanged={fetchDonations} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        )}

        {!loading && donations.length === 0 && (
          <tbody>
            <tr>
              <td colSpan={8}>
                <EmptyState
                  title={hasFilters ? "No matching donations" : "No donations yet"}
                  message={
                    hasFilters
                      ? "Try widening your date range or clearing the filters."
                      : "Donations made on the HKMV site arrive here automatically. You can also record one manually."
                  }
                  action={
                    hasFilters ? (
                      <button onClick={clearFilters} className={buttonSecondary}>
                        Clear filters
                      </button>
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

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`text-sm text-slate-800 mt-0.5 truncate ${mono ? "font-mono text-xs" : ""}`}>
        {value || <span className="text-slate-300">—</span>}
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
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-6 gap-y-3">
        <Field label="Donor" value={donation.donor_name} />
        <Field label="Phone" value={donation.donor_phone} />
        <Field label="Amount" value={currency(donation.amount)} />
        <Field label="Purpose" value={titleCase(donation.display_purpose || donation.purpose)} />
        {donation.display_purpose &&
          donation.display_purpose.toLowerCase() !== (donation.purpose ?? "").toLowerCase() && (
            /* The donor's site recorded something that describes the input box
               rather than the gift, so the label above shows the page instead.
               The original is kept visible - it is what that site still holds. */
            <Field label="As recorded on the site" value={donation.purpose} />
          )}
        <Field label="Type" value={titleCase(donation.type)} />

        <Field label="Came from" value={siteLabel(donation.source_site)} />
        <Field label="Page" value={donation.source_page} mono />
        <Field label="Campaign" value={donation.campaign} />
        <Field label="Payment mode" value={titleCase(donation.payment_mode)} />
        <Field label="Payment ref" value={donation.payment_ref} mono />

        <Field label="Receipt no." value={donation.receipt_number} mono />
        <Field label="Receipt issued" value={donation.receipt_issued_at ? shortDate(donation.receipt_issued_at) : null} />
        <Field label="Received on" value={shortDate(donation.created_at)} />
        <Field label="UTM source" value={donation.utm_source} />
        <Field label="UTM campaign" value={donation.utm_campaign} />
      </dl>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Link href={`/people/${donation.person_id}`} className={buttonSecondary}>
          Open donor
        </Link>
        {fromSite && donation.receipt_generated && (
          <>
            <button onClick={download} disabled={busy !== null} className={buttonSecondary}>
              {busy === "download" ? "Fetching…" : "Download receipt"}
            </button>
            <button onClick={resend} disabled={busy !== null} className={buttonPrimary}>
              {busy === "resend" ? "Sending…" : "Resend receipt on WhatsApp"}
            </button>
          </>
        )}
        {fromSite && !donation.receipt_generated && (
          <span className="text-xs text-slate-500">
            No receipt issued for this donation yet, so there is nothing to resend.
          </span>
        )}
        {!fromSite && (
          <span className="text-xs text-slate-500">
            Recorded directly in DRM — receipts are issued by the donation sites, so there is none to resend.
          </span>
        )}
      </div>

      {message && (
        <p
          className={`text-sm rounded-lg px-3 py-2 ${
            message.tone === "ok"
              ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }`}
        >
          {message.text}
        </p>
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
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl p-6 w-full max-w-md space-y-4 shadow-xl">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Record Donation</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Matched to an existing donor by phone number, or a new one is created.
          </p>
        </div>

        {error && <div className="bg-red-50 text-red-700 text-sm p-3 rounded-lg border border-red-200">{error}</div>}

        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Donor name *"
          required
          className={`${inputClass} w-full`}
        />
        <input
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          placeholder="Phone number *"
          required
          className={`${inputClass} w-full`}
        />
        <input
          type="number"
          step="0.01"
          min="0"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          placeholder="Amount (₹) *"
          required
          className={`${inputClass} w-full`}
        />

        <div className="grid grid-cols-2 gap-3">
          <select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
            className={`${inputClass} w-full`}
          >
            <option value="one-time">One-time</option>
            <option value="recurring">Recurring</option>
            <option value="in-kind">In-kind</option>
            <option value="event-sponsorship">Event sponsorship</option>
          </select>
          <select
            value={form.purpose}
            onChange={(e) => setForm({ ...form, purpose: e.target.value })}
            className={`${inputClass} w-full`}
          >
            {purposes.map((p) => (
              <option key={p} value={p}>
                {titleCase(p)}
              </option>
            ))}
          </select>
          <select
            value={form.payment_mode}
            onChange={(e) => setForm({ ...form, payment_mode: e.target.value })}
            className={`${inputClass} w-full`}
          >
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
            <option value="netbanking">Net banking</option>
            <option value="bank_transfer">Bank transfer</option>
          </select>
          <select
            value={form.source}
            onChange={(e) => setForm({ ...form, source: e.target.value })}
            className={`${inputClass} w-full`}
          >
            <option value="offline">Offline</option>
            <option value="website">Website</option>
            <option value="event">Event</option>
          </select>
        </div>

        <div className="flex gap-3 pt-2">
          <button type="button" onClick={onClose} className={`${buttonSecondary} flex-1 justify-center`}>
            Cancel
          </button>
          <button type="submit" disabled={loading} className={`${buttonPrimary} flex-1 justify-center`}>
            {loading ? "Saving…" : "Record Donation"}
          </button>
        </div>
      </form>
    </div>
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
// still exactly one receipt series per site and DCC sees every gift.
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
      <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center p-4 z-50">
        <Card className="w-full max-w-md text-center">
          <p className="text-sm text-slate-500">Recorded on the {site === "annadan" ? "annadan" : "main"} site</p>
          <p className="text-2xl font-semibold text-slate-900 mt-2 tabular-nums">{currency(Number(amount))}</p>
          {done.receiptNumber && (
            <p className="font-mono text-sm text-[var(--accent-ink)] mt-1">{done.receiptNumber}</p>
          )}
          <p className="text-xs text-slate-500 mt-3">{done.message}</p>
          <div className="flex gap-2 mt-5">
            <button onClick={onClose} className={`${buttonSecondary} flex-1 justify-center`}>
              Close
            </button>
            <button
              onClick={() => {
                // Same donor, next gift — keep who they are, clear the money.
                setDone(null);
                setAmount("");
                setReference("");
                setSeva("");
                setNote("");
              }}
              className={`${buttonPrimary} flex-1 justify-center`}
            >
              Record another
            </button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-start justify-center p-4 overflow-y-auto z-50">
      <Card className="w-full max-w-2xl my-8">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Record an offline donation</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Cash, cheque, bank transfer or a UPI payment taken outside the website. The receipt is
              issued by the site you choose, exactly as if it had been entered there.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            ×
          </button>
        </div>

        {error && <p className="mb-3 text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-1.5">
              Which site issues the receipt
            </p>
            <div className="flex gap-2">
              {(
                [
                  ["hkmv", "HKM Vizag site"],
                  ["annadan", "Annadan site"],
                ] as const
              ).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => setSite(key)}
                  className={
                    "flex-1 rounded-lg border px-3 py-2 text-sm transition-colors " +
                    (site === key
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]/25 text-[var(--accent-ink)] font-medium"
                      : "border-[var(--line-soft)] text-slate-600 hover:border-[var(--accent)]/40")
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-slate-500 sm:col-span-1">
              Mobile number
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                placeholder="98765 43210"
                className={`${inputClass} w-full mt-1`}
              />
              <span className="block text-[11px] mt-1 min-h-[1rem]">
                {looking ? (
                  <span className="text-slate-400">Looking up…</span>
                ) : matched ? (
                  <span className="text-[var(--accent-ink)]">
                    Known donor · {number(matched.donation_count)} donations ·{" "}
                    {currency(matched.lifetime_total)} lifetime
                  </span>
                ) : phone.replace(/\D/g, "").length >= 10 ? (
                  <span className="text-slate-400">New donor — they will be created</span>
                ) : null}
              </span>
            </label>
            <label className="text-xs text-slate-500">
              Donor name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className={`${inputClass} w-full mt-1`}
              />
            </label>
            <label className="text-xs text-slate-500">
              Email (optional)
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`${inputClass} w-full mt-1`}
              />
            </label>
            <label className="text-xs text-slate-500">
              Seva / purpose (optional)
              <input
                value={seva}
                onChange={(e) => setSeva(e.target.value)}
                placeholder="Gau Seva, Annadan…"
                className={`${inputClass} w-full mt-1`}
              />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <label className="text-xs text-slate-500">
              Amount
              <input
                type="number"
                min="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                className={`${inputClass} w-full mt-1`}
              />
            </label>
            <label className="text-xs text-slate-500">
              How it was paid
              <select value={mode} onChange={(e) => setMode(e.target.value)} className={`${inputClass} w-full mt-1`}>
                <option value="cash">Cash</option>
                <option value="cheque">Cheque</option>
                <option value="upi">UPI</option>
                <option value="bank">Bank transfer</option>
              </select>
            </label>
            <label className="text-xs text-slate-500">
              {mode === "cash"
                ? "Receipt book no."
                : mode === "cheque"
                ? "Cheque number"
                : "UTR / reference"}
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                required
                className={`${inputClass} w-full mt-1`}
              />
            </label>
            <label className="text-xs text-slate-500">
              Received on
              <input
                type="date"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
                className={`${inputClass} w-full mt-1`}
              />
            </label>
          </div>
          <p className="text-[11px] text-slate-400 -mt-2">
            The reference has to be unique — both sites refuse a second entry against the same one,
            which is what stops the same gift being recorded twice.
          </p>

          <div className="space-y-2 border-t border-[var(--line-soft)] pt-3">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={wantCertificate}
                onChange={(e) => setWantCertificate(e.target.checked)}
              />
              80G certificate wanted
            </label>
            {wantCertificate && (
              <input
                value={pan}
                onChange={(e) => setPan(e.target.value.toUpperCase())}
                placeholder="PAN (required for 80G)"
                required
                className={`${inputClass} w-full`}
              />
            )}

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={wantPrasadam}
                onChange={(e) => setWantPrasadam(e.target.checked)}
              />
              Prasadam to be sent
            </label>
            {wantPrasadam && (
              <textarea
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Delivery address"
                required
                rows={2}
                className={`${inputClass} w-full`}
              />
            )}
          </div>

          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional) — who handed it in, anything worth remembering"
            className={`${inputClass} w-full`}
          />

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className={`${buttonSecondary} flex-1 justify-center`}>
              Cancel
            </button>
            <button type="submit" disabled={saving} className={`${buttonPrimary} flex-1 justify-center`}>
              {saving ? "Issuing receipt…" : "Record and issue receipt"}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
