"use client";

// Prasadam fulfilment.
//
// Three things happen on this screen, and all of them can go wrong quietly:
//   - marking deliveries done, one at a time or in bulk
//   - handing a courier a manifest of what is still pending
//   - taking the courier's file back and applying it
//
// The rule running through all of it: when a donor's number has more than one
// open delivery, nothing is guessed. The person marking it chooses which gift
// arrived, because marking the wrong one is invisible until the donor rings up.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import { currency, number, relativeDate, shortDate } from "@/lib/format";
import { siteLabel } from "@/components/source";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  StatusBadge,
  TableShell,
  Td,
  Th,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/ui";

interface Delivery {
  id: string;
  person_id: string;
  donation_id: string | null;
  address: string;
  status: string;
  courier_name: string | null;
  tracking_number: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  notes: string | null;
  created_at: string;
  source_site: string;
  marked_at: string | null;
  marked_via: string | null;
  donor_name: string;
  donor_phone: string;
  marked_by_name: string | null;
  donation_amount: string | null;
  donation_purpose: string | null;
  donation_date: string | null;
  donation_receipt: string | null;
  donation_page: string | null;
}

interface ListResponse {
  deliveries: Delivery[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  byStatus: Record<string, number>;
}

interface FilterOptions {
  purposes: { purpose: string; count: number }[];
  pages: { page: string; count: number }[];
  sites: { site: string; count: number }[];
}

interface ImportRow {
  rowNumber: number;
  phone: string;
  name?: string;
  trackingNumber?: string;
  deliveredAt?: string;
}

interface PreviewResponse {
  summary: { rows: number; matched: number; ambiguous: number; unmatched: number };
  matched: { row: ImportRow; delivery: Delivery }[];
  ambiguous: { row: ImportRow; candidates: Delivery[] }[];
  unmatched: { row: ImportRow; reason: string }[];
}

const STATUS_TABS = ["pending", "packed", "shipped", "delivered", "returned", "all"] as const;
type Tab = (typeof STATUS_TABS)[number];

const PAGE_GROUPS = [
  { key: "", label: "Any page" },
  { key: "donations", label: "Donations page (incl. nested)" },
  { key: "donate", label: "Donate — seva campaigns" },
  { key: "other", label: "Other pages" },
];

// ---------------------------------------------------------------------------
// A small CSV reader. Courier files are plain CSV but do quote addresses that
// contain commas, so a naive split on "," would shear every row apart.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// Courier files never agree on header names, so guess and let the person
// correct it rather than silently reading the wrong column.
function guessColumn(headers: string[], candidates: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const i = lower.findIndex((h) => h === c);
    if (i !== -1) return i;
  }
  for (const c of candidates) {
    const i = lower.findIndex((h) => h.includes(c));
    if (i !== -1) return i;
  }
  return -1;
}

