"use client";

// Add or edit a lead. Name and mobile number are all that is required - a devotee meeting someone
// at a festival stall can save them in ten seconds and fill in the rest later. Everything else is
// grouped so the form reads top to bottom: who, what they care about, where they live, their days.

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiClient } from "@/lib/api";
import { istInputToISO, istToday } from "@/lib/format";
import {
  FOLLOW_UP_PRESETS,
  INTERESTS,
  PRIORITY,
  SOURCES,
  addressLine,
  leadsChanged,
  toIstInput,
  type DevoteeConfig,
  type DevoteeLead,
  type Priority,
} from "@/lib/devotee";
import { Alert, Button, Field, Input, SegmentedControl, Select, Textarea } from "@/components/ui";
import { LocationPicker } from "./location-picker";
import type { MapAddress } from "@/lib/google-maps";

const ADDRESS_FIELDS = ["address_line", "area", "city", "pincode"] as const;

type Form = Record<
  | "name" | "phone" | "alt_phone" | "email" | "occupation" | "organisation" | "interest" | "source" | "referred_by"
  | "expected_amount" | "date_of_birth" | "anniversary_date" | "address_line" | "area" | "city" | "pincode"
  | "landmark" | "notes" | "next_follow_up_at",
  string
> & { priority: Priority; location: { lat: number; lng: number } | null };

