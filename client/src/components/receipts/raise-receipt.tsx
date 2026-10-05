"use client";

// "Raise a receipt" - the one door for every receipt raised by hand.
//
// It used to be two buttons on the donations screen ("Record offline donation"
// and "Record Donation") that did very different things - one raised a real
// 80G receipt on a site, the other only wrote a row into DRM - and a payment
// to the temple QR could only be receipted from a third screen most people
// never opened. So the first question is the one the person can actually
// answer: how did the donor pay?

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { currency, dateTime, relativeDate } from "@/lib/format";
import { Alert, Badge, Button, EmptyState, Modal, SearchInput, Skeleton } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { toast } from "@/components/toast";
import { ReceiptDialog, personName, type Payment } from "./qr-receipt-dialog";

type QrRow = Payment & { utr?: string | null };

function Choice({
  icon,
  title,
  body,
  onClick,
}: {
  icon: IconName;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-card border border-line-soft bg-surface p-4 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
    >
      <span className="grid h-10 w-10 flex-none place-items-center rounded-control bg-brand-50 text-brand-700">
        <Icon name={icon} size={19} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="mt-0.5 block text-sm text-ink-muted">{body}</span>
      </span>
      <Icon name="chevronRight" size={16} className="mt-3 flex-none text-ink-faint" />
    </button>
  );
}

/** Pick the temple-QR payment the receipt is for. */
function QrPicker({ onPick, onBack, onClose }: { onPick: (p: QrRow) => void; onBack: () => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<QrRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(async () => {
      try {
        const r = await apiClient.get<{ payments: QrRow[] }>(
          `/api/crm/qr/payments?scope=needs_receipt&q=${encodeURIComponent(q.trim())}`
        );
        if (live) {
          setRows(r.payments);
          setError(null);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    }, q ? 250 : 0);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q]);

  return (
    <Modal
      title="Pick the QR payment"
      onClose={onClose}
      wide
      footer={
        <Button variant="secondary" icon="arrowLeft" onClick={onBack}>
          Back
        </Button>
      }
    >
      <p className="mb-3 text-sm text-ink-muted">QR payments without a receipt.</p>
      <SearchInput value={q} onChange={setQ} placeholder="Amount, name or UTR" autoFocus />
      <div className="mt-3 max-h-[55vh] space-y-2 overflow-y-auto pr-1">
        {error && <Alert tone="danger">{error}</Alert>}
        {!rows && !error && (
          <>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </>
        )}
        {rows && !rows.length && (
          <EmptyState
            icon="qr"
            title={q ? "No match" : "All QR payments have receipts"}
            message={
              q
                ? "Try the amount or the last 4 digits of the UTR."
                : "New payments take a minute to show."
            }
          />
        )}
        {rows?.map((p) => {
          const who = personName(p.payer_name) ?? p.lead_name ?? p.payer_vpa ?? "Unknown payer";
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p)}
              className="flex w-full flex-col gap-1 rounded-card border border-line-soft bg-surface p-3 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/50 sm:flex-row sm:items-center sm:gap-4"
            >
              <span className="text-base font-semibold tabular-nums text-ink sm:w-28">{currency(p.amount)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">
                  {who}
                  {p.payer_vpa && who !== p.payer_vpa ? <span className="text-ink-muted"> · {p.payer_vpa}</span> : null}
                </span>
                <span className="block text-xs text-ink-muted">
                  {dateTime(p.received_at)} · {relativeDate(p.received_at)}
                  {p.qr_label ? ` · ${p.qr_label}` : ""}
                  {p.utr ? ` · UTR ${p.utr}` : ""}
                </span>
              </span>
              <span className="flex flex-wrap gap-1.5">
                {p.receipt_status === "failed" && <Badge tone="danger">Failed before</Badge>}
                {p.receipt_status === "needs_donor" && <Badge tone="warn">Needs details</Badge>}
                {p.lead_name && <Badge tone="info">{p.lead_name}</Badge>}
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/**
 * The whole flow. `onOther` opens the cash / cheque / bank / other-UPI form,
 * which lives on the donations screen.
 */
export function RaiseReceiptFlow({
  onClose,
  onOther,
  onDone,
}: {
  onClose: () => void;
  onOther: () => void;
  onDone?: () => void;
}) {
  const { user } = useAuth();
  const [step, setStep] = useState<"choose" | "qr">("choose");
  const [payment, setPayment] = useState<QrRow | null>(null);

  if (payment) {
    return (
      <ReceiptDialog
        payment={payment}
        currentUserId={user?.id ?? null}
        currentUserName={user?.name ?? null}
        onClose={() => setPayment(null)}
        onDone={(message) => {
          toast(message);
          onDone?.();
          onClose();
        }}
        onCreditKnown={() => undefined}
      />
    );
  }

  if (step === "qr") return <QrPicker onPick={setPayment} onBack={() => setStep("choose")} onClose={onClose} />;

  return (
    <Modal title="Send Receipt" onClose={onClose}>
      <p className="mb-4 text-sm text-ink-muted">How did they pay?</p>
      <div className="space-y-2.5">
        <Choice
          icon="qr"
          title="Temple QR code"
          body="Pick the payment."
          onClick={() => setStep("qr")}
        />
        <Choice
          icon="rupee"
          title="Cash, UPI, cheque or bank"
          body="Enter the details."
          onClick={onOther}
        />
      </div>
      <p className="mt-4 text-xs text-ink-faint">Website donations get receipts automatically.</p>
    </Modal>
  );
}
