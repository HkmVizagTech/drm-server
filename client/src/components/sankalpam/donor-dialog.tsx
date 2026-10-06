"use client";

// Add or change one donor and their special days.
//
// Kept to one screen: the donor at the top, their days underneath as rows of
// occasion + day + month. The year is optional and only shown, never used -
// the day comes round every year whatever it says.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { toast } from "@/components/toast";
import { DAYS_IN, MONTHS_LONG, OCCASIONS, type SankalpDate, type SankalpDonor } from "@/lib/sankalpam";
import { Alert, Button, Field, Icon, Input, Modal, Select, Skeleton, Textarea, Toggle } from "@/components/ui";

interface Form {
  donor_name: string;
  sevak_name: string;
  phone: string;
  alt_phone: string;
  patron_number: string;
  preacher: string;
  gotram: string;
  address: string;
  notes: string;
  active: boolean;
  dates: (SankalpDate & { key: string })[];
}

let k = 0;
const newDay = (): SankalpDate & { key: string } => ({ key: `n${++k}`, occasion: "", day: 0, month: 0, orig_year: null });

const empty = (): Form => ({
  donor_name: "",
  sevak_name: "",
  phone: "",
  alt_phone: "",
  patron_number: "",
  preacher: "",
  gotram: "",
  address: "",
  notes: "",
  active: true,
  dates: [newDay()],
});

