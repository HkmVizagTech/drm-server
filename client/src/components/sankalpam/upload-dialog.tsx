"use client";

// Upload the office's sheet. Two steps: read it and say what it would add,
// then add it. Nothing is ever removed or duplicated, so uploading a fresher
// copy of the same sheet later only adds what is new.

import { useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import { number } from "@/lib/format";
import { SPREADSHEET_ACCEPT, downloadFromApi, toBase64 } from "@/lib/spreadsheet";
import { toast } from "@/components/toast";
import { Alert, Button, Icon, Modal, Spinner } from "@/components/ui";

interface Result {
  applied: boolean;
  donors_new: number;
  donors_existing: number;
  dates_new: number;
  dates_existing: number;
  donors_without_dates: number;
  sheets: number;
  skipped: number;
  skipped_rows: { row: number; sheet: string; why: string; text: string }[];
}

export function UploadDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void | Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [check, setCheck] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"reading" | "adding" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  async function pick(f: File | undefined) {
    if (!f) return;
    setError(null);
    setCheck(null);
    if (f.size > 18 * 1024 * 1024) return setError("That file is over 18 MB. Split it and upload the parts.");
    setBusy("reading");
    try {
      const base64 = toBase64(await f.arrayBuffer());
      setFile({ name: f.name, base64 });
      setCheck(await apiClient.post<Result>("/api/sankalpam/import", { filename: f.name, base64 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read this file.");
      setFile(null);
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    if (!file) return;
    setBusy("adding");
    setError(null);
    try {
      const r = await apiClient.post<Result>("/api/sankalpam/import", { filename: file.name, base64: file.base64, apply: true });
      toast(`Added ${number(r.dates_new)} special day${r.dates_new === 1 ? "" : "s"} and ${number(r.donors_new)} donor${r.donors_new === 1 ? "" : "s"}`);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add. Try again.");
      setBusy(null);
    }
  }

  const nothing = check && check.donors_new === 0 && check.dates_new === 0;

  return (
    <Modal
      title="Upload sheet"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {check ? "Cancel" : "Close"}
          </Button>
          {check && !nothing && (
            <Button loading={busy === "adding"} onClick={() => void add()}>
              Add {number(check.dates_new)} day{check.dates_new === 1 ? "" : "s"}
            </Button>
          )}
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <input
        ref={input}
        type="file"
        accept={SPREADSHEET_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {!check && (
        <>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => input.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void pick(e.dataTransfer.files?.[0]);
            }}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-line-strong bg-sunken/40 px-4 py-10 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/60"
          >
            {busy === "reading" ? (
              <>
                <Spinner />
                <span className="text-sm font-medium text-ink">Reading the sheet…</span>
                <span className="text-xs text-ink-muted">A big workbook takes a few seconds.</span>
              </>
            ) : (
              <>
                <Icon name="upload" size={22} className="text-brand-700" />
                <span className="text-sm font-medium text-ink">Choose an Excel or CSV file</span>
                <span className="text-xs text-ink-muted">or drop it here</span>
              </>
            )}
          </button>
          <p className="mt-3 text-sm text-ink-soft">
            One row per special day: Patron No., Donor Name, Mobile Number, Date, Occasion. The office&apos;s
            &ldquo;Special Puja Dates&rdquo; sheet works as it is, month tabs too.
          </p>
          <Button
            variant="ghost"
            size="sm"
            icon="download"
            className="mt-1 -ml-2"
            onClick={() => void downloadFromApi("/api/sankalpam/sample.xlsx", "sankalpam-sample.xlsx")}
          >
            Sample sheet
          </Button>
        </>
      )}

      {check && (
        <div className="space-y-3">
          <p className="text-sm text-ink-soft">
            <Icon name="fileText" size={14} className="mr-1 inline text-ink-muted" />
            {file?.name}
            {check.sheets > 1 ? ` · ${check.sheets} tabs read` : ""}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Count label="Special days" add={check.dates_new} have={check.dates_existing} />
            <Count label="Donors" add={check.donors_new} have={check.donors_existing} />
          </div>
          {nothing && <Alert tone="info" title="Nothing new in this sheet." />}
          {check.donors_without_dates > 0 && (
            <p className="text-xs text-ink-muted">
              {number(check.donors_without_dates)} donor{check.donors_without_dates === 1 ? " has" : "s have"} no days yet. They are
              added so their days can be filled in later.
            </p>
          )}
          {check.dates_existing > 0 && (
            <p className="text-xs text-ink-muted">A day the donor already has is kept as it is.</p>
          )}
          {check.skipped > 0 && (
            <div className="rounded-card border border-amber-200 bg-warn-wash/50 px-3 py-2.5">
              <button type="button" className="flex w-full items-center justify-between text-sm font-medium text-warn" onClick={() => setShowSkipped((v) => !v)}>
                <span>
                  {number(check.skipped)} row{check.skipped === 1 ? "" : "s"} left out (date not readable)
                </span>
                <Icon name={showSkipped ? "chevronUp" : "chevronDown"} size={14} />
              </button>
              {showSkipped && (
                <ul className="mt-2 space-y-1 text-xs text-ink-soft">
                  {check.skipped_rows.map((s) => (
                    <li key={`${s.sheet}-${s.row}`}>
                      <span className="tabular-nums text-ink-muted">
                        {s.sheet} row {s.row}:
                      </span>{" "}
                      {s.text || "—"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <Button variant="ghost" size="sm" className="-ml-2" disabled={!!busy} onClick={() => input.current?.click()}>
            Choose another file
          </Button>
        </div>
      )}
    </Modal>
  );
}

function Count({ label, add, have }: { label: string; add: number; have: number }) {
  return (
    <div className="rounded-card border border-line-soft bg-surface px-3 py-2.5">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="text-2xl font-semibold tabular-nums text-ink">+{number(add)}</p>
      <p className="text-xs text-ink-muted">{have ? `${number(have)} already here` : "all new"}</p>
    </div>
  );
}