export default function PrasadamPage() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [options, setOptions] = useState<FilterOptions>({ purposes: [], pages: [], sites: [] });
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  const [tab, setTab] = useState<Tab>("pending");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [site, setSite] = useState("");
  const [group, setGroup] = useState("");
  const [includePurpose, setIncludePurpose] = useState("");
  const [excludePurpose, setExcludePurpose] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [courier, setCourier] = useState("");
  const [tracking, setTracking] = useState("");
  const [deliveredOn, setDeliveredOn] = useState("");
  const [working, setWorking] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setPage(1), [tab, debounced, site, group, includePurpose, excludePurpose, fromDate, toDate]);

  // One place that turns the filter state into query params, used by the list
  // AND the export - so the file you download is exactly the rows on screen.
  const filterParams = useCallback(() => {
    const p = new URLSearchParams();
    if (tab !== "all") p.set("status", tab);
    if (debounced) p.set("search", debounced);
    if (site) p.set("site", site);
    if (group) p.set("group", group);
    if (includePurpose) p.set("include_purpose", includePurpose);
    if (excludePurpose) p.set("exclude_purpose", excludePurpose);
    if (fromDate) p.set("from_date", fromDate);
    if (toDate) p.set("to_date", toDate);
    return p;
  }, [tab, debounced, site, group, includePurpose, excludePurpose, fromDate, toDate]);

  const fetchData = useCallback(() => {
    setLoading(true);
    const p = filterParams();
    p.set("page", String(page));
    p.set("limit", "50");
    apiClient
      .get<ListResponse>(`/api/prasadam?${p}`)
      .then((d) => {
        setData(d);
        // Drop any selection that is no longer on screen, so a bulk action can
        // never hit a row the person can no longer see.
        setSelected((prev) => {
          const visible = new Set(d.deliveries.map((x) => x.id));
          return new Set([...prev].filter((id) => visible.has(id)));
        });
      })
      .catch((e: Error) => setNotice({ tone: "bad", text: e.message }))
      .finally(() => setLoading(false));
  }, [filterParams, page]);

  useEffect(fetchData, [fetchData]);

  useEffect(() => {
    apiClient.get<FilterOptions>("/api/prasadam/filters").then(setOptions).catch(() => undefined);
  }, []);

  const deliveries = data?.deliveries ?? [];
  const allSelected = deliveries.length > 0 && deliveries.every((d) => selected.has(d.id));

  // Donors with more than one row in view. Marking any of these needs a choice,
  // so they are flagged in the table rather than silently ticked along.
  const multiPhone = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of deliveries) {
      const key = (d.donor_phone || "").replace(/\D/g, "").slice(-10);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [deliveries]);

  const hasMultiple = (d: Delivery) =>
    (multiPhone.get((d.donor_phone || "").replace(/\D/g, "").slice(-10)) ?? 0) > 1;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const applyBulk = async (status: string) => {
    if (!selected.size) return;
    setWorking(true);
    try {
      const body: Record<string, unknown> = { ids: [...selected], status };
      if (courier) body.courier_name = courier;
      if (tracking) body.tracking_number = tracking;
      if (deliveredOn && status === "delivered") body.delivered_at = deliveredOn;
      const r = await apiClient.post<{ requested: number; updated: number; skipped: number }>(
        "/api/prasadam/bulk-status",
        body
      );
      setNotice({
        tone: "good",
        text:
          `${number(r.updated)} marked ${status}` +
          (r.skipped ? ` — ${number(r.skipped)} could not be updated` : ""),
      });
      setSelected(new Set());
      setTracking("");
      fetchData();
    } catch (e) {
      setNotice({ tone: "bad", text: (e as Error).message });
    } finally {
      setWorking(false);
    }
  };

  const markOne = async (d: Delivery, status: string) => {
    setWorking(true);
    try {
      await apiClient.put(`/api/prasadam/${d.id}`, { status });
      setNotice({ tone: "good", text: `${d.donor_name} marked ${status}` });
      fetchData();
    } catch (e) {
      setNotice({ tone: "bad", text: (e as Error).message });
    } finally {
      setWorking(false);
    }
  };

  const download = async () => {
    try {
      const blob = await apiClient.getBlob(`/api/prasadam/export.csv?${filterParams()}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `prasadam-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setNotice({ tone: "bad", text: (e as Error).message });
    }
  };

  return (
    <div>
      <PageHeader
        title="Prasadam deliveries"
        subtitle={
          data
            ? `${number(data.total)} matching · ${number(data.byStatus.pending ?? 0)} still pending`
            : undefined
        }
        actions={
          <div className="flex gap-2">
            <button onClick={download} className={buttonSecondary}>
              Download list
            </button>
            <button onClick={() => setImportOpen(true)} className={buttonPrimary}>
              Upload courier file
            </button>
          </div>
        }
      />

      {notice && (
        <div
          className={
            "mb-4 rounded-lg px-4 py-2.5 text-sm flex items-start justify-between gap-4 " +
            (notice.tone === "good"
              ? "bg-[var(--accent-soft)]/30 text-[var(--accent-ink)]"
              : "bg-red-50 text-red-800")
          }
        >
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" className="leading-none">
            ×
          </button>
        </div>
      )}

      <Card className="mb-4">
        <div className="flex flex-wrap gap-2 mb-3">
          {STATUS_TABS.map((s) => (
            <button
              key={s}
              onClick={() => setTab(s)}
              className={
                "px-3 py-1.5 rounded-full text-xs capitalize transition-colors " +
                (tab === s
                  ? "bg-[var(--accent)] text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200")
              }
            >
              {s}
              {data?.byStatus[s] !== undefined && s !== "all" ? ` (${number(data.byStatus[s])})` : ""}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Donor name, phone or tracking number"
            className={`${inputClass} flex-1 min-w-[16rem]`}
          />
          <select value={site} onChange={(e) => setSite(e.target.value)} className={inputClass}>
            <option value="">All sites</option>
            {options.sites.map((s) => (
              <option key={s.site} value={s.site}>
                {siteLabel(s.site)} ({s.count})
              </option>
            ))}
          </select>
          <select value={group} onChange={(e) => setGroup(e.target.value)} className={inputClass}>
            {PAGE_GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
          <select
            value={includePurpose}
            onChange={(e) => setIncludePurpose(e.target.value)}
            className={inputClass}
          >
            <option value="">Include any seva</option>
            {options.purposes.map((p) => (
              <option key={p.purpose} value={p.purpose}>
                Only {p.purpose} ({p.count})
              </option>
            ))}
          </select>
          <select
            value={excludePurpose}
            onChange={(e) => setExcludePurpose(e.target.value)}
            className={inputClass}
          >
            <option value="">Exclude nothing</option>
            {options.purposes.map((p) => (
              <option key={p.purpose} value={p.purpose}>
                Exclude {p.purpose} ({p.count})
              </option>
            ))}
          </select>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className={inputClass}
            aria-label="Queued from"
          />
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className={inputClass}
            aria-label="Queued to"
          />
        </div>
      </Card>

      {/* The bulk bar only exists while something is ticked, so it can never be
          clicked against an empty selection by accident. */}
      {selected.size > 0 && (
        <Card className="mb-4 border-[var(--accent)]/40 bg-[var(--accent-soft)]/15">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[var(--accent-ink)]">
              {number(selected.size)} selected
            </span>
            <input
              value={courier}
              onChange={(e) => setCourier(e.target.value)}
              placeholder="Courier (optional)"
              className={`${inputClass} w-40`}
            />
            <input
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              placeholder="Tracking no (optional)"
              className={`${inputClass} w-44`}
            />
            <input
              type="date"
              value={deliveredOn}
              onChange={(e) => setDeliveredOn(e.target.value)}
              className={`${inputClass} w-40`}
              aria-label="Delivered on"
              title="Leave blank to use today"
            />
            <button disabled={working} onClick={() => applyBulk("shipped")} className={buttonSecondary}>
              Mark shipped
            </button>
            <button disabled={working} onClick={() => applyBulk("delivered")} className={buttonPrimary}>
              Mark delivered
            </button>
            <button onClick={() => setSelected(new Set())} className="text-xs text-slate-500 hover:underline">
              Clear
            </button>
          </div>
          {[...selected].some((id) => {
            const d = deliveries.find((x) => x.id === id);
            return d && hasMultiple(d);
          }) && (
            <p className="text-xs text-[var(--accent-ink)] mt-2">
              Some of these donors have more than one open delivery. Check you have ticked the right
              gift — the row expands to show which donation it belongs to.
            </p>
          )}
        </Card>
      )}

      <TableShell>
        <thead className="bg-slate-50/80">
          <tr>
            <Th className="w-10">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() =>
                  setSelected(allSelected ? new Set() : new Set(deliveries.map((d) => d.id)))
                }
                aria-label="Select all on this page"
              />
            </Th>
            <Th>Donor</Th>
            <Th>Donation</Th>
            <Th>Address</Th>
            <Th>Status</Th>
            <Th align="right">Actions</Th>
          </tr>
        </thead>
        {loading ? (
          <tbody className="divide-y divide-slate-100">
            <tr>
              <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">
                Loading…
              </td>
            </tr>
          </tbody>
        ) : deliveries.length === 0 ? (
          <tbody>
            <tr>
              <td colSpan={6}>
                <EmptyState
                  title="Nothing here"
                  message="No deliveries match these filters. Try a different status or widen the dates."
                />
              </td>
            </tr>
          </tbody>
        ) : (
          <tbody className="divide-y divide-slate-100">
            {deliveries.map((d) => (
              <tr key={d.id} className={selected.has(d.id) ? "bg-[var(--accent-soft)]/10" : undefined}>
                <Td>
                  <input
                    type="checkbox"
                    checked={selected.has(d.id)}
                    onChange={() => toggle(d.id)}
                    aria-label={`Select delivery for ${d.donor_name}`}
                  />
                </Td>
                <Td>
                  <span className="block font-medium text-slate-900">{d.donor_name}</span>
                  <span className="block text-xs text-slate-500 tabular-nums">{d.donor_phone}</span>
                  {hasMultiple(d) && (
                    <span className="inline-block mt-1">
                      <Badge tone="warn">several open</Badge>
                    </span>
                  )}
                </Td>
                <Td>
                  {d.donation_id ? (
                    <>
                      <span className="block text-sm tabular-nums text-slate-900">
                        {currency(Number(d.donation_amount ?? 0))}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {d.donation_purpose ?? "—"}
                        {d.donation_date ? ` · ${shortDate(d.donation_date)}` : ""}
                      </span>
                      <span className="block text-[11px] text-slate-400 font-mono">
                        {siteLabel(d.source_site)}
                        {d.donation_page ? ` ${d.donation_page}` : ""}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-slate-400">No donation linked</span>
                  )}
                </Td>
                <Td>
                  <span className="block text-xs text-slate-600 max-w-[18rem] truncate" title={d.address}>
                    {d.address}
                  </span>
                  {d.tracking_number && (
                    <span className="block text-[11px] text-slate-400 font-mono">
                      {d.courier_name ? `${d.courier_name} ` : ""}
                      {d.tracking_number}
                    </span>
                  )}
                </Td>
                <Td>
                  <StatusBadge status={d.status} />
                  {d.delivered_at && (
                    <span className="block text-[11px] text-slate-400 mt-1">
                      {relativeDate(d.delivered_at)}
                    </span>
                  )}
                  {d.marked_by_name && (
                    <span className="block text-[11px] text-slate-400">
                      by {d.marked_by_name}
                      {d.marked_via ? ` (${d.marked_via})` : ""}
                    </span>
                  )}
                </Td>
                <Td align="right">
                  <div className="flex gap-2 justify-end">
                    {d.status !== "delivered" && (
                      <button
                        disabled={working}
                        onClick={() => markOne(d, "delivered")}
                        className="text-xs text-[var(--accent)] hover:underline"
                      >
                        Delivered
                      </button>
                    )}
                    <button
                      onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                      className="text-xs text-slate-500 hover:underline"
                    >
                      {expanded === d.id ? "Hide" : "View"}
                    </button>
                  </div>
                  {expanded === d.id && (
                    <div className="mt-2 text-left text-xs text-slate-600 bg-slate-50 rounded-lg p-3 space-y-1">
                      <p>
                        <span className="text-slate-400">Queued</span> {shortDate(d.created_at)}
                      </p>
                      {d.dispatched_at && (
                        <p>
                          <span className="text-slate-400">Dispatched</span> {shortDate(d.dispatched_at)}
                        </p>
                      )}
                      {d.donation_receipt && (
                        <p>
                          <span className="text-slate-400">Receipt</span> {d.donation_receipt}
                        </p>
                      )}
                      {d.notes && (
                        <p>
                          <span className="text-slate-400">Notes</span> {d.notes}
                        </p>
                      )}
                      <p className="text-slate-400">{d.address}</p>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        )}
      </TableShell>

      {data && (
        <Pagination
          page={data.page}
          limit={data.limit}
          total={data.total}
          totalPages={data.totalPages}
          onPage={setPage}
          unit="deliveries"
        />
      )}

      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onDone={(msg) => {
            setImportOpen(false);
            setNotice({ tone: "good", text: msg });
            fetchData();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload → preview → resolve → apply.
//
// Deliberately four steps rather than one. The file has phone numbers, not
// delivery ids, and a donor can have several open deliveries; applying it
// blindly would mark the wrong gift delivered with nothing on screen to say so.
function ImportDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [cols, setCols] = useState({ phone: -1, name: -1, tracking: -1, delivered: -1 });
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [courier, setCourier] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readFile = async (file: File) => {
    setError(null);
    setPreview(null);
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      setError("That file has no data rows.");
      return;
    }
    const head = parsed[0].map((h) => h.replace(/^﻿/, "").trim());
    setHeaders(head);
    setRows(parsed.slice(1));
    setCols({
      phone: guessColumn(head, ["phone", "mobile", "contact", "number"]),
      name: guessColumn(head, ["donor", "name", "consignee"]),
      tracking: guessColumn(head, ["tracking number", "tracking", "awb", "waybill"]),
      delivered: guessColumn(head, ["delivered at", "delivered", "delivery date", "date"]),
    });
  };

  const runPreview = async () => {
    if (cols.phone < 0) {
      setError("Pick which column holds the phone number.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload: ImportRow[] = rows.map((r, i) => ({
        rowNumber: i + 2, // +2: header row, and spreadsheets count from 1
        phone: r[cols.phone] ?? "",
        name: cols.name >= 0 ? r[cols.name] : undefined,
        trackingNumber: cols.tracking >= 0 ? r[cols.tracking] : undefined,
        deliveredAt: cols.delivered >= 0 ? r[cols.delivered] : undefined,
      }));
      setPreview(await apiClient.post<PreviewResponse>("/api/prasadam/import/preview", { rows: payload }));
      setChoices({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const entries = [
        ...preview.matched.map((m) => ({ id: m.delivery.id, delivered_at: m.row.deliveredAt || undefined })),
        ...preview.ambiguous
          .filter((a) => choices[a.row.rowNumber])
          .map((a) => ({ id: choices[a.row.rowNumber], delivered_at: a.row.deliveredAt || undefined })),
      ];
      if (!entries.length) {
        setError("Nothing to apply — no rows matched and none were chosen.");
        setBusy(false);
        return;
      }
      const r = await apiClient.post<{ requested: number; updated: number; skipped: number }>(
        "/api/prasadam/import/commit",
        { deliveries: entries, courier_name: courier || undefined }
      );
      onDone(
        `${number(r.updated)} deliveries marked delivered from the file` +
          (r.skipped ? ` — ${number(r.skipped)} could not be applied` : "")
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const unresolved = preview
    ? preview.ambiguous.filter((a) => !choices[a.row.rowNumber]).length
    : 0;

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-start justify-center p-4 overflow-y-auto z-50">
      <Card className="w-full max-w-4xl my-8">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Upload courier file</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Nothing is changed until you press Apply. Rows matching more than one open delivery
              wait for you to choose.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            ×
          </button>
        </div>

        {error && <p className="mb-3 text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
          className="text-sm mb-4 block"
        />

        {headers.length > 0 && !preview && (
          <>
            <p className="text-xs text-slate-500 mb-2">
              {number(rows.length)} rows read. Check the columns were picked up correctly:
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
              {(
                [
                  ["phone", "Phone (required)"],
                  ["name", "Name"],
                  ["tracking", "Tracking no"],
                  ["delivered", "Delivered date"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="text-xs text-slate-500">
                  {label}
                  <select
                    value={cols[key]}
                    onChange={(e) => setCols({ ...cols, [key]: Number(e.target.value) })}
                    className={`${inputClass} w-full mt-1`}
                  >
                    <option value={-1}>— none —</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <button disabled={busy} onClick={runPreview} className={buttonPrimary}>
              {busy ? "Checking…" : "Check the file"}
            </button>
          </>
        )}

        {preview && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              {[
                ["Rows", preview.summary.rows],
                ["Ready", preview.summary.matched],
                ["Need a choice", preview.summary.ambiguous],
                ["No match", preview.summary.unmatched],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-lg border border-[var(--line-soft)] p-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
                  <p className="text-xl font-semibold tabular-nums text-slate-900">
                    {number(value as number)}
                  </p>
                </div>
              ))}
            </div>

            {preview.ambiguous.length > 0 && (
              <div className="mb-4">
                <p className="text-xs font-medium text-slate-700 mb-2">
                  These donors have more than one open delivery. Pick which gift arrived:
                </p>
                <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                  {preview.ambiguous.map((a) => (
                    <div key={a.row.rowNumber} className="rounded-lg border border-[var(--line-soft)] p-3">
                      <p className="text-xs text-slate-500 mb-2">
                        Row {a.row.rowNumber} · {a.row.name || "—"} · {a.row.phone}
                      </p>
                      <div className="space-y-1">
                        {a.candidates.map((c) => (
                          <label
                            key={c.id}
                            className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer"
                          >
                            <input
                              type="radio"
                              name={`row-${a.row.rowNumber}`}
                              checked={choices[a.row.rowNumber] === c.id}
                              onChange={() => setChoices({ ...choices, [a.row.rowNumber]: c.id })}
                            />
                            <span className="tabular-nums">
                              {currency(Number(c.donation_amount ?? 0))}
                            </span>
                            <span>{c.donation_purpose ?? "no seva recorded"}</span>
                            <span className="text-slate-400">
                              {c.donation_date ? shortDate(c.donation_date) : ""} · {c.status}
                            </span>
                          </label>
                        ))}
                        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                          <input
                            type="radio"
                            name={`row-${a.row.rowNumber}`}
                            checked={!choices[a.row.rowNumber]}
                            onChange={() => {
                              const next = { ...choices };
                              delete next[a.row.rowNumber];
                              setChoices(next);
                            }}
                          />
                          Skip this row
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview.unmatched.length > 0 && (
              <details className="mb-4">
                <summary className="text-xs text-slate-500 cursor-pointer">
                  {number(preview.unmatched.length)} rows matched nothing — see why
                </summary>
                <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                  {preview.unmatched.map((u) => (
                    <li key={u.row.rowNumber} className="text-[11px] text-slate-500">
                      Row {u.row.rowNumber} ({u.row.phone || "no phone"}): {u.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--line-soft)] pt-4">
              <input
                value={courier}
                onChange={(e) => setCourier(e.target.value)}
                placeholder="Courier name (optional)"
                className={`${inputClass} w-48`}
              />
              <button disabled={busy} onClick={commit} className={buttonPrimary}>
                {busy
                  ? "Applying…"
                  : `Apply ${number(preview.summary.matched + Object.keys(choices).length)} deliveries`}
              </button>
              {unresolved > 0 && (
                <span className="text-xs text-slate-500">
                  {number(unresolved)} still unchosen and will be skipped
                </span>
              )}
              <button onClick={onClose} className={buttonSecondary}>
                Cancel
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
