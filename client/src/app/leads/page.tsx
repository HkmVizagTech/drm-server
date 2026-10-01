"use client";

// Leads - the whole calling list, with everything that acts on many at once.
//
// The calling screen (/calling/queue) is where a caller spends the day; this is
// where whoever runs the campaign works: building lists, assigning them,
// tagging them, and seeing what the callers have found.
//
// Two ways in, because lists arrive two ways at a temple:
//   Pull from donors  - filters over people/donations DRM already holds, which
//                       is how "ring everyone who gave last Janmashtami and
//                       hasn't given since" becomes a calling list without a
//                       spreadsheet ever existing.
//   Upload a file     - the event register, the Gita stall sheet, the list
//                       someone's uncle sent on WhatsApp.
//
// Both preview before they write. A list is exactly the kind of thing where a
// third of the rows turn out to be landlines and duplicates, and finding that
// out from a summary is very different from finding it out afterwards.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, number, relativeDate } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  LinkButton,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  SegmentedControl,
  Select,
  SkeletonRows,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
  Toolbar,
} from "@/components/ui";
import { ExportButton } from "@/components/export-button";
import { readSpreadsheet, SPREADSHEET_ACCEPT, type ParsedSheet } from "@/lib/spreadsheet";

/* -------------------------------------------------------------------- types */

interface Lead {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  city: string | null;
  person_id: string | null;
  status: string;
  status_label: string | null;
  source: string;
  source_detail: string | null;
  tags: string[];
  remarks: string | null;
  next_follow_up_at: string | null;
  last_contacted_at: string | null;
  last_outcome: string | null;
  call_attempts: number;
  expected_amount: string | null;
  converted_amount: string | null;
  do_not_call: boolean;
  assigned_to_name: string | null;
  total_donated: string | null;
  donation_count: number | null;
  preacher_code: string | null;
  preacher_name: string | null;
  external_total_donated: string | null;
}

interface Preacher { id: string; code: string; name: string | null; leads?: number }

interface Config {
  statuses: { slug: string; label: string; tone: string; is_open: boolean }[];
  dispositions: { slug: string; label: string }[];
  users: { id: string; name: string }[];
  settings: Record<string, unknown>;
}

const SOURCES = [
  { key: "donor", label: "Existing donors" },
  { key: "csv", label: "Uploaded list" },
  { key: "website", label: "Website enquiry" },
  { key: "walk_in", label: "Walk-in" },
  { key: "referral", label: "Referral" },
  { key: "event", label: "Event" },
  { key: "manual", label: "Added by hand" },
];

