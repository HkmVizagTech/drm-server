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
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
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
  // Optional because the list query does not select them today - only the
  // detail route does. Declared so that the column below starts filling in on
  // its own the day the list learns to send them, rather than needing this
  // screen changed again.
  credit_user_id?: string | null;
  credit_user_name?: string | null;
}

/** Everything GET /qr/payments/:id knows, which is what the receipt dialog fills itself from. */
interface PaymentDetail {
  id: string;
  payment_id: string;
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
  purpose: string | null;
  sevak_name: string | null;
  sevak_phone: string | null;
  receipt_status: string | null;
  receipt_error: string | null;
  receipt_number: string | null;
}

interface ReceiptOutcome {
  receipt_status: string | null;
  receipt_error: string | null;
  receipt_number: string | null;
  external_donation_id: string | null;
  credited: boolean;
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

/**
 * Who a payment is counted for, as far as this screen has been told.
 *
 * `null` means asked and nobody has it; `undefined` means never asked. The two
 * must stay distinguishable - printing "nobody" for a row we have simply not
 * looked at would invite somebody to claim money that is already somebody
 * else's, and the only thing stopping them would be a 409 after the fact.
 */
type Credit = { user_id: string | null; name: string | null } | null;

const SITE_NAMES: Record<string, string> = {
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
function personName(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!s || s.includes("@")) return null;
  return s;
}

const siteName = (key: string | null | undefined) =>
  key ? SITE_NAMES[key] ?? key : null;

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
      setError(e instanceof Error ? e.message : "Could not load the payments");
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
      setNotice(`${currency(Number(p.amount))} is now counted towards your total.`);
    } catch (e) {
      // The 409 body names whoever already has it, and that sentence is the
      // whole answer - "could not claim" would send somebody to ask around
      // for something the server already told us.
      setError(e instanceof Error ? e.message : "Could not claim that payment");
    } finally {
      setClaiming(null);
    }
  }

  const receiptBadge = (p: Payment) => {
    if (p.receipt_status === "issued") {
      return (
        <span>
          <Badge tone="good">issued</Badge>
          {p.receipt_number && <div className="mt-0.5 text-xs text-ink-muted">{p.receipt_number}</div>}
        </span>
      );
    }
    if (p.receipt_status === "pending") return <Badge tone="neutral">in progress</Badge>;
    if (p.receipt_status === "skipped") return <Badge tone="warn">no site chosen yet</Badge>;
    if (p.receipt_status === "needs_donor") return <Badge tone="warn">needs the donor&apos;s details</Badge>;
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

      {notice && <Alert tone="good" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

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
          <Th>Counted for</Th>
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
                    <Td>
                      {credit ? (
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <Badge tone="brand" icon="user">
                            {credit.name ?? "somebody"}
                          </Badge>
                          {canReverse && (
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => setReversing({ payment: p, credit })}
                            >
                              Reverse
                            </Button>
                          )}
                        </span>
                      ) : (
                        <>
                          {credit === null && (
                            <div className="mb-0.5 text-xs text-ink-faint">counted for nobody</div>
                          )}
                          <Button
                            variant="ghost"
                            size="xs"
                            icon="user"
                            loading={claiming === p.id}
                            onClick={() => void claim(p)}
                          >
                            That one was mine
                          </Button>
                        </>
                      )}
                    </Td>
                    <Td>{receiptBadge(p)}</Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        {!p.share_id && (
                          <Button size="sm" variant="secondary" onClick={() => setAttaching(p)}>
                            Whose is it?
                          </Button>
                        )}
                        {/* Offered on every payment now, matched or not. The
                            dialog asks for whatever is missing, so there is no
                            longer a payment this screen can only shrug at. */}
                        {p.receipt_status !== "issued" && p.receipt_status !== "pending" && (
                          <Button size="sm" icon="receipt" onClick={() => setReceipting(p)}>
                            Raise receipt
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
        <p className="text-xs text-ink-muted">
          Raising a receipt and counting the money towards somebody are two separate acts, on purpose. A credit
          can be corrected later; an 80G number that has gone out cannot be withdrawn.
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
function ReceiptDialog({
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
  /** What the site said when it refused, kept so the form can be fixed and tried again. */
  const [refusal, setRefusal] = useState<string | null>(null);

  const [donorName, setDonorName] = useState("");
  const [donorPhone, setDonorPhone] = useState("");
  const [donorEmail, setDonorEmail] = useState("");
  const [donorPan, setDonorPan] = useState("");
  const [donorAddress, setDonorAddress] = useState("");
  const [purpose, setPurpose] = useState("");
  const [sevakName, setSevakName] = useState("");
  const [sevakPhone, setSevakPhone] = useState("");
  const [site, setSite] = useState("");
  const [creditMe, setCreditMe] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ payment: PaymentDetail }>(`/api/crm/qr/payments/${payment.id}`)
      .then(({ payment: d }) => {
        if (cancelled) return;
        setDetail(d);
        // Prefilled from the most specific thing DRM holds down to the least:
        // the donor record, then the lead, then whatever Razorpay reported.
        //
        // Razorpay's payer_name is last AND is dropped when it looks like a
        // UPI handle. The comment here used to say that and the code did not
        // do it, so the box arrived holding "rameshk@okhdfcbank" — which looks
        // filled in, reads as a name at a glance, and would have gone onto a
        // real 80G certificate the moment somebody pressed the button without
        // reading it. An empty box that has to be filled is the safer failure.
        setDonorName(
          d.donor_name ?? d.person_name ?? d.lead_name ?? personName(d.payer_name) ?? ""
        );
        setDonorPhone(d.donor_phone ?? d.share_phone ?? d.payer_phone ?? "");
        setDonorEmail(d.donor_email ?? d.person_email ?? d.lead_email ?? "");
        setDonorPan(d.donor_pan ?? d.person_pan ?? "");
        setDonorAddress(d.donor_address ?? d.person_address ?? "");
        setPurpose(d.purpose ?? d.qr_purpose ?? "");
        setSevakName(d.sevak_name ?? "");
        setSevakPhone(d.sevak_phone ?? "");
        setSite(d.site_for_receipt ?? "");
        // Defaulted to yes only where this person's own work is plainly behind
        // the payment. Defaulting to yes everywhere would quietly move other
        // callers' donations onto whoever happened to open the dialog.
        setCreditMe(
          !d.credit_id &&
            !!currentUserId &&
            (d.shared_by === currentUserId || d.lead_assigned_to === currentUserId)
        );
        // Told either way, including "nobody has it". The list request does not
        // carry the credit, so without this the row behind the dialog goes on
        // showing nothing where the answer is now known.
        onCreditKnown(
          d.id,
          d.credit_id ? { user_id: d.credit_user_id, name: d.credit_user_name } : null
        );
        setRefusal(d.receipt_error);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load that payment");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [payment.id, currentUserId, onCreditKnown]);

  const phoneDigits = donorPhone.replace(/\D/g, "").slice(-10);
  const phoneOk = phoneDigits.length === 10;
  const pan = donorPan.trim().toUpperCase();
  const panLooksOdd = pan.length > 0 && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan);
  const chosenSite = detail?.site_for_receipt ?? site;
  const ready = !loading && !!donorName.trim() && phoneOk && !!chosenSite;

  async function raise() {
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const r = await apiClient.post<ReceiptOutcome>(`/api/crm/qr/payments/${payment.id}/receipt`, {
        donor_name: donorName.trim(),
        donor_phone: phoneDigits,
        donor_email: donorEmail.trim(),
        donor_pan: pan,
        donor_address: donorAddress.trim(),
        purpose: purpose.trim(),
        sevak_name: sevakName.trim(),
        sevak_phone: sevakPhone.trim(),
        site,
        credit_me: creditMe,
      });

      if (r.receipt_status === "issued") {
        // Only on a credit that actually landed. `credited: false` also covers
        // "somebody already has it", so recording "nobody" from it would put a
        // claim button back on a row that is already counted for a colleague.
        if (r.credited) onCreditKnown(payment.id, { user_id: currentUserId, name: currentUserName });
        onDone(
          `Receipt ${r.receipt_number ?? ""} raised for ${currency(Number(payment.amount))}.${
            creditMe && !r.credited
              ? " The receipt is out, but the money was not counted for you — it is already counted for somebody."
              : ""
          }`
        );
        return;
      }

      // Left open on purpose. The site's refusal is usually specific - a PAN it
      // will not take, a duplicate reference - and closing the dialog would
      // throw away everything just typed, so the next attempt starts from a
      // blank form.
      setRefusal(r.receipt_error ?? "The site did not issue a receipt and did not say why.");
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not raise that receipt");
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Raise the receipt for ${currency(Number(payment.amount))}`}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-xs text-ink-muted">
            {chosenSite
              ? `Numbered from ${siteName(chosenSite)}`
              : "Choose which site issues it before raising"}
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="receipt" disabled={!ready} loading={busy} onClick={() => void raise()}>
            Raise the receipt
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {refusal && (
        <Alert tone="danger" title="The site would not issue it">
          {refusal}
        </Alert>
      )}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-9.5 w-full" />
          <Skeleton className="h-9.5 w-full" />
          <Skeleton className="h-9.5 w-full" />
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-ink-soft">
            {currency(Number(payment.amount))} received {dateTime(payment.received_at)} through{" "}
            {detail?.qr_label ?? "a QR"}
            {detail?.payer_vpa && ` from ${detail.payer_vpa}`}.
            {detail?.lead_name
              ? ` Matched to ${detail.lead_name}.`
              : " Nothing is matched to it, so everything on the certificate comes from this form."}
          </p>

          {detail?.credit_user_name && (
            <Alert tone="info">
              This money is already counted for {detail.credit_user_name}. The receipt can still be raised; the
              credit is left where it is.
            </Alert>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Donor's name" htmlFor="receipt-name" required>
              <Input
                id="receipt-name"
                value={donorName}
                onChange={(e) => setDonorName(e.target.value)}
                placeholder="As it should read on the certificate"
              />
            </Field>

            <Field
              label="Mobile number"
              htmlFor="receipt-phone"
              required
              error={donorPhone && !phoneOk ? "Ten digits are needed." : undefined}
              hint="Where the site sends the receipt."
            >
              <Input
                id="receipt-phone"
                value={donorPhone}
                inputMode="numeric"
                invalid={!!donorPhone && !phoneOk}
                onChange={(e) => setDonorPhone(e.target.value)}
              />
            </Field>

            <Field label="Email" htmlFor="receipt-email" hint="Optional — a second copy goes here.">
              <Input
                id="receipt-email"
                type="email"
                value={donorEmail}
                onChange={(e) => setDonorEmail(e.target.value)}
              />
            </Field>

            <Field
              label="PAN"
              htmlFor="receipt-pan"
              error={panLooksOdd ? "A PAN reads as five letters, four digits, then a letter." : undefined}
              hint="This is what decides it. With a PAN the donor gets an 80G certificate; without one the site records the donation and issues no certificate at all."
            >
              <Input
                id="receipt-pan"
                value={donorPan}
                onChange={(e) => setDonorPan(e.target.value.toUpperCase())}
                placeholder="ABCDE1234F"
              />
            </Field>

            <Field label="What the donation is for" htmlFor="receipt-purpose" className="sm:col-span-2">
              <Input
                id="receipt-purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="Annadan, Gaushala, general…"
              />
            </Field>

            <Field label="Address" htmlFor="receipt-address" className="sm:col-span-2">
              <Textarea
                id="receipt-address"
                rows={2}
                value={donorAddress}
                onChange={(e) => setDonorAddress(e.target.value)}
              />
            </Field>
          </div>

          <div className="mt-4 space-y-3 border-t border-line-soft pt-4">
            <div>
              <h3 className="text-sm font-semibold text-ink">On the name of</h3>
              {/* Spelled out because the field has been on both sites' receipt
                  templates all along and DRM never filled it, so every receipt
                  DRM has ever raised printed "---" where the donor expected the
                  name they gave on the phone. */}
              <p className="mt-0.5 text-xs text-ink-muted">
                Who the donation is offered for — a family member, a departed relative, the donor themselves.
                It prints on the certificate. Leave it empty and the certificate shows a dash there.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name it is offered for" htmlFor="receipt-sevak-name">
                <Input
                  id="receipt-sevak-name"
                  value={sevakName}
                  onChange={(e) => setSevakName(e.target.value)}
                />
              </Field>
              <Field
                label="Their mobile number"
                htmlFor="receipt-sevak-phone"
                hint="Optional."
              >
                <Input
                  id="receipt-sevak-phone"
                  value={sevakPhone}
                  inputMode="numeric"
                  onChange={(e) => setSevakPhone(e.target.value)}
                />
              </Field>
            </div>
          </div>

          <div className="mt-4 space-y-3 border-t border-line-soft pt-4">
            {!detail?.site_for_receipt && (
              <Field
                label="Which site issues the receipt"
                className="sm:w-80"
                hint="Nothing on the QR says which, and DRM cannot pick an 80G series on its own."
              >
                <Select
                  value={site}
                  onChange={setSite}
                  placeholder="Choose a site…"
                  ariaLabel="Which site issues the receipt"
                  options={[
                    { value: "hkmv", label: SITE_NAMES.hkmv },
                    { value: "annadan", label: SITE_NAMES.annadan },
                  ]}
                />
              </Field>
            )}

            <div>
              <Checkbox
                checked={creditMe}
                onChange={setCreditMe}
                disabled={!!detail?.credit_id}
                label="Is this your lead?"
              />
              <p className="mt-1 pl-6 text-xs text-ink-muted">
                {detail?.credit_id
                  ? `Already counted for ${detail.credit_user_name ?? "somebody"}, so this cannot move.`
                  : creditMe
                  ? "Yes — this counts towards your own total."
                  : "No — the receipt goes out and the money is counted for nobody. That is the right answer when you are helping with somebody else's donor."}
              </p>
            </div>
          </div>

          <Alert tone="warn" className="mb-0 mt-4" title="This cannot be undone">
            Pressing the button creates a real 80G number on{" "}
            {siteName(chosenSite) ?? "the site you choose"} and sends the certificate to the donor. A receipt
            with the wrong name or the wrong PAN on it has to be chased back by hand. Read the name, the number
            and the PAN once more before you press it.
          </Alert>
        </>
      )}
    </Modal>
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
      title={`Reverse the credit for ${currency(Number(payment.amount))}`}
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
                  `${currency(Number(payment.amount))} is no longer counted for ${credit?.name ?? "them"}.`
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not reverse that credit");
                setBusy(false);
              }
            }}
          >
            Reverse it
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="mb-3 text-sm text-ink-soft">
        {currency(Number(payment.amount))} received {dateTime(payment.received_at)} is counted for{" "}
        <span className="font-medium text-ink">{credit?.name ?? "somebody"}</span>. Reversing it leaves the
        credit on record with your reason against it — the receipt, if one was raised, is untouched.
      </p>

      <Field label="Why" htmlFor="reverse-reason" required>
        <Textarea
          id="reverse-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Claimed by mistake — the donor was Ravi's, confirmed on the call recording."
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
