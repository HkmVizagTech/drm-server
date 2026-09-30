"use client";

// Donations that were started and never finished.
//
// WHY THESE ARE THE BEST LEADS THE TEMPLE HAS
// Everybody here filled in the form, chose an amount, reached the payment
// screen — and then a UPI app timed out, or a phone rang, or the bank's page
// hung. The decision to give was already made. Nothing else in DRM is that
// warm, which is why this is a screen of its own rather than a checkbox on the
// leads page.
//
// THE ONE RULE
// Never ring somebody to chase money they have already given. Neither site can
// tell — a person who failed on annadan and retried successfully on the main
// site looks abandoned to annadan for ever. DRM holds the completed donations
// from both, so it is the only place that can settle it, and it does that
// before anything reaches this screen. The ones it filtered out are counted on
// the page rather than hidden, so the number is never a mystery.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, number, relativeDate, shortDate } from "@/lib/format";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Select,
  StatTile,
  TableShell,
  Td,
  Th,
  buttonPrimary,
  buttonSecondary,
} from "@/components/ui";

interface Row {
  externalId: string;
  name: string | null;
  phone: string;
  email: string | null;
  amount: number | null;
  purpose: string | null;
  sourcePage: string | null;
  status: string;
  attemptedAt: string;
  sourceSite: string;
  attempts: number;
  gave_anyway?: boolean;
  lead_id?: string | null;
  lead_status?: string | null;
}

interface Answer {
  rows: Row[];
  total: number;
  open: number;
  gave_anyway: number;
  already_leads: number;
  value_at_stake: number;
  cached: boolean;
  site_errors: { site: string; error: string }[];
}

const SITE_LABELS: Record<string, string> = {
  hkmv: "harekrishnavizag.org",
  annadan: "annadan",
};

/**
 * What each site's status word actually means, said plainly.
 *
 * The two sites do not agree on vocabulary — annadan writes "created" for an
 * order that was never paid and has no failure handler at all, while the main
 * site distinguishes "pending" from "failed". A caller does not need that
 * history; they need to know whether the payment was attempted and refused, or
 * simply never attempted.
 */
const STATUS_WORDS: Record<string, { label: string; tone: "warn" | "danger" | "info" }> = {
  pending: { label: "Never completed", tone: "warn" },
  created: { label: "Never completed", tone: "warn" },
  failed: { label: "Payment failed", tone: "danger" },
  halted: { label: "Halted", tone: "danger" },
};

