"use client";

// Prasadam fulfilment.
//
// Three things happen on this screen, and all of them can go wrong quietly:
//   - marking deliveries done, one at a time or in bulk
//   - handing a courier a manifest of what is still pending
//   - taking the courier's file back and applying it
//
// The rule running through all of it: when a donor's number has more than one
// open delivery, nothing is guessed. The person marking it chooses which donation
// arrived, because marking the wrong one is invisible until the donor rings up.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import { currency, number, relativeDate, shortDate, titleCase } from "@/lib/format";
import { siteLabel } from "@/components/source";
import { ExportButton } from "@/components/export-button";
import {
  downloadFromApi,
  downloadSample,
  guessColumn,
  readSpreadsheet,
  SPREADSHEET_ACCEPT,
  type ParsedSheet,
} from "@/lib/spreadsheet";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Icon,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  SkeletonRows,
  StatusBadge,
  TableShell,
  Tabs,
  Tbody,
  Td,
  Th,
  Thead,
  Toolbar,
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

// A sample of the file the importer expects.
//
// Built here rather than fetched: it is four lines of text, and a courier file
// arriving in the wrong shape is the most likely reason an import goes wrong.
// Seeing the expected columns beforehand is faster than uploading, reading the
// "matched nothing" report and guessing which header was misread.
//
// The example rows deliberately show three different phone spellings, because
// that is the field that decides whether a row matches at all, and staff
// otherwise assume one exact format is required.
function downloadSampleCsv() {
  downloadSample("prasadam-upload-sample.csv", [
    ["Donor Name", "Phone", "Tracking Number", "Delivered Date"],
    ["Ramesh Kumar", "9876543210", "BD10001", "2026-09-20"],
    ["Lakshmi Devi", "+91 98765 43211", "BD10002", "2026-09-21"],
    ["Suresh Babu", "919876543212", "", "2026-09-21"],
  ]);
}

