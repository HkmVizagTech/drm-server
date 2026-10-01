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
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Select,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
  buttonSecondary,
} from "@/components/ui";
import { downloadFromApi, SPREADSHEET_ACCEPT, toBase64 } from "@/lib/spreadsheet";

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
  // The original workbook, when file storage kept one. Absent on uploads made
  // before storage was set up - their rows are all still here.
  file_key?: string | null;
  file_size?: number | null;
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
        eyebrow="Calling"
        title="Uploaded sheets"
        subtitle="Excel or CSV from the office — every one kept, so a fresh export never costs you the calls already made"
        actions={
          // A next/link anchor wearing the button class rather than LinkButton:
          // LinkButton is a plain <a>, which would drop out of the client
          // router.
          <Link href="/leads" className={buttonSecondary}>
            All leads
          </Link>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

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
          className={`cursor-pointer rounded-card border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragging ? "border-brand-600 bg-brand-50" : "border-line-strong hover:border-brand-400 hover:bg-sunken"
          }`}
        >
          <p className="text-sm font-medium text-ink">
            {busy ? "Reading the file…" : "Drop an Excel file or CSV here, or click to choose one"}
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            Every tab of a workbook is read separately; a CSV is read as one. Columns are matched by their
            headings — Donor Number, Mobile Number, Enrolled By, Total Amount Donated and the rest are all
            recognised as they are written.
          </p>
        </div>
      </Card>

      {/* ------------------------------------------------- what it would do */}
      {drafts.length > 0 && (
        <div className="mb-6 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <p className="text-sm font-semibold text-ink">
              Read {drafts.length} sheet{drafts.length === 1 ? "" : "s"} — nothing has been saved yet
            </p>
            <Field label="Assign what gets added to" className="w-56">
              <Select
                value={assignTo}
                onChange={setAssignTo}
                ariaLabel="Assign what gets added to"
                placeholder="Nobody yet"
                options={[{ value: "", label: "Nobody yet" }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
              />
            </Field>
          </div>

          {drafts.map((b) => (
            <Card key={b.id} className={b.error ? "border-red-200" : ""}>
              <CardHeader
                title={b.sheet_name ?? "Sheet"}
                subtitle={`${number(b.rows_total)} rows in ${b.filename}`}
              />

              {b.error ? (
                <Alert tone="danger" title={b.error}>
                  Without a phone column there is nobody to ring. Headings found: {(b.headers ?? []).join(", ")}
                </Alert>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Tally label="Will be added" value={b.counts?.new ?? 0} tone="good" />
                    <Tally label="Already leads" value={b.counts?.updated ?? 0} />
                    <Tally label="Same number twice" value={b.counts?.duplicate_in_file ?? 0} />
                    <Tally
                      label="No usable number"
                      value={(b.counts?.invalid_phone ?? 0) + (b.counts?.no_phone ?? 0)}
                      tone="warn"
                    />
                  </div>

                  <div className="mt-3 space-y-1.5 text-xs text-ink-soft">
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
                      <p className="text-warn">
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
                      <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                        Columns read
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(b.mapping).map(([field, idx]) => (
                          <span
                            key={field}
                            className="inline-flex items-center gap-1 rounded-md bg-sunken px-2 py-1 text-xs text-ink-soft"
                          >
                            <span className="text-ink-muted">{b.headers?.[idx] ?? `col ${idx + 1}`}</span>
                            <Icon name="arrowRight" size={12} className="text-ink-faint" />
                            {FIELD_LABELS[field] ?? field}
                          </span>
                        ))}
                        {(b.headers ?? [])
                          .map((h, i) => ({ h, i }))
                          .filter(({ h, i }) => h && !Object.values(b.mapping!).includes(i))
                          .map(({ h }) => (
                            <span
                              key={h}
                              className="rounded-md border border-dashed border-line-strong px-2 py-1 text-xs text-ink-faint"
                            >
                              {h} — kept, not used
                            </span>
                          ))}
                      </div>
                    </div>
                  )}

                  {b.samples?.new?.length ? (
                    <ul className="mt-4 divide-y divide-line-soft text-xs">
                      {b.samples.new.slice(0, 4).map((r) => (
                        <li key={r.row_number} className="flex justify-between gap-3 py-1.5">
                          <span className="truncate text-ink-soft">
                            {r.name || r.phone}{" "}
                            {r.preacher_code && <span className="text-ink-faint">· {r.preacher_code}</span>}
                          </span>
                          <span className="whitespace-nowrap tabular-nums text-ink-muted">
                            {r.amount_total ? currency(r.amount_total) : r.donor_code}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <Button variant="secondary" onClick={() => void discard(b)}>
                      Discard
                    </Button>
                    <Button
                      onClick={() => void apply(b)}
                      disabled={!(b.counts?.new || b.counts?.updated)}
                      loading={busy}
                    >
                      {`Add ${number(b.counts?.new ?? 0)} and update ${number(b.counts?.updated ?? 0)}`}
                    </Button>
                  </div>
                </>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* ---------------------------------------------------------- history */}
      <CardHeader
        title="Every sheet ever uploaded"
        subtitle="Kept row by row. A fresher export adds and updates — it never removes anyone, and never touches a call that has been made."
      />
      <TableShell>
        <Thead>
          <Th>Sheet</Th>
          <Th align="right">Rows</Th>
          <Th align="right">Added</Th>
          <Th align="right">Updated</Th>
          <Th>Uploaded</Th>
          <Th align="center">State</Th>
          <Th align="right">File</Th>
        </Thead>
        <Tbody>
          {!history.length ? (
            <tr>
              <td colSpan={7}>
                <EmptyState title="Nothing uploaded yet" message="Drop an Excel file or CSV above to get started." />
              </td>
            </tr>
          ) : (
            history.map((b) => (
              <tr key={b.id}>
                <Td>
                  <span className="font-medium text-ink">{b.sheet_name ?? "Sheet"}</span>
                  <div className="max-w-xs truncate text-xs text-ink-muted" title={b.filename}>
                    {b.filename}
                  </div>
                </Td>
                <Td align="right" className="tabular-nums">{number(b.rows_total)}</Td>
                <Td align="right" className="tabular-nums">{b.leads_added ? number(b.leads_added) : <span className="text-ink-faint">—</span>}</Td>
                <Td align="right" className="tabular-nums">{b.leads_updated ? number(b.leads_updated) : <span className="text-ink-faint">—</span>}</Td>
                <Td className="text-xs text-ink-muted">
                  {shortDate(b.created_at)} · {relativeDate(b.created_at)}
                  {b.uploaded_by_name && <div className="text-ink-faint">{b.uploaded_by_name}</div>}
                </Td>
                <Td align="center">
                  {b.status === "applied" ? (
                    <Badge tone="good">applied</Badge>
                  ) : (
                    <Badge tone="warn">read, not applied</Badge>
                  )}
                </Td>
                <Td align="right">
                  {/* The workbook itself, not a reconstruction of it. Only
                      offered where one was actually kept — uploads from
                      before file storage was set up have their rows and
                      nothing else, and saying so beats a button that 404s.
                      This is one stored file, not the list on screen, so it
                      stays a plain button rather than an ExportButton. */}
                  {b.file_key ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="download"
                      onClick={() =>
                        void downloadFromApi(
                          `/api/crm/import/batches/${b.id}/file`,
                          b.filename
                        ).catch((e) => setError(e instanceof Error ? e.message : "Could not fetch that file"))
                      }
                    >
                      Download
                    </Button>
                  ) : (
                    <span className="text-xs text-ink-faint">not kept</span>
                  )}
                </Td>
              </tr>
            ))
          )}
        </Tbody>
      </TableShell>
    </div>
  );
}

function Tally({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "good" | "warn" }) {
  const tones = { neutral: "text-ink", good: "text-good", warn: "text-warn" };
  return (
    <div className="rounded-card border border-line-soft px-3 py-2">
      <p className="text-2xs uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tones[tone]}`}>{number(value)}</p>
    </div>
  );
}