export default function PendingPaymentsPage() {
  const [data, setData] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("30");
  const [site, setSite] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (fresh = false) => {
      setLoading(true);
      try {
        const q = new URLSearchParams({ days });
        if (site) q.set("sites", site);
        if (fresh) q.set("fresh", "true");
        setData(await apiClient.get<Answer>(`/api/crm/leads/abandoned?${q}`));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not reach the sites");
      } finally {
        setLoading(false);
      }
    },
    [days, site]
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function adopt(r: Row) {
    setBusy(r.phone);
    setNotice(null);
    try {
      const res = await apiClient.post<{ lead: { id: string }; created: boolean }>(
        "/api/crm/leads/abandoned/adopt",
        {
          phone: r.phone,
          name: r.name,
          email: r.email,
          amount: r.amount,
          purpose: r.purpose,
          source_page: r.sourcePage,
          source_site: r.sourceSite,
          attempted_at: r.attemptedAt,
          attempts: r.attempts,
        }
      );
      setData((d) =>
        d
          ? {
              ...d,
              rows: d.rows.map((x) =>
                x.phone === r.phone ? { ...x, lead_id: res.lead.id, lead_status: "new" } : x
              ),
            }
          : d
      );
      setNotice(
        res.created
          ? `${r.name || r.phone} is now a lead, assigned to you.`
          : `${r.name || r.phone} was already a lead — opened rather than duplicated.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add that person");
    } finally {
      setBusy(null);
    }
  }

  const rows = data?.rows ?? [];

  return (
    <div>
      <PageHeader
        title="Nearly gave"
        subtitle="Donations started on the websites and never completed — the warmest calls in DRM"
        actions={
          <button onClick={() => void load(true)} disabled={loading} className={buttonSecondary}>
            {loading ? "Checking…" : "Check the sites again"}
          </button>
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-2">
        <label className="min-w-[9rem] text-xs text-slate-500">
          How far back
          <Select
            value={days}
            onChange={setDays}
            className="mt-1 w-full"
            options={[
              { value: "7", label: "Last 7 days" },
              { value: "30", label: "Last 30 days" },
              { value: "90", label: "Last 90 days" },
              { value: "365", label: "Last year" },
            ]}
          />
        </label>
        <label className="min-w-[11rem] text-xs text-slate-500">
          Site
          <Select
            value={site}
            onChange={setSite}
            className="mt-1 w-full"
            options={[
              { value: "", label: "Both sites" },
              { value: "hkmv", label: SITE_LABELS.hkmv },
              { value: "annadan", label: SITE_LABELS.annadan },
            ]}
          />
        </label>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {notice}
        </div>
      )}
      {/* A site being unreachable must not look like a quiet week. */}
      {data?.site_errors.map((e) => (
        <div
          key={e.site}
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {SITE_LABELS[e.site] ?? e.site} could not be reached, so nothing from it is listed here. {e.error}
        </div>
      ))}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Worth ringing"
          value={loading ? "—" : number(data?.open ?? 0)}
          sub="started a donation, never finished"
        />
        <StatTile
          label="Value at stake"
          value={loading ? "—" : currency(data?.value_at_stake ?? 0)}
          accent="brand"
          sub="what they were trying to give"
        />
        <StatTile
          label="Already leads"
          value={loading ? "—" : number(data?.already_leads ?? 0)}
          sub="in DRM already — no need to add them"
        />
        <StatTile
          label="Gave anyway"
          value={loading ? "—" : number(data?.gave_anyway ?? 0)}
          accent="good"
          sub="settled since — never shown here"
        />
      </div>

      <Card padded={false}>
        <TableShell>
          <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
            <tr>
              <Th>Who</Th>
              <Th align="right">Tried to give</Th>
              <Th>For</Th>
              <Th>When</Th>
              <Th>What happened</Th>
              <Th align="right">&nbsp;</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              [0, 1, 2, 3].map((i) => (
                <tr key={i}>
                  <td colSpan={6} className="px-5 py-3">
                    <div className="h-6 animate-pulse rounded bg-slate-100" />
                  </td>
                </tr>
              ))
            ) : !rows.length ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    title="Nobody to ring"
                    message={
                      data?.gave_anyway
                        ? `Everyone who started a donation in this period has since given. ${number(
                            data.gave_anyway
                          )} of them, in fact.`
                        : "No unfinished donations in this period."
                    }
                  />
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const word = STATUS_WORDS[r.status] ?? { label: r.status, tone: "info" as const };
                return (
                  <tr key={`${r.sourceSite}-${r.externalId}`} className="hover:bg-slate-50/60">
                    <Td>
                      <div className="font-medium text-slate-900">{r.name || "Name not given"}</div>
                      <div className="text-xs tabular-nums text-slate-500">{r.phone}</div>
                    </Td>
                    <Td align="right" className="tabular-nums font-medium text-slate-900">
                      {r.amount ? currency(r.amount) : <span className="text-slate-300">—</span>}
                    </Td>
                    <Td className="text-sm text-slate-600">
                      {r.purpose || <span className="text-slate-300">—</span>}
                      <div className="text-[11px] text-slate-400">{SITE_LABELS[r.sourceSite] ?? r.sourceSite}</div>
                    </Td>
                    <Td className="text-xs text-slate-500">
                      {shortDate(r.attemptedAt)}
                      <div className="text-slate-400">{relativeDate(r.attemptedAt)}</div>
                    </Td>
                    <Td>
                      <Badge tone={word.tone}>{word.label}</Badge>
                      {r.attempts > 1 && (
                        <div className="mt-0.5 text-[11px] text-slate-500">tried {number(r.attempts)} times</div>
                      )}
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1.5">
                        <a
                          href={`tel:+91${r.phone}`}
                          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                        >
                          Call
                        </a>
                        {r.lead_id ? (
                          <Link
                            href={`/leads/${r.lead_id}`}
                            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                          >
                            Open lead
                          </Link>
                        ) : (
                          <button
                            onClick={() => void adopt(r)}
                            disabled={busy === r.phone}
                            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {busy === r.phone ? "…" : "Add as lead"}
                          </button>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </TableShell>

        <div className="border-t border-[var(--line-soft)] px-5 py-4">
          <p className="text-xs text-slate-500">
            Read live from both sites, so this is what they hold right now rather than a copy taken at some point in
            the past. Anyone who has since given — on either site, by any means — is removed before the list reaches
            you, because chasing money that has already arrived is worse than not calling at all.
          </p>
        </div>
      </Card>
    </div>
  );
}
