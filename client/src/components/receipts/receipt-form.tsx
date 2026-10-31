"use client";

// The receipt form. One form for every receipt raised by hand - a temple-QR
// payment or cash/cheque/transfer - laid out like the checkout on our own
// donation sites (Donor Name, Mobile Number, E-mail ID, then the two
// checkboxes for 80G and Maha Prasadam), so staff see the same thing donors
// see and nothing more. Explanations live in these comments, not on screen.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { currency, dateTime, istToday } from "@/lib/format";
import { Alert, Button, Checkbox, Field, Input, Modal, SegmentedControl, Skeleton, Textarea } from "@/components/ui";
import { SevaPicker, sevaListAvailable, useSevaCatalog } from "@/components/receipts/seva-picker";

export interface ReceiptValues {
  donorName: string;
  mobile: string;
  email: string;
  seva: string;
  /** The seva picked from DRM's seva list (HKM Vizag receipts). Its code is what DCC is sent. */
  sevaCatalogId: string;
  onNameOf: string;
  want80G: boolean;
  pan: string;
  address: string;
  wantPrasadam: boolean;
  site: "" | "hkmv" | "annadan";
  /** HKM Vizag only: HKMI (DCC account 4, the default) or TSC (account 5). The seva picked decides it on the server. */
  account: "HKMI" | "TSC";
  myDonor: boolean;
}

export const emptyReceipt = (): ReceiptValues => ({
  donorName: "",
  mobile: "",
  email: "",
  seva: "",
  sevaCatalogId: "",
  onNameOf: "",
  want80G: false,
  pan: "",
  address: "",
  wantPrasadam: false,
  site: "",
  account: "HKMI",
  myDonor: false,
});

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const digits10 = (v: string) => v.replace(/\D/g, "").slice(-10);

/** What must be filled before Send is allowed. */
export function receiptProblems(v: ReceiptValues, opts: { needSite: boolean; listForAnnadan?: boolean }): string | null {
  if (!v.donorName.trim()) return "Enter the Donor Name.";
  if (digits10(v.mobile).length !== 10) return "Enter a 10-digit Mobile Number.";
  if (v.want80G && !PAN_RE.test(v.pan.trim().toUpperCase())) return "Enter a valid PAN Number.";
  if ((v.want80G || v.wantPrasadam) && !v.address.trim()) return "Enter the Address.";
  if (opts.needSite && !v.site) return "Choose the receipt site.";
  // The main site's DCC wants a Seva Code, so a seva must be picked - once the list has
  // loaded. If it could not, the typed seva below is used and nobody is blocked.
  if ((v.site !== "annadan" || v.account === "TSC" || opts.listForAnnadan) && sevaListAvailable() && !v.sevaCatalogId) return "Choose the Seva.";
  return null;
}

