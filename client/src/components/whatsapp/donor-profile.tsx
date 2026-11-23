"use client";

// Who you are chatting with, as a donor. Opens on the name or picture at the top of a WhatsApp chat:
// what they have given in all (how many times, the average, the largest, this year), year by year,
// what for, the latest gifts - with every gift one tap away - and their lead in DRM.
//
// A number nobody has given from yet says so, rather than showing a page of zeros.

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, shortDate } from "@/lib/format";
import { Alert, Avatar, Badge, Modal, Skeleton } from "@/components/ui";
import { DonationHistoryDialog, type HistoryDonation } from "@/components/calling/donation-history";

interface DonorProfile {
  person: { id: string; name: string | null; phone: string; email: string | null; city: string | null; created_at: string } | null;
  stats?: { count: number; total: number; average: number; largest: number; this_year: number; first_at: string | null; last_at: string | null };
  by_year?: { year: number; count: number; total: number }[];
  by_purpose?: { purpose: string; count: number; total: number }[];
  donations?: HistoryDonation[];
  lead?: { id: string; status_label: string | null; caller_name: string | null; next_follow_up_at: string | null } | null;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border border-line-soft bg-surface px-3 py-2.5">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-ink">{value}</p>
      {sub && <p className="text-xs text-ink-faint">{sub}</p>}
    </div>
  );
}

export function WhatsAppDonorProfile({
  conversationId,
  name,
  phone,
  onClose,
}: {
  conversationId: string;
  name: string;
  phone: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<DonorProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allOpen, setAllOpen] = useState(false);

  useEffect(() => {
    let live = true;
    apiClient
      .get<DonorProfile>(`/api/wa-chat/conversations/${conversationId}/donor`)
      .then((r) => live && setData(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [conversationId]);

  const s = data?.stats;
  const gifts = data?.donations ?? [];
  const best = Math.max(1, ...(data?.by_year ?? []).map((y) => y.total));
  const shownName = data?.person?.name || name;

  if (allOpen) {
    return <DonationHistoryDialog name={shownName} donations={gifts} onClose={() => setAllOpen(false)} />;
  }

  return (
    <Modal title="Donor profile" onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Avatar name={shownName} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-ink">{shownName}</p>
            <p className="truncate text-xs text-ink-muted">
              {phone}
              {data?.person?.email ? ` · ${data.person.email}` : ""}
              {data?.person?.city ? ` · ${data.person.city}` : ""}
            </p>
          </div>
          {data?.person && (
            <Link href={`/people/${data.person.id}`} className="shrink-0 text-sm font-medium text-brand-700 hover:underline">
              Full profile
            </Link>
          )}
        </div>

        {error && <Alert tone="danger">{error}</Alert>}
        {!data && !error && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        )}

        {data && !data.person && (
          <p className="rounded-card bg-sunken/60 p-3 text-sm text-ink-muted">This number is not a donor in DRM yet - no donations recorded.</p>
        )}

        {data?.person && s && s.count === 0 && (
          <p className="rounded-card bg-sunken/60 p-3 text-sm text-ink-muted">In DRM since {shortDate(data.person.created_at)}, but no donations recorded yet.</p>
        )}

        {data?.person && s && s.count > 0 && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Given in all" value={currency(s.total)} sub={`${s.count} donation${s.count === 1 ? "" : "s"}`} />
              <Stat label="Average gift" value={currency(Math.round(s.average))} />
              <Stat label="Largest gift" value={currency(s.largest)} />
              <Stat label="This year" value={currency(s.this_year)} />
            </div>
            <p className="text-xs text-ink-muted">
              First gift {shortDate(s.first_at)} · last gift {shortDate(s.last_at)}
            </p>

            {(data.by_year?.length ?? 0) > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-ink-soft">Year by year</p>
                <ul className="space-y-1.5">
                  {data.by_year!.map((y) => (
                    <li key={y.year} className="flex items-center gap-3 text-sm">
                      <span className="w-10 shrink-0 tabular-nums text-ink-muted">{y.year}</span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
                        <span className="block h-full rounded-full bg-brand-500" style={{ width: `${(y.total / best) * 100}%` }} />
                      </span>
                      <span className="w-24 shrink-0 text-right font-medium tabular-nums text-ink">{currency(y.total)}</span>
                      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-ink-faint">{y.count}×</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(data.by_purpose?.length ?? 0) > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-ink-soft">Gives for</p>
                <div className="flex flex-wrap gap-1.5">
                  {data.by_purpose!.map((p) => (
                    <Badge key={p.purpose} tone="neutral">
                      {p.purpose} · {currency(p.total)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="mb-1.5 text-xs font-medium text-ink-soft">Latest donations</p>
              <ul className="divide-y divide-line-soft rounded-card border border-line-soft">
                {gifts.slice(0, 5).map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{shortDate(d.created_at)}</p>
                      <p className="truncate text-xs text-ink-muted">{d.purpose || "Donation"}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-semibold tabular-nums text-ink">{currency(Number(d.amount))}</p>
                      {d.receipt_number && <p className="font-mono text-xs text-brand-700">{d.receipt_number}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => setAllOpen(true)} className="mt-2 text-sm font-semibold text-brand-700 hover:underline">
                See all {s.count} donation{s.count === 1 ? "" : "s"} - date, amount, receipt
              </button>
            </div>
          </>
        )}

        {data?.lead && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-card bg-sunken/60 px-3 py-2.5 text-sm">
            <span className="text-ink-soft">
              In calling{data.lead.status_label ? ` · ${data.lead.status_label}` : ""}
              {data.lead.caller_name ? ` · ${data.lead.caller_name}` : " · no caller yet"}
              {data.lead.next_follow_up_at ? ` · follow up ${shortDate(data.lead.next_follow_up_at)}` : ""}
            </span>
            <Link href={`/leads/${data.lead.id}`} className="font-medium text-brand-700 hover:underline">
              Open lead
            </Link>
          </div>
        )}
      </div>
    </Modal>
  );
}
