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
import { currency, number, relativeDate, shortDate } from "@/lib/format";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Modal,
  PageHeader,
  Select,
  TableShell,
  Td,
  Th,
  buttonPrimary,
  buttonSecondary,
} from "@/components/ui";

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
}

export default function QrPaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [scope, setScope] = useState("attention");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<Payment | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiClient.get<{ payments: Payment[] }>(`/api/crm/qr/payments?scope=${scope}`);
      setPayments(d.payments);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the payments");
    } finally {
      setLoading(false);
    }
  }, [scope]);

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
    if (!p.share_id) return <span className="text-slate-300">—</span>;
    if (p.receipt_status === "issued") {
      return (
        <span>
          <Badge tone="good">issued</Badge>
          {p.receipt_number && <div className="mt-0.5 text-[11px] text-slate-500">{p.receipt_number}</div>}
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
        title="QR payments"
        subtitle="Money that came in through a shared QR — and anything still waiting on a person"
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/calling/settings" className={buttonSecondary}>
              QR setup
            </Link>
            <Select
              value={scope}
              onChange={setScope}
              className="min-w-[12rem]"
              options={[
                { value: "attention", label: "Needs attention" },
                { value: "unmatched", label: "Unmatched only" },
                { value: "all", label: "Everything" },
              ]}
            />
          </div>
        }
      />

      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      <Card padded={false}>
        <div className="px-5 pt-5">
          <CardHeader
            title={`${payments.length} payment${payments.length === 1 ? "" : "s"}`}
            subtitle={
              scope === "attention"
                ? "Unmatched, or matched with no receipt behind them. A donation with no receipt looks finished everywhere else."
                : undefined
            }
          />
        </div>

        <TableShell>
          <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
            <tr>
              <Th>Received</Th>
              <Th align="right">Amount</Th>
              <Th>QR</Th>
              <Th>Who paid</Th>
              <Th>Matched to</Th>
              <Th>Receipt</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">Loading…</td></tr>
            ) : !payments.length ? (
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
                <tr key={p.id} className="hover:bg-slate-50/60">
                  <Td className="text-xs text-slate-500">
                    {shortDate(p.received_at)}
                    <div className="text-slate-400">{relativeDate(p.received_at)}</div>
                  </Td>
                  <Td align="right" className="tabular-nums font-medium text-slate-900">
                    {currency(Number(p.amount))}
                  </Td>
                  <Td>
                    <span className="text-sm text-slate-700">{p.qr_label ?? <span className="text-slate-400">unknown QR</span>}</span>
                    {p.qr_owner && <div className="text-[11px] text-slate-500">{p.qr_owner}</div>}
                  </Td>
                  <Td className="text-xs text-slate-600">
                    {p.payer_phone ? <span className="tabular-nums">{p.payer_phone}</span> : null}
                    {p.payer_vpa && <div className="text-slate-400">{p.payer_vpa}</div>}
                    {!p.payer_phone && !p.payer_vpa && <span className="text-slate-300">not given</span>}
                  </Td>
                  <Td>
                    {p.lead_id ? (
                      <Link href={`/leads/${p.lead_id}`} className="text-sm text-[var(--accent)] hover:underline">
                        {p.lead_name || "a lead"}
                      </Link>
                    ) : (
                      <>
                        <Badge tone="warn">nobody yet</Badge>
                        {/* The reason, not just the state. Each one asks for a
                            different fix, and only the matcher knows which. */}
                        {p.match_note && (
                          <p className="mt-1 max-w-[16rem] text-[11px] leading-snug text-slate-500">
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
                        <button
                          onClick={() => setAttaching(p)}
                          className="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                        >
                          Whose is it?
                        </button>
                      )}
                      {p.share_id && p.receipt_status !== "issued" && p.receipt_status !== "pending" && (
                        <button
                          onClick={() => void retryReceipt(p)}
                          disabled={busy === p.id}
                          className="rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                          title={p.receipt_error ?? undefined}
                        >
                          {busy === p.id ? "…" : "Raise receipt"}
                        </button>
                      )}
                    </div>
                    {p.receipt_error && (
                      <p className="mt-0.5 max-w-xs text-right text-[11px] text-red-600">{p.receipt_error}</p>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </TableShell>

        <div className="border-t border-[var(--line-soft)] px-5 py-4">
          <p className="text-xs text-slate-500">
            DRM matches a payment on the QR it came through, the amount, and how soon it arrived after the QR was
            shared. Anything it cannot place confidently waits here rather than being credited to a guess — a
            donation attributed to the wrong caller is worse than one attributed to nobody.
          </p>
          {/* Said out loud because it is the one case where DRM knows the
              answer and still refuses to act on it, which otherwise looks like
              a fault rather than the safeguard it is. */}
          <p className="mt-2 text-xs text-slate-500">
            A payment that only matches on the donor&apos;s phone number is never applied on its own. The websites
            take their donations through the same Razorpay account, so that payment might be a website donation
            that already has a receipt — linking it here would raise a second one for the same money.
          </p>
        </div>
      </Card>

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

  useEffect(() => {
    apiClient
      .get<{ shares: Share[] }>("/api/crm/qr/shares?mine=false")
      .then((d) => setShares(d.shares.filter((s) => !s.matched_at)))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the shares"));
  }, []);

  return (
    <Modal title={`Who sent ${currency(Number(payment.amount))}?`} onClose={onClose}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <p className="mb-3 text-sm text-slate-600">
        Received {relativeDate(payment.received_at)} through {payment.qr_label ?? "a QR"}
        {payment.payer_vpa && ` from ${payment.payer_vpa}`}
        {payment.payer_phone && ` · ${payment.payer_phone}`}. Pick the donor it was meant for and DRM will credit
        the lead and raise the receipt.
      </p>

      <div className="max-h-72 space-y-1 overflow-y-auto scroll-slim">
        {!shares.length && <p className="py-6 text-center text-sm text-slate-400">No unmatched QR shares waiting.</p>}
        {shares.map((s) => (
          <label
            key={s.id}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${
              chosen === s.id ? "border-[var(--accent)] bg-[var(--accent-wash)]" : "border-transparent hover:bg-slate-50"
            }`}
          >
            <input
              type="radio"
              name="share"
              checked={chosen === s.id}
              onChange={() => setChosen(s.id)}
              className="border-slate-300"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-slate-900">{s.lead_name || s.phone}</span>
              <span className="block text-[11px] text-slate-500">
                {s.qr_label} · {relativeDate(s.created_at)}
                {s.expected_amount && ` · said ${currency(Number(s.expected_amount))}`}
              </span>
            </span>
            {s.expected_amount && Math.abs(Number(s.expected_amount) - Number(payment.amount)) < 1 && (
              <Badge tone="good">amount matches</Badge>
            )}
          </label>
        ))}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={buttonSecondary}>Cancel</button>
        <button
          disabled={busy || !chosen}
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
          className={buttonPrimary}
        >
          {busy ? "Linking…" : "Link it"}
        </button>
      </div>
    </Modal>
  );
}
