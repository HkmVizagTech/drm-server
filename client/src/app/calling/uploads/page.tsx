"use client";

// Uploading the office's spreadsheets, and the record of every one ever sent.
//
// HOW THE TEMPLE ACTUALLY WORKS
// Donor data lives in Excel: "Last 4 year General Donation Data" with an HKMI
// tab and a TSC tab, a festival register, a stall list. A workbook goes up, the
// team calls through it, and weeks later a fresher export of the same data
// arrives. That second upload is where a careless importer destroys everything,
// because replacing the rows takes every call, note, reminder and outcome with
// them.
//
// So an upload never replaces. It adds who is new, fills gaps on who is already
// here, and leaves everything a caller recorded alone. And because every sheet
// is stored row by row, "what did the March sheet say about this donor" stays
// answerable long after the file has been lost off somebody's laptop.
//
// TWO STEPS, ON PURPOSE
// Uploading only reads and parks the workbook - not one lead changes. The
// office sees what it would do per tab, and applies the tabs it wants. Getting
// that decision right matters: on the real workbook the difference between
// reading the donor code and reading the phone number is 6,286 leads or 5,452,
// and finding that out afterwards is too late.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, number, relativeDate, shortDate } from "@/lib/format";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  Select,
  TableShell,
  Td,
  Th,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/ui";
import { SPREADSHEET_ACCEPT, toBase64 } from "@/lib/spreadsheet";

interface Counts {
  new: number;
  updated: number;
  duplicate_in_file: number;
  invalid_phone: number;
  no_phone: number;
  already_donors: number;
}

interface Batch {
  id: string;
  filename: string;
  sheet_name: string | null;
  label: string | null;
  status: string;
  rows_total: number;
  leads_added: number;
  leads_updated: number;
  rows_skipped: number;
  matched_existing_donors: number;
  created_at: string;
  applied_at: string | null;
  uploaded_by_name: string | null;
  stored_rows?: number;
  detail?: { counts?: Counts; headers?: string[]; mapping?: Record<string, number>; external_total?: number };
  // present only on a fresh upload
  counts?: Counts;
  headers?: string[];
  mapping?: Record<string, number>;
  preacher_codes?: string[];
  external_total?: number;
  unreachable_amount?: number;
  shared_amount?: number;
  error?: string;
  samples?: { new: Row[]; updated: Row[]; invalid: Row[] };
}

interface Row {
  row_number: number;
  donor_code: string | null;
  phone: string | null;
  name: string | null;
  preacher_code: string | null;
  amount_total: number | null;
}

const FIELD_LABELS: Record<string, string> = {
  donor_code: "Donor number",
  phone: "Phone",
  name: "Name",
  preacher_code: "Preacher (Enrolled By)",
  account_type: "Account type",
  last_donation_at: "Last donation date",
  amount_total: "Lifetime total",
  amount_recent: "Recent total",
  remarks: "Remarks",
};