const fromLead = (l?: DevoteeLead | null): Form => ({
  name: l?.name ?? "",
  phone: l?.phone ?? "",
  alt_phone: l?.alt_phone ?? "",
  email: l?.email ?? "",
  occupation: l?.occupation ?? "",
  organisation: l?.organisation ?? "",
  interest: l?.interest ?? "",
  source: l?.source ?? "",
  referred_by: l?.referred_by ?? "",
  expected_amount: l?.expected_amount ? String(l.expected_amount) : "",
  date_of_birth: l?.date_of_birth ?? "",
  anniversary_date: l?.anniversary_date ?? "",
  address_line: l?.address_line ?? "",
  area: l?.area ?? "",
  city: l?.city ?? (l ? "" : "Visakhapatnam"),
  pincode: l?.pincode ?? "",
  landmark: l?.landmark ?? "",
  notes: l?.notes ?? "",
  next_follow_up_at: toIstInput(l?.next_follow_up_at),
  priority: l?.priority ?? "warm",
  location: l && l.latitude !== null && l.longitude !== null ? { lat: l.latitude, lng: l.longitude } : null,
});

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-panel border border-line-soft bg-surface p-4 shadow-card sm:p-5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function LeadForm({
  lead,
  config,
  onSaved,
  onCancel,
}: {
  lead?: DevoteeLead | null;
  config: DevoteeConfig | null;
  onSaved: (lead: DevoteeLead) => void;
  onCancel: () => void;
}) {
  const editing = !!lead;
  const [f, setF] = useState<Form>(() => fromLead(lead));
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  // The map's address, held back when it differs from what the devotee typed themselves.
  const [offered, setOffered] = useState<MapAddress | null>(null);
  // What the map last wrote into each address field. A field still holding that value was not
  // typed by the devotee, so moving the pin may replace it freely.
  // The city a new lead starts with is a default, not something the devotee typed.
  const mapWrote = useRef<Partial<Record<(typeof ADDRESS_FIELDS)[number], string>>>(lead ? {} : { city: "Visakhapatnam" });
  const latest = useRef(f);
  useEffect(() => {
    latest.current = f;
  });

  /** A pin was placed: fill the fields the devotee has not typed; offer the map's version of the rest. */
  function fromMap(a: MapAddress) {
    const now = latest.current;
    const next: Partial<Form> = {};
    let typedDiffers = false;
    for (const k of ADDRESS_FIELDS) {
      const mine = now[k].trim();
      if (!mine || mine === mapWrote.current[k]) {
        next[k] = a[k];
        mapWrote.current[k] = a[k];
      } else if (a[k] && mine !== a[k]) {
        typedDiffers = true;
      }
    }
    set(next);
    setOffered(typedDiffers ? a : null);
  }

  /** Take the map's address for the whole address, so the four fields describe one place. */
  function applyMapAddress() {
    if (!offered) return;
    const next: Partial<Form> = {};
    for (const k of ADDRESS_FIELDS) {
      next[k] = offered[k];
      mapWrote.current[k] = offered[k];
    }
    set(next);
    setOffered(null);
  }

  const phone = f.phone.replace(/\D/g, "").slice(-10);
  const missing = { name: !f.name.trim(), phone: phone.length !== 10 || !/^[6-9]/.test(phone) };

  async function save() {
    setShown(true);
    setError(null);
    setDuplicate(null);
    if (missing.name || missing.phone) return;
    setBusy(true);
    const body = {
      name: f.name,
      phone,
      alt_phone: f.alt_phone,
      email: f.email,
      occupation: f.occupation,
      organisation: f.organisation,
      interest: f.interest,
      source: f.source,
      referred_by: f.referred_by,
      priority: f.priority,
      expected_amount: f.expected_amount,
      date_of_birth: f.date_of_birth,
      anniversary_date: f.anniversary_date,
      address_line: f.address_line,
      area: f.area,
      city: f.city,
      pincode: f.pincode,
      landmark: f.landmark,
      notes: f.notes,
      latitude: f.location?.lat ?? null,
      longitude: f.location?.lng ?? null,
      // On edit the follow-up is changed from the lead page, not here.
      ...(editing ? {} : { next_follow_up_at: f.next_follow_up_at ? istInputToISO(f.next_follow_up_at) : null }),
    };
    try {
      const r = editing
        ? await apiClient.patch<{ lead: DevoteeLead }>(`/api/devotee/leads/${lead!.id}`, body)
        : await apiClient.post<{ lead: DevoteeLead }>("/api/devotee/leads", body);
      leadsChanged();
      onSaved(r.lead);
    } catch (e) {
      const err = e as Error & { status?: number; data?: { lead_id?: string } };
      setError(err.message || "Could not save. Try again.");
      if (err.status === 409 && err.data?.lead_id) setDuplicate(err.data.lead_id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      noValidate
    >
      {error && (
        <Alert
          tone="danger"
          action={
            duplicate ? (
              <Link className="text-sm font-semibold underline" href={`/devotee/leads/${duplicate}`}>
                Open that lead
              </Link>
            ) : undefined
          }
        >
          {error}
        </Alert>
      )}

      <Section title="Contact" hint="Only the name and mobile number are needed to save.">
        <Field label="Full name" required htmlFor="dl-name" error={shown && missing.name ? "Enter the name." : undefined}>
          <Input id="dl-name" autoComplete="off" value={f.name} onChange={(e) => set({ name: e.target.value })} invalid={shown && missing.name} placeholder="e.g. Ravi Kumar" />
        </Field>
        <Field label="Mobile number" required htmlFor="dl-phone" error={shown && missing.phone ? "Enter a 10-digit mobile number." : undefined}>
          <Input id="dl-phone" type="tel" inputMode="numeric" autoComplete="off" value={f.phone} onChange={(e) => set({ phone: e.target.value.replace(/[^\d+\s]/g, "") })} invalid={shown && missing.phone} placeholder="10-digit number" />
        </Field>
        <Field label="Other number" hint="Optional" htmlFor="dl-alt">
          <Input id="dl-alt" type="tel" inputMode="numeric" value={f.alt_phone} onChange={(e) => set({ alt_phone: e.target.value.replace(/[^\d+\s]/g, "") })} />
        </Field>
        <Field label="Email" hint="Optional" htmlFor="dl-email">
          <Input id="dl-email" type="email" inputMode="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
      </Section>

      <Section title="About them" hint="Helps you plan what to talk about.">
        <Field label="Interested in">
          <Select value={f.interest} onChange={(v) => set({ interest: v })} options={INTERESTS} placeholder="Choose…" ariaLabel="Interested in" />
        </Field>
        <Field label="How you met">
          <Select value={f.source} onChange={(v) => set({ source: v })} options={SOURCES} placeholder="Choose…" ariaLabel="How you met" />
        </Field>
        <Field label="Chance of donating">
          <SegmentedControl
            options={(["hot", "warm", "cold"] as const).map((v) => ({ value: v, label: PRIORITY[v].label }))}
            value={f.priority}
            onChange={(v) => set({ priority: v })}
            className="w-full [&>button]:flex-1"
          />
        </Field>
        <Field label="Expected donation (₹)" hint="Optional">
          <Input inputMode="numeric" value={f.expected_amount} onChange={(e) => set({ expected_amount: e.target.value.replace(/[^\d.]/g, "") })} />
        </Field>
        <Field label="Occupation" hint="Optional">
          <Input value={f.occupation} onChange={(e) => set({ occupation: e.target.value })} />
        </Field>
        <Field label="Organisation" hint="Optional">
          <Input value={f.organisation} onChange={(e) => set({ organisation: e.target.value })} />
        </Field>
        {f.source === "referral" && (
          <Field label="Referred by" className="sm:col-span-2">
            <Input value={f.referred_by} onChange={(e) => set({ referred_by: e.target.value })} />
          </Field>
        )}
      </Section>

      <Section title="Address and location" hint="Pin the location to see them on your map and get directions.">
        <Field label="House / street" className="sm:col-span-2">
          <Input value={f.address_line} onChange={(e) => set({ address_line: e.target.value })} placeholder="Door no., building, street" />
        </Field>
        <Field label="Area / locality">
          <Input value={f.area} onChange={(e) => set({ area: e.target.value })} placeholder="e.g. MVP Colony" />
        </Field>
        <Field label="Landmark">
          <Input value={f.landmark} onChange={(e) => set({ landmark: e.target.value })} />
        </Field>
        <Field label="City">
          <Input value={f.city} onChange={(e) => set({ city: e.target.value })} />
        </Field>
        <Field label="PIN code">
          <Input inputMode="numeric" maxLength={6} value={f.pincode} onChange={(e) => set({ pincode: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <div className="sm:col-span-2">
          <LocationPicker
            value={f.location}
            onChange={(location) => {
              set({ location });
              if (!location) setOffered(null);
            }}
            onAddress={fromMap}
            address={addressLine(f)}
            config={config}
          />
          {offered && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-control bg-info-wash px-3 py-2 text-xs text-sky-900">
              <span>
                The map says: <strong>{[offered.address_line, offered.area, offered.city, offered.pincode].filter(Boolean).join(", ")}</strong>
              </span>
              <span className="flex gap-2">
                <Button size="xs" onClick={applyMapAddress}>
                  Use map address
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setOffered(null)}>
                  Keep mine
                </Button>
              </span>
            </div>
          )}
        </div>
      </Section>

      <Section title="Special days" hint="Optional. Good days to call with blessings.">
        <Field label="Birthday">
          <Input type="date" max={istToday()} value={f.date_of_birth} onChange={(e) => set({ date_of_birth: e.target.value })} />
        </Field>
        <Field label="Wedding anniversary">
          <Input type="date" max={istToday()} value={f.anniversary_date} onChange={(e) => set({ anniversary_date: e.target.value })} />
        </Field>
      </Section>

      <Section title={editing ? "Notes" : "Notes and first follow-up"}>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Family, what they said, anything to remember" />
        </Field>
        {!editing && (
          <div className="sm:col-span-2">
            <p className="mb-1.5 text-xs font-medium text-ink-soft">When to follow up</p>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {FOLLOW_UP_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => set({ next_follow_up_at: toIstInput(p.at().toISOString()) })}
                  className="rounded-full px-2.5 py-1 text-xs font-medium text-ink-soft ring-1 ring-inset ring-line-soft hover:bg-sunken"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Input
              type="datetime-local"
              value={f.next_follow_up_at}
              min={toIstInput(new Date().toISOString())}
              onChange={(e) => set({ next_follow_up_at: e.target.value })}
              aria-label="First follow-up date and time"
              className="sm:max-w-xs"
            />
          </div>
        )}
      </Section>

      <div className="sticky bottom-20 z-10 flex justify-end gap-2 rounded-panel border border-line-soft bg-surface/95 p-3 shadow-raised backdrop-blur md:bottom-4">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} icon="check">
          {editing ? "Save changes" : "Save lead"}
        </Button>
      </div>
    </form>
  );
}