export function DonorDialog({
  donorId,
  onClose,
  onSaved,
}: {
  /** null to add a new donor. */
  donorId: string | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { user } = useAuth();
  const [id, setId] = useState<string | null>(donorId);
  const [f, setF] = useState<Form>(empty);
  const [loading, setLoading] = useState(!!donorId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [already, setAlready] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));

  useEffect(() => {
    if (!id) return;
    let live = true;
    apiClient
      .get<{ donor: SankalpDonor }>(`/api/sankalpam/donors/${id}`)
      .then(({ donor: d }) => {
        if (!live) return;
        setF({
          donor_name: d.donor_name ?? "",
          sevak_name: d.sevak_name ?? "",
          phone: d.phone ?? "",
          alt_phone: d.alt_phone ?? "",
          patron_number: d.patron_number ?? "",
          preacher: d.preacher ?? "",
          gotram: d.gotram ?? "",
          address: d.address ?? "",
          notes: d.notes ?? "",
          active: d.active,
          dates: d.dates.length ? d.dates.map((x) => ({ ...x, key: x.id ?? `n${++k}` })) : [newDay()],
        });
        setAlready(null);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id]);

  // Adding someone who is already here? Say so, and offer to open them -
  // a second copy of a donor means two videos on one day.
  const digits = f.phone.replace(/\D/g, "").slice(-10);
  useEffect(() => {
    if (id || digits.length !== 10) return;
    let live = true;
    const t = window.setTimeout(async () => {
      try {
        const r = await apiClient.get<{ donors: SankalpDonor[] }>(`/api/sankalpam/donors?search=${digits}&limit=1&show=all`);
        if (!live) return;
        const d = r.donors[0];
        setAlready(d ? { id: d.id, name: d.donor_name } : null);
        if (!d) {
          // Not here yet; a donor DRM already knows fills in the blanks.
          const p = (await apiClient.get<{ people: Record<string, unknown>[] }>(`/api/people?search=${digits}&limit=1`)).people?.[0];
          if (live && p) {
            setF((x) => ({
              ...x,
              donor_name: x.donor_name || String(p.name ?? ""),
              address: x.address || String(p.prasadam_address ?? p.address ?? ""),
            }));
          }
        }
      } catch {
        /* a convenience */
      }
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [digits, id]);

  const setDay = (key: string, patch: Partial<SankalpDate>) =>
    setF((x) => ({ ...x, dates: x.dates.map((d) => (d.key === key ? { ...d, ...patch } : d)) }));

  async function save() {
    setError(null);
    if (!f.donor_name.trim()) return setError("Enter the Donor Name.");
    if (digits && digits.length !== 10) return setError("Enter a 10-digit mobile number.");
    const dates = f.dates.filter((d) => d.occasion.trim() || d.day || d.month);
    for (const d of dates) {
      if (!d.occasion.trim()) return setError("Enter the occasion for every day.");
      if (!d.day || !d.month) return setError(`Pick the day and month for "${d.occasion}".`);
      if (d.day > DAYS_IN[d.month - 1]) return setError(`${MONTHS_LONG[d.month - 1]} has no ${d.day}th.`);
    }
    setBusy(true);
    const body = {
      ...f,
      dates: dates.map((d) => ({
        id: d.id,
        occasion: d.occasion.trim(),
        day: d.day,
        month: d.month,
        orig_year: d.orig_year,
        notes: d.notes ?? null,
        active: d.active !== false,
      })),
    };
    try {
      if (id) await apiClient.put(`/api/sankalpam/donors/${id}`, body);
      else await apiClient.post(`/api/sankalpam/donors`, body);
      toast(id ? "Saved" : `${f.donor_name.trim()} added`);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setBusy(false);
    }
  }

  async function remove() {
    if (!id) return;
    setBusy(true);
    try {
      await apiClient.delete(`/api/sankalpam/donors/${id}`);
      toast(`${f.donor_name} removed`);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove.");
      setBusy(false);
    }
  }

  const dayOptions = (month: number) =>
    Array.from({ length: month ? DAYS_IN[month - 1] : 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));

  return (
    <Modal
      title={id ? "Donor and special days" : "Add sankalp"}
      wide
      onClose={onClose}
      footer={
        <>
          {id && user?.role === "admin" && (
            <Button
              variant={confirmDelete ? "danger" : "ghost"}
              icon="trash"
              className="mr-auto"
              disabled={busy}
              onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
            >
              {confirmDelete ? "Yes, remove for good" : "Remove"}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={loading} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {already && (
        <Alert tone="warn" title={`${already.name} is already here with this number.`}>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => {
              setLoading(true);
              setId(already.id);
            }}
          >
            Open {already.name}
          </Button>
        </Alert>
      )}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Donor Name" htmlFor="sk-name" required>
              <Input id="sk-name" value={f.donor_name} onChange={(e) => set({ donor_name: e.target.value })} />
            </Field>
            <Field label="Mobile Number" htmlFor="sk-phone">
              <Input
                id="sk-phone"
                value={f.phone}
                inputMode="tel"
                className="tabular-nums"
                placeholder="10-digit number"
                onChange={(e) => set({ phone: e.target.value.replace(/[^\d+\s]/g, "") })}
              />
            </Field>
            <Field label="On the name of (optional)" htmlFor="sk-sevak">
              <Input id="sk-sevak" value={f.sevak_name} onChange={(e) => set({ sevak_name: e.target.value })} />
            </Field>
            <Field label="Gotram (optional)" htmlFor="sk-gotram">
              <Input id="sk-gotram" value={f.gotram} onChange={(e) => set({ gotram: e.target.value })} />
            </Field>
          </div>

          {/* The days. The heart of the form, so it sits above the extras. */}
          <div className="rounded-card bg-sunken/60 p-3 sm:p-4">
            <p className="mb-2.5 text-sm font-semibold text-ink">Special days</p>
            <datalist id="sk-occasions">
              {OCCASIONS.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
            <ul className="space-y-2.5">
              {f.dates.map((d) => (
                <li key={d.key} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_8.5rem_5.5rem_auto] sm:items-end">
                  <Field label="Occasion" htmlFor={`sk-occ-${d.key}`} className="col-span-2 sm:col-span-1">
                    <Input
                      id={`sk-occ-${d.key}`}
                      list="sk-occasions"
                      value={d.occasion}
                      placeholder="e.g. Wife Birthday"
                      onChange={(e) => setDay(d.key, { occasion: e.target.value })}
                    />
                  </Field>
                  <div className="col-span-2 grid grid-cols-[5rem_minmax(0,1fr)] items-end gap-2 sm:contents">
                    <Field label="Day">
                      <Select
                        value={d.day ? String(d.day) : ""}
                        onChange={(v) => setDay(d.key, { day: Number(v) })}
                        options={dayOptions(d.month)}
                        placeholder="Day"
                        ariaLabel="Day"
                      />
                    </Field>
                    <Field label="Month">
                      <Select
                        value={d.month ? String(d.month) : ""}
                        onChange={(v) => setDay(d.key, { month: Number(v) })}
                        options={MONTHS_LONG.map((m, i) => ({ value: String(i + 1), label: m }))}
                        placeholder="Month"
                        ariaLabel="Month"
                      />
                    </Field>
                    <div className="col-span-2 flex items-end gap-2 sm:contents">
                    <Field label="Year (opt.)" className="w-24 sm:w-auto">
                      <Input
                        value={d.orig_year ? String(d.orig_year) : ""}
                        inputMode="numeric"
                        maxLength={4}
                        className="tabular-nums"
                        onChange={(e) => {
                          const y = Number(e.target.value.replace(/\D/g, ""));
                          setDay(d.key, { orig_year: y || null });
                        }}
                      />
                    </Field>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="trash"
                      aria-label="Remove this day"
                      className="mb-0.5 h-9.5"
                      onClick={() => setF((x) => ({ ...x, dates: x.dates.filter((y) => y.key !== d.key) }))}
                    />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <Button variant="secondary" size="sm" icon="plus" className="mt-3" onClick={() => setF((x) => ({ ...x, dates: [...x.dates, newDay()] }))}>
              Add a day
            </Button>
            <p className="mt-2 text-xs text-ink-muted">Every day repeats each year.</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Patron No. (optional)" htmlFor="sk-patron">
              <Input id="sk-patron" value={f.patron_number} placeholder="VSI/000123" onChange={(e) => set({ patron_number: e.target.value })} />
            </Field>
            <Field label="Preacher (optional)" htmlFor="sk-preacher">
              <Input id="sk-preacher" value={f.preacher} placeholder="Code, e.g. SYMD" onChange={(e) => set({ preacher: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Other mobile (optional)" htmlFor="sk-alt">
              <Input id="sk-alt" value={f.alt_phone} inputMode="tel" className="tabular-nums" onChange={(e) => set({ alt_phone: e.target.value.replace(/[^\d+\s]/g, "") })} />
            </Field>
            <Field label="Address (optional)" htmlFor="sk-address" className="sm:col-span-3">
              <Textarea id="sk-address" rows={2} value={f.address} onChange={(e) => set({ address: e.target.value })} />
            </Field>
            <Field label="Notes (optional)" htmlFor="sk-notes" className="sm:col-span-3">
              <Textarea id="sk-notes" rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
          </div>

          {id && (
            <label className="flex items-center justify-between gap-3 rounded-card border border-line-soft px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm">
                <Icon name="bell" size={15} className="text-ink-muted" />
                <span>
                  <span className="font-medium text-ink">Remind me of their days</span>
                  <span className="block text-xs text-ink-muted">Switch off to stop without removing them.</span>
                </span>
              </span>
              <Toggle on={f.active} onChange={(on) => set({ active: on })} label="Remind me of their days" />
            </label>
          )}
        </div>
      )}
    </Modal>
  );
}
