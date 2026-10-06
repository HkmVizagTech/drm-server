"use client";

// The receipt dialog for a temple-QR payment, shared by the QR payments
// screen and "Raise a receipt" on the donations screen. One copy, so the
// rules about what goes on an 80G certificate (no UPI handle as a name, the
// PAN deciding whether there is a certificate at all, "on the name of") can
// never differ between the two places a receipt can be raised from.

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { currency } from "@/lib/format";
import { Alert, Badge, Button, Field, Input, Modal, SearchInput, Skeleton } from "@/components/ui";
import { Icon } from "@/components/icons";
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
  /** Linked straight to a person (a donor, or somebody added for this payment). */
  person_id?: string | null;
  person_name?: string | null;
  person_phone?: string | null;
  donor_name?: string | null;
  donor_phone?: string | null;
  /** share | lead | person | new - how it was linked, when somebody linked it. */
  link_kind?: string | null;
  linked_by?: string | null;
  linked_by_name?: string | null;
  utr?: string | null;
}

/** Linked to somebody, by any route. */
export const isLinked = (p: { share_id?: string | null; lead_id?: string | null; person_id?: string | null }) =>
  !!(p.share_id || p.lead_id || p.person_id);

/** Who a payment is linked to, as a name, or null. */
export const linkedName = (p: Payment) => p.person_name || p.lead_name || null;

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
  share_id: string | null;
  lead_id: string | null;
  person_id: string | null;
  person_phone: string | null;
  link_kind: string | null;
  linked_by: string | null;
  linked_by_name: string | null;
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

interface WhoRow {
  kind: "share" | "lead" | "person";
  id: string;
  name: string | null;
  phone: string | null;
  hint: string;
  promised?: boolean;
  same_amount?: boolean;
  same_number?: boolean;
}

const KIND_LABEL: Record<WhoRow["kind"], string> = { share: "QR sent", lead: "Lead", person: "Donor" };

/**
 * Step one: who paid?
 *
 * Anybody DRM knows - somebody a QR was sent to, a lead, a donor - found by
 * name or mobile number, with the likely ones listed before anything is
 * typed. Or a new person, by name and number. It used to be only the people
 * a QR had been sent to, so a regular donor scanning the temple QR, or a
 * walk-in, could never be linked to anyone.
 */
