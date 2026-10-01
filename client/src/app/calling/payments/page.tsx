"use client";

// QR payments — what came in, and what still needs a person.
//
// WHY THIS SCREEN EXISTS
// Two things can go wrong after a donor pays by QR, and both are invisible
// from everywhere else:
//
//   unmatched   Razorpay reports money against a QR and DRM cannot say with
//               confidence whose it was. That happens when the payer's number
//               differs from the one called, the amount is nothing like what
//               was promised, or several shares of the same QR are open at
//               once. The money is real; only the attribution is missing.
//
//   no receipt  A payment matched to a lead, but the site refused the entry
//               or the QR has no site set, so nobody raised an 80G receipt.
//               This one is the quiet failure: from every other screen the
//               donation looks complete.
//
// Both are listed together, because the second is the one that gets forgotten.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, relativeDate, shortDate } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  CardHeader,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Select,
  SkeletonRows,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
  Toolbar,
  buttonSecondary,
} from "@/components/ui";
import { ExportButton } from "@/components/export-button";

interface Payment {
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
}

interface Share {
  id: string;
  qr_label: string;
  lead_name: string | null;
  phone: string;
  expected_amount: string | null;
  created_at: string;
  matched_at: string | null;
  /** They said on the call that they would pay by this QR. */
  awaiting_payment_at: string | null;
  awaiting_qr_at: string | null;
}

