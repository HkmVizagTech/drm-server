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
//
// WHAT CHANGED
// An unmatched payment used to be a dead end: with no share behind it there was
// no name, no number and no site, so the receipt function returned without
// doing anything and the donor simply never got their certificate. Nothing on
// screen said so. A person can now supply those details by hand - that is the
// receipt dialog below - and the attribution is a second, separate act, so
// getting a certificate out for somebody else's donor no longer means taking
// the credit for their call.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { clockTime, currency, dateTime, relativeDate, shortDate } from "@/lib/format";
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
  Textarea,
  Th,
  Thead,
  Toolbar,
  buttonSecondary,
} from "@/components/ui";
import { ExportButton } from "@/components/export-button";
import { ReceiptDialog, type Credit, type Payment } from "@/components/receipts/qr-receipt-dialog";

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
  const { user } = useAuth();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [scope, setScope] = useState("attention");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<Payment | null>(null);
  const [receipting, setReceipting] = useState<Payment | null>(null);
  const [reversing, setReversing] = useState<{ payment: Payment; credit: Credit } | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [credits, setCredits] = useState<Record<string, Credit>>({});

  // Reversing a credit is the one thing on this screen a caller must not do,
  // because a credit is somebody's figures at the end of the month.
  const canReverse = user?.role === "admin" || user?.role === "accountant";

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
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
    } finally {
      setLoading(false);
    }
  }, [filterParams]);

  useEffect(() => {
    void load();
  }, [load]);

  const rememberCredit = useCallback((paymentId: string, credit: Credit) => {
    setCredits((c) => ({ ...c, [paymentId]: credit }));
  }, []);

  /**
   * What this screen knows about who the money is counted for.
   *
   * Anything learned during this session wins over the row: a claim made a
   * moment ago is not in the list response, and a row still showing the money
   * as unclaimed after somebody pressed the button reads as a button that did
   * nothing.
   */
  const creditOf = (p: Payment): Credit | undefined => {
    if (p.id in credits) return credits[p.id];
    if (p.credit_user_name) return { user_id: p.credit_user_id ?? null, name: p.credit_user_name };
    return undefined;
  };

  async function claim(p: Payment) {
    setClaiming(p.id);
    setError(null);
    setNotice(null);
    try {
      await apiClient.post<{ claimed: boolean }>(`/api/crm/qr/payments/${p.id}/claim`, {});
      rememberCredit(p.id, { user_id: user?.id ?? null, name: user?.name ?? "you" });
      setNotice(`${currency(Number(p.amount))} added to your total.`);
    } catch (e) {
      // The 409 body names whoever already has it, and that sentence is the
      // whole answer - "could not claim" would send somebody to ask around
      // for something the server already told us.
      setError(e instanceof Error ? e.message : "Could not add to your total. Try again.");
    } finally {
      setClaiming(null);
    }
  }

  const receiptBadge = (p: Payment) => {
    if (p.receipt_status === "issued") {
      return (
        <span>
          <Badge tone="good">Sent</Badge>
          {p.receipt_number && <div className="mt-0.5 text-xs text-ink-muted">{p.receipt_number}</div>}
        </span>
      );
    }
    if (p.receipt_status === "pending") return <Badge tone="neutral">In progress</Badge>;
    if (p.receipt_status === "skipped") return <Badge tone="warn">No site set</Badge>;
    if (p.receipt_status === "needs_donor") return <Badge tone="warn">Needs donor details</Badge>;
    if (p.receipt_status === "failed") return <Badge tone="danger">Failed</Badge>;
    return <Badge tone="warn">Not sent</Badge>;
  };

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="QR payments"
        subtitle="Money paid through a QR."
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
              { value: "attention", label: "Needs action" },
              { value: "unmatched", label: "Not linked yet" },
              { value: "all", label: "All" },
            ]}
          />
        </Field>
      </Toolbar>

      {notice && <Alert tone="good" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <CardHeader
        title={`${payments.length} payment${payments.length === 1 ? "" : "s"}`}
        subtitle={
          scope === "attention"
            ? "Not linked, or no receipt yet."
            : undefined
        }
      />

      <TableShell>
        <Thead>
          <Th>Date</Th>
          <Th align="right">Amount</Th>
          <Th>QR</Th>
          <Th>Paid by</Th>
          <Th>Donor</Th>
          <Th>Caller</Th>
          <Th>Receipt</Th>
          <Th align="right">Actions</Th>
        </Thead>

        {loading ? (
          <SkeletonRows rows={6} cols={8} />
        ) : (
          <Tbody>
            {!payments.length ? (
              <tr>
                <td colSpan={8}>
                  <EmptyState
                    title={scope === "attention" ? "All done" : "No QR payments yet"}
                    message={
                      scope === "attention"
                        ? "Every payment is linked and has a receipt."
                        : "QR payments show here."
                    }
                  />
                </td>
              </tr>
            ) : (
              payments.map((p) => {
                const credit = creditOf(p);
                return (
                  <tr key={p.id}>
                    <Td className="text-xs text-ink-muted">
                      {shortDate(p.received_at)}
                      {/* The hour, not just the day. Somebody reconciling a
                          shift or matching a bank statement is asking whether
                          the money came in before or after a particular call,
                          and a date on its own cannot answer that. */}
                      <div className="text-ink-faint">
                        {clockTime(p.received_at)} · {relativeDate(p.received_at)}
                      </div>
                    </Td>
                    <Td align="right" className="font-medium tabular-nums text-ink">
                      {currency(Number(p.amount))}
                    </Td>
                    <Td>
                      <span className="text-sm text-ink-soft">
                        {p.qr_label ?? <span className="text-ink-faint">Unknown QR</span>}
                      </span>
                      {p.qr_owner && <div className="text-xs text-ink-muted">{p.qr_owner}</div>}
                    </Td>
                    <Td className="text-xs text-ink-soft">
                      {p.payer_phone ? <span className="tabular-nums">{p.payer_phone}</span> : null}
                      {p.payer_vpa && <div className="text-ink-faint">{p.payer_vpa}</div>}
                      {!p.payer_phone && !p.payer_vpa && <span className="text-ink-faint">Not given</span>}
                    </Td>
                    <Td>
                      {p.lead_id ? (
                        <Link href={`/leads/${p.lead_id}`} className="text-sm text-brand-700 hover:underline">
                          {p.lead_name || "a lead"}
                        </Link>
                      ) : (
                        <>
                          <Badge tone="warn">Not linked yet</Badge>
                          {/* The reason, not just the state. Each one asks for a
                              different fix, and only the matcher knows which. */}
                          {p.match_note && (
                            <p className="mt-1 max-w-[16rem] text-xs leading-snug text-ink-muted">
                              {p.match_note}
                            </p>
                          )}
                        </>
                      )}
                    </Td>
                    <Td>
                      {credit ? (
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <Badge tone="brand" icon="user">
                            {credit.name ?? "Someone"}
                          </Badge>
                          {canReverse && (
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => setReversing({ payment: p, credit })}
                            >
                              Remove
                            </Button>
                          )}
                        </span>
                      ) : (
                        <>
                          {credit === null && (
                            <div className="mb-0.5 text-xs text-ink-faint">No caller</div>
                          )}
                          <Button
                            variant="ghost"
                            size="xs"
                            icon="user"
                            loading={claiming === p.id}
                            onClick={() => void claim(p)}
                          >
                            Add to my total
                          </Button>
                        </>
                      )}
                    </Td>
                    <Td>{receiptBadge(p)}</Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        {!p.share_id && (
                          <Button size="sm" variant="secondary" onClick={() => setAttaching(p)}>
                            Link donor
                          </Button>
                        )}
                        {/* Offered on every payment now, matched or not. The
                            dialog asks for whatever is missing, so there is no
                            longer a payment this screen can only shrug at. */}
                        {p.receipt_status !== "issued" && p.receipt_status !== "pending" && (
                          <Button size="sm" icon="receipt" onClick={() => setReceipting(p)}>
                            Send receipt
                          </Button>
                        )}
                      </div>
                      {p.receipt_error && (
                        <p className="mt-0.5 max-w-xs text-right text-xs text-danger">{p.receipt_error}</p>
                      )}
                    </Td>
                  </tr>
                );
              })
            )}
          </Tbody>
        )}
      </TableShell>



      {attaching && (
        <AttachDialog
          payment={attaching}
          onClose={() => setAttaching(null)}
          onDone={async () => {
            setAttaching(null);
            setNotice("Linked. Receipt is being sent.");
            await load();
          }}
        />
      )}

      {receipting && (
        <ReceiptDialog
          payment={receipting}
          currentUserId={user?.id ?? null}
          currentUserName={user?.name ?? null}
          onCreditKnown={rememberCredit}
          onClose={() => setReceipting(null)}
          onDone={async (message) => {
            setReceipting(null);
            setError(null);
            setNotice(message);
            await load();
          }}
        />
      )}

      {reversing && (
        <ReverseCreditDialog
          payment={reversing.payment}
          credit={reversing.credit}
          onClose={() => setReversing(null)}
          onDone={(message) => {
            rememberCredit(reversing.payment.id, null);
            setReversing(null);
            setNotice(message);
          }}
        />
      )}
    </div>
  );
}