function WhoPaid({
  payment,
  detail,
  onClose,
  onLinked,
}: {
  payment: Payment;
  detail: PaymentDetail;
  onClose: () => void;
  onLinked: (message: string) => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<WhoRow[] | null>(null);
  const [chosen, setChosen] = useState<WhoRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(personName(detail.payer_name) ?? "");
  const [mobile, setMobile] = useState(detail.payer_phone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(async () => {
      try {
        const r = await apiClient.get<{ results: WhoRow[] }>(
          `/api/crm/qr/payments/${payment.id}/who?q=${encodeURIComponent(q.trim())}`
        );
        if (live) {
          setRows(r.results);
          // Paid from the very number DRM has for somebody: picked already,
          // so the common case is one press of Next.
          if (!q && r.results[0]?.same_number) setChosen((c) => c ?? r.results[0]);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Could not search. Try again.");
      }
    }, q ? 250 : 0);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, payment.id]);

  // The number typed for a new person is already somebody in the list.
  const typed = digits10(mobile);
  const alreadyThere = adding && typed.length === 10 ? rows?.find((r) => r.phone === typed) ?? null : null;

  const canNext = adding ? name.trim().length >= 2 && typed.length === 10 : !!chosen;

  async function next() {
    setBusy(true);
    setError(null);
    try {
      const body = adding ? { kind: "new", name: name.trim(), phone: typed } : { kind: chosen!.kind, id: chosen!.id };
      const r = await apiClient.post<{
        name: string | null;
        existing: boolean;
        counted_for: string | null;
        kind?: string;
        replaced_said?: number | null;
      }>(`/api/crm/qr/payments/${payment.id}/link`, body);
      // "Donated now" on the call was this same money: said, so nobody adds it again.
      const once =
        r.replaced_said !== undefined
          ? r.replaced_said !== null && Number(r.replaced_said) !== Number(payment.amount)
            ? ` Counted once: ${currency(Number(payment.amount))} in place of the ${currency(Number(r.replaced_said))} noted on the call.`
            : " Counted once with the gift noted on the call."
          : "";
      onLinked(
        `Linked to ${r.name ?? "the donor"}${r.kind === "lead" && body.kind !== "lead" ? " (their lead)" : r.existing ? " (already in DRM)" : ""}.` +
          (r.counted_for ? ` Counted for ${r.counted_for}.` : "") +
          once
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not link. Try again.");
      setBusy(false);
    }
  }

  const payer = [detail.payer_vpa, detail.payer_phone, personName(detail.payer_name)].filter(Boolean).join(" · ");

  return (
    <Modal
      title="Who paid?"
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="arrowRight" disabled={!canNext} loading={busy} onClick={() => void next()}>
            Next
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <QrSummary amount={payment.amount} receivedAt={payment.received_at} qrLabel={detail.qr_label} utr={detail.utr} />
        {payer && <p className="text-sm text-ink-muted">Paid from {payer}</p>}
        {error && <Alert tone="danger">{error}</Alert>}

        {!adding && (
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search name or mobile number" autoFocus />
            <div className="max-h-[42vh] space-y-1.5 overflow-y-auto pr-1">
              {!rows && (
                <>
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </>
              )}
              {rows && !rows.length && (
                <p className="py-4 text-center text-sm text-ink-muted">
                  {q ? "No one found. Add them as a new person." : "No likely match. Search, or add a new person."}
                </p>
              )}
              {rows?.map((r) => {
                const on = chosen?.kind === r.kind && chosen.id === r.id;
                return (
                  <button
                    key={`${r.kind}:${r.id}`}
                    type="button"
                    onClick={() => setChosen(r)}
                    className={`flex w-full items-center gap-3 rounded-control border px-3 py-2 text-left transition-colors ${
                      on ? "border-brand-600 bg-brand-50" : "border-line-soft hover:bg-sunken"
                    }`}
                  >
                    <span
                      className={`grid h-5 w-5 flex-none place-items-center rounded-full border ${
                        on ? "border-brand-600 bg-brand-600 text-white" : "border-line"
                      }`}
                    >
                      {on && <Icon name="check" size={12} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {r.name || r.phone || "No name"}
                        {r.name && r.phone && <span className="font-normal tabular-nums text-ink-muted"> · {r.phone}</span>}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">{r.hint}</span>
                    </span>
                    <span className="flex flex-none flex-wrap justify-end gap-1">
                      {r.same_number && <Badge tone="good">Same number</Badge>}
                      {r.same_amount && <Badge tone="good">Same amount</Badge>}
                      {r.promised && <Badge tone="info">Promised</Badge>}
                      <Badge>{KIND_LABEL[r.kind]}</Badge>
                    </span>
                  </button>
                );
              })}
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon="userPlus"
              onClick={() => {
                setAdding(true);
                setChosen(null);
                // A number typed into the search is the new person's number.
                const d = q.replace(/\D/g, "");
                if (d.length >= 10) setMobile(d.slice(-10));
                else if (q.trim() && !name) setName(q.trim());
              }}
            >
              Not in the list? Add new person
            </Button>
          </>
        )}

        {adding && (
          <div className="space-y-3 rounded-card bg-sunken/60 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Donor Name" htmlFor="who-name" required>
                <Input id="who-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Name" />
              </Field>
              <Field label="Mobile Number" htmlFor="who-mobile" required>
                <Input
                  id="who-mobile"
                  value={mobile}
                  inputMode="numeric"
                  maxLength={14}
                  onChange={(e) => setMobile(e.target.value.replace(/[^\d+\s]/g, ""))}
                  placeholder="10-digit number"
                />
              </Field>
            </div>
            {alreadyThere && (
              <p className="text-sm text-ink-soft">
                This number is already in DRM as <span className="font-medium">{alreadyThere.name}</span>. It will be
                linked to them.
              </p>
            )}
            <Button variant="ghost" size="sm" icon="arrowLeft" onClick={() => setAdding(false)}>
              Back to search
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * A temple-QR payment, start to finish: who paid, then the receipt.
 *
 * WHY ONE WINDOW
 * There were two buttons - "Link donor" and "Send receipt" - that did related
 * things in an order nobody could guess, and the link could only reach people
 * a QR had been sent to. Now a payment nobody has linked opens on "Who paid?",
 * and the receipt form follows already filled in from whoever was picked. A
 * payment already linked opens straight on the form, with "Change" for when
 * it was the wrong person.
 *
 * WHO IS CREDITED is decided by the link, not here: a QR send counts for
 * whoever sent it, a lead for its caller, anybody else for the caller who
 * linked it.
 */
export function ReceiptDialog({
  payment,
  currentUserId,
  currentUserName,
  onClose,
  onDone,
  onCreditKnown,
  onChanged,
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
  /** The payment was linked or unlinked - the list behind should refresh. */
  onChanged?: () => void;
}) {
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [step, setStep] = useState<"loading" | "who" | "receipt">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [sent, setSent] = useState<{ receiptNo: string | null; message: string } | null>(null);
  const [v, setV] = useState<ReceiptValues>(emptyReceipt());
  const set = (patch: Partial<ReceiptValues>) => setV((x) => ({ ...x, ...patch }));
  void currentUserName;
  const { user } = useAuth();

  const load = useCallback(async () => {
    try {
      const { payment: d } = await apiClient.get<{ payment: PaymentDetail }>(`/api/crm/qr/payments/${payment.id}`);
      setDetail(d);
      // Prefilled from the most specific thing DRM holds down to the least:
      // what a previous attempt typed, the donor record, the lead, then
      // Razorpay - whose payer_name is dropped when it is a UPI handle.
      const pan = d.donor_pan ?? d.person_pan ?? "";
      const address = d.donor_address ?? d.person_address ?? "";
      setV({
        donorName: d.donor_name ?? d.person_name ?? d.lead_name ?? personName(d.payer_name) ?? "",
        mobile: d.donor_phone ?? d.person_phone ?? d.share_phone ?? d.payer_phone ?? "",
        email: d.donor_email ?? d.person_email ?? d.lead_email ?? "",
        seva: d.purpose ?? d.qr_purpose ?? "",
        onNameOf: d.sevak_name ?? "",
        want80G: d.want_certificate ?? !!pan,
        pan,
        address,
        wantPrasadam: !!d.want_prasadam,
        site: (d.site_for_receipt as ReceiptValues["site"]) ?? "",
        myDonor: false,
      });
      onCreditKnown(d.id, d.credit_id ? { user_id: d.credit_user_id, name: d.credit_user_name } : null);
      if (d.receipt_error) setError(d.receipt_error);
      setStep(isLinked(d) ? "receipt" : "who");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
      setStep("receipt");
    }
  }, [payment.id, onCreditKnown]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(t);
  }, [load]);

  const siteFixed = !!detail?.site_for_receipt;
  const problem = receiptProblems(v, { needSite: !siteFixed });

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<{ lead_left_donated: boolean }>(`/api/crm/qr/payments/${payment.id}/unlink`, {});
      setNotice(r.lead_left_donated ? "Unlinked. The lead still shows Donated - change it on the lead." : null);
      onChanged?.();
      setStep("loading");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not unlink. Try again.");
    } finally {
      setBusy(false);
    }
  }

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
        // No PAN, no 80G certificate - that is how both sites decide it. The
        // address is sent either way, so a corrected address is never lost.
        donor_pan: v.want80G ? v.pan.trim().toUpperCase() : "",
        donor_address: v.address.trim(),
        purpose: v.seva.trim(),
        sevak_name: v.onNameOf.trim(),
        sevak_phone: "",
        site: siteFixed ? detail?.site_for_receipt : v.site,
        // The credit was decided when the payment was linked.
        credit_me: false,
        want_certificate: v.want80G,
        want_prasadam: v.wantPrasadam,
      });
      if (r.receipt_status === "issued") {
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

  if (step === "who" && detail) {
    return (
      <WhoPaid
        payment={payment}
        detail={detail}
        onClose={onClose}
        onLinked={async (message) => {
          setNotice(message);
          onChanged?.();
          setStep("loading");
          await load();
        }}
      />
    );
  }

  const who = detail ? detail.person_name || detail.lead_name || detail.donor_name : null;
  const whoPhone = detail ? detail.person_phone || detail.share_phone || detail.donor_phone : null;
  const receiptOut = detail?.receipt_status === "issued" || detail?.receipt_status === "pending";

  return (
    <Modal
      title="Send Receipt"
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Send later
          </Button>
          <Button icon="receipt" disabled={step === "loading"} loading={busy} onClick={() => void send()}>
            Send Receipt
          </Button>
        </>
      }
    >
      {step === "loading" ? (
        <FormSkeleton />
      ) : (
        <div className="space-y-4">
          <QrSummary
            amount={payment.amount}
            receivedAt={payment.received_at}
            qrLabel={detail?.qr_label}
            utr={detail?.utr}
          />
          {notice && <Alert tone="good">{notice}</Alert>}
          {detail && isLinked(detail) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-line-soft px-3 py-2 text-sm">
              <Icon name="user" size={15} className="text-ink-faint" />
              <span className="text-ink">
                Paid by <span className="font-medium">{who ?? "the donor"}</span>
                {whoPhone && <span className="tabular-nums text-ink-muted"> · {whoPhone}</span>}
              </span>
              {detail.credit_user_name && (
                <span className="text-ink-muted">· Counted for {detail.credit_user_name}</span>
              )}
              {/* Whoever linked it, or an admin - the server says the same. */}
              {!receiptOut && (user?.role !== "caller" || detail.linked_by === currentUserId) && (
                <Button variant="ghost" size="xs" className="ml-auto" disabled={busy} onClick={() => void unlink()}>
                  Wrong person? Change
                </Button>
              )}
            </div>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          {shown && problem && !error && <Alert tone="warn">{problem}</Alert>}
          <DonorFields v={v} set={set} showPrasadam showSite={!siteFixed} showMyDonor={false} />
          <p className="text-xs text-ink-muted">Check the name and number. The receipt is sent at once.</p>
        </div>
      )}
    </Modal>
  );
}