/** The donor part of the form. Same on both paths. */
export function DonorFields({
  v,
  set,
  showPrasadam,
  showSite,
  showMyDonor,
  myDonorLocked,
  lookupHint,
  showAccount = true,
  listForAnnadan = false,
}: {
  v: ReceiptValues;
  set: (patch: Partial<ReceiptValues>) => void;
  showPrasadam: boolean;
  showSite: boolean;
  /** The HKMI / TSC choice. Off in the QR popup, which offers DRM's own seva list only. */
  showAccount?: boolean;
  /** Pick the seva from DRM's list even for an Annadan receipt, instead of typing it. */
  listForAnnadan?: boolean;
  showMyDonor: boolean;
  myDonorLocked?: string | null;
  lookupHint?: string | null;
}) {
  // HKM Vizag receipts pick the seva from the list; if the list could not be loaded
  // (or is empty) the typed seva is used instead, so nobody is stopped.
  const { sevas, ready } = useSevaCatalog();
  // Picked from the list unless the receipt is for annadan, which takes a typed seva. With no
  // site chosen yet the list is shown too, so a QR receipt never opens on a typed field.
  const tsc = showAccount && v.account === "TSC";
  const pickSeva = (v.site !== "annadan" || tsc || listForAnnadan) && (!ready || sevas.length > 0);
  // A receipt reopened with a seva already chosen (a QR retried) shows that seva's account.
  const savedAccount = sevas.find((s) => s.id === v.sevaCatalogId)?.accountType;
  useEffect(() => {
    if (showAccount && savedAccount && (savedAccount === "TSC" || savedAccount === "HKMI") && savedAccount !== v.account) {
      set({ account: savedAccount });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedAccount]);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Donor Name" htmlFor="r-name" required>
          <Input id="r-name" value={v.donorName} onChange={(e) => set({ donorName: e.target.value })} placeholder="Name" />
        </Field>
        <Field label="Mobile Number" htmlFor="r-mobile" required hint={lookupHint ?? undefined}>
          <Input
            id="r-mobile"
            value={v.mobile}
            inputMode="numeric"
            maxLength={14}
            onChange={(e) => set({ mobile: e.target.value.replace(/[^\d+\s]/g, "") })}
            placeholder="10-digit number"
          />
        </Field>
        <Field label="E-mail ID (optional)" htmlFor="r-email">
          <Input id="r-email" type="email" value={v.email} onChange={(e) => set({ email: e.target.value.toLowerCase() })} />
        </Field>
        {showAccount && pickSeva && v.site === "hkmv" && sevas.some((s) => s.accountType === "TSC") && (
          <Field label="Account" className="sm:col-span-2">
            <SegmentedControl
              solid
              options={[
                { value: "HKMI", label: "HKMI" },
                { value: "TSC", label: "TSC" },
              ]}
              value={v.account}
              onChange={(account) => set({ account: account as ReceiptValues["account"], sevaCatalogId: "", seva: "" })}
            />
          </Field>
        )}
        {pickSeva ? (
          <Field label="Seva" required className="sm:col-span-2">
            <SevaPicker
              account={showAccount && (v.site !== "annadan" || tsc) ? v.account : "HKMI"}
              value={v.sevaCatalogId}
              onChange={(id, name) => set({ sevaCatalogId: id, seva: name })}
            />
          </Field>
        ) : (
          <Field label="Seva (optional)" htmlFor="r-seva">
            <Input id="r-seva" value={v.seva} onChange={(e) => set({ seva: e.target.value })} placeholder="e.g. Annadan" />
          </Field>
        )}
        <Field label="On the name of (optional)" htmlFor="r-onname" className="sm:col-span-2">
          <Input id="r-onname" value={v.onNameOf} onChange={(e) => set({ onNameOf: e.target.value })} />
        </Field>
      </div>

      <div className="space-y-2.5 rounded-card bg-sunken/60 p-3">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:gap-6">
          <Checkbox checked={v.want80G} onChange={(on) => set({ want80G: on })} label="80G Tax Exemption" />
          {showPrasadam && (
            <Checkbox checked={v.wantPrasadam} onChange={(on) => set({ wantPrasadam: on })} label="Send Maha Prasadam" />
          )}
        </div>
        {v.want80G && (
          <Field label="PAN Number" htmlFor="r-pan" required>
            <Input
              id="r-pan"
              value={v.pan}
              maxLength={10}
              onChange={(e) => set({ pan: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })}
              placeholder="Eg: ABCDE1234F"
              className="uppercase"
            />
          </Field>
        )}
        {(v.want80G || v.wantPrasadam) && (
          <Field label="Address" htmlFor="r-address" required>
            <Textarea id="r-address" rows={2} value={v.address} onChange={(e) => set({ address: e.target.value })} />
          </Field>
        )}
      </div>

      {showSite && (
        <Field label="Receipt from">
          <SegmentedControl
            solid
            options={[
              { value: "hkmv", label: "HKM Vizag" },
              { value: "annadan", label: "Annadan" },
            ]}
            value={v.site}
            onChange={(site) => set({ site: site as ReceiptValues["site"], account: "HKMI" })}
          />
        </Field>
      )}

      {showMyDonor && (
        <Checkbox
          checked={v.myDonor}
          onChange={(on) => set({ myDonor: on })}
          disabled={!!myDonorLocked}
          label={myDonorLocked ? `Counted for ${myDonorLocked}` : "My donor (adds to my total)"}
        />
      )}
    </div>
  );
}