const DUE_FILTERS = [
  { key: "", label: "Any" },
  { key: "overdue", label: "Overdue" },
  { key: "today_only", label: "Due today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "none", label: "Nothing scheduled" },
];

const SORTS = [
  { value: "due", label: "What's due" },
  { value: "untouched", label: "Never called" },
  { value: "value", label: "Biggest first" },
  { value: "newest", label: "Newest" },
] as const;

type SortKey = (typeof SORTS)[number]["value"];

/* --------------------------------------------------------------- the page */

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [assigned, setAssigned] = useState("");
  const [due, setDue] = useState("");
  const [preacher, setPreacher] = useState("");
  const [preachers, setPreachers] = useState<Preacher[]>([]);
  const [sort, setSort] = useState<SortKey>("due");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showUpload, setShowUpload] = useState(false);
  const [showPull, setShowPull] = useState(false);
  const [showAbandoned, setShowAbandoned] = useState(false);
  const [busy, setBusy] = useState(false);

  const limit = 50;

  // Returns the URLSearchParams themselves rather than a string, because the
  // download is handed this same value: ExportButton has to be able to drop
  // page and limit from it, and it cannot do that to a string. The list fetch
  // interpolates it, which calls toString() for free.
  const query = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), limit: String(limit), sort });
    if (search.trim()) p.set("search", search.trim());
    if (status) p.set("status", status);
    if (source) p.set("source", source);
    if (assigned) p.set("assigned_to", assigned);
    if (due) p.set("due", due);
    if (preacher) p.set("preacher", preacher);
    return p;
  }, [page, sort, search, status, source, assigned, due, preacher]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiClient.get<{ leads: Lead[]; total: number }>(`/api/crm/leads?${query()}`);
      setLeads(d.leads);
      setTotal(d.total);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load leads");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    apiClient.get<Config>("/api/crm/config").then(setConfig).catch(() => undefined);
    apiClient
      .get<{ preachers: Preacher[] }>("/api/crm/preachers")
      .then((d) => setPreachers(d.preachers))
      .catch(() => undefined);
  }, []);

  // Debounce the search so typing a name doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setPage(1), 300);
    return () => clearTimeout(t);
  }, [search]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const allOnPage = leads.length > 0 && leads.every((l) => selected.has(l.id));
  const someOnPage = leads.some((l) => selected.has(l.id));

  const filters = [search.trim(), status, source, assigned, due, preacher].filter(Boolean);
  const clearFilters = () => {
    setSearch("");
    setStatus("");
    setSource("");
    setAssigned("");
    setDue("");
    setPreacher("");
    setPage(1);
  };

  async function bulk(action: string, extra: Record<string, unknown> = {}) {
    if (!selected.size) return;
    setBusy(true);
    try {
      await apiClient.post("/api/crm/leads/bulk", { ids: [...selected], action, ...extra });
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply that");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="Leads"
        subtitle={`${number(total)} ${total === 1 ? "person" : "people"} in the calling list`}
        actions={
          <>
            {/* Both formats, from one control. An office that works in Excel
                opens a .csv into the text-import wizard and concludes the
                sample was no help. */}
            <ExportButton
              path="/api/crm/leads/sample"
              filename="lead-upload-sample"
              label="Sample file"
              hint="The columns a calling list can have"
            />
            <ExportButton
              path="/api/crm/leads/export"
              params={query()}
              filename="leads"
              hint={`${number(total)} lead${total === 1 ? "" : "s"} match these filters`}
            />
            <Button variant="secondary" icon="rupee" onClick={() => setShowAbandoned(true)}>
              Unfinished donations
            </Button>
            <Button variant="secondary" icon="users" onClick={() => setShowPull(true)}>
              Pull from donors
            </Button>
            {/* Two ways in, for two genuinely different files.
                  Quick list   - the thirty numbers someone sent on WhatsApp.
                                 One step: named, tagged, assigned, callable.
                  Office sheet - the donor workbook. Parked tab by tab, previewed
                                 against what DRM already holds, and kept for
                                 good, because a fresher export always follows. */}
            <Button variant="secondary" icon="upload" onClick={() => setShowUpload(true)}>
              Quick list
            </Button>
            <LinkButton href="/calling/uploads" variant="primary" icon="sheet">
              Upload an office sheet
            </LinkButton>
          </>
        }
      />

      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      {/* ----------------------------------------------------------- filters */}
      <Toolbar onClear={clearFilters} activeCount={filters.length}>
        <Field label="Search" htmlFor="leads-search" className="min-w-[16rem] flex-[2]">
          <SearchInput
            id="leads-search"
            value={search}
            onChange={setSearch}
            placeholder="Name, phone, email…"
          />
        </Field>
        <Field label="Stage" className="min-w-[9rem] flex-1">
          <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} ariaLabel="Stage">
            <option value="">Any stage</option>
            {config?.statuses.map((s) => (
              <option key={s.slug} value={s.slug}>{s.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Source" className="min-w-[9rem] flex-1">
          <Select value={source} onChange={(v) => { setSource(v); setPage(1); }} ariaLabel="Source">
            <option value="">Any source</option>
            {SOURCES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Assigned to" className="min-w-[9rem] flex-1">
          <Select value={assigned} onChange={(v) => { setAssigned(v); setPage(1); }} ariaLabel="Assigned to">
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {config?.users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Follow-up" className="min-w-[9rem] flex-1">
          <Select value={due} onChange={(v) => { setDue(v); setPage(1); }} ariaLabel="Follow-up">
            {DUE_FILTERS.map((d) => (
              <option key={d.key} value={d.key}>{d.label || "Any follow-up"}</option>
            ))}
          </Select>
        </Field>
        {/* "Ring everyone Jagat Tarini Mataji brought in" is one of the
            commonest ways the office builds a list, so the preacher is a
            filter rather than something to search for. */}
        <Field label="Preacher" className="min-w-[10rem] flex-1">
          <Select
            value={preacher}
            onChange={(v) => { setPreacher(v); setPage(1); }}
            ariaLabel="Preacher"
            placeholder="Any preacher"
            options={[
              { value: "", label: "Any preacher" },
              { value: "none", label: "No preacher" },
              ...preachers.map((p) => ({
                value: p.code,
                label: p.name ? `${p.name} (${p.code})` : p.code,
                hint: p.leads ? `${p.leads} leads` : undefined,
              })),
            ]}
          />
        </Field>
        <Field label="Sort by" className="flex-none">
          <SegmentedControl
            size="sm"
            options={SORTS.map((s) => ({ value: s.value, label: s.label }))}
            value={sort}
            onChange={setSort}
          />
        </Field>
      </Toolbar>

      {/* ------------------------------------------------------- bulk actions */}
      {selected.size > 0 && (
        <Card tone="brand" padded={false} className="mb-4 flex flex-wrap items-center gap-3 p-3">
          <span className="text-sm font-medium text-ink">{selected.size} selected</span>
          <Select
            disabled={busy}
            onChange={(v) => v && void bulk("assign", { assigned_to: v })}
            value=""
            ariaLabel="Assign the selected leads to"
            className="min-w-[9rem]"
          >
            <option value="">Assign to…</option>
            {config?.users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Select>
          <Select
            disabled={busy}
            onChange={(v) => v && void bulk("status", { status: v })}
            value=""
            ariaLabel="Move the selected leads to stage"
            className="min-w-[9rem]"
          >
            <option value="">Move to stage…</option>
            {config?.statuses.map((s) => (
              <option key={s.slug} value={s.slug}>{s.label}</option>
            ))}
          </Select>
          <Button
            variant="secondary"
            icon="tag"
            disabled={busy}
            onClick={() => {
              const tag = prompt("Tag to add to the selected leads");
              if (tag?.trim()) void bulk("tag", { tags: [tag.trim()] });
            }}
          >
            Add tag
          </Button>
          {/* The one destructive thing on the screen, and the only soft-danger
              button: marking do-not-call cannot be undone from here, so it must
              not look like the two dropdowns beside it. */}
          <Button
            variant="dangerSoft"
            icon="xCircle"
            disabled={busy}
            onClick={() => {
              if (confirm(`Mark ${selected.size} lead(s) as do-not-call? They will never appear in a calling queue again.`))
                void bulk("do_not_call");
            }}
          >
            Do not call
          </Button>
          <Button variant="ghost" size="sm" icon="x" onClick={() => setSelected(new Set())} className="ml-auto">
            Clear
          </Button>
        </Card>
      )}

      {/* -------------------------------------------------------------- table */}
      <TableShell>
        <Thead>
          <Th className="w-10">
            <Checkbox
              checked={allOnPage}
              indeterminate={someOnPage}
              onChange={() =>
                setSelected((s) => {
                  const next = new Set(s);
                  allOnPage ? leads.forEach((l) => next.delete(l.id)) : leads.forEach((l) => next.add(l.id));
                  return next;
                })
              }
              label={<span className="sr-only">Select every lead on this page</span>}
            />
          </Th>
          <Th>Who</Th>
          <Th>Stage</Th>
          <Th>Preacher</Th>
          <Th>Assigned</Th>
          <Th align="right">Attempts</Th>
          <Th>Due</Th>
          <Th align="right">Given before</Th>
        </Thead>

        {loading ? (
          <SkeletonRows rows={8} cols={8} />
        ) : !leads.length ? (
          <tbody>
            <tr>
              <td colSpan={8}>
                <EmptyState
                  title="No leads match"
                  message="Try clearing a filter, or build a list from your existing donors."
                  action={
                    <Button icon="users" onClick={() => setShowPull(true)}>
                      Pull from donors
                    </Button>
                  }
                />
              </td>
            </tr>
          </tbody>
        ) : (
          <Tbody>
            {leads.map((l) => {
              const overdue = l.next_follow_up_at && new Date(l.next_follow_up_at) < new Date();
              const picked = selected.has(l.id);
              return (
                // The whole row is tinted while it is selected, not just its
                // checkbox. Assigning fifty leads to the wrong caller is other
                // people's work changed, so what is in the selection has to be
                // readable from across the table rather than one box at a time.
                <tr key={l.id} className={picked ? "bg-brand-50" : ""}>
                  <Td>
                    <Checkbox
                      checked={picked}
                      onChange={() => toggle(l.id)}
                      label={<span className="sr-only">Select {l.name || l.phone}</span>}
                    />
                  </Td>
                  <Td>
                    <Link href={`/leads/${l.id}`} className="font-medium text-ink hover:text-brand-700">
                      {l.name || "Name not known"}
                    </Link>
                    <div className="text-xs tabular-nums text-ink-muted">
                      {l.phone}
                      {l.city && <> · {l.city}</>}
                      {l.do_not_call && <span className="ml-1 font-medium text-danger">· do not call</span>}
                    </div>
                    {l.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {l.tags.slice(0, 3).map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                        {l.tags.length > 3 && <span className="text-xs text-ink-faint">+{l.tags.length - 3}</span>}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={l.converted_amount ? "good" : "neutral"}>{l.status_label ?? l.status}</Badge>
                    {l.last_outcome && <div className="mt-0.5 text-xs text-ink-faint">{l.last_outcome.replace(/_/g, " ")}</div>}
                  </Td>
                  <Td className="text-sm">
                    {l.preacher_code ? (
                      <span title={l.preacher_name ?? undefined}>{l.preacher_name || l.preacher_code}</span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </Td>
                  <Td className="text-sm">{l.assigned_to_name ?? <span className="text-ink-faint">—</span>}</Td>
                  <Td align="right" className="text-sm tabular-nums">
                    {l.call_attempts || <span className="text-ink-faint">0</span>}
                  </Td>
                  <Td className="text-sm">
                    {l.next_follow_up_at ? (
                      <span className={overdue ? "font-medium text-warn" : ""}>
                        {relativeDate(l.next_follow_up_at)}
                      </span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </Td>
                  <Td align="right" className="text-sm tabular-nums">
                    {l.donation_count ? (
                      <>
                        <span className="font-semibold text-ink">{currency(Number(l.total_donated ?? 0))}</span>
                        <div className="text-xs text-ink-faint">{l.donation_count} donation{l.donation_count === 1 ? "" : "s"}</div>
                      </>
                    ) : l.external_total_donated ? (
                      <>
                        <span className="text-ink-soft">{currency(Number(l.external_total_donated))}</span>
                        <div className="text-xs text-ink-faint">in temple accounts</div>
                      </>
                    ) : (
                      <span className="text-ink-faint">never given</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Tbody>
        )}
      </TableShell>

      <Pagination
        page={page}
        limit={limit}
        total={total}
        totalPages={Math.max(1, Math.ceil(total / limit))}
        onPage={setPage}
        unit="leads"
      />

      {showUpload && <UploadDialog onClose={() => setShowUpload(false)} onDone={() => { setShowUpload(false); void load(); }} config={config} />}
      {showPull && <PullDialog onClose={() => setShowPull(false)} onDone={() => { setShowPull(false); void load(); }} config={config} />}
      {showAbandoned && (
        <AbandonedDialog
          onClose={() => setShowAbandoned(false)}
          onDone={() => { setShowAbandoned(false); void load(); }}
          config={config}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ upload dialog */

interface Preview {
  total: number;
  columns_found: string[];
  columns_ignored: string[];
  counts: {
    new: number;
    duplicate: number;
    repeated_in_file: number;
    invalid: number;
    blank: number;
    already_donors: number;
    do_not_call: number;
  };
  samples: { new: Record<string, unknown>[]; duplicate: Record<string, unknown>[]; invalid: Record<string, unknown>[] };
  rows: Record<string, unknown>[];
}

function UploadDialog({
  onClose,
  onDone,
  config,
}: {
  onClose: () => void;
  onDone: () => void;
  config: Config | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [listName, setListName] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ added: number; updated: number; skipped: number } | null>(null);
  // Only set when a workbook turns out to have several tabs, which is the only
  // time there is anything to ask.
  const [sheets, setSheets] = useState<ParsedSheet[] | null>(null);

  // Sent as a grid rather than as CSV text: the file has already been read once
  // on the way in, and writing it back out as CSV so the server can read it a
  // second time is a quoting bug waiting to happen.
  async function previewSheet(sheet: ParsedSheet) {
    setPreview(
      await apiClient.post<Preview>("/api/crm/leads/import/preview", {
        rows: [sheet.headers, ...sheet.rows],
      })
    );
  }

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    setFileName(file.name);
    setSheets(null);
    if (!listName) setListName(file.name.replace(/\.(csv|xlsx|xlsm)$/i, ""));
    try {
      const parsed = await readSpreadsheet(file);
      // One sheet is the whole story — go straight to the preview. Several, and
      // the person is asked, because importing the wrong tab is the sort of
      // mistake that is only noticed once callers start ringing strangers.
      if (parsed.length > 1) setSheets(parsed);
      else await previewSheet(parsed[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function chooseSheet(sheet: ParsedSheet) {
    setBusy(true);
    setError(null);
    try {
      await previewSheet(sheet);
      setSheets(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that sheet");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await apiClient.post("/api/crm/leads/import/commit", {
          rows: preview.rows,
          list_name: listName || fileName || "Uploaded list",
          assigned_to: assignTo || undefined,
          tags: tag.trim() ? [tag.trim()] : undefined,
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import that list");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Upload a calling list"
      onClose={onClose}
      wide
      footer={
        result ? (
          <Button onClick={onDone}>See the list</Button>
        ) : preview ? (
          <>
            <Button variant="secondary" onClick={() => { setPreview(null); setFileName(null); }}>
              Choose a different file
            </Button>
            <Button onClick={() => void commit()} loading={busy} disabled={!preview.counts.new}>
              {busy ? "Importing…" : `Import ${number(preview.counts.new)} lead${preview.counts.new === 1 ? "" : "s"}`}
            </Button>
          </>
        ) : undefined
      }
    >
      {result ? (
        <div className="py-6 text-center">
          <p className="text-2xl font-semibold text-ink">{number(result.added)} added</p>
          <p className="mt-1 text-sm text-ink-muted">
            {number(result.updated)} already existed and were topped up · {number(result.skipped)} skipped
          </p>
        </div>
      ) : sheets ? (
        <>
          <p className="text-sm text-ink-soft">
            <strong>{fileName}</strong> has {sheets.length} sheets. Which one holds the list to call?
          </p>
          <div className="mt-3 space-y-2">
            {sheets.map((s, i) => (
              <button
                key={i}
                disabled={busy}
                onClick={() => void chooseSheet(s)}
                className="flex w-full items-center justify-between rounded-control border border-line-soft px-4 py-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50 disabled:opacity-50"
              >
                <span className="text-sm font-medium text-ink">{s.name}</span>
                <span className="text-xs text-ink-muted">
                  {number(s.rows.length)} rows · {s.headers.filter(Boolean).length} columns
                </span>
              </button>
            ))}
          </div>
          {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
        </>
      ) : !preview ? (
        <>
          <input
            ref={fileRef}
            type="file"
            accept={SPREADSHEET_ACCEPT}
            className="sr-only"
            onChange={(e) => e.target.files?.[0] && void handleFile(e.target.files[0])}
          />
          {/* The dashed border stays. It is the one place in the product where
              that shape is right - it says "this rectangle is waiting for
              something", which is exactly what a dropzone is - and nothing else
              draws one, so it cannot be mistaken for a card. */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void handleFile(f);
            }}
            className={`cursor-pointer rounded-card border-2 border-dashed px-6 py-10 text-center transition-colors ${
              dragging ? "border-brand-600 bg-brand-50" : "border-line-strong hover:border-brand-400 hover:bg-sunken"
            }`}
          >
            <p className="text-sm font-medium text-ink">
              {busy ? "Reading the file…" : "Drop an Excel file or CSV here, or click to choose one"}
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              Any column names work — Mobile, Mobile No., Contact Number are all understood
            </p>
          </div>
          {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
        </>
      ) : (
        <>
          <p className="text-sm text-ink-soft">
            Read <strong>{fileName}</strong> — {number(preview.total)} rows. Nothing has been saved yet.
          </p>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tally label="Will be added" value={preview.counts.new} tone="good" />
            <Tally label="Already leads" value={preview.counts.duplicate} />
            <Tally label="Bad numbers" value={preview.counts.invalid + preview.counts.blank} tone="warn" />
            <Tally label="New, but known to us" value={preview.counts.already_donors} tone="info" />
          </div>

          {preview.counts.already_donors > 0 && (
            <p className="mt-3 text-xs text-ink-muted">
              {number(preview.counts.already_donors)} of the new rows have given to the temple before — they will be
              linked to their giving history automatically, so callers see it before they dial.
            </p>
          )}
          {preview.counts.repeated_in_file > 0 && (
            <p className="mt-3 text-xs text-ink-muted">
              {number(preview.counts.repeated_in_file)} row{preview.counts.repeated_in_file === 1 ? " was" : "s were"} the
              same number twice in this file — counted once.
            </p>
          )}
          {preview.counts.do_not_call > 0 && (
            <p className="mt-2 text-xs text-danger">
              {number(preview.counts.do_not_call)} of these previously asked not to be called. They stay marked
              do-not-call and will not enter any queue.
            </p>
          )}
          {preview.columns_ignored.length > 0 && (
            <p className="mt-2 text-xs text-ink-faint">Ignored columns: {preview.columns_ignored.join(", ")}</p>
          )}

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Field label="Call this list" htmlFor="upload-list-name">
              <Input id="upload-list-name" value={listName} onChange={(e) => setListName(e.target.value)} />
            </Field>
            <Field label="Assign to">
              <Select value={assignTo} onChange={(v) => setAssignTo(v)} ariaLabel="Assign to">
                <option value="">Nobody yet</option>
                {config?.users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Tag them (optional)" htmlFor="upload-tag">
              <Input id="upload-tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. janmashtami-2026" />
            </Field>
          </div>

          {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
        </>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------- pull dialog */

function PullDialog({
  onClose,
  onDone,
  config,
}: {
  onClose: () => void;
  onDone: () => void;
  config: Config | null;
}) {
  const [notSince, setNotSince] = useState("");
  const [minTotal, setMinTotal] = useState("");
  const [site, setSite] = useState("");
  const [limit, setLimit] = useState("500");
  const [listName, setListName] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [tag, setTag] = useState("");
  const [preview, setPreview] = useState<{ matched: number; already_leads: number; would_add: number } | null>(null);
  const [result, setResult] = useState<{ added: number; already_leads: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const body = () => ({
    not_since: notSince || undefined,
    min_total: minTotal ? Number(minTotal) : undefined,
    site: site || undefined,
    limit: Number(limit) || 500,
    has_donated: true,
    list_name: listName || "Pulled from donors",
    assigned_to: assignTo || undefined,
    tags: tag.trim() ? [tag.trim()] : undefined,
  });

  async function run(dry: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<Record<string, number>>("/api/crm/leads/from-people", {
        ...body(),
        dry_run: dry,
      });
      if (dry) setPreview(r as unknown as { matched: number; already_leads: number; would_add: number });
      else setResult(r as unknown as { added: number; already_leads: number });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build that list");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Build a list from your donors"
      onClose={onClose}
      footer={
        result ? (
          <Button onClick={onDone}>See the list</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => void run(true)} loading={busy}>
              {busy ? "Checking…" : "Check how many"}
            </Button>
            <Button onClick={() => void run(false)} disabled={busy || !preview?.would_add}>
              Add {preview ? number(preview.would_add) : ""} to the list
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="py-6 text-center">
          <p className="text-2xl font-semibold text-ink">{number(result.added)} added</p>
          <p className="mt-1 text-sm text-ink-muted">{number(result.already_leads)} were already in the list</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-ink-soft">
            Pulls people DRM already knows into the calling list, with their giving history attached. Nothing is
            duplicated — anyone already a lead is left as they are.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Hasn't given since" htmlFor="pull-not-since">
              <Input
                id="pull-not-since"
                type="date"
                value={notSince}
                onChange={(e) => { setNotSince(e.target.value); setPreview(null); }}
              />
            </Field>
            <Field label="Has given at least (₹)" htmlFor="pull-min-total">
              <Input
                id="pull-min-total"
                type="number"
                value={minTotal}
                onChange={(e) => { setMinTotal(e.target.value); setPreview(null); }}
                placeholder="Any"
              />
            </Field>
            <Field label="From site">
              <Select value={site} onChange={(v) => { setSite(v); setPreview(null); }} ariaLabel="From site">
                <option value="">Either site</option>
                <option value="hkmv">Main site</option>
                <option value="annadan">Annadan site</option>
              </Select>
            </Field>
            <Field label="At most" htmlFor="pull-limit">
              <Input
                id="pull-limit"
                type="number"
                value={limit}
                onChange={(e) => { setLimit(e.target.value); setPreview(null); }}
              />
            </Field>
          </div>

          {preview && (
            <div className="mt-4 rounded-card bg-sunken px-4 py-3 text-sm">
              <p className="text-ink">
                <strong>{number(preview.matched)}</strong> donors match.{" "}
                <strong>{number(preview.would_add)}</strong> would be added
                {preview.already_leads > 0 && <> — {number(preview.already_leads)} are already in the list</>}.
              </p>
              {preview.would_add > 400 && (
                <p className="mt-1 text-xs text-warn">
                  That is a lot of calls. At 20 an hour it is about {Math.round(preview.would_add / 20)} hours of
                  phone time — consider narrowing it before committing.
                </p>
              )}
            </div>
          )}

          {preview && preview.would_add > 0 && (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Field label="Call this list" htmlFor="pull-list-name">
                <Input id="pull-list-name" value={listName} onChange={(e) => setListName(e.target.value)} placeholder="Lapsed donors" />
              </Field>
              <Field label="Assign to">
                <Select value={assignTo} onChange={(v) => setAssignTo(v)} ariaLabel="Assign to">
                  <option value="">Nobody yet</option>
                  {config?.users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Tag them" htmlFor="pull-tag">
                <Input id="pull-tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="optional" />
              </Field>
            </div>
          )}

          {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
        </>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------- abandoned dialog */

interface AbandonedPreview {
  found: number;
  gave_anyway: number;
  already_leads: number;
  would_add: number;
  value_at_stake: number;
  sample: { name: string | null; phone: string; amount: number | null; purpose: string | null; page: string | null; site: string }[];
  site_errors: { site: string; error: string }[];
}

// People who reached the payment screen on annadan or the main site and never
// finished. The strongest leads the temple has, and the ones nobody currently
// calls - so this is deliberately one button away rather than buried.
function AbandonedDialog({
  onClose,
  onDone,
  config,
}: {
  onClose: () => void;
  onDone: () => void;
  config: Config | null;
}) {
  const [days, setDays] = useState("30");
  const [assignTo, setAssignTo] = useState("");
  const [preview, setPreview] = useState<AbandonedPreview | null>(null);
  const [result, setResult] = useState<{ added: number; already_leads: number; gave_anyway: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(dry: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<Record<string, unknown>>("/api/crm/leads/sync-abandoned", {
        days: Number(days) || 30,
        assigned_to: assignTo || undefined,
        dry_run: dry,
      });
      if (dry) setPreview(r as unknown as AbandonedPreview);
      else setResult(r as unknown as { added: number; already_leads: number; gave_anyway: number });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the sites");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Donations nobody finished"
      onClose={onClose}
      footer={
        result ? (
          <Button onClick={onDone}>See the list</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => void run(true)} loading={busy}>
              {busy ? "Checking…" : "Check how many"}
            </Button>
            <Button onClick={() => void run(false)} disabled={busy || !preview?.would_add}>
              Add {preview ? number(preview.would_add) : ""} to the list
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="py-6 text-center">
          <p className="text-2xl font-semibold text-ink">{number(result.added)} added</p>
          <p className="mt-1 text-sm text-ink-muted">
            {number(result.already_leads)} were already leads · {number(result.gave_anyway)} had given anyway and were
            left alone
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-ink-soft">
            People who filled in the form on annadan or the main site, reached the payment screen and never came back.
            Most of the time that is a UPI app that failed, not a change of heart.
          </p>
          <p className="mt-2 text-xs text-ink-muted">
            Anyone who gave successfully afterwards — on either site — is left out, so nobody is rung about a donation
            they already made.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Going back how many days" htmlFor="abandoned-days">
              <Input
                id="abandoned-days"
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => { setDays(e.target.value); setPreview(null); }}
              />
            </Field>
            <Field label="Assign to">
              <Select value={assignTo} onChange={(v) => setAssignTo(v)} ariaLabel="Assign to">
                <option value="">Nobody yet</option>
                {config?.users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </Select>
            </Field>
          </div>

          {preview && (
            <div className="mt-4 rounded-card bg-sunken px-4 py-3">
              <p className="text-sm text-ink">
                <strong>{number(preview.found)}</strong> unfinished donations.{" "}
                <strong>{number(preview.would_add)}</strong> would become leads
                {preview.gave_anyway > 0 && <> — {number(preview.gave_anyway)} of these people gave anyway</>}
                {preview.already_leads > 0 && <>, {number(preview.already_leads)} are already in the list</>}.
              </p>
              {preview.value_at_stake > 0 && (
                <p className="mt-1 text-sm text-ink-soft">
                  <strong>{currency(preview.value_at_stake)}</strong> was on the payment screen and never arrived.
                </p>
              )}
              {preview.sample.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-ink-soft">
                  {preview.sample.slice(0, 5).map((s) => (
                    <li key={s.phone} className="flex justify-between gap-3">
                      <span className="truncate">
                        {s.name || s.phone} {s.page && <span className="text-ink-faint">· {s.page}</span>}
                      </span>
                      <span className="whitespace-nowrap tabular-nums">{s.amount ? currency(s.amount) : "—"}</span>
                    </li>
                  ))}
                </ul>
              )}
              {preview.site_errors.length > 0 && (
                <p className="mt-2 text-xs text-warn">
                  Could not reach: {preview.site_errors.map((e) => e.site).join(", ")} — the count above is only what
                  the other site returned.
                </p>
              )}
            </div>
          )}

          {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
        </>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------- small bits */

function Tally({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "good" | "warn" | "info" }) {
  const tones = {
    neutral: "text-ink",
    good: "text-good",
    warn: "text-warn",
    info: "text-info",
  };
  return (
    <div className="rounded-card border border-line-soft px-3 py-2">
      <p className="text-2xs uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tones[tone]}`}>{number(value)}</p>
    </div>
  );
}
