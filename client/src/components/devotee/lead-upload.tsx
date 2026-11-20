"use client";

// Upload many leads at once from an Excel or CSV file. Two steps, so nothing is saved by surprise:
// the file is checked first (how many are ready, which are already in your leads, which rows have
// a problem and why), then "Add N leads" saves the ready ones. Nothing already there is changed.

import { useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import { leadsChanged } from "@/lib/devotee";
import { SPREADSHEET_ACCEPT, downloadSample, toBase64 } from "@/lib/spreadsheet";
import { Alert, Badge, Button, Modal } from "@/components/ui";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";

interface Report {
  sheet: string;
  columns: Record<string, string>;
  total: number;
  ready: number;
  added: number;
  problems: { row: number; name: string; reason: string }[];
  duplicates: { row: number; name: string; phone: string; reason: string }[];
  preview: { row: number; name: string; phone: string; area: string | null; follow_up: string | null }[];
}

/** The sample file: every column the upload understands, with three example rows. Only Name and Mobile are required. */
export const LEAD_SAMPLE: string[][] = [
  ["Name", "Mobile", "Other number", "Email", "Address", "Area", "Landmark", "City", "PIN code", "Interest", "How met", "Priority", "Expected amount", "Birthday", "Anniversary", "Next follow-up", "Notes"],
  ["Ravi Kumar", "9876543210", "", "ravi@example.com", "Flat 402, Sai Krupa Residency", "MVP Colony", "Near Sivalayam", "Visakhapatnam", "530017", "Annadanam", "Temple visit", "High", "5000", "14-05-1980", "", "25-11-2026 10:30", "Wants to sponsor Sunday Annadanam"],
  ["Lakshmi Devi", "9123456780", "08912345678", "", "12-3, Beach Road", "Siripuram", "", "Visakhapatnam", "530003", "Temple construction", "Personal contact", "Medium", "", "", "02-02-2005", "26-11-2026", ""],
  ["Suresh Reddy", "9988776655", "", "", "", "Gajuwaka", "", "Visakhapatnam", "", "General donation", "Event or festival", "Low", "", "", "", "", "Met at the Janmashtami stall"],
];

const FIELD_WORDS: Record<string, string> = {
  name: "Name", phone: "Mobile", alt_phone: "Other number", email: "Email", address_line: "Address", area: "Area",
  landmark: "Landmark", city: "City", pincode: "PIN code", interest: "Interest", source: "How met", priority: "Priority",
  expected_amount: "Expected amount", date_of_birth: "Birthday", anniversary_date: "Anniversary",
  next_follow_up_at: "Next follow-up", occupation: "Occupation", organisation: "Organisation", notes: "Notes",
};

export function LeadUploadDialog({ onClose }: { onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<"check" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check(picked: File) {
    setError(null);
    setReport(null);
    if (!/\.(xlsx|xlsm|csv)$/i.test(picked.name)) return setError(`"${picked.name}" is not an Excel or CSV file.`);
    if (picked.size > 10 * 1024 * 1024) return setError("That file is over 10 MB. Split it and upload the parts one by one.");
    setBusy("check");
    try {
      const f = { name: picked.name, base64: toBase64(await picked.arrayBuffer()) };
      setFile(f);
      setReport(await apiClient.post<Report>("/api/devotee/leads/import", { filename: f.name, base64: f.base64 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the file.");
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    if (!file) return;
    setBusy("add");
    setError(null);
    try {
      const r = await apiClient.post<Report>("/api/devotee/leads/import", { filename: file.name, base64: file.base64, apply: true });
      toast.success(`${r.added} lead${r.added === 1 ? "" : "s"} added`, r.duplicates.length || r.problems.length ? `${r.duplicates.length + r.problems.length} rows left out` : undefined);
      leadsChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the leads.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title="Upload leads"
      onClose={onClose}
      wide
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {report && report.ready > 0 && (
            <Button icon="userPlus" loading={busy === "add"} onClick={() => void add()}>
              Add {report.ready} lead{report.ready === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-card bg-sunken/60 p-3 text-sm text-ink-soft">
          <p>
            An Excel or CSV file with one lead per row. Only <strong>Name</strong> and <strong>Mobile</strong> are needed; every other column is optional.
          </p>
          <button
            type="button"
            onClick={() => downloadSample("devotee-leads-sample.csv", LEAD_SAMPLE)}
            className="mt-2 inline-flex items-center gap-1.5 font-semibold text-brand-700 hover:underline"
          >
            <Icon name="download" size={15} />
            Download the sample file
          </button>
        </div>

        <input
          ref={input}
          type="file"
          accept={SPREADSHEET_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void check(f);
          }}
        />
        <Button variant="secondary" icon="upload" block loading={busy === "check"} onClick={() => input.current?.click()}>
          {file ? `Choose another file (${file.name})` : "Choose file"}
        </Button>

        {error && <Alert tone="danger">{error}</Alert>}

        {report && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge tone="good" icon="checkCircle">{report.ready} ready to add</Badge>
              {report.duplicates.length > 0 && <Badge tone="info">{report.duplicates.length} already in your leads</Badge>}
              {report.problems.length > 0 && <Badge tone="danger">{report.problems.length} with a problem</Badge>}
            </div>
            <p className="text-xs text-ink-muted">
              Columns read: {Object.entries(report.columns).map(([f, h]) => `${FIELD_WORDS[f] ?? f} ← "${h}"`).join(" · ")}
            </p>

            {report.preview.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-ink-soft">First of the leads to be added</p>
                <ul className="divide-y divide-line-soft rounded-card border border-line-soft">
                  {report.preview.map((p) => (
                    <li key={p.row} className="flex flex-wrap items-center justify-between gap-x-3 px-3 py-2 text-sm">
                      <span className="font-medium text-ink">{p.name}</span>
                      <span className="text-xs tabular-nums text-ink-muted">
                        {p.phone}
                        {p.area ? ` · ${p.area}` : ""}
                        {p.follow_up ? ` · follow up ${p.follow_up}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.problems.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-danger">Not added - fix these rows in the file and upload again</p>
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-card border border-red-200 bg-danger-wash p-2 text-xs text-red-900">
                  {report.problems.slice(0, 100).map((p) => (
                    <li key={p.row}>
                      Row {p.row} ({p.name}): {p.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.duplicates.length > 0 && (
              <details className="text-xs text-ink-muted">
                <summary className="cursor-pointer">Left out: already in your leads or repeated ({report.duplicates.length})</summary>
                <ul className="mt-1 space-y-0.5">
                  {report.duplicates.slice(0, 100).map((d) => (
                    <li key={d.row}>
                      Row {d.row}: {d.name} {d.phone} - {d.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {report.ready === 0 && <Alert tone="warn">No new leads to add from this file.</Alert>}
          </div>
        )}
      </div>
    </Modal>
  );
}
