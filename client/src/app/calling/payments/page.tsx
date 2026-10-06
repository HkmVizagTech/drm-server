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
// HOW IT WORKS NOW
// One button per payment. A payment nobody has linked opens on "Who paid?" -
// anybody DRM knows, found by name or number, or a new person - and the
// receipt form follows, filled in from whoever was picked. It used to be two
// buttons, and the link could only reach somebody a QR had been sent to.

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
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
  SearchInput,
  SegmentedControl,
  Skeleton,
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
import { ReceiptDialog, isLinked, linkedName, type Credit, type Payment } from "@/components/receipts/qr-receipt-dialog";


// ?scope=all opens on every payment - the overview's QR tiles link here.
export default function QrPaymentsPage() {
  return (
    <Suspense fallback={null}>
      <QrPayments />
    </Suspense>
  );
}

function QrPayments() {
  const { user } = useAuth();
  const sp = useSearchParams();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [scope, setScope] = useState<"attention" | "all">(() => (sp.get("scope") === "all" ? "all" : "attention"));
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    const p = new URLSearchParams({ scope });
    if (q.trim()) p.set("q", q.trim());
    return p;
  }, [scope, q]);

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
    const t = window.setTimeout(() => void load(), q ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, q]);

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
        <SegmentedControl
          options={[
            { value: "attention", label: "To do" },
            { value: "all", label: "All" },
          ]}
          value={scope}
          onChange={setScope}
        />
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="Name, number, amount or UTR"
          className="min-w-[14rem] flex-1"
        />
      </Toolbar>

      {notice && <Alert tone="good" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <CardHeader
        title={`${payments.length} payment${payments.length === 1 ? "" : "s"}`}
        subtitle={scope === "attention" ? "No receipt sent yet." : undefined}
      />

      {/* On a phone: one card per payment, with its button in reach. The
          table below needs a sideways scroll to reach the button, which is
          where callers on a phone kept getting lost. */}
      <div className="space-y-2 sm:hidden">
        {loading && (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </>
        )}
        {!loading && !payments.length && (
          <EmptyState
            title={q ? "No match" : scope === "attention" ? "All done" : "No QR payments yet"}
            message={scope === "attention" && !q ? "Every payment has its receipt." : "QR payments show here."}
          />
        )}
        {!loading &&
          payments.map((p) => {
            const linked = isLinked(p);
            const name = linkedName(p) ?? p.donor_name ?? null;
            const done = p.receipt_status === "issued" || p.receipt_status === "pending";
            return (
              <div key={p.id} className="rounded-card border border-line-soft bg-surface p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-lg font-semibold tabular-nums text-ink">{currency(Number(p.amount))}</p>
                    <p className="text-xs text-ink-muted">
                      {shortDate(p.received_at)} · {clockTime(p.received_at)}
                      {p.payer_vpa ? ` · ${p.payer_vpa}` : ""}
                    </p>
                    {p.utr && <p className="text-xs text-ink-faint">UTR {p.utr}</p>}
                  </div>
                  {receiptBadge(p)}
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="min-w-0 text-sm">
                    {linked || name ? (
                      <span className="font-medium text-ink">{name ?? "Linked"}</span>
                    ) : (
                      <Badge tone="warn">Not linked</Badge>
                    )}
                    {creditOf(p)?.name && (
                      <span className="block text-xs text-ink-muted">Counted for {creditOf(p)?.name}</span>
                    )}
                  </div>
                  {!done && (
                    <Button
                      size="sm"
                      icon={linked ? "receipt" : "user"}
                      variant={linked ? "primary" : "secondary"}
                      onClick={() => setReceipting(p)}
                    >
                      {linked ? "Send receipt" : "Who paid?"}
                    </Button>
                  )}
                </div>
                {p.receipt_error && <p className="mt-1 text-xs text-danger">{p.receipt_error}</p>}
              </div>
            );
          })}
      </div>

      <div className="hidden sm:block">
      <TableShell>
        <Thead>
          <Th>When</Th>
          <Th align="right">Amount</Th>
          <Th>Paid from</Th>
          <Th>Donor</Th>
          <Th>Receipt</Th>
          <Th align="right">{""}</Th>
        </Thead>

        {loading ? (
          <SkeletonRows rows={6} cols={6} />
        ) : (
          <Tbody>
            {!payments.length ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    title={q ? "No match" : scope === "attention" ? "All done" : "No QR payments yet"}
                    message={
                      q
                        ? "Try the amount or the last digits of the number or UTR."
                        : scope === "attention"
                        ? "Every payment has its receipt."
                        : "QR payments show here."
                    }
                  />
                </td>
              </tr>
            ) : (
              payments.map((p) => {
                const credit = creditOf(p);
                const linked = isLinked(p);
                const name = linkedName(p) ?? p.donor_name ?? null;
                const phone = p.person_phone ?? p.donor_phone ?? null;
                const done = p.receipt_status === "issued" || p.receipt_status === "pending";
                return (
                  <tr key={p.id}>
                    <Td className="text-xs text-ink-muted">
                      {shortDate(p.received_at)}
                      {/* The hour as well: matching a payment to a call or a
                          bank statement turns on before or after. */}
                      <div className="text-ink-faint">
                        {clockTime(p.received_at)} · {relativeDate(p.received_at)}
                      </div>
                      {p.qr_label && <div className="text-ink-faint">{p.qr_label}</div>}
                    </Td>
                    <Td align="right" className="font-medium tabular-nums text-ink">
                      {currency(Number(p.amount))}
                    </Td>
                    <Td className="text-xs text-ink-soft">
                      {p.payer_vpa && <div>{p.payer_vpa}</div>}
                      {p.payer_phone && <div className="tabular-nums">{p.payer_phone}</div>}
                      {!p.payer_phone && !p.payer_vpa && <span className="text-ink-faint">Not given</span>}
                      {p.utr && <div className="text-ink-faint">UTR {p.utr}</div>}
                    </Td>
                    <Td>
                      {linked || name ? (
                        <div className="min-w-0">
                          {p.lead_id ? (
                            <Link href={`/leads/${p.lead_id}`} className="text-sm font-medium text-brand-700 hover:underline">
                              {name || "a lead"}
                            </Link>
                          ) : p.person_id ? (
                            <Link href={`/people/${p.person_id}`} className="text-sm font-medium text-brand-700 hover:underline">
                              {name || "a donor"}
                            </Link>
                          ) : (
                            <span className="text-sm font-medium text-ink">{name}</span>
                          )}
                          {phone && <div className="text-xs tabular-nums text-ink-muted">{phone}</div>}
                        </div>
                      ) : (
                        <Badge tone="warn">Not linked</Badge>
                      )}
                      <div className="mt-1 text-xs">
                        {credit ? (
                          <span className="inline-flex flex-wrap items-center gap-1 text-ink-muted">
                            Counted for {credit.name ?? "someone"}
                            {canReverse && (
                              <Button variant="ghost" size="xs" onClick={() => setReversing({ payment: p, credit })}>
                                Remove
                              </Button>
                            )}
                          </span>
                        ) : (
                          // Only once a donor is known: before that, "Who paid?"
                          // decides the credit along with the link.
                          (linked || done) && (
                            <Button
                              variant="ghost"
                              size="xs"
                              icon="user"
                              loading={claiming === p.id}
                              onClick={() => void claim(p)}
                            >
                              Add to my total
                            </Button>
                          )
                        )}
                      </div>
                    </Td>
                    <Td>{receiptBadge(p)}</Td>
                    <Td align="right">
                      {!done && (
                        <Button
                          size="sm"
                          icon={linked ? "receipt" : "user"}
                          variant={linked ? "primary" : "secondary"}
                          onClick={() => setReceipting(p)}
                        >
                          {linked ? "Send receipt" : "Who paid?"}
                        </Button>
                      )}
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
      </div>

      {receipting && (
        <ReceiptDialog
          payment={receipting}
          currentUserId={user?.id ?? null}
          currentUserName={user?.name ?? null}
          onCreditKnown={rememberCredit}
          onChanged={() => void load()}
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
