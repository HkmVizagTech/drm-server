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
import { Badge, buttonPrimary, buttonSecondary, Card, EmptyState, inputClass, PageHeader, Pagination, Select, SkeletonRows, TableShell, Td, Th } from "@/components/ui";

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

/* ---------------------------------------------------------- csv helpers */

// Same minimal reader as the server uses, so what the browser shows and what
// the server parses cannot disagree about a quoted comma.
function parseCsvPreviewCount(text: string): number {
  return text.split(/\r?\n/).filter((l) => l.trim()).length - 1;
}

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
  const [sort, setSort] = useState("due");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showUpload, setShowUpload] = useState(false);
  const [showPull, setShowPull] = useState(false);
  const [showAbandoned, setShowAbandoned] = useState(false);
  const [busy, setBusy] = useState(false);

  const limit = 50;

  const query = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), limit: String(limit), sort });
    if (search.trim()) p.set("search", search.trim());
    if (status) p.set("status", status);
    if (source) p.set("source", source);
    if (assigned) p.set("assigned_to", assigned);
    if (due) p.set("due", due);
    if (preacher) p.set("preacher", preacher);
    return p.toString();
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

  async function downloadCsv(path: string, filename: string) {
    try {
      const blob = await apiClient.getBlob(path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not download that file");
    }
  }

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle={`${number(total)} ${total === 1 ? "person" : "people"} in the calling list`}
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void downloadCsv("/api/crm/leads/sample.csv", "lead-upload-sample.csv")}
              className={buttonSecondary}
            >
              Sample upload file
            </button>
            <button onClick={() => void downloadCsv(`/api/crm/leads/export.csv?${query()}`, "leads.csv")} className={buttonSecondary}>
              Download list
            </button>
            <button onClick={() => setShowAbandoned(true)} className={buttonSecondary}>
              Unfinished donations
            </button>
            <button onClick={() => setShowPull(true)} className={buttonSecondary}>
              Pull from donors
            </button>
            <Link href="/calling/uploads" className={buttonPrimary}>
              Upload a sheet
            </Link>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {/* ----------------------------------------------------------- filters */}
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, phone, email…"
            className={`${inputClass} w-full lg:col-span-2`}
          />
          <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} className="w-full">
            <option value="">Any stage</option>
            {config?.statuses.map((s) => (
              <option key={s.slug} value={s.slug}>{s.label}</option>
            ))}
          </Select>
          <Select value={source} onChange={(v) => { setSource(v); setPage(1); }} className="w-full">
            <option value="">Any source</option>
            {SOURCES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </Select>
          <Select value={assigned} onChange={(v) => { setAssigned(v); setPage(1); }} className="w-full">
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {config?.users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Select>
          <Select value={due} onChange={(v) => { setDue(v); setPage(1); }} className="w-full">
            {DUE_FILTERS.map((d) => (
              <option key={d.key} value={d.key}>{d.label || "Any follow-up"}</option>
            ))}
          </Select>
          {/* "Ring everyone Jagat Tarini Mataji brought in" is one of the
              commonest ways the office builds a list, so the preacher is a
              filter rather than something to search for. */}
          <Select
            value={preacher}
            onChange={(v) => { setPreacher(v); setPage(1); }}
            className="w-full"
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
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
          <span>Sort by</span>
          {[
            ["due", "What's due"],
            ["untouched", "Never called"],
            ["value", "Biggest first"],
            ["newest", "Newest"],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSort(k)}
              className={`rounded px-2 py-1 font-medium ${sort === k ? "bg-[var(--accent-wash)] text-[var(--accent)]" : "hover:bg-slate-100"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      {/* ------------------------------------------------------- bulk actions */}
      {selected.size > 0 && (
        <div className="mb-4 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-wash)] px-4 py-3 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-slate-900">{selected.size} selected</span>
          <Select
            disabled={busy}
            onChange={(v) => v && void bulk("assign", { assigned_to: v })}
            value=""
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
            className="min-w-[9rem]"
          >
            <option value="">Move to stage…</option>
            {config?.statuses.map((s) => (
              <option key={s.slug} value={s.slug}>{s.label}</option>
            ))}
          </Select>
          <button
            disabled={busy}
            onClick={() => {
              const tag = prompt("Tag to add to the selected leads");
              if (tag?.trim()) void bulk("tag", { tags: [tag.trim()] });
            }}
            className={buttonSecondary}
          >
            Add tag
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (confirm(`Mark ${selected.size} lead(s) as do-not-call? They will never appear in a calling queue again.`))
                void bulk("do_not_call");
            }}
            className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Do not call
          </button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-sm text-slate-500 hover:text-slate-700">
            Clear
          </button>
        </div>
      )}

      {/* -------------------------------------------------------------- table */}
      <TableShell>
        <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
          <tr>
            <Th className="w-10">
              <input
                type="checkbox"
                checked={allOnPage}
                onChange={() =>
                  setSelected((s) => {
                    const next = new Set(s);
                    allOnPage ? leads.forEach((l) => next.delete(l.id)) : leads.forEach((l) => next.add(l.id));
                    return next;
                  })
                }
                className="rounded border-slate-300"
              />
            </Th>
            <Th>Who</Th>
            <Th>Stage</Th>
            <Th>Preacher</Th>
            <Th>Assigned</Th>
            <Th align="right">Attempts</Th>
            <Th>Due</Th>
            <Th align="right">Given before</Th>
          </tr>
        </thead>

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
                    <button onClick={() => setShowPull(true)} className={buttonPrimary}>
                      Pull from donors
                    </button>
                  }
                />
              </td>
            </tr>
          </tbody>
        ) : (
          <tbody className="divide-y divide-slate-100">
            {leads.map((l) => {
              const overdue = l.next_follow_up_at && new Date(l.next_follow_up_at) < new Date();
              return (
                <tr key={l.id} className="hover:bg-slate-50/60">
                  <Td>
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onChange={() => toggle(l.id)}
                      className="rounded border-slate-300"
                    />
                  </Td>
                  <Td>
                    <Link href={`/leads/${l.id}`} className="font-medium text-slate-900 hover:text-[var(--accent)]">
                      {l.name || "Name not known"}
                    </Link>
                    <div className="text-xs text-slate-500 tabular-nums">
                      {l.phone}
                      {l.city && <> · {l.city}</>}
                      {l.do_not_call && <span className="ml-1 text-red-600 font-medium">· do not call</span>}
                    </div>
                    {l.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {l.tags.slice(0, 3).map((t) => (
                          <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                            {t}
                          </span>
                        ))}
                        {l.tags.length > 3 && <span className="text-[10px] text-slate-400">+{l.tags.length - 3}</span>}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={l.converted_amount ? "good" : "neutral"}>{l.status_label ?? l.status}</Badge>
                    {l.last_outcome && <div className="mt-0.5 text-[11px] text-slate-400">{l.last_outcome.replace(/_/g, " ")}</div>}
                  </Td>
                  <Td className="text-sm text-slate-600">
                    {l.preacher_code ? (
                      <span title={l.preacher_name ?? undefined}>{l.preacher_name || l.preacher_code}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </Td>
                  <Td className="text-sm text-slate-600">{l.assigned_to_name ?? <span className="text-slate-400">—</span>}</Td>
                  <Td align="right" className="tabular-nums text-sm text-slate-600">
                    {l.call_attempts || <span className="text-slate-300">0</span>}
                  </Td>
                  <Td className="text-sm">
                    {l.next_follow_up_at ? (
                      <span className={overdue ? "text-amber-700 font-medium" : "text-slate-600"}>
                        {relativeDate(l.next_follow_up_at)}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </Td>
                  <Td align="right" className="tabular-nums text-sm">
                    {l.donation_count ? (
                      <>
                        <span className="text-slate-900">{currency(Number(l.total_donated ?? 0))}</span>
                        <div className="text-[11px] text-slate-400">{l.donation_count} donation{l.donation_count === 1 ? "" : "s"}</div>
                      </>
                    ) : l.external_total_donated ? (
                      <>
                        <span className="text-slate-700">{currency(Number(l.external_total_donated))}</span>
                        <div className="text-[11px] text-slate-400">in temple accounts</div>
                      </>
                    ) : (
                      <span className="text-slate-300">never given</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
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

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    setFileName(file.name);
    if (!listName) setListName(file.name.replace(/\.csv$/i, ""));
    try {
      const text = await file.text();
      if (parseCsvPreviewCount(text) < 1) throw new Error("That file has no rows under its header");
      setPreview(await apiClient.post<Preview>("/api/crm/leads/import/preview", { csv: text }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file");
      setPreview(null);
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
    <Modal title="Upload a calling list" onClose={onClose} wide>
      {result ? (
        <div className="text-center py-6">
          <p className="text-2xl font-semibold text-slate-900">{number(result.added)} added</p>
          <p className="mt-1 text-sm text-slate-500">
            {number(result.updated)} already existed and were topped up · {number(result.skipped)} skipped
          </p>
          <button onClick={onDone} className={`${buttonPrimary} mt-5`}>
            See the list
          </button>
        </div>
      ) : !preview ? (
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(e) => e.target.files?.[0] && void handleFile(e.target.files[0])}
          />
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
            className={`rounded-xl border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors ${
              dragging ? "border-[var(--accent)] bg-[var(--accent-wash)]" : "border-slate-300 hover:border-slate-400 hover:bg-slate-50"
            }`}
          >
            <p className="text-sm font-medium text-slate-900">
              {busy ? "Reading the file…" : "Drop a CSV here, or click to choose one"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Any column names work — Mobile, Mobile No., Contact Number are all understood
            </p>
          </div>
          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        </>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            Read <strong>{fileName}</strong> — {number(preview.total)} rows. Nothing has been saved yet.
          </p>

          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Tally label="Will be added" value={preview.counts.new} tone="good" />
            <Tally label="Already leads" value={preview.counts.duplicate} />
            <Tally label="Bad numbers" value={preview.counts.invalid + preview.counts.blank} tone="warn" />
            <Tally label="New, but known to us" value={preview.counts.already_donors} tone="info" />
          </div>

          {preview.counts.already_donors > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              {number(preview.counts.already_donors)} of the new rows have given to the temple before — they will be
              linked to their giving history automatically, so callers see it before they dial.
            </p>
          )}
          {preview.counts.repeated_in_file > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              {number(preview.counts.repeated_in_file)} row{preview.counts.repeated_in_file === 1 ? " was" : "s were"} the
              same number twice in this file — counted once.
            </p>
          )}
          {preview.counts.do_not_call > 0 && (
            <p className="mt-2 text-xs text-red-700">
              {number(preview.counts.do_not_call)} of these previously asked not to be called. They stay marked
              do-not-call and will not enter any queue.
            </p>
          )}
          {preview.columns_ignored.length > 0 && (
            <p className="mt-2 text-xs text-slate-400">Ignored columns: {preview.columns_ignored.join(", ")}</p>
          )}

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">Call this list</span>
              <input value={listName} onChange={(e) => setListName(e.target.value)} className={`${inputClass} w-full`} />
            </label>
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">Assign to</span>
              <Select value={assignTo} onChange={(v) => setAssignTo(v)} className="w-full">
                <option value="">Nobody yet</option>
                {config?.users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">Tag them (optional)</span>
              <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. janmashtami-2026" className={`${inputClass} w-full`} />
            </label>
          </div>

          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => { setPreview(null); setFileName(null); }} className={buttonSecondary}>
              Choose a different file
            </button>
            <button onClick={() => void commit()} disabled={busy || !preview.counts.new} className={buttonPrimary}>
              {busy ? "Importing…" : `Import ${number(preview.counts.new)} lead${preview.counts.new === 1 ? "" : "s"}`}
            </button>
          </div>
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
    <Modal title="Build a list from your donors" onClose={onClose}>
      {result ? (
        <div className="text-center py-6">
          <p className="text-2xl font-semibold text-slate-900">{number(result.added)} added</p>
          <p className="mt-1 text-sm text-slate-500">{number(result.already_leads)} were already in the list</p>
          <button onClick={onDone} className={`${buttonPrimary} mt-5`}>
            See the list
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            Pulls people DRM already knows into the calling list, with their giving history attached. Nothing is
            duplicated — anyone already a lead is left as they are.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">Hasn&apos;t given since</span>
              <input type="date" value={notSince} onChange={(e) => { setNotSince(e.target.value); setPreview(null); }} className={`${inputClass} w-full`} />
            </label>
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">Has given at least (₹)</span>
              <input type="number" value={minTotal} onChange={(e) => { setMinTotal(e.target.value); setPreview(null); }} placeholder="Any" className={`${inputClass} w-full`} />
            </label>
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">From site</span>
              <Select value={site} onChange={(v) => { setSite(v); setPreview(null); }} className="w-full">
                <option value="">Either site</option>
                <option value="hkmv">Main site</option>
                <option value="annadan">Annadan site</option>
              </Select>
            </label>
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">At most</span>
              <input type="number" value={limit} onChange={(e) => { setLimit(e.target.value); setPreview(null); }} className={`${inputClass} w-full`} />
            </label>
          </div>

          {preview && (
            <div className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm">
              <p className="text-slate-900">
                <strong>{number(preview.matched)}</strong> donors match.{" "}
                <strong>{number(preview.would_add)}</strong> would be added
                {preview.already_leads > 0 && <> — {number(preview.already_leads)} are already in the list</>}.
              </p>
              {preview.would_add > 400 && (
                <p className="mt-1 text-xs text-amber-700">
                  That is a lot of calls. At 20 an hour it is about {Math.round(preview.would_add / 20)} hours of
                  phone time — consider narrowing it before committing.
                </p>
              )}
            </div>
          )}

          {preview && preview.would_add > 0 && (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="block text-xs text-slate-500 mb-1">Call this list</span>
                <input value={listName} onChange={(e) => setListName(e.target.value)} placeholder="Lapsed donors" className={`${inputClass} w-full`} />
              </label>
              <label className="block">
                <span className="block text-xs text-slate-500 mb-1">Assign to</span>
                <Select value={assignTo} onChange={(v) => setAssignTo(v)} className="w-full">
                  <option value="">Nobody yet</option>
                  {config?.users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </Select>
              </label>
              <label className="block">
                <span className="block text-xs text-slate-500 mb-1">Tag them</span>
                <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="optional" className={`${inputClass} w-full`} />
              </label>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => void run(true)} disabled={busy} className={buttonSecondary}>
              {busy ? "Checking…" : "Check how many"}
            </button>
            <button onClick={() => void run(false)} disabled={busy || !preview?.would_add} className={buttonPrimary}>
              Add {preview ? number(preview.would_add) : ""} to the list
            </button>
          </div>
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
    <Modal title="Donations nobody finished" onClose={onClose}>
      {result ? (
        <div className="text-center py-6">
          <p className="text-2xl font-semibold text-slate-900">{number(result.added)} added</p>
          <p className="mt-1 text-sm text-slate-500">
            {number(result.already_leads)} were already leads · {number(result.gave_anyway)} had given anyway and were
            left alone
          </p>
          <button onClick={onDone} className={`${buttonPrimary} mt-5`}>
            See the list
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            People who filled in the form on annadan or the main site, reached the payment screen and never came back.
            Most of the time that is a UPI app that failed, not a change of heart.
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Anyone who gave successfully afterwards — on either site — is left out, so nobody is rung about a donation
            they already made.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">Going back how many days</span>
              <input
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => { setDays(e.target.value); setPreview(null); }}
                className={`${inputClass} w-full`}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">Assign to</span>
              <Select value={assignTo} onChange={(v) => setAssignTo(v)} className="w-full">
                <option value="">Nobody yet</option>
                {config?.users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </Select>
            </label>
          </div>

          {preview && (
            <div className="mt-4 rounded-lg bg-slate-50 px-4 py-3">
              <p className="text-sm text-slate-900">
                <strong>{number(preview.found)}</strong> unfinished donations.{" "}
                <strong>{number(preview.would_add)}</strong> would become leads
                {preview.gave_anyway > 0 && <> — {number(preview.gave_anyway)} of these people gave anyway</>}
                {preview.already_leads > 0 && <>, {number(preview.already_leads)} are already in the list</>}.
              </p>
              {preview.value_at_stake > 0 && (
                <p className="mt-1 text-sm text-slate-700">
                  <strong>{currency(preview.value_at_stake)}</strong> was on the payment screen and never arrived.
                </p>
              )}
              {preview.sample.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-slate-600">
                  {preview.sample.slice(0, 5).map((s) => (
                    <li key={s.phone} className="flex justify-between gap-3">
                      <span className="truncate">
                        {s.name || s.phone} {s.page && <span className="text-slate-400">· {s.page}</span>}
                      </span>
                      <span className="tabular-nums whitespace-nowrap">{s.amount ? currency(s.amount) : "—"}</span>
                    </li>
                  ))}
                </ul>
              )}
              {preview.site_errors.length > 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  Could not reach: {preview.site_errors.map((e) => e.site).join(", ")} — the count above is only what
                  the other site returned.
                </p>
              )}
            </div>
          )}

          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => void run(true)} disabled={busy} className={buttonSecondary}>
              {busy ? "Checking…" : "Check how many"}
            </button>
            <button onClick={() => void run(false)} disabled={busy || !preview?.would_add} className={buttonPrimary}>
              Add {preview ? number(preview.would_add) : ""} to the list
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------- small bits */

function Tally({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "good" | "warn" | "info" }) {
  const tones = {
    neutral: "text-slate-900",
    good: "text-emerald-700",
    warn: "text-amber-700",
    info: "text-sky-700",
  };
  return (
    <div className="rounded-lg border border-[var(--line-soft)] px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tones[tone]}`}>{number(value)}</p>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 overflow-y-auto">
      <div className={`mt-12 w-full ${wide ? "max-w-3xl" : "max-w-2xl"} rounded-xl bg-white shadow-xl`}>
        <div className="flex items-center justify-between border-b border-[var(--line-soft)] px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
