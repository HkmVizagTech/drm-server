"use client";

// The receipt dialog for a temple-QR payment, shared by the QR payments
// screen and "Raise a receipt" on the donations screen. One copy, so the
// rules about what goes on an 80G certificate (no UPI handle as a name, the
// PAN deciding whether there is a certificate at all, "on the name of") can
// never differ between the two places a receipt can be raised from.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { currency } from "@/lib/format";
import { Alert, Button, Modal } from "@/components/ui";
import {
  DonorFields,
  FormSkeleton,
  QrSummary,
  ReceiptSent,
  digits10,
  emptyReceipt,
  receiptProblems,
  type ReceiptValues,
} from "./receipt-form";

export interface Payment {
  id: string;
  payment_id: string;
  qr_id: string | null;
  qr_label: string | null;
  qr_owner: string | null;
  qr_receipt_site: string | null;
  amount: string;
  payer_phone: string | null;
  payer_vpa: string | null;
  payer_name: string | null;
  status: string | null;
  received_at: string;
  share_id: string | null;
  lead_id: string | null;
  lead_name: string | null;
  receipt_status: string | null;
  receipt_error: string | null;
  receipt_number: string | null;
  /** Why this one is still sitting here, written down by the matcher. */
  match_note: string | null;
  match_score: number | null;
  match_basis: string | null;
  last_event: string | null;
  // Optional because the list query does not select them today - only the
  // detail route does. Declared so that the column below starts filling in on
  // its own the day the list learns to send them, rather than needing this
  // screen changed again.
  credit_user_id?: string | null;
  credit_user_name?: string | null;
}

/** Everything GET /qr/payments/:id knows, which is what the receipt dialog fills itself from. */
export interface PaymentDetail {
  id: string;
  payment_id: string;
  /** The 12-digit UPI transaction number the donor sees, when Razorpay sent it. */
  utr?: string | null;
  amount: string;
  received_at: string;
  payer_name: string | null;
  payer_phone: string | null;
  payer_vpa: string | null;
  qr_label: string | null;
  qr_purpose: string | null;
  /** The QR's site, or the one a previous attempt chose. Null means nobody has said. */
  site_for_receipt: string | null;
  shared_by: string | null;
  shared_by_name: string | null;
  share_phone: string | null;
  lead_id: string | null;
  lead_name: string | null;
  lead_email: string | null;
  lead_assigned_to: string | null;
  person_name: string | null;
  person_email: string | null;
  person_pan: string | null;
  person_address: string | null;
  credit_id: string | null;
  credit_user_id: string | null;
  credit_user_name: string | null;
  donor_name: string | null;
  donor_phone: string | null;
  donor_email: string | null;
  donor_pan: string | null;
  donor_address: string | null;
  want_prasadam?: boolean | null;
  want_certificate?: boolean | null;
  purpose: string | null;
  sevak_name: string | null;
  sevak_phone: string | null;
  receipt_status: string | null;
  receipt_error: string | null;
  receipt_number: string | null;
}

export interface ReceiptOutcome {
  receipt_status: string | null;
  receipt_error: string | null;
  receipt_number: string | null;
  external_donation_id: string | null;
  credited: boolean;
}

/**
 * Who a payment is counted for, as far as this screen has been told.
 *
 * `null` means asked and nobody has it; `undefined` means never asked. The two
 * must stay distinguishable - printing "nobody" for a row we have simply not
 * looked at would invite somebody to claim money that is already somebody
 * else's, and the only thing stopping them would be a 409 after the fact.
 */
export type Credit = { user_id: string | null; name: string | null } | null;

export const SITE_NAMES: Record<string, string> = {
  hkmv: "harekrishnavizag.org",
  annadan: "annadan",
};

/**
 * Razorpay's idea of who paid, when it is actually a person.
 *
 * What comes back is very often the UPI handle - "rameshk@okhdfcbank",
 * "sita.d@ybl" - because that is all the payer's app sent. A handle is not a
 * name, and on an 80G certificate it is a document the donor cannot use. The
 * "@" test is crude and that is the point: anything ambiguous falls through
 * to an empty box, and an empty required field is a problem somebody notices.
 */
export function personName(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!s || s.includes("@")) return null;
  return s;
}

export const siteName = (key: string | null | undefined) =>
  key ? SITE_NAMES[key] ?? key : null;

/**
 * Raising the 80G receipt, with whatever DRM is missing filled in by hand.
 *
 * WHY IT IS A FORM AND NOT A BUTTON
 * On a matched payment this should be one glance and a press - everything is
 * prefilled from the person, the lead and the share. The form is for the other
 * case: money that arrived on a shared QR with nothing behind it, where a
 * certificate needs a name and a number that exist nowhere in DRM. Both go
 * through the same dialog so there is one thing to learn, and so the prefilled
 * case still shows what is about to be printed before it is printed.
 */