export default function QrPaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [scope, setScope] = useState("attention");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<Payment | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * The filters, described once.
   *
   * The list request and the download both read this. A second builder would
   * drift from the one on screen, and "Needs attention" downloading as
   * "Everything" is a file somebody then works through row by row.
   */
  const filterParams = useCallback(() => {
    return new URLSearchParams({ scope });
  }, [scope]);

  const load = useCallback(async () => {
    try {
      const d = await apiClient.get<{ payments: Payment[] }>(`/api/crm/qr/payments?${filterParams()}`);
      setPayments(d.payments);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the payments");
    } finally {
      setLoading(false);
    }
  }, [filterParams]);

  useEffect(() => {
    void load();
  }, [load]);

  async function retryReceipt(p: Payment) {
    setBusy(p.id);
    setError(null);
    try {
      const r = await apiClient.post<{ receipt_status: string; receipt_error: string | null; receipt_number: string | null }>(
        `/api/crm/qr/payments/${p.id}/issue-receipt`,
        {}
      );
      setNotice(
        r.receipt_status === "issued"
          ? `Receipt ${r.receipt_number ?? ""} raised for ${currency(Number(p.amount))}.`
          : `Still not issued — ${r.receipt_error ?? "the site refused it."}`
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not issue that receipt");
    } finally {
      setBusy(null);
    }
  }

  const receiptBadge = (p: Payment) => {
    if (!p.share_id) return <span className="text-ink-faint">—</span>;
    if (p.receipt_status === "issued") {
      return (
        <span>
          <Badge tone="good">issued</Badge>
          {p.receipt_number && <div className="mt-0.5 text-xs text-ink-muted">{p.receipt_number}</div>}
        </span>
      );
    }
    if (p.receipt_status === "pending") return <Badge tone="neutral">in progress</Badge>;
    if (p.receipt_status === "skipped") return <Badge tone="warn">no site on the QR</Badge>;
    if (p.receipt_status === "failed") return <Badge tone="danger">refused</Badge>;
    return <Badge tone="warn">not raised</Badge>;
  };

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="QR payments"
        subtitle="Money that came in through a shared QR — and anything still waiting on a person"
        actions={
          <>
            {/* A next/link anchor wearing the button class rather than
                LinkButton: LinkButton is a plain <a>, which would drop out of
                the client router. */}
            <Link href="/calling/settings" className={buttonSecondary}>
              QR setup
            </Link>
            <ExportButton
              path="/api/crm/qr/payments/export"
              params={filterParams()}
              filename="qr-payments"
            />
          </>
        }
      />

      <Toolbar>
        <Field label="Show" className="w-52">
          <Select
            value={scope}
            onChange={setScope}
            ariaLabel="Show"
            options={[
              { value: "attention", label: "Needs attention" },
              { value: "unmatched", label: "Unmatched only" },
              { value: "all", label: "Everything" },
            ]}
          />
        </Field>
      </Toolbar>

      {notice && <Alert tone="good">{notice}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <CardHeader
        title={`${payments.length} payment${payments.length === 1 ? "" : "s"}`}
        subtitle={
          scope === "attention"
            ? "Unmatched, or matched with no receipt behind them. A donation with no receipt looks finished everywhere else."
            : undefined
        }
      />

      <TableShell>
        <Thead>
          <Th>Received</Th>
          <Th align="right">Amount</Th>
          <Th>QR</Th>
          <Th>Who paid</Th>
          <Th>Matched to</Th>
          <Th>Receipt</Th>
          <Th align="right">Actions</Th>
        </Thead>

        {loading ? (
          <SkeletonRows rows={6} cols={7} />
        ) : (
          <Tbody>
            {!payments.length ? (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    title={scope === "attention" ? "Nothing waiting" : "No QR payments yet"}
                    message={
                      scope === "attention"
                        ? "Every payment that has come in is matched to a lead and has a receipt behind it."
                        : "When a caller shares a QR and the donor pays, it appears here."
                    }
                  />
                </td>
              </tr>
            ) : (
              payments.map((p) => (
                <tr key={p.id}>
                  <Td className="text-xs text-ink-muted">
                    {shortDate(p.received_at)}
                    <div className="text-ink-faint">{relativeDate(p.received_at)}</div>
                  </Td>
                  <Td align="right" className="font-medium tabular-nums text-ink">
                    {currency(Number(p.amount))}
                  </Td>
                  <Td>
                    <span className="text-sm text-ink-soft">
                      {p.qr_label ?? <span className="text-ink-faint">unknown QR</span>}
                    </span>
                    {p.qr_owner && <div className="text-xs text-ink-muted">{p.qr_owner}</div>}
                  </Td>
                  <Td className="text-xs text-ink-soft">
                    {p.payer_phone ? <span className="tabular-nums">{p.payer_phone}</span> : null}
                    {p.payer_vpa && <div className="text-ink-faint">{p.payer_vpa}</div>}
                    {!p.payer_phone && !p.payer_vpa && <span className="text-ink-faint">not given</span>}
                  </Td>
                  <Td>
                    {p.lead_id ? (
                      <Link href={`/leads/${p.lead_id}`} className="text-sm text-brand-700 hover:underline">
                        {p.lead_name || "a lead"}
                      </Link>
                    ) : (
                      <>
                        <Badge tone="warn">nobody yet</Badge>
                        {/* The reason, not just the state. Each one asks for a
                            different fix, and only the matcher knows which. */}
                        {p.match_note && (
                          <p className="mt-1 max-w-[16rem] text-xs leading-snug text-ink-muted">
                            {p.match_note}
                            {p.match_score != null && ` (scored ${p.match_score} of ${60} needed)`}
                          </p>
                        )}
                      </>
                    )}
                  </Td>
                  <Td>{receiptBadge(p)}</Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      {!p.share_id && (
                        <Button size="sm" onClick={() => setAttaching(p)}>
                          Whose is it?
                        </Button>
                      )}
                      {p.share_id && p.receipt_status !== "issued" && p.receipt_status !== "pending" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void retryReceipt(p)}
                          loading={busy === p.id}
                          title={p.receipt_error ?? undefined}
                        >
                          Raise receipt
                        </Button>
                      )}
                    </div>
                    {p.receipt_error && (
                      <p className="mt-0.5 max-w-xs text-right text-xs text-danger">{p.receipt_error}</p>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </Tbody>
        )}
      </TableShell>

      <div className="mt-4 space-y-2">
        <p className="text-xs text-ink-muted">
          DRM matches a payment on the QR it came through, the amount, and how soon it arrived after the QR was
          shared. Anything it cannot place confidently waits here rather than being credited to a guess — a
          donation attributed to the wrong caller is worse than one attributed to nobody.
        </p>
        {/* Said out loud because it is the one case where DRM knows the
            answer and still refuses to act on it, which otherwise looks like
            a fault rather than the safeguard it is. */}
        <p className="text-xs text-ink-muted">
          A payment that only matches on the donor&apos;s phone number is never applied on its own. The websites
          take their donations through the same Razorpay account, so that payment might be a website donation
          that already has a receipt — linking it here would raise a second one for the same money.
        </p>
      </div>

      {attaching && (
        <AttachDialog
          payment={attaching}
          onClose={() => setAttaching(null)}
          onDone={async () => {
            setAttaching(null);
            setNotice("Linked. The receipt is being raised now.");
            await load();
          }}
        />
      )}
    </div>
  );
}

/** Choosing which shared QR a payment belongs to. */
function AttachDialog({
  payment,
  onClose,
  onDone,
}: {
  payment: Payment;
  onClose: () => void;
  onDone: () => void;
}) {
  const [shares, setShares] = useState<Share[]>([]);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Start with the people who actually said they would pay. Most shares went
  // to people who said nothing, and scrolling past forty of those to reach the
  // three who promised is how the wrong one gets picked.
  const [promisedOnly, setPromisedOnly] = useState(true);

  useEffect(() => {
    apiClient
      .get<{ shares: Share[] }>(
        `/api/crm/qr/shares?mine=false&unmatched=true${promisedOnly ? "&awaiting=true" : ""}`
      )
      .then((d) => setShares(d.shares))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the shares"));
  }, [promisedOnly]);

  const promised = (s: Share) => !!(s.awaiting_payment_at || s.awaiting_qr_at);

  return (
    <Modal
      title={`Who sent ${currency(Number(payment.amount))}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!chosen}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await apiClient.post(`/api/crm/qr/payments/${payment.id}/attach`, { share_id: chosen });
                onDone();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not link that payment");
                setBusy(false);
              }
            }}
          >
            Link it
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="mb-3 text-sm text-ink-soft">
        Received {relativeDate(payment.received_at)} through {payment.qr_label ?? "a QR"}
        {payment.payer_vpa && ` from ${payment.payer_vpa}`}
        {payment.payer_phone && ` · ${payment.payer_phone}`}. Pick the donor it was meant for and DRM will credit
        the lead and raise the receipt.
      </p>

      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs text-ink-muted">
          {promisedOnly ? "Showing people who said they would pay" : "Showing everyone who was sent a QR"}
        </span>
        <Button variant="ghost" size="xs" onClick={() => setPromisedOnly((v) => !v)}>
          {promisedOnly ? "Show everyone" : "Only those who promised"}
        </Button>
      </div>

      <div className="max-h-72 space-y-1 overflow-y-auto scroll-slim">
        {!shares.length && (
          <p className="py-6 text-center text-sm text-ink-faint">
            {promisedOnly
              ? "Nobody is down as having promised to pay. Show everyone to pick from every QR sent."
              : "No unmatched QR shares waiting."}
          </p>
        )}
        {shares.map((s) => (
          <label
            key={s.id}
            className={`flex cursor-pointer items-center gap-3 rounded-control border px-3 py-2 ${
              chosen === s.id ? "border-brand-600 bg-brand-50" : "border-transparent hover:bg-sunken"
            }`}
          >
            <input
              type="radio"
              name="share"
              checked={chosen === s.id}
              onChange={() => setChosen(s.id)}
              className="accent-brand-600"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">{s.lead_name || s.phone}</span>
              <span className="block text-xs text-ink-muted">
                {s.qr_label} · {relativeDate(s.created_at)}
                {s.expected_amount && ` · said ${currency(Number(s.expected_amount))}`}
              </span>
            </span>
            {promised(s) && <Badge tone="info">said they would</Badge>}
            {s.expected_amount && Math.abs(Number(s.expected_amount) - Number(payment.amount)) < 1 && (
              <Badge tone="good">amount matches</Badge>
            )}
          </label>
        ))}
      </div>
    </Modal>
  );
}
