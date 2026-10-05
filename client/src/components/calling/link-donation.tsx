"use client";

// "They gave — but from another number."
//
// A failed website payment is often finished on somebody else's phone: a
// son's UPI, a spouse's card, the temple QR scanned by a neighbour. DRM
// matches money to people by number, so that donation lands on a stranger
// and this person stays "nearly gave" - rung again, chased again, and the
// caller credited with nothing.
//
// This dialog lists the donations and temple-QR payments that came in around
// the time they tried, the likely ones first (same amount, a name in common,
// recent), and links the one the caller recognises. Linking converts the
// lead, credits the caller, closes their promises and remembers the other
// number. Undo is offered on the toast for half an hour's worth of regret.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { currency, dateTime, relativeDate } from "@/lib/format";
import { Alert, Badge, Button, EmptyState, Modal, SearchInput, Skeleton } from "../ui";
import { Icon } from "../icons";
import { toast } from "../toast";

interface DonationCandidate {
  kind: "donation";
  id: string;
  amount: string;
  at: string;
  purpose: string | null;
  source_site: string | null;
  source_page: string | null;
  receipt_number: string | null;
  sevak_name: string | null;
  donor_name: string | null;
  donor_phone: string | null;
  linked_lead_id: string | null;
  linked_lead_name: string | null;
  credited_to: string | null;
  likely: boolean;
}
interface QrCandidate {
  kind: "qr";
  id: string;
  amount: string;
  at: string;
  payer_name: string | null;
  payer_vpa: string | null;
  payer_phone: string | null;
  qr_label: string | null;
  credited_to: string | null;
  likely: boolean;
}
type Candidate = DonationCandidate | QrCandidate;

interface Response {
  lead: { id: string; name: string | null; phone: string; expected: number | null; since: string };
  donations: DonationCandidate[];
  qr_payments: QrCandidate[];
}

export function LinkDonationDialog({
  leadId,
  leadName,
  onClose,
  onLinked,
}: {
  leadId: string;
  leadName?: string | null;
  onClose: () => void;
  /** Called after a successful link (and again after an Undo), to refresh. */
  onLinked?: () => void;
}) {
  const [q, setQ] = useState("");
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [days, setDays] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (q.trim()) params.set("q", q.trim());
        if (days) params.set("days", String(days));
        const r = await api<Response>(`/api/crm/leads/${leadId}/donation-candidates?${params}`);
        if (live) {
          setData(r);
          setError(null);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) setLoading(false);
      }
    }, q ? 250 : 0);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [leadId, q, days]);

  const link = async (c: Candidate) => {
    setBusy(c.id);
    try {
      const r = await api<{ activity_id: string; amount: number; credited: boolean; credited_to_other: string | null }>(
        `/api/crm/leads/${leadId}/link-donation`,
        {
          method: "POST",
          body: JSON.stringify(c.kind === "donation" ? { donation_id: c.id } : { qr_payment_id: c.id }),
        }
      );
      toast(`Linked ${currency(r.amount)} to ${leadName || "this lead"}`, {
        body: r.credited
          ? "Counted towards your money raised."
          : r.credited_to_other
            ? `Already counted for ${r.credited_to_other} — the lead is marked as donated.`
            : "The lead is marked as donated.",
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              await api(`/api/crm/link-donation/${r.activity_id}/undo`, { method: "POST", body: "{}" });
              toast.info("Link undone");
              onLinked?.();
            } catch (e) {
              toast.error("Could not undo that", (e as Error).message);
            }
          },
        },
      });
      onLinked?.();
      onClose();
    } catch (e) {
      toast.error("Could not link that", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const all: Candidate[] = data
    ? [...data.donations, ...data.qr_payments].sort(
        (a, b) => Number(b.likely) - Number(a.likely) || +new Date(b.at) - +new Date(a.at)
      )
    : [];

  return (
    <Modal title="They gave from another number" onClose={onClose} wide>
      <p className="text-sm text-ink-muted">
        Find the donation {leadName ? <strong className="text-ink">{leadName}</strong> : "they"} made from somebody
        else&apos;s phone or under another name. The ones matching what they tried to give are first.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="Name, number, UPI id, receipt no. or amount…"
          className="flex-1"
          autoFocus
        />
        <Button variant="secondary" onClick={() => setDays(days ? null : 90)}>
          {days ? "Since they tried" : "Look back 90 days"}
        </Button>
      </div>
      {data && (
        <p className="mt-2 text-xs text-ink-faint">
          Showing money received since {dateTime(data.lead.since)}
          {data.lead.expected ? ` · they were hoping to give ${currency(data.lead.expected)}` : ""}
        </p>
      )}

      <div className="mt-3 max-h-[55vh] space-y-2 overflow-y-auto pr-1">
        {error && <Alert tone="danger">{error}</Alert>}
        {loading && !data && (
          <>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </>
        )}
        {data && !all.length && (
          <EmptyState
            icon="search"
            title="Nothing matches"
            message="Try their family name, the UPI id they paid from, or the amount. Money that has not reached DRM yet will not show here."
          />
        )}
        {all.map((c) => {
          const taken = c.kind === "donation" && !!c.linked_lead_id;
          return (
            <div
              key={`${c.kind}${c.id}`}
              className={`flex flex-col gap-3 rounded-card border p-3 sm:flex-row sm:items-center ${
                c.likely ? "border-brand-300 bg-brand-50/60" : "border-line-soft bg-surface"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold tabular-nums text-ink">{currency(c.amount)}</span>
                  <Badge tone={c.kind === "qr" ? "info" : "neutral"}>{c.kind === "qr" ? "Temple QR" : c.source_site ?? "Donation"}</Badge>
                  {c.likely && <Badge tone="good">Likely</Badge>}
                  {c.credited_to && <Badge tone="warn">Counted for {c.credited_to}</Badge>}
                </div>
                <p className="mt-1 truncate text-sm text-ink">
                  {c.kind === "donation"
                    ? `${c.donor_name ?? "Unknown"}${c.donor_phone ? ` · ${c.donor_phone}` : ""}${c.sevak_name ? ` · on the name of ${c.sevak_name}` : ""}`
                    : `${c.payer_name ?? "Unknown payer"}${c.payer_vpa ? ` · ${c.payer_vpa}` : ""}${c.payer_phone ? ` · ${c.payer_phone}` : ""}`}
                </p>
                <p className="text-xs text-ink-muted">
                  {dateTime(c.at)} · {relativeDate(c.at)}
                  {c.kind === "donation" && c.purpose ? ` · ${c.purpose}` : ""}
                  {c.kind === "donation" && c.receipt_number ? ` · receipt ${c.receipt_number}` : ""}
                  {c.kind === "qr" && c.qr_label ? ` · ${c.qr_label}` : ""}
                </p>
                {taken && (
                  <p className="mt-1 text-xs text-warn">Already linked to {c.linked_lead_name ?? "another lead"}</p>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => void link(c)}
                loading={busy === c.id}
                disabled={taken || (!!busy && busy !== c.id)}
                className="sm:flex-none"
              >
                <Icon name="link" size={14} />
                This is theirs
              </Button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
