"use client";

// Upload the office's sheet. Two steps: read it and say what it would do, then
// do it. Two ways:
//
//   Add to what's here (anyone) - nothing is ever removed or duplicated, so
//   uploading a fresher copy of the same sheet later only adds what is new.
//
//   Replace with this sheet (admins) - for a corrected sheet. DRM is made to
//   match it: days from the old sheet that this one does not have are removed,
//   its days added, its details taken, and donors from the old sheet who are
//   not in it switched off (not deleted - their history stays). Anything added
//   by hand in DRM is kept. The preview lists every day that would go and
//   every donor that would be switched off, and nothing happens until the
//   admin ticks that they have checked it.

import { useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { number } from "@/lib/format";
import { SPREADSHEET_ACCEPT, downloadFromApi, toBase64 } from "@/lib/spreadsheet";
import { toast } from "@/components/toast";
import { Alert, Button, Checkbox, Icon, Modal, SegmentedControl, Spinner } from "@/components/ui";

type Mode = "add" | "replace";

interface Result {
  applied: boolean;
  mode: Mode;
  donors_new: number;
  donors_existing: number;
  dates_new: number;
  dates_existing: number;
  donors_without_dates: number;
  dates_removed: number;
  donors_switched_off: number;
  donors_switched_on: number;
  sheet_donors_before: number;
  sheets: number;
  skipped: number;
  skipped_rows: { row: number; sheet: string; why: string; text: string }[];
  removed_dates: { donor: string; month: number; day: number; occasion: string }[];
  switched_off: string[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

export function UploadDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void | Promise<void> }) {
  const { user } = useAuth();
  const canReplace = user?.role === "admin";
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("add");
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [check, setCheck] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"reading" | "adding" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [showOff, setShowOff] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  async function preview(f: { name: string; base64: string }, m: Mode) {
    setBusy("reading");
    setError(null);
    setCheck(null);
    setConfirmed(false);
    try {
      setCheck(await apiClient.post<Result>("/api/sankalpam/import", { filename: f.name, base64: f.base64, mode: m }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read this file.");
    } finally {
      setBusy(null);
    }
  }

  async function pick(f: File | undefined) {
    if (!f) return;
    setError(null);
    setCheck(null);
    if (f.size > 18 * 1024 * 1024) return setError("That file is over 18 MB. Split it and upload the parts.");
    setBusy("reading");
    let picked: { name: string; base64: string };
    try {
      picked = { name: f.name, base64: toBase64(await f.arrayBuffer()) };
    } catch {
      setBusy(null);
      return setError("Could not read this file.");
    }
    setFile(picked);
    await preview(picked, mode);
  }

  function changeMode(m: Mode) {
    setMode(m);
    if (file) void preview(file, m);
  }

  async function run() {
    if (!file) return;
    setBusy("adding");
    setError(null);
    try {
      const r = await apiClient.post<Result>("/api/sankalpam/import", {
        filename: file.name,
        base64: file.base64,
        mode,
        apply: true,
      });
      if (r.mode === "replace") {
        toast(
          "Sankalpam data replaced",
          {
            body: [
              `${plural(r.dates_new, "day")} added`,
              `${plural(r.dates_removed, "day")} removed`,
              r.donors_switched_off ? `${plural(r.donors_switched_off, "donor")} switched off` : "",
            ]
              .filter(Boolean)
              .join(" · "),
          }
        );
      } else {
        toast(`Added ${plural(r.dates_new, "special day")} and ${plural(r.donors_new, "donor")}`);
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setBusy(null);
    }
  }

  const replacing = check?.mode === "replace";
  const nothing =
    check &&
    check.donors_new === 0 &&
    check.dates_new === 0 &&
    (!replacing || (check.dates_removed === 0 && check.donors_switched_off === 0 && check.donors_switched_on === 0));
  // Switching off a big share of the donors usually means a partial sheet
  // (one month's tab) was chosen instead of the whole list.
  const bigSwitchOff =
    replacing && check.sheet_donors_before >= 10 && check.donors_switched_off > check.sheet_donors_before * 0.3;

  return (
    <Modal
      title="Upload sheet"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {check ? "Cancel" : "Close"}
          </Button>
          {check && !nothing && !replacing && (
            <Button loading={busy === "adding"} disabled={!!busy && busy !== "adding"} onClick={() => void run()}>
              Add {plural(check.dates_new, "day")}
            </Button>
          )}
          {check && !nothing && replacing && (
            <Button
              variant="danger"
              loading={busy === "adding"}
              disabled={!confirmed || (!!busy && busy !== "adding")}
              onClick={() => void run()}
            >
              Replace Sankalpam data
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

      {canReplace && (
        <div className="mb-3">
          <SegmentedControl<Mode>
            options={[
              { value: "add", label: "Add to what's here" },
              { value: "replace", label: "Replace with this sheet" },
            ]}
            value={mode}
            onChange={changeMode}
            size="sm"
          />
          <p className="mt-2 text-xs text-ink-muted">
            {mode === "add"
              ? "Adds new donors and days. Nothing already here is changed or removed."
              : "For a corrected sheet. Days from the old sheet that this one doesn't have are removed, and donors not in it are switched off. Anything added by hand in DRM stays. You see everything before it happens."}
          </p>
        </div>
      )}

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

          {replacing ? (
            <div className="grid grid-cols-2 gap-3">
              <Count
                label="Special days"
                add={check.dates_new}
                remove={check.dates_removed}
                note={`${number(check.dates_existing)} kept`}
              />
              <Count
                label="Donors"
                add={check.donors_new}
                remove={check.donors_switched_off}
                removeWord="off"
                note={`${number(check.donors_existing)} updated from the sheet`}
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Count
                label="Special days"
                add={check.dates_new}
                note={check.dates_existing ? `${number(check.dates_existing)} already here` : "all new"}
              />
              <Count
                label="Donors"
                add={check.donors_new}
                note={check.donors_existing ? `${number(check.donors_existing)} already here` : "all new"}
              />
            </div>
          )}

          {nothing && (
            <Alert tone="info" title={replacing ? "DRM already matches this sheet." : "Nothing new in this sheet."} />
          )}

          {bigSwitchOff && (
            <Alert tone="warn" title={`This switches off ${number(check.donors_switched_off)} of ${number(check.sheet_donors_before)} donors.`}>
              Make sure this is the full list, not one month&apos;s tab.
            </Alert>
          )}

          {replacing && check.dates_removed > 0 && (
            <Section
              tone="danger"
              open={showRemoved}
              onToggle={() => setShowRemoved((v) => !v)}
              title={`${plural(check.dates_removed, "day")} from the old sheet will be removed`}
            >
              {check.removed_dates.map((r, i) => (
                <li key={i}>
                  <span className="tabular-nums text-ink-muted">
                    {r.day} {MONTHS[r.month - 1]}
                  </span>{" "}
                  · {r.donor} · {r.occasion}
                </li>
              ))}
              {check.dates_removed > check.removed_dates.length && (
                <li className="text-ink-muted">and {number(check.dates_removed - check.removed_dates.length)} more</li>
              )}
            </Section>
          )}

          {replacing && check.donors_switched_off > 0 && (
            <Section
              tone="warn"
              open={showOff}
              onToggle={() => setShowOff((v) => !v)}
              title={`${plural(check.donors_switched_off, "donor")} not in this sheet will be switched off`}
            >
              {check.switched_off.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
              {check.donors_switched_off > check.switched_off.length && (
                <li className="text-ink-muted">and {number(check.donors_switched_off - check.switched_off.length)} more</li>
              )}
            </Section>
          )}

          {replacing && check.donors_switched_on > 0 && (
            <p className="text-xs text-ink-muted">
              {plural(check.donors_switched_on, "donor")} switched off earlier {check.donors_switched_on === 1 ? "is" : "are"} in
              this sheet and will be switched back on.
            </p>
          )}

          {check.donors_without_dates > 0 && (
            <p className="text-xs text-ink-muted">
              {plural(check.donors_without_dates, "donor")} {check.donors_without_dates === 1 ? "has" : "have"} no days in
              this sheet.
              {replacing ? " Their days from the old sheet are removed." : " They are added so their days can be filled in later."}
            </p>
          )}
          {!replacing && check.dates_existing > 0 && (
            <p className="text-xs text-ink-muted">A day the donor already has is kept as it is.</p>
          )}

          {check.skipped > 0 && (
            <Section
              tone="warn"
              open={showSkipped}
              onToggle={() => setShowSkipped((v) => !v)}
              title={`${plural(check.skipped, "row")} left out (date not readable)`}
            >
              {check.skipped_rows.map((s) => (
                <li key={`${s.sheet}-${s.row}`}>
                  <span className="tabular-nums text-ink-muted">
                    {s.sheet} row {s.row}:
                  </span>{" "}
                  {s.text || "—"}
                </li>
              ))}
            </Section>
          )}

          {replacing && !nothing && (
            <div className="rounded-card border border-line-soft bg-sunken/50 px-3 py-2.5">
              <Checkbox
                checked={confirmed}
                onChange={setConfirmed}
                label="I have checked this. Replace the Sankalpam data with this sheet."
              />
              <p className="mt-1.5 pl-6 text-xs text-ink-muted">
                Calls and &ldquo;sent&rdquo; ticks on days that stay are kept. A switched-off donor can be switched back on
                from their page.
              </p>
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

function Section({
  tone,
  open,
  onToggle,
  title,
  children,
}: {
  tone: "warn" | "danger";
  open: boolean;
  onToggle: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const box =
    tone === "danger" ? "border-red-200 bg-danger-wash/50 text-danger" : "border-amber-200 bg-warn-wash/50 text-warn";
  return (
    <div className={`rounded-card border px-3 py-2.5 ${box}`}>
      <button type="button" className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium" onClick={onToggle}>
        <span>{title}</span>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} className="flex-none" />
      </button>
      {open && <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-ink-soft">{children}</ul>}
    </div>
  );
}

function Count({
  label,
  add,
  remove,
  removeWord,
  note,
}: {
  label: string;
  add: number;
  remove?: number;
  /** "off" for donors (switched off, not removed). */
  removeWord?: string;
  note: string;
}) {
  return (
    <div className="rounded-card border border-line-soft bg-surface px-3 py-2.5">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="flex flex-wrap items-baseline gap-x-2 text-2xl font-semibold tabular-nums text-ink">
        <span>+{number(add)}</span>
        {remove !== undefined && (
          <span className={remove ? "text-danger" : "text-ink-faint"}>
            −{number(remove)}
            {removeWord && <span className="ml-1 text-xs font-medium">{removeWord}</span>}
          </span>
        )}
      </p>
      <p className="text-xs text-ink-muted">{note}</p>
    </div>
  );
}
