"use client";

// A donor's giving, gift by gift: when, how much, for what, how it was paid and the receipt.
//
// Opened from "4 donations" on the call screen and "See all" on the lead page, so a caller who
// is asked "when did I give, and how much?" - or who sees "₹8,000 · 4×" and wants to know if
// that was four ₹2,000 gifts or one big one - can answer from the list instead of a total.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { clockTime, currency, shortDate } from "@/lib/format";
import { Alert, Badge, Modal, Skeleton } from "@/components/ui";

export interface HistoryDonation {
  id: string;
  amount: string | number;
  purpose: string | null;
  source_page?: string | null;
  source_site?: string | null;
  receipt_number: string | null;
  created_at: string;
  payment_mode?: string | null;
  payment_ref?: string | null;
  sevak_name?: string | null;
  source?: string | null;
}

const MODE: Record<string, string> = {
  upi: "UPI",
  cash: "Cash",
  cheque: "Cheque",
  bank: "Bank transfer",
  bank_transfer: "Bank transfer",
  card: "Card",
  netbanking: "Net banking",
};
const SITE: Record<string, string> = { hkmv: "HKM Vizag", annadan: "Annadan", drm: "DRM" };

/** How it was given, in words: "UPI · website" or "Cash · raised by hand". */
function howPaid(d: HistoryDonation): string {
  const mode = d.payment_mode ? MODE[d.payment_mode] ?? d.payment_mode : null;
  const how = d.source === "offline" ? "receipt raised by hand" : d.source === "website" || !d.source ? "online" : d.source.replace(/_/g, " ");
  return [mode, how].filter(Boolean).join(" · ");
}

export function DonationHistoryDialog({
  leadId,
  name,
  donations: given,
  onClose,
}: {
  /** Loads the history for this lead (the call screen, which has only the totals). */
  leadId?: string;
  name: string;
  /** Or the list already in hand (the lead page). */
  donations?: HistoryDonation[];
  onClose: () => void;
}) {
  const [rows, setRows] = useState<HistoryDonation[] | null>(given ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (given || !leadId) return;
    let live = true;
    apiClient
      .get<{ donations: HistoryDonation[] }>(`/api/crm/leads/${leadId}`)
      .then((r) => live && setRows(r.donations))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [leadId, given]);

  const total = (rows ?? []).reduce((s, d) => s + Number(d.amount || 0), 0);

  return (
    <Modal title={`Donations · ${name}`} onClose={onClose} wide>
      {error && <Alert tone="danger">{error}</Alert>}
      {!rows && !error && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
      {rows && rows.length === 0 && <p className="text-sm text-ink-muted">No donations recorded for this donor.</p>}
      {rows && rows.length > 0 && (
        <>
          <p className="mb-3 text-sm text-ink-muted">
            <span className="text-lg font-semibold tabular-nums text-ink">{currency(total)}</span> in {rows.length} donation
            {rows.length === 1 ? "" : "s"}
            {rows.length > 1 && (
              <>
                {" "}
                · first {shortDate(rows[rows.length - 1].created_at)} · last {shortDate(rows[0].created_at)}
              </>
            )}
          </p>
          <ul className="max-h-[60vh] divide-y divide-line-soft overflow-y-auto rounded-card border border-line-soft">
            {rows.map((d, i) => (
              <li key={d.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    <span className="mr-2 text-xs font-normal tabular-nums text-ink-faint">#{rows.length - i}</span>
                    {shortDate(d.created_at)}
                    <span className="font-normal text-ink-muted"> · {clockTime(d.created_at)}</span>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-ink-muted">
                    {d.purpose || "Donation"}
                    {d.sevak_name ? ` · on the name of ${d.sevak_name}` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {howPaid(d)}
                    {d.payment_ref && !/^CASH-/.test(d.payment_ref) ? ` · ${d.payment_ref}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold tabular-nums text-ink">{currency(Number(d.amount))}</p>
                  <p className="mt-0.5 font-mono text-xs text-brand-700">{d.receipt_number ?? <span className="font-sans text-ink-faint">No receipt no.</span>}</p>
                  {d.source_site && SITE[d.source_site] && (
                    <span className="mt-1 inline-block">
                      <Badge tone="neutral">{SITE[d.source_site]}</Badge>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