export default function UploadsPage() {
  const [drafts, setDrafts] = useState<Batch[]>([]);
  const [history, setHistory] = useState<Batch[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assignTo, setAssignTo] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const loadHistory = useCallback(async () => {
    try {
      const d = await apiClient.get<{ batches: Batch[] }>("/api/crm/import/batches");
      setHistory(d.batches);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the upload history");
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    apiClient
      .get<{ users: { id: string; name: string }[] }>("/api/crm/config")
      .then((d) => setUsers(d.users))
      .catch(() => undefined);
  }, [loadHistory]);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      // Read as base64 and post as JSON rather than as multipart: a multipart
      // parser with its temp files is more moving parts than the upload is
      // worth.
      //
      // This one posts the file itself rather than going through
      // /api/files/parse, because the rows are not just read here - they are
      // parked in lead_import_rows so the sheet survives the decision to apply
      // it. Sending the file and sending the rows back would mean carrying
      // 8,500 rows through the browser for no reason.
      const d = await apiClient.post<{ batches: Batch[] }>("/api/crm/import/sheet", {
        filename: file.name,
        base64: toBase64(await file.arrayBuffer()),
      });
      setDrafts(d.batches);
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file");
    } finally {
      setBusy(false);
    }
  }

  async function apply(b: Batch) {
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(`/api/crm/import/batches/${b.id}/apply`, {
        assigned_to: assignTo || undefined,
      });
      setDrafts((ds) => ds.filter((d) => d.id !== b.id));
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply that sheet");
    } finally {
      setBusy(false);
    }
  }

  async function discard(b: Batch) {
    try {
      await apiClient.delete(`/api/crm/import/batches/${b.id}`);
      setDrafts((ds) => ds.filter((d) => d.id !== b.id));
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not discard that");
    }
  }

  return (
    <div>
      <PageHeader
        title="Uploaded sheets"
        subtitle="Excel or CSV from the office — every one kept, so a fresh export never costs you the calls already made"
        actions={
          <Link href="/leads" className={buttonSecondary}>
            All leads
          </Link>
        }
      />

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {/* ------------------------------------------------------------ upload */}
      <Card className="mb-5">
        <input
          ref={fileRef}
          type="file"
          accept={SPREADSHEET_ACCEPT}
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
            {busy ? "Reading the file…" : "Drop an Excel file or CSV here, or click to choose one"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Every tab of a workbook is read separately; a CSV is read as one. Columns are matched by their
            headings — Donor Number, Mobile Number, Enrolled By, Total Amount Donated and the rest are all
            recognised as they are written.
          </p>
        </div>
      </Card>

      {/* ------------------------------------------------- what it would do */}
      {drafts.length > 0 && (
        <div className="mb-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-900">
              Read {drafts.length} sheet{drafts.length === 1 ? "" : "s"} — nothing has been saved yet
            </p>
            <label className="flex items-center gap-2 text-xs text-slate-500">
              Assign what gets added to
              <Select
                value={assignTo}
                onChange={setAssignTo}
                className="min-w-[10rem]"
                placeholder="Nobody yet"
                options={[{ value: "", label: "Nobody yet" }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
              />
            </label>
          </div>

          {drafts.map((b) => (
            <Card key={b.id} className={b.error ? "border-red-200" : ""}>
              <CardHeader
                title={b.sheet_name ?? "Sheet"}
                subtitle={`${number(b.rows_total)} rows in ${b.filename}`}
              />

              {b.error ? (
                <div className="rounded-lg bg-red-50 px-4 py-3">
                  <p className="text-sm font-medium text-red-900">{b.error}</p>
                  <p className="text-xs text-red-800 mt-0.5">
                    Without a phone column there is nobody to ring. Headings found: {(b.headers ?? []).join(", ")}
                  </p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Tally label="Will be added" value={b.counts?.new ?? 0} tone="good" />
                    <Tally label="Already leads" value={b.counts?.updated ?? 0} />
                    <Tally label="Same number twice" value={b.counts?.duplicate_in_file ?? 0} />
                    <Tally
                      label="No usable number"
                      value={(b.counts?.invalid_phone ?? 0) + (b.counts?.no_phone ?? 0)}
                      tone="warn"
                    />
                  </div>

                  <div className="mt-3 space-y-1.5 text-xs text-slate-600">
                    {(b.counts?.already_donors ?? 0) > 0 && (
                      <p>
                        {number(b.counts!.already_donors)} of the new rows are people DRM already knows as donors — they
                        will be linked to their giving history automatically.
                      </p>
                    )}
                    {(b.counts?.duplicate_in_file ?? 0) > 0 && (
                      <p>
                        {number(b.counts!.duplicate_in_file)} rows share a phone with another row in this sheet. One
                        number is one call, so they become one lead each
                        {(b.shared_amount ?? 0) > 0 && (
                          <> — and the {currency(b.shared_amount!)} on those rows is added onto it, not dropped</>
                        )}
                        .
                      </p>
                    )}
                    {(b.unreachable_amount ?? 0) > 0 && (
                      <p className="text-amber-700">
                        {currency(b.unreachable_amount!)} of giving sits on rows with no usable phone number. Worth
                        fixing in the source sheet — nobody can ring those donors.
                      </p>
                    )}
                    {(b.external_total ?? 0) > 0 && (
                      <p>
                        {currency(b.external_total!)} of lifetime giving in this sheet. Shown to callers, never added to
                        DRM&apos;s own totals.
                      </p>
                    )}
                    {(b.preacher_codes?.length ?? 0) > 0 && (
                      <p>
                        {b.preacher_codes!.length} preacher codes — any DRM has not seen before are created
                        automatically, ready to be given real names.
                      </p>
                    )}
                  </div>

                  {/* What each column was read as. The commonest import disaster
                      is a column silently matched to the wrong field, so it is
                      shown rather than assumed. */}
                  {b.mapping && (
                    <div className="mt-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                        Columns read
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(b.mapping).map(([field, idx]) => (
                          <span key={field} className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700">
                            <span className="text-slate-500">{b.headers?.[idx] ?? `col ${idx + 1}`}</span> →{" "}
                            {FIELD_LABELS[field] ?? field}
                          </span>
                        ))}
                        {(b.headers ?? [])
                          .map((h, i) => ({ h, i }))
                          .filter(({ h, i }) => h && !Object.values(b.mapping!).includes(i))
                          .map(({ h }) => (
                            <span key={h} className="rounded-md border border-dashed border-slate-200 px-2 py-1 text-[11px] text-slate-400">
                              {h} — kept, not used
                            </span>
                          ))}
                      </div>
                    </div>
                  )}

                  {b.samples?.new?.length ? (
                    <ul className="mt-4 divide-y divide-slate-100 text-xs">
                      {b.samples.new.slice(0, 4).map((r) => (
                        <li key={r.row_number} className="py-1.5 flex justify-between gap-3">
                          <span className="truncate text-slate-700">
                            {r.name || r.phone}{" "}
                            {r.preacher_code && <span className="text-slate-400">· {r.preacher_code}</span>}
                          </span>
                          <span className="tabular-nums text-slate-500 whitespace-nowrap">
                            {r.amount_total ? currency(r.amount_total) : r.donor_code}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <button onClick={() => void discard(b)} className={buttonSecondary}>
                      Discard
                    </button>
                    <button onClick={() => void apply(b)} disabled={busy || !(b.counts?.new || b.counts?.updated)} className={buttonPrimary}>
                      {busy ? "Applying…" : `Add ${number(b.counts?.new ?? 0)} and update ${number(b.counts?.updated ?? 0)}`}
                    </button>
                  </div>
                </>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* ---------------------------------------------------------- history */}
      <Card padded={false}>
        <div className="px-5 pt-5">
          <CardHeader
            title="Every sheet ever uploaded"
            subtitle="Kept row by row. A fresher export adds and updates — it never removes anyone, and never touches a call that has been made."
          />
        </div>
        <TableShell>
          <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
            <tr>
              <Th>Sheet</Th>
              <Th align="right">Rows</Th>
              <Th align="right">Added</Th>
              <Th align="right">Updated</Th>
              <Th>Uploaded</Th>
              <Th align="center">State</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!history.length ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState title="Nothing uploaded yet" message="Drop an Excel file or CSV above to get started." />
                </td>
              </tr>
            ) : (
              history.map((b) => (
                <tr key={b.id} className="hover:bg-slate-50/60">
                  <Td>
                    <span className="font-medium text-slate-900">{b.sheet_name ?? "Sheet"}</span>
                    <div className="text-[11px] text-slate-500 truncate max-w-xs" title={b.filename}>
                      {b.filename}
                    </div>
                  </Td>
                  <Td align="right" className="tabular-nums text-slate-600">{number(b.rows_total)}</Td>
                  <Td align="right" className="tabular-nums">{b.leads_added ? number(b.leads_added) : <span className="text-slate-300">—</span>}</Td>
                  <Td align="right" className="tabular-nums text-slate-600">{b.leads_updated ? number(b.leads_updated) : <span className="text-slate-300">—</span>}</Td>
                  <Td className="text-xs text-slate-500">
                    {shortDate(b.created_at)} · {relativeDate(b.created_at)}
                    {b.uploaded_by_name && <div className="text-slate-400">{b.uploaded_by_name}</div>}
                  </Td>
                  <Td align="center">
                    {b.status === "applied" ? (
                      <Badge tone="good">applied</Badge>
                    ) : (
                      <Badge tone="warn">read, not applied</Badge>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </TableShell>
      </Card>
    </div>
  );
}

function Tally({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "good" | "warn" }) {
  const tones = { neutral: "text-slate-900", good: "text-emerald-700", warn: "text-amber-700" };
  return (
    <div className="rounded-lg border border-[var(--line-soft)] px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tones[tone]}`}>{number(value)}</p>
    </div>
  );
}
