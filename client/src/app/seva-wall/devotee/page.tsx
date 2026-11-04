"use client";

// Add record, for a devotee: the honoree's name (what is printed on the brick) and the donation
// receipt number are both required. The record joins the same list the team works from.

import { useState } from "react";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Alert, Button, Field, Input, Select } from "@/components/ui";

const EMPTY = { donor_name: "", honoree_name: "", phone: "", amount: "", receipt_number: "", kind: "", donated_on: "" };

export default function DevoteeAddRecordPage() {
  const { user } = useAuth();
  const [f, setF] = useState(EMPTY);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const set = (p: Partial<typeof EMPTY>) => setF((x) => ({ ...x, ...p }));

  const phone = f.phone.replace(/\D/g, "");
  const missing = {
    honoree_name: !f.honoree_name.trim(),
    receipt_number: !f.receipt_number.trim(),
    donor_name: !f.donor_name.trim(),
    phone: phone.length < 10,
    amount: !(Number(f.amount) >= 1500),
    kind: !f.kind,
  };
  const invalid = Object.values(missing).some(Boolean);

  async function save() {
    setShown(true);
    setError(null);
    setAdded(null);
    if (invalid) return;
    setBusy(true);
    try {
      await apiClient.post("/api/seva-wall/devotee-record", {
        donor_name: f.donor_name.trim(),
        honoree_name: f.honoree_name.trim(),
        phone,
        amount: f.amount,
        receipt_number: f.receipt_number.trim(),
        kind: f.kind,
        donated_on: f.donated_on,
      });
      setAdded(f.honoree_name.trim());
      setF(EMPTY);
      setShown(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the record. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (user && user.role !== "devotee") {
    return <Alert tone="info">This page is for devotees adding brick records. Use the Seva wall from the menu instead.</Alert>;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-xl font-semibold text-ink">Add record</h1>
      <p className="mb-5 text-sm text-ink-muted">The honoree name is printed on the brick.</p>

      {added && <Alert tone="good">Added: {added}. You can add another below.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="mt-4 grid gap-4 rounded-panel border border-line-soft bg-surface p-5 shadow-raised sm:grid-cols-2">
        <Field label="Honoree name" required hint="Printed on the brick" error={shown && missing.honoree_name ? "Enter the honoree's name." : undefined}>
          <Input value={f.honoree_name} onChange={(e) => set({ honoree_name: e.target.value })} invalid={shown && missing.honoree_name} />
        </Field>
        <Field label="Donation receipt no." required error={shown && missing.receipt_number ? "Enter the receipt number." : undefined}>
          <Input value={f.receipt_number} onChange={(e) => set({ receipt_number: e.target.value })} invalid={shown && missing.receipt_number} />
        </Field>
        <Field label="Donor name" required error={shown && missing.donor_name ? "Enter the donor name." : undefined}>
          <Input value={f.donor_name} onChange={(e) => set({ donor_name: e.target.value })} invalid={shown && missing.donor_name} />
        </Field>
        <Field label="Donor phone number" required error={shown && missing.phone ? "Enter the 10-digit number." : undefined}>
          <Input inputMode="numeric" value={f.phone} onChange={(e) => set({ phone: e.target.value })} invalid={shown && missing.phone} />
        </Field>
        <Field label="Amount donated" required error={shown && missing.amount ? "Enter 1500 or more." : undefined}>
          <Input inputMode="numeric" value={f.amount} onChange={(e) => set({ amount: e.target.value })} invalid={shown && missing.amount} />
        </Field>
        <Field label="Seva" required error={shown && missing.kind ? "Choose the seva." : undefined}>
          <Select value={f.kind} onChange={(v) => set({ kind: v })} placeholder="Choose…" ariaLabel="Seva">
            <option value="brick">Brick seva</option>
            <option value="square">Square foot seva</option>
            <option value="mandir">Mandir nirmana seva</option>
          </Select>
        </Field>
        <Field label="Donation date" hint="Optional">
          <Input type="date" value={f.donated_on} onChange={(e) => set({ donated_on: e.target.value })} />
        </Field>
        <div className="flex items-end sm:justify-end">
          <Button size="lg" block loading={busy} onClick={() => void save()}>
            {busy ? "Adding…" : "Add record"}
          </Button>
        </div>
      </div>
    </div>
  );
}