/**
 * "Receipt sent" - shared by both paths.
 *
 * `sentTo` is the mobile the receipt was sent to, so the caller can read it back to
 * the donor ("I have sent it to 98765 43210") instead of trusting a bare "sent".
 *
 * `resend`, when given, shows "Send again" - for "it never arrived". It asks the site
 * that issued the receipt to send it once more and returns the number the site
 * actually used, which replaces the one shown: that one is the site's own word, not
 * DRM's guess. The site refuses a second send moments after the first; that comes
 * back as a message here, not as a failure.
 */
export function ReceiptSent({
  amount,
  receiptNo,
  sentTo,
  resend,
  onClose,
  onAnother,
}: {
  amount: number;
  receiptNo: string | null;
  sentTo?: string | null;
  resend?: () => Promise<{ sentTo: string | null; receiptNumber: string | null }>;
  onClose: () => void;
  onAnother?: () => void;
}) {
  const [number, setNumber] = useState(receiptNo);
  const [to, setTo] = useState(sentTo ?? null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "good" | "danger" | "info"; text: string } | null>(null);

  async function again() {
    if (!resend) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await resend();
      if (r.sentTo) setTo(r.sentTo);
      if (r.receiptNumber) setNumber(r.receiptNumber);
      setNote({ tone: "good", text: `Sent again${r.sentTo ? ` to ${r.sentTo}` : ""}.` });
    } catch (e) {
      const text = e instanceof Error ? e.message : "Could not send it again. Try again.";
      // The site's own "just sent" guard is information, not a fault.
      setNote({ tone: /moment|just|already/i.test(text) ? "info" : "danger", text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Receipt sent"
      onClose={onClose}
      footer={
        <>
          {resend && (
            <Button variant="secondary" onClick={() => void again()} loading={busy}>
              Send again
            </Button>
          )}
          {onAnother && (
            <Button variant="secondary" onClick={onAnother}>
              Send another
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="py-2 text-center">
        <p className="text-3xl font-semibold tabular-nums text-ink">{currency(amount)}</p>
        {number ? (
          <p className="mt-2 text-sm text-ink-muted">
            Receipt No. <span className="font-mono font-semibold text-brand-700">{number}</span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-muted">Receipt No. will show soon.</p>
        )}
        {to && (
          <p className="mt-1 text-sm text-ink-muted">
            Sent to <span className="font-medium tabular-nums text-ink">{to}</span>
          </p>
        )}
      </div>
      {note && (
        <Alert tone={note.tone} className="mt-3">
          {note.text}
        </Alert>
      )}
    </Modal>
  );
}

/* ------------------------------------------- cash / UPI / cheque / bank */

type Mode = "cash" | "upi" | "cheque" | "bank";

export function ManualReceiptDialog({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const [v, setV] = useState<ReceiptValues>({ ...emptyReceipt(), site: "hkmv" });
  const set = (patch: Partial<ReceiptValues>) => setV((x) => ({ ...x, ...patch }));
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<Mode>("cash");
  const [txn, setTxn] = useState("");
  const [paidOn, setPaidOn] = useState(istToday());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState<{ amount: number; receiptNo: string | null } | null>(null);
  const [known, setKnown] = useState<string | null>(null);

  // A returning donor fills themselves in - only blanks, never over typing.
  const mobile = digits10(v.mobile);
  useEffect(() => {
    if (mobile.length !== 10) return;
    let live = true;
    const t = window.setTimeout(async () => {
      try {
        const r = await apiClient.get<{ people: Record<string, unknown>[] }>(
          `/api/people?search=${encodeURIComponent(mobile)}&limit=1`
        );
        const p = r.people?.[0];
        if (!live) return;
        if (!p) {
          setKnown(null);
          return;
        }
        setKnown("Returning donor");
        setV((x) => ({
          ...x,
          donorName: x.donorName || String(p.name ?? ""),
          email: x.email || String(p.email ?? ""),
          pan: x.pan || String(p.pan ?? ""),
          address: x.address || String(p.prasadam_address ?? p.address ?? ""),
        }));
      } catch {
        /* the lookup is a convenience; the form works without it */
      }
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [mobile]);

  const amt = Number(amount);
  const needTxn = mode !== "cash";
  const problem =
    !Number.isFinite(amt) || amt <= 0
      ? "Enter the Amount."
      : needTxn && !txn.trim()
      ? mode === "cheque"
        ? "Enter the Cheque No."
        : "Enter the Transaction ID (UTR)."
      : receiptProblems(v, { needSite: true });

  async function send() {
    setShown(true);
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<{ receiptNumber: string | null }>("/api/donations/offline", {
        site: v.site,
        donor_name: v.donorName.trim(),
        donor_mobile: mobile,
        donor_email: v.email.trim() || undefined,
        amount: amt,
        payment_mode: mode,
        reference_no: needTxn ? txn.trim() : undefined,
        payment_date: paidOn || undefined,
        seva_name: v.seva.trim() || undefined,
        seva_catalog_id: v.sevaCatalogId || undefined,
        sevak_name: v.onNameOf.trim() || undefined,
        want_certificate: v.want80G,
        pan_number: v.want80G ? v.pan.trim().toUpperCase() : undefined,
        want_prasadam: v.wantPrasadam,
        prasadam_address: v.want80G || v.wantPrasadam ? v.address.trim() : undefined,
      });
      setDone({ amount: amt, receiptNo: r.receiptNumber });
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <ReceiptSent
        amount={done.amount}
        receiptNo={done.receiptNo}
        onClose={onClose}
        onAnother={() => {
          setDone(null);
          setShown(false);
          setAmount("");
          setTxn("");
          setV((x) => ({ ...emptyReceipt(), site: x.site }));
        }}
      />
    );
  }

  return (
    <Modal
      title="Send Receipt"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="receipt" loading={busy} onClick={() => void send()}>
            Send Receipt
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {shown && problem && !error && <Alert tone="warn">{problem}</Alert>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount" htmlFor="r-amount" required>
            <Input
              id="r-amount"
              type="number"
              min="1"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="₹"
            />
          </Field>
          <Field label="Date" htmlFor="r-date">
            <Input id="r-date" type="date" value={paidOn} max={istToday()} onChange={(e) => setPaidOn(e.target.value)} />
          </Field>
        </div>

        <Field label="Paid by">
          <SegmentedControl
            options={[
              { value: "cash", label: "Cash" },
              { value: "upi", label: "UPI" },
              { value: "cheque", label: "Cheque" },
              { value: "bank", label: "Bank Transfer" },
            ]}
            value={mode}
            onChange={(m) => setMode(m as Mode)}
          />
        </Field>
        {needTxn && (
          <Field label={mode === "cheque" ? "Cheque No." : "Transaction ID (UTR)"} htmlFor="r-txn" required>
            <Input
              id="r-txn"
              value={txn}
              inputMode="numeric"
              onChange={(e) => setTxn(e.target.value)}
              placeholder={mode === "cheque" ? "e.g. 004512" : "12-digit number"}
            />
          </Field>
        )}

        <DonorFields v={v} set={set} showPrasadam showSite showMyDonor={false} lookupHint={known} />
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- QR payment */

/** The bits of a QR payment the summary strip shows. */
export function QrSummary({
  amount,
  receivedAt,
  qrLabel,
  utr,
}: {
  amount: string | number;
  receivedAt: string;
  qrLabel?: string | null;
  utr?: string | null;
}) {
  return (
    <div className="rounded-card border border-brand-200 bg-brand-50/60 px-4 py-3">
      <p className="text-2xl font-semibold tabular-nums text-ink">{currency(amount)}</p>
      <p className="mt-0.5 text-sm text-ink-muted">
        Paid by QR · {dateTime(receivedAt)}
        {qrLabel ? ` · ${qrLabel}` : ""}
        {utr ? ` · UTR ${utr}` : ""}
      </p>
    </div>
  );
}

export function FormSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