export function ReceiptDialog({
  payment,
  currentUserId,
  currentUserName,
  onClose,
  onDone,
  onCreditKnown,
}: {
  payment: Payment;
  // Two strings rather than one user object: an object built inline by the
  // parent is a new value on every render, which would put the detail fetch
  // below into a loop that re-runs each time its own response lands.
  currentUserId: string | null;
  currentUserName: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
  /** Lets the list show a credit the detail route revealed, without a second request. */
  onCreditKnown: (paymentId: string, credit: Credit) => void;
}) {
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [sent, setSent] = useState<{ receiptNo: string | null; message: string } | null>(null);
  const [v, setV] = useState<ReceiptValues>(emptyReceipt());
  const set = (patch: Partial<ReceiptValues>) => setV((x) => ({ ...x, ...patch }));

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ payment: PaymentDetail }>(`/api/crm/qr/payments/${payment.id}`)
      .then(({ payment: d }) => {
        if (cancelled) return;
        setDetail(d);
        // Prefilled from the most specific thing DRM holds down to the least:
        // what a previous attempt typed, the donor record, the lead, then
        // Razorpay. Razorpay's payer_name is dropped when it is a UPI handle
        // ("rameshk@okhdfcbank") - a handle is not a name, and on an 80G
        // certificate it is a document the donor cannot use.
        const pan = d.donor_pan ?? d.person_pan ?? "";
        const address = d.donor_address ?? d.person_address ?? "";
        setV({
          donorName: d.donor_name ?? d.person_name ?? d.lead_name ?? personName(d.payer_name) ?? "",
          mobile: d.donor_phone ?? d.share_phone ?? d.payer_phone ?? "",
          email: d.donor_email ?? d.person_email ?? d.lead_email ?? "",
          seva: d.purpose ?? d.qr_purpose ?? "",
          onNameOf: d.sevak_name ?? "",
          want80G: d.want_certificate ?? !!pan,
          pan,
          address,
          wantPrasadam: !!d.want_prasadam,
          site: (d.site_for_receipt as ReceiptValues["site"]) ?? "",
          // Ticked only where this person's own work is plainly behind the
          // payment; ticking it everywhere would move colleagues' donations
          // onto whoever opened the form.
          myDonor:
            !d.credit_id && !!currentUserId && (d.shared_by === currentUserId || d.lead_assigned_to === currentUserId),
        });
        onCreditKnown(d.id, d.credit_id ? { user_id: d.credit_user_id, name: d.credit_user_name } : null);
        if (d.receipt_error) setError(d.receipt_error);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load. Try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [payment.id, currentUserId, onCreditKnown]);

  const siteFixed = !!detail?.site_for_receipt;
  const problem = receiptProblems(v, { needSite: !siteFixed });

  async function send() {
    setShown(true);
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<ReceiptOutcome>(`/api/crm/qr/payments/${payment.id}/receipt`, {
        donor_name: v.donorName.trim(),
        donor_phone: digits10(v.mobile),
        donor_email: v.email.trim(),
        // No PAN, no 80G certificate - that is how both sites decide it.
        //
        // The address is sent whether or not a PAN is ticked. It used to be
        // gated on want80G, which meant an operator correcting the address of
        // a payment with no PAN sent "" and the edit was thrown away.
        donor_pan: v.want80G ? v.pan.trim().toUpperCase() : "",
        donor_address: v.address.trim(),
        purpose: v.seva.trim(),
        sevak_name: v.onNameOf.trim(),
        sevak_phone: "",
        site: siteFixed ? detail?.site_for_receipt : v.site,
        credit_me: v.myDonor,
        want_certificate: v.want80G,
        want_prasadam: v.wantPrasadam,
      });
      if (r.receipt_status === "issued") {
        if (r.credited) onCreditKnown(payment.id, { user_id: currentUserId, name: currentUserName });
        setSent({
          receiptNo: r.receipt_number,
          message: `Receipt ${r.receipt_number ?? ""} sent for ${currency(Number(payment.amount))}.`,
        });
        return;
      }
      // Kept open so the details can be fixed and sent again.
      setError(r.receipt_error ?? "The site did not send the receipt. Try again.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <ReceiptSent
        amount={Number(payment.amount)}
        receiptNo={sent.receiptNo}
        onClose={() => onDone(sent.message)}
      />
    );
  }

  return (
    <Modal
      title="Send Receipt"
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="receipt" disabled={loading} loading={busy} onClick={() => void send()}>
            Send Receipt
          </Button>
        </>
      }
    >
      {loading ? (
        <FormSkeleton />
      ) : (
        <div className="space-y-4">
          <QrSummary
            amount={payment.amount}
            receivedAt={payment.received_at}
            qrLabel={detail?.qr_label}
            utr={detail?.utr}
          />
          {error && <Alert tone="danger">{error}</Alert>}
          {shown && problem && !error && <Alert tone="warn">{problem}</Alert>}
          <DonorFields
            v={v}
            set={set}
            showPrasadam
            showSite={!siteFixed}
            showMyDonor
            myDonorLocked={detail?.credit_id ? detail.credit_user_name ?? "someone else" : null}
          />
          <p className="text-xs text-ink-muted">Check the name and number. The receipt is sent at once.</p>
        </div>
      )}
    </Modal>
  );
}
