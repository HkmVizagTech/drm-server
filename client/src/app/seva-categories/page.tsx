"use client";

// Seva categories: the list of sevas a receipt can be raised for, with the Seva Code
// the donation sites' DCC call expects.
//
// Where DRM raises a receipt for HKM Vizag (the cash receipt form, a QR payment, a
// collected entry) the seva is picked from this list and its code is sent. Nothing
// here is ever deleted - a seva is switched off to stop it being offered, so a
// receipt raised against it last year still points at something.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { number } from "@/lib/format";
import { downloadSample, readSpreadsheet, SPREADSHEET_ACCEPT, type ParsedSheet } from "@/lib/spreadsheet";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  SkeletonRows,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
} from "@/components/ui";
import { toast } from "@/components/toast";

interface Seva {
  id: string;
  category: string;
  categoryId: number;
  code: string;
  subCategory: string;
  subCategoryId: number;
  subCode: string | null;
  subCodeId: number | null;
  isActive: boolean;
  taxExempted: boolean | null;
  name: string;
}

const PER_PAGE = 25;

export default function SevaCategoriesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [all, setAll] = useState<Seva[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [state, setState] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Seva | "new" | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get<{ sevas: Seva[] }>("/api/seva-catalog");
      setAll(r.sevas);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of all ?? []) if (!m.has(s.categoryId)) m.set(s.categoryId, s.category);
    return [...m];
  }, [all]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (all ?? []).filter(
      (s) =>
        (!category || String(s.categoryId) === category) &&
        (!state || (state === "active" ? s.isActive : !s.isActive)) &&
        (!q || `${s.category} ${s.subCategory} ${s.code} ${s.subCode ?? ""}`.toLowerCase().includes(q))
    );
  }, [all, search, category, state]);
  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  const rows = shown.slice((Math.min(page, pages) - 1) * PER_PAGE, Math.min(page, pages) * PER_PAGE);

  async function toggle(s: Seva) {
    try {
      await apiClient.patch(`/api/seva-catalog/${s.id}`, { is_active: !s.isActive });
      toast.success(s.isActive ? "Switched off - no longer offered on receipts" : "Switched on");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div>
      <PageHeader
        title="Seva categories"
        subtitle="The sevas a receipt can be raised for. When a receipt is raised for HKM Vizag, the seva is picked from this list and its Seva Code is sent to DCC."
        actions={
          isAdmin ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" icon="upload" onClick={() => setImporting(true)}>
                Import sheet
              </Button>
              <Button icon="plus" onClick={() => setEditing("new")}>
                Add seva
              </Button>
            </div>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search category, seva or code"
          className="w-full sm:w-72"
        />
        <Select
          value={category}
          onChange={(v) => {
            setCategory(v);
            setPage(1);
          }}
          ariaLabel="Category"
          className="w-56"
        >
          <option value="">All categories</option>
          {categories.map(([id, name]) => (
            <option key={id} value={String(id)}>
              {name}
            </option>
          ))}
        </Select>
        <Select
          value={state}
          onChange={(v) => {
            setState(v);
            setPage(1);
          }}
          ariaLabel="Status"
          className="w-40"
        >
          <option value="">Active and off</option>
          <option value="active">Active only</option>
          <option value="off">Switched off</option>
        </Select>
      </div>

      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <TableShell>
        <Thead>
          <Th>Seva category</Th>
          <Th>Seva sub category</Th>
          <Th>Seva code</Th>
          <Th>Seva sub code</Th>
          <Th>Tax exempted</Th>
          <Th>Status</Th>
          {isAdmin && <Th>Actions</Th>}
        </Thead>
        {!all ? (
          <SkeletonRows rows={8} cols={isAdmin ? 7 : 6} />
        ) : (
          <Tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={isAdmin ? 7 : 6}>
                  <EmptyState
                    icon="list"
                    title="No sevas found"
                    message={all.length ? "Nothing matches that search." : "Add a seva, or import the temple's sheet."}
                  />
                </td>
              </tr>
            ) : (
              rows.map((s) => (
                <tr key={s.id} className={s.isActive ? undefined : "opacity-60"}>
                  <Td>
                    {s.category}
                    <span className="ml-1.5 text-xs text-ink-faint">#{s.categoryId}</span>
                  </Td>
                  <Td className="font-medium text-ink">
                    {s.subCategory}
                    <span className="ml-1.5 text-xs font-normal text-ink-faint">#{s.subCategoryId}</span>
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs">{s.code}</Td>
                  <Td>
                    {s.subCode ? (
                      <>
                        {s.subCode}
                        <span className="ml-1.5 text-xs text-ink-faint">#{s.subCodeId}</span>
                      </>
                    ) : (
                      <span className="text-ink-faint">-</span>
                    )}
                  </Td>
                  <Td>
                    {s.taxExempted === null ? <span className="text-ink-faint">-</span> : s.taxExempted ? "Yes" : "No"}
                  </Td>
                  <Td>
                    <Badge tone={s.isActive ? "good" : "neutral"} dot>
                      {s.isActive ? "Active" : "Off"}
                    </Badge>
                  </Td>
                  {isAdmin && (
                    <Td>
                      <div className="flex items-center gap-2">
                        <Button size="xs" variant="secondary" icon="edit" onClick={() => setEditing(s)}>
                          Edit
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => void toggle(s)}>
                          {s.isActive ? "Switch off" : "Switch on"}
                        </Button>
                      </div>
                    </Td>
                  )}
                </tr>
              ))
            )}
            {shown.length > 0 && (
              <tr>
                <td colSpan={isAdmin ? 7 : 6} className="p-0">
                  <Pagination
                    page={Math.min(page, pages)}
                    limit={PER_PAGE}
                    total={shown.length}
                    totalPages={pages}
                    onPage={setPage}
                    unit="sevas"
                  />
                </td>
              </tr>
            )}
          </Tbody>
        )}
      </TableShell>

      {editing && (
        <SevaForm
          seva={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            toast.success("Saved");
            await load();
          }}
        />
      )}
      {importing && (
        <ImportSheet
          onClose={() => setImporting(false)}
          onDone={async (msg) => {
            setImporting(false);
            toast.success(msg);
            await load();
          }}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------- add / edit form */

function SevaForm({ seva, onClose, onSaved }: { seva: Seva | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const editing = !!seva;
  const [f, setF] = useState({
    category: seva?.category ?? "",
    category_id: seva ? String(seva.categoryId) : "",
    code: seva?.code ?? "",
    sub_category: seva?.subCategory ?? "",
    sub_category_id: seva ? String(seva.subCategoryId) : "",
    sub_code: seva?.subCode ?? "",
    sub_code_id: seva?.subCodeId != null ? String(seva.subCodeId) : "",
    tax: seva?.taxExempted ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { ...f, is_tax_exempted: f.tax };
      if (editing) await apiClient.patch(`/api/seva-catalog/${seva!.id}`, body);
      else await apiClient.post("/api/seva-catalog", body);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editing ? "Edit seva" : "Add seva"}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="check" loading={busy} onClick={() => void save()}>
            {editing ? "Save" : "Add seva"}
          </Button>
        </>
      }
    >
      <h3 className="text-sm font-semibold text-ink">Seva structure</h3>
      <p className="mb-4 mt-1 text-sm text-ink-muted">
        The main category, sub category and the internal IDs used to organise this seva. The Seva Code is what DCC is sent.
        {editing ? " The IDs identify the seva and cannot be changed." : ""}
      </p>
      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Seva category" required className="sm:col-span-2">
          <Input value={f.category} onChange={(e) => set({ category: e.target.value })} placeholder="e.g. Cultural Program" />
        </Field>
        <Field label="Seva category ID" required>
          <Input inputMode="numeric" value={f.category_id} disabled={editing} onChange={(e) => set({ category_id: e.target.value })} placeholder="e.g. 3" />
        </Field>
        <Field label="Seva code" required hint="Sent to DCC">
          <Input value={f.code} onChange={(e) => set({ code: e.target.value })} placeholder="e.g. DEEP" />
        </Field>
        <Field label="Seva sub category" required className="sm:col-span-2">
          <Input value={f.sub_category} onChange={(e) => set({ sub_category: e.target.value })} placeholder="e.g. Deepotsava" />
        </Field>
        <Field label="Seva sub category ID" required>
          <Input inputMode="numeric" value={f.sub_category_id} disabled={editing} onChange={(e) => set({ sub_category_id: e.target.value })} placeholder="e.g. 5" />
        </Field>
        <div />
        <Field label="Seva sub code" hint="Optional - leave blank when this seva has none">
          <Input value={f.sub_code} onChange={(e) => set({ sub_code: e.target.value })} placeholder="e.g. Annadana Seva" />
        </Field>
        <Field label="Seva sub code ID" hint="Needed when there is a sub code">
          <Input inputMode="numeric" value={f.sub_code_id} disabled={editing} onChange={(e) => set({ sub_code_id: e.target.value })} placeholder="e.g. 1" />
        </Field>
        <div className="sm:col-span-2">
          <Checkbox checked={f.tax} onChange={(on) => set({ tax: on })} label="Tax exempted" />
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------- import */

interface ImportResult {
  dry_run: boolean;
  new: number;
  changed: number;
  same: number;
  problems: number;
  repeated: number;
  not_in_file: number;
  issues: { row: number; status: "problem" | "repeated"; message: string }[];
  changes: { row: number; seva: string; fields: { field: string; from: unknown; to: unknown }[] }[];
}

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "(blank)" : v === true ? "Yes" : v === false ? "No" : String(v));

/**
 * Upload the temple's sheet. It is compared with the list first and nothing is
 * written until the person presses the button: they see how many are new, which
 * differ (and exactly how), and which already match. That is also how a mistake in
 * the list is found - re-uploading the real sheet shows every value that differs.
 */
function ImportSheet({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const send = (s: ParsedSheet, dry: boolean) =>
    apiClient.post<ImportResult>("/api/seva-catalog/import", {
      headers: s.headers,
      rows: s.rows,
      row_numbers: s.rowNumbers,
      dry_run: dry,
    });

  async function choose(file: File | undefined) {
    if (input.current) input.current.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const first = (await readSpreadsheet(file))[0];
      setSheet(first);
      setFileName(file.name);
      setResult(await send(first, true));
    } catch (e) {
      setSheet(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!sheet) return;
    setBusy(true);
    setError(null);
    try {
      const r = await send(sheet, false);
      await onDone(`${r.new} added, ${r.changed} corrected`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const nothing = !result || (result.new === 0 && result.changed === 0);

  return (
    <Modal
      title="Import sheet"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="upload" disabled={nothing} loading={busy} onClick={() => void apply()}>
            {result && !nothing ? `Add ${result.new} and correct ${result.changed}` : "Import"}
          </Button>
        </>
      }
    >
      <input ref={input} type="file" accept={SPREADSHEET_ACCEPT} className="hidden" onChange={(e) => void choose(e.target.files?.[0])} />
      <p className="mb-3 text-sm text-ink-muted">
        Upload the temple's seva sheet (Excel or CSV) with the columns <b className="text-ink">Seva Category, Seva Sub Category,
        Seva Code, Seva Sub Code, SevaCategoryId, SevaSubCategoryId, SevaSubCategoryCodeId, IsActive, IsTaxEempted</b>. Sevas
        already in DRM are compared, never duplicated: only new ones are added, and any that differ are shown below and
        corrected to match the sheet. Whether a seva is switched on stays as it is in DRM. Nothing is changed until you press
        the button.
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" icon="file" loading={busy && !result} onClick={() => input.current?.click()}>
          {sheet ? "Choose another file" : "Choose file"}
        </Button>
        <Button
          variant="ghost"
          icon="download"
          onClick={() =>
            downloadSample("seva-catalog-sample.csv", [
              ["Account Type", "Seva Category", "Seva Sub Category", "Seva Code", "Seva Sub Code", "SevaCategoryId", "SevaSubCategoryId", "SevaSubCategoryCodeId", "IsActive", "IsTaxEempted"],
              ["HKMI", "General Donation", "Brick Seva", "BSC", "NULL", "2", "103", "NULL", "1", "NULL"],
              ["HKMI", "Cultural Program", "Deepotsava", "DEEP", "Annadana Seva", "3", "5", "1", "1", "1"],
            ])
          }
        >
          Download sample
        </Button>
        {fileName && <span className="text-sm text-ink-muted">{fileName}</span>}
      </div>
      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {result && (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Badge tone="good" dot>{number(result.new)} new</Badge>
            <Badge tone={result.changed ? "warn" : "neutral"} dot>{number(result.changed)} differ from DRM</Badge>
            <Badge tone="neutral" dot>{number(result.same)} already match</Badge>
            {result.repeated > 0 && <Badge tone="warn" dot>{number(result.repeated)} repeated in the file</Badge>}
            {result.problems > 0 && <Badge tone="danger" dot>{number(result.problems)} with a problem</Badge>}
            {result.not_in_file > 0 && <Badge tone="neutral" dot>{number(result.not_in_file)} in DRM but not in this file</Badge>}
          </div>
          {result.changes.length > 0 && (
            <div className="mb-3 max-h-56 overflow-y-auto rounded-control ring-1 ring-line-soft">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-sunken text-left text-2xs uppercase tracking-[0.06em] text-ink-muted">
                  <tr>
                    <th className="px-3 py-2">Row</th>
                    <th className="px-3 py-2">Seva</th>
                    <th className="px-3 py-2">DRM has</th>
                    <th className="px-3 py-2">Sheet says</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {result.changes.flatMap((c) =>
                    c.fields.map((x) => (
                      <tr key={`${c.row}-${x.field}`}>
                        <td className="px-3 py-2 tabular-nums">{c.row}</td>
                        <td className="px-3 py-2">
                          {c.seva}
                          <span className="block text-xs text-ink-muted">{x.field}</span>
                        </td>
                        <td className="px-3 py-2 text-ink-soft">{show(x.from)}</td>
                        <td className="px-3 py-2 font-medium text-ink">{show(x.to)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
          {result.issues.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-control ring-1 ring-line-soft">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-line-soft">
                  {result.issues.map((x) => (
                    <tr key={`${x.row}-${x.status}`}>
                      <td className="px-3 py-2 tabular-nums">Row {x.row}</td>
                      <td className="px-3 py-2 text-ink-soft">{x.message[0].toUpperCase() + x.message.slice(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
