"use client";

// Raise a receipt, as a devotee: money taken in cash, UPI, cheque or a bank transfer, in the
// HKMI or TSC account the chosen seva belongs to. The same donor fields as the office's form
// (DonorFields: donor, seva category and seva, 80G), without Maha Prasadam. DRM sends it straight
// to DCC, which numbers it, and draws the PDF itself; no WhatsApp goes out - the devotee shares the
// receipt with the donor from their own WhatsApp (ReceiptActions). It is filed on the devotee's own
// list and the donor's lead. If DCC does not answer, the receipt is kept on the list to retry.

import { useState } from "react";
import { apiClient } from "@/lib/api";
import { istToday } from "@/lib/format";
import { leadsChanged, type DevoteeLead } from "@/lib/devotee";
import { currency } from "@/lib/format";
import { Alert, Button, Field, Input, Modal, SegmentedControl } from "@/components/ui";
import { DonorFields, digits10, emptyReceipt, receiptProblems, type ReceiptValues } from "@/components/receipts/receipt-form";
import { ReceiptActions, type ShareableReceipt } from "./receipt-share";

type Mode = "cash" | "upi" | "cheque" | "bank";

export function DevoteeReceiptDialog({
  lead,
  onClose,
  onSaved,
}: {
  /** Raising from a lead: the donor is filled in from it, and the receipt is filed on it. */
  lead?: Pick<DevoteeLead, "id" | "name" | "phone" | "email" | "address_line" | "area" | "city" | "pincode"> | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const address = lead ? [lead.address_line, lead.area, lead.city, lead.pincode].filter(Boolean).join(", ") : "";
  const [v, setV] = useState<ReceiptValues>({
    ...emptyReceipt(),
    site: "hkmv",
    donorName: lead?.name ?? "",
    mobile: lead?.phone ?? "",
    email: lead?.email ?? "",
    address,
  });
  const set = (patch: Partial<ReceiptValues>) => setV((x) => ({ ...x, ...patch, site: "hkmv" }));
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<Mode>("cash");
  const [txn, setTxn] = useState("");
  const [paidOn, setPaidOn] = useState(istToday());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState<ShareableReceipt | null>(null);

  const amt = Number(amount);
  const needTxn = mode !== "cash";
  const problem =
    !Number.isFinite(amt) || amt <= 0
      ? "Enter the Amount."
      : needTxn && !txn.trim()
      ? mode === "cheque"
        ? "Enter the Cheque No."
        : "Enter the Transaction ID (UTR)."
      : needTxn && mode !== "cheque" && txn.trim().length < 12
      ? "The Transaction ID (UTR) must be at least 12 characters."
      : !v.sevaCatalogId
      ? "Choose the Seva."
      : receiptProblems(v, { needSite: false });

  async function send() {
    setShown(true);
    if (problem) return;
    setBusy(true);
    setError(null);
    const mobile = digits10(v.mobile);
    try {
      const r = await apiClient.post<{ id: string | null; receiptNumber: string | null; share_token: string | null }>("/api/devotee/receipts", {
        lead_id: lead?.id,
        donor_name: v.donorName.trim(),
        donor_mobile: mobile,
        donor_email: v.email.trim() || undefined,
        amount: amt,
        payment_mode: mode,
        reference_no: needTxn ? txn.trim() : undefined,
        payment_date: paidOn || undefined,
        seva_catalog_id: v.sevaCatalogId,
        sevak_name: v.onNameOf.trim() || undefined,
        want_certificate: v.want80G,
        pan_number: v.want80G ? v.pan.trim().toUpperCase() : undefined,
        address: v.address.trim() || undefined,
      });
      setDone({
        id: r.id ?? "",
        donor_name: v.donorName.trim(),
        donor_mobile: mobile,
        amount: amt,
        seva_name: v.seva || null,
        receipt_number: r.receiptNumber,
        share_token: r.share_token,
      });
      leadsChanged();
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not raise the receipt. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Modal title="Receipt raised" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
        <div className="py-2 text-center">
          <p className="text-3xl font-semibold tabular-nums text-ink">{currency(done.amount)}</p>
          <p className="mt-2 text-sm text-ink-muted">
            {done.receipt_number ? (
              <>
                Receipt No. <span className="font-mono font-semibold text-brand-700">{done.receipt_number}</span>
              </>
            ) : (
              "Receipt No. will show soon."
            )}
          </p>
          <p className="mt-1 text-sm text-ink-muted">{done.donor_name} · {done.donor_mobile}</p>
        </div>
        <div className="mt-4 rounded-card bg-sunken/60 p-3">
          <p className="mb-2 text-sm text-ink-soft">Send the receipt to the donor from your WhatsApp:</p>
          {done.id ? <ReceiptActions r={done} /> : <p className="text-sm text-ink-muted">It is on your Receipts page.</p>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={lead ? `Raise receipt · ${lead.name}` : "Raise receipt"}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="receipt" loading={busy} onClick={() => void send()}>
            Raise receipt
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {shown && problem && !error && <Alert tone="warn">{problem}</Alert>}
        <p className="text-sm text-ink-muted">
          The receipt is issued through DCC. Then send it to the donor from your own WhatsApp.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount" htmlFor="dr-amount" required>
            <Input id="dr-amount" type="number" min="1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="₹" />
          </Field>
          <Field label="Date" htmlFor="dr-date">
            <Input id="dr-date" type="date" value={paidOn} max={istToday()} onChange={(e) => setPaidOn(e.target.value)} />
          </Field>
        </div>

        <Field label="Paid by">
          <SegmentedControl
            options={[
              { value: "cash", label: "Cash" },
              { value: "upi", label: "UPI" },
              { value: "cheque", label: "Cheque" },
              { value: "bank", label: "Bank" },
            ]}
            value={mode}
            onChange={(m) => setMode(m as Mode)}
            className="w-full [&>button]:flex-1"
          />
        </Field>
        {needTxn && (
          <Field label={mode === "cheque" ? "Cheque No." : "Transaction ID (UTR)"} htmlFor="dr-txn" required>
            <Input
              id="dr-txn"
              value={txn}
              inputMode="numeric"
              onChange={(e) => setTxn(e.target.value)}
              placeholder={mode === "cheque" ? "e.g. 004512" : "12-digit number"}
            />
          </Field>
        )}

        <DonorFields v={v} set={set} showPrasadam={false} showSite={false} showMyDonor={false} askAddress />
      </div>
    </Modal>
  );
}