/**
 * Taking a credit back off somebody.
 *
 * The reason is asked for rather than optional because this is one person
 * removing money from another person's figures. Two people disagreeing about a
 * month's total a fortnight later need to be able to read why it moved, and
 * nobody remembers by then.
 */
function ReverseCreditDialog({
  payment,
  credit,
  onClose,
  onDone,
}: {
  payment: Payment;
  credit: Credit;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={`Remove ${currency(Number(payment.amount))} from ${credit?.name ?? "caller"}'s total?`}
      tone="danger"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!reason.trim()}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                // apiClient.delete sends no body, and the reason is the whole
                // point of this dialog, so the request is built here instead.
                await api(`/api/crm/qr/payments/${payment.id}/claim`, {
                  method: "DELETE",
                  body: JSON.stringify({ reason: reason.trim() }),
                });
                onDone(
                  `${currency(Number(payment.amount))} removed from ${credit?.name ?? "their"} total.`
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not remove. Try again.");
                setBusy(false);
              }
            }}
          >
            Remove
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="mb-3 text-sm text-ink-soft">
        {currency(Number(payment.amount))} paid {dateTime(payment.received_at)}. The receipt stays.
      </p>

      <Field label="Reason" htmlFor="reverse-reason" required>
        <Textarea
          id="reverse-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Added by mistake. Ravi's donor."
        />
      </Field>
    </Modal>
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
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load. Try again."));
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
                setError(e instanceof Error ? e.message : "Could not link. Try again.");
                setBusy(false);
              }
            }}
          >
            Link
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="mb-3 text-sm text-ink-soft">
        Paid {relativeDate(payment.received_at).toLowerCase()} through {payment.qr_label ?? "a QR"}
        {payment.payer_vpa && ` from ${payment.payer_vpa}`}
        {payment.payer_phone && ` · ${payment.payer_phone}`}. Pick the donor.
      </p>

      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs text-ink-muted">
          {promisedOnly ? "Said they would pay" : "Everyone sent a QR"}
        </span>
        <Button variant="ghost" size="xs" onClick={() => setPromisedOnly((v) => !v)}>
          {promisedOnly ? "Show everyone" : "Only who promised"}
        </Button>
      </div>

      <div className="max-h-72 space-y-1 overflow-y-auto scroll-slim">
        {!shares.length && (
          <p className="py-6 text-center text-sm text-ink-faint">
            {promisedOnly
              ? "No one promised to pay. Tap Show everyone."
              : "No QRs waiting to be linked."}
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
                {s.expected_amount && ` · promised ${currency(Number(s.expected_amount))}`}
              </span>
            </span>
            {promised(s) && <Badge tone="info">Promised</Badge>}
            {s.expected_amount && Math.abs(Number(s.expected_amount) - Number(payment.amount)) < 1 && (
              <Badge tone="good">Same amount</Badge>
            )}
          </label>
        ))}
      </div>
    </Modal>
  );
}