// Both formats, because "sample file" meaning CSV is only obvious to whoever
// wrote it. An office that lives in Excel opens a .csv into the text-import
// wizard and decides the sample was no help.
function SampleButtons({ onError }: { onError?: (m: string) => void }) {
  return (
    <>
      <Button variant="secondary" icon="fileText" onClick={downloadSampleCsv}>
        Sample file (CSV)
      </Button>
      <Button
        variant="secondary"
        icon="sheet"
        onClick={() =>
          downloadFromApi("/api/prasadam/import/sample.xlsx", "prasadam-upload-sample.xlsx").catch((e) =>
            onError?.(e instanceof Error ? e.message : "Could not download the sample")
          )
        }
      >
        Excel
      </Button>
    </>
  );
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

  return (
    <div>
      <PageHeader
        eyebrow="Fulfilment"
        title="Prasadam deliveries"
        subtitle={
          data
            ? `${number(data.total)} matching · ${number(data.byStatus.pending ?? 0)} still pending`
            : undefined
        }
        actions={
          <>
            {/* The sample sits out here as well as inside the upload dialog:
                someone preparing a file for the courier needs the format
                BEFORE they have anything to upload, so hiding it behind the
                upload button is exactly the wrong way round. */}
            <SampleButtons onError={(text) => setNotice({ tone: "bad", text })} />
            {/* The same filterParams() the list request used, so the file is
                the whole filtered set and not the page on screen. */}
            <ExportButton
              path="/api/prasadam/export"
              params={filterParams()}
              filename={`prasadam-${tab}`}
            />
            <Button icon="upload" onClick={() => setImportOpen(true)}>
              Upload courier file
            </Button>
          </>
        }
      />

      {notice && (
        <Alert tone={notice.tone === "good" ? "good" : "danger"} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <div className="mb-4">
        <Tabs
          variant="pill"
          value={tab}
          onChange={(k) => setTab(k as Tab)}
          items={STATUS_TABS.map((s) => ({
            key: s,
            label: titleCase(s),
            count: s !== "all" ? data?.byStatus[s] : undefined,
          }))}
        />
      </div>

      <Toolbar>
        <Field label="Search" htmlFor="prasadam-search" className="flex-1 min-w-[16rem]">
          <SearchInput
            id="prasadam-search"
            value={search}
            onChange={setSearch}
            placeholder="Donor name, phone or tracking number"
          />
        </Field>
        <Field label="Site" className="flex-1 min-w-[9rem]">
          <Select value={site} onChange={(v) => setSite(v)} ariaLabel="Site">
            <option value="">All sites</option>
            {options.sites.map((s) => (
              <option key={s.site} value={s.site}>
                {siteLabel(s.site)} ({s.count})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Page" className="flex-1 min-w-[9rem]">
          <Select value={group} onChange={(v) => setGroup(v)} ariaLabel="Page group">
            {PAGE_GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Include seva" className="flex-1 min-w-[9rem]">
          <Select
            value={includePurpose}
            onChange={(v) => setIncludePurpose(v)}
            ariaLabel="Include seva"
          >
            <option value="">Include any seva</option>
            {options.purposes.map((p) => (
              <option key={p.purpose} value={p.purpose}>
                Only {p.purpose} ({p.count})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Exclude seva" className="flex-1 min-w-[9rem]">
          <Select
            value={excludePurpose}
            onChange={(v) => setExcludePurpose(v)}
            ariaLabel="Exclude seva"
          >
            <option value="">Exclude nothing</option>
            {options.purposes.map((p) => (
              <option key={p.purpose} value={p.purpose}>
                Exclude {p.purpose} ({p.count})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Queued from" htmlFor="prasadam-from" className="w-40">
          <Input
            id="prasadam-from"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </Field>
        <Field label="Queued to" htmlFor="prasadam-to" className="w-40">
          <Input
            id="prasadam-to"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </Field>
      </Toolbar>

      {/* The bulk bar only exists while something is ticked, so it can never be
          clicked against an empty selection by accident. */}
      {selected.size > 0 && (
        <Card tone="brand" className="mb-4">
          <div className="flex flex-wrap items-end gap-2.5">
            <span className="mb-2 text-sm font-medium text-brand-800">
              {/* Sits on the input baseline rather than the label row: every
                  control beside it is a Field, which is a label stacked over a
                  control, so bottom-aligning is what lines this up with them. */}
              {number(selected.size)} selected
            </span>
            <Field label="Courier" htmlFor="bulk-courier" className="w-40">
              <Input
                id="bulk-courier"
                value={courier}
                onChange={(e) => setCourier(e.target.value)}
                placeholder="Optional"
              />
            </Field>
            <Field label="Tracking no" htmlFor="bulk-tracking" className="w-44">
              <Input
                id="bulk-tracking"
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
                placeholder="Optional"
              />
            </Field>
            <Field label="Delivered on" htmlFor="bulk-delivered" className="w-40">
              <Input
                id="bulk-delivered"
                type="date"
                value={deliveredOn}
                onChange={(e) => setDeliveredOn(e.target.value)}
                title="Leave blank to use today"
              />
            </Field>
            <Button variant="secondary" disabled={working} onClick={() => applyBulk("shipped")}>
              Mark shipped
            </Button>
            <Button disabled={working} onClick={() => applyBulk("delivered")}>
              Mark delivered
            </Button>
            <Button variant="ghost" icon="x" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
          {[...selected].some((id) => {
            const d = deliveries.find((x) => x.id === id);
            return d && hasMultiple(d);
          }) && (
            <p className="mt-2 text-xs text-brand-800">
              Some of these donors have more than one open delivery. Check you have ticked the right
              donation — the row expands to show which donation it belongs to.
            </p>
          )}
        </Card>
      )}

      <TableShell>
        <Thead>
          <Th className="w-10">
            <Checkbox
              checked={allSelected}
              indeterminate={selected.size > 0}
              onChange={() =>
                setSelected(allSelected ? new Set() : new Set(deliveries.map((d) => d.id)))
              }
              label={<span className="sr-only">Select all on this page</span>}
            />
          </Th>
          <Th>Donor</Th>
          <Th>Donation</Th>
          <Th>Address</Th>
          <Th>Status</Th>
          <Th align="right">Actions</Th>
        </Thead>
        {loading ? (
          <SkeletonRows rows={8} cols={6} />
        ) : deliveries.length === 0 ? (
          <tbody>
            <tr>
              <td colSpan={6}>
                <EmptyState
                  icon="box"
                  title="Nothing here"
                  message="No deliveries match these filters. Try a different status or widen the dates."
                />
              </td>
            </tr>
          </tbody>
        ) : (
          <Tbody>
            {deliveries.map((d) => (
              <tr key={d.id} className={selected.has(d.id) ? "bg-brand-50/60" : undefined}>
                <Td>
                  <Checkbox
                    checked={selected.has(d.id)}
                    onChange={() => toggle(d.id)}
                    label={<span className="sr-only">Select delivery for {d.donor_name}</span>}
                  />
                </Td>
                <Td>
                  <span className="block font-medium text-ink">{d.donor_name}</span>
                  <span className="block text-xs tabular-nums text-ink-muted">{d.donor_phone}</span>
                  {hasMultiple(d) && (
                    <span className="mt-1 inline-block">
                      <Badge tone="warn">several open</Badge>
                    </span>
                  )}
                </Td>
                <Td>
                  {d.donation_id ? (
                    <>
                      <span className="block text-sm tabular-nums text-ink">
                        {currency(Number(d.donation_amount ?? 0))}
                      </span>
                      <span className="block text-xs text-ink-muted">
                        {d.donation_purpose ?? "—"}
                        {d.donation_date ? ` · ${shortDate(d.donation_date)}` : ""}
                      </span>
                      <span className="block font-mono text-2xs text-ink-faint">
                        {siteLabel(d.source_site)}
                        {d.donation_page ? ` ${d.donation_page}` : ""}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-ink-faint">No donation linked</span>
                  )}
                </Td>
                <Td>
                  <span className="block max-w-[18rem] truncate text-xs text-ink-soft" title={d.address}>
                    {d.address}
                  </span>
                  {d.tracking_number && (
                    <span className="block font-mono text-2xs text-ink-faint">
                      {d.courier_name ? `${d.courier_name} ` : ""}
                      {d.tracking_number}
                    </span>
                  )}
                </Td>
                <Td>
                  <StatusBadge status={d.status} />
                  {d.delivered_at && (
                    <span className="mt-1 block text-2xs text-ink-faint">
                      {relativeDate(d.delivered_at)}
                    </span>
                  )}
                  {d.marked_by_name && (
                    <span className="block text-2xs text-ink-faint">
                      by {d.marked_by_name}
                      {d.marked_via ? ` (${d.marked_via})` : ""}
                    </span>
                  )}
                </Td>
                <Td align="right">
                  <div className="flex justify-end gap-1.5">
                    {d.status !== "delivered" && (
                      <Button
                        size="xs"
                        variant="secondary"
                        icon="check"
                        disabled={working}
                        onClick={() => markOne(d, "delivered")}
                      >
                        Delivered
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={expanded === d.id ? "chevronUp" : "eye"}
                      onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                    >
                      {expanded === d.id ? "Hide" : "View"}
                    </Button>
                  </div>
                  {expanded === d.id && (
                    <div className="mt-2 space-y-1 rounded-card bg-sunken p-3 text-left text-xs text-ink-soft">
                      <p>
                        <span className="text-ink-faint">Queued</span> {shortDate(d.created_at)}
                      </p>
                      {d.dispatched_at && (
                        <p>
                          <span className="text-ink-faint">Dispatched</span> {shortDate(d.dispatched_at)}
                        </p>
                      )}
                      {d.donation_receipt && (
                        <p>
                          <span className="text-ink-faint">Receipt</span> {d.donation_receipt}
                        </p>
                      )}
                      {d.notes && (
                        <p>
                          <span className="text-ink-faint">Notes</span> {d.notes}
                        </p>
                      )}
                      <p className="text-ink-faint">{d.address}</p>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Tbody>
        )}

        {data && (
          <tfoot>
            <tr>
              <td colSpan={6} className="p-0">
                <Pagination
                  page={data.page}
                  limit={data.limit}
                  total={data.total}
                  totalPages={data.totalPages}
                  onPage={setPage}
                  unit="deliveries"
                />
              </td>
            </tr>
          </tfoot>
        )}
      </TableShell>

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
// blindly would mark the wrong donation delivered with nothing on screen to say so.
function ImportDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  // A courier's file is nearly always one sheet, but an Excel export can carry
  // a tab per day or per route. Rather than guess, all of them are kept and the
  // person picks - with the first selected, so the common case is unchanged.
  const [sheets, setSheets] = useState<ParsedSheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [cols, setCols] = useState({ phone: -1, name: -1, tracking: -1, delivered: -1 });
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [courier, setCourier] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sheet = sheets[sheetIndex] ?? null;
  const headers = sheet?.headers ?? [];
  const rows = sheet?.rows ?? [];

  // Courier files never agree on header names, so guess and let the person
  // correct it rather than silently reading the wrong column.
  const mapColumns = (head: string[]) =>
    setCols({
      phone: guessColumn(head, ["phone", "mobile", "contact", "number"]),
      name: guessColumn(head, ["donor", "name", "consignee"]),
      tracking: guessColumn(head, ["tracking number", "tracking", "awb", "waybill"]),
      delivered: guessColumn(head, ["delivered at", "delivered", "delivery date", "date"]),
    });

  const pickSheet = (i: number) => {
    setSheetIndex(i);
    mapColumns(sheets[i]?.headers ?? []);
  };

  const readFile = async (file: File) => {
    setError(null);
    setPreview(null);
    setFileName(file.name);
    setBusy(true);
    try {
      // Excel or CSV, read by the server's one parser - the same one the donor
      // sheets go through, so a workbook that imports there imports here.
      const parsed = await readSpreadsheet(file);
      setSheets(parsed);
      setSheetIndex(0);
      mapColumns(parsed[0].headers);
    } catch (e) {
      setSheets([]);
      setError(e instanceof Error ? e.message : "That file could not be read.");
    } finally {
      setBusy(false);
    }
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
        // The row number in the file itself, not the position in this list, so
        // "row 47 had no phone" sends someone to row 47 of their own sheet.
        rowNumber: sheet?.rowNumbers[i] ?? i + 2,
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
    <Modal
      title="Upload courier file"
      onClose={onClose}
      wide
      // The action for the step you are on, in the one place the eye goes back
      // to. The dialog is long enough on a preview with twenty ambiguous rows
      // that a button at the bottom of the body scrolls out of reach.
      footer={
        <>
          {preview && unresolved > 0 && (
            <span className="mr-auto text-xs text-ink-muted">
              {number(unresolved)} still unchosen and will be skipped
            </span>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {preview ? (
            <Button loading={busy} onClick={commit}>
              {`Apply ${number(preview.summary.matched + Object.keys(choices).length)} deliveries`}
            </Button>
          ) : (
            headers.length > 0 && (
              <Button loading={busy} onClick={runPreview}>
                Check the file
              </Button>
            )
          )}
        </>
      }
    >
      <p className="mb-4 text-xs text-ink-muted">
        Nothing is changed until you press Apply. Rows matching more than one open delivery wait for
        you to choose.
      </p>

      {error && <Alert tone="danger">{error}</Alert>}

      {/* A real drop target rather than the browser's default "Choose File"
          control, which is tiny, unlabelled and gives no hint about what
          kind of file is wanted. Clicking anywhere in the box opens the
          picker, and a file can also be dragged straight in from the
          courier's email. */}
      <input
        ref={fileRef}
        type="file"
        accept={SPREADSHEET_ACCEPT}
        onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
        className="sr-only"
      />

      {!preview && (
        <div className="mb-5">
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) readFile(f);
            }}
            className={
              "cursor-pointer rounded-card border-2 border-dashed px-6 py-8 text-center transition-colors " +
              (dragging
                ? "border-brand-600 bg-brand-50"
                : fileName
                ? "border-brand-300 bg-brand-50/50"
                : "border-line-strong hover:border-brand-400 hover:bg-sunken")
            }
          >
            <Icon name="upload" size={32} className="mx-auto text-brand-500" />

            {fileName ? (
              <>
                <p className="mt-3 text-sm font-medium text-ink">{fileName}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {number(rows.length)} rows read · click to choose a different file
                </p>
              </>
            ) : (
              <>
                <p className="mt-3 text-sm font-medium text-ink">Drop the courier&apos;s file here</p>
                <p className="mt-1 text-xs text-ink-muted">
                  or click to choose one — Excel or CSV, and only a phone column is required
                </p>
              </>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <SampleButtons onError={setError} />
            </div>
            <span className="max-w-md text-xs text-ink-muted">
              Not sure of the format? The sample shows the columns. The file from “Download” also
              works as-is — it already has Phone and Tracking number columns.
            </span>
          </div>
        </div>
      )}

      {headers.length > 0 && !preview && (
        <>
          {/* Only when there is a choice to make. A CSV, and the great
              majority of workbooks, have one sheet and should not be asked
              about it. */}
          {sheets.length > 1 && (
            <Field
              label={`This workbook has ${sheets.length} sheets — which one is the courier's?`}
              className="mb-3"
            >
              <Select
                value={String(sheetIndex)}
                onChange={(v) => pickSheet(Number(v))}
                ariaLabel="Sheet"
              >
                {sheets.map((s, i) => (
                  <option key={i} value={i}>
                    {s.name} ({number(s.rows.length)} rows)
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <p className="mb-2 text-xs text-ink-muted">
            {number(rows.length)} rows read. Check the columns were picked up correctly:
          </p>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ["phone", "Phone (required)"],
                ["name", "Name"],
                ["tracking", "Tracking no"],
                ["delivered", "Delivered date"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                {/* Select is a string-valued control and the column index is
                    a number, so it is stringified here and parsed back on
                    change - simpler than teaching the component about types
                    only this one dropdown uses. */}
                <Select
                  value={String(cols[key])}
                  onChange={(v) => setCols({ ...cols, [key]: Number(v) })}
                  ariaLabel={label}
                >
                  <option value={-1}>— none —</option>
                  {headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
        </>
      )}

      {preview && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Rows", preview.summary.rows],
              ["Ready", preview.summary.matched],
              ["Need a choice", preview.summary.ambiguous],
              ["No match", preview.summary.unmatched],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-card border border-line-soft p-3">
                <p className="text-2xs uppercase tracking-wide text-ink-muted">{label}</p>
                <p className="text-xl font-semibold tabular-nums text-ink">
                  {number(value as number)}
                </p>
              </div>
            ))}
          </div>

          {preview.ambiguous.length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-ink-soft">
                These donors have more than one open delivery. Pick which donation arrived:
              </p>
              <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
                {preview.ambiguous.map((a) => (
                  <div key={a.row.rowNumber} className="rounded-card border border-line-soft p-3">
                    <p className="mb-2 text-xs text-ink-muted">
                      Row {a.row.rowNumber} · {a.row.name || "—"} · {a.row.phone}
                    </p>
                    <div className="space-y-1">
                      {a.candidates.map((c) => (
                        <label
                          key={c.id}
                          className="flex cursor-pointer items-center gap-2 text-xs text-ink-soft"
                        >
                          <input
                            type="radio"
                            name={`row-${a.row.rowNumber}`}
                            checked={choices[a.row.rowNumber] === c.id}
                            onChange={() => setChoices({ ...choices, [a.row.rowNumber]: c.id })}
                            className="accent-brand-600"
                          />
                          <span className="tabular-nums">
                            {currency(Number(c.donation_amount ?? 0))}
                          </span>
                          <span>{c.donation_purpose ?? "no seva recorded"}</span>
                          <span className="text-ink-faint">
                            {c.donation_date ? shortDate(c.donation_date) : ""} · {c.status}
                          </span>
                        </label>
                      ))}
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-faint">
                        <input
                          type="radio"
                          name={`row-${a.row.rowNumber}`}
                          checked={!choices[a.row.rowNumber]}
                          onChange={() => {
                            const next = { ...choices };
                            delete next[a.row.rowNumber];
                            setChoices(next);
                          }}
                          className="accent-brand-600"
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
              <summary className="cursor-pointer text-xs text-ink-muted">
                {number(preview.unmatched.length)} rows matched nothing — see why
              </summary>
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {preview.unmatched.map((u) => (
                  <li key={u.row.rowNumber} className="text-2xs text-ink-muted">
                    Row {u.row.rowNumber} ({u.row.phone || "no phone"}): {u.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <Field label="Courier name" hint="Optional — recorded against every row this file marks" className="w-60">
            <Input value={courier} onChange={(e) => setCourier(e.target.value)} />
          </Field>
        </>
      )}
    </Modal>
  );
}
