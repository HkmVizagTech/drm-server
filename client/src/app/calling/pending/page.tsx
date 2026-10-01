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
  inputClass,
} from "@/components/ui";

interface Row {
  id: string;
  external_id: string;
  name: string | null;
  phone: string;
  email: string | null;
  amount: string | null;
  purpose: string | null;
  source_page: string | null;
  status: string;
  attempted_at: string;
  source_site: string;
  attempts: number;
  gave_anyway?: boolean;
  lead_id?: string | null;
  lead_status?: string | null;
  assigned_to_name?: string | null;
}

interface Answer {
  rows: Row[];
  total: number;
  open: number;
  gave_anyway: number;
  already_leads: number;
  value_at_stake: number;
  /** Per site: when it was last asked, what went wrong, whether it is being asked now. */
  sites: { site: string; last_synced_at: string | null; error: string | null; refreshing: boolean }[];
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
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("recent");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ days, sort });
      if (site) q.set("sites", site);
      if (minAmount) q.set("min_amount", minAmount);
      if (maxAmount) q.set("max_amount", maxAmount);
      if (status) q.set("status", status);
      if (debounced.trim()) q.set("search", debounced.trim());
      setData(await apiClient.get<Answer>(`/api/crm/leads/abandoned?${q}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the list");
    } finally {
      setLoading(false);
    }
  }, [days, site, minAmount, maxAmount, status, sort, debounced]);

  /**
   * Ask the sites now, and wait.
   *
   * Ordinary loads read DRM's stored copy and return immediately, refreshing
   * in the background when it is more than half an hour old. This is the
   * button for somebody who has just watched a donation fail and wants it on
   * the screen this minute.
   */
  async function refreshNow() {
    setRefreshing(true);
    setNotice(null);
    try {
      await apiClient.post("/api/crm/leads/abandoned/refresh", { sites: site || undefined });
      await load();
      setNotice("Checked both sites just now.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the sites");
    } finally {
      setRefreshing(false);
    }
  }

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
          amount: r.amount ? Number(r.amount) : null,
          purpose: r.purpose,
          source_page: r.source_page,
          source_site: r.source_site,
          attempted_at: r.attempted_at,
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

  async function dismiss(r: Row) {
    setBusy(r.phone);
    try {
      await apiClient.post(`/api/crm/leads/abandoned/${r.id}/dismiss`, {});
      setData((d) => (d ? { ...d, rows: d.rows.filter((x) => x.id !== r.id), open: d.open - 1 } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not set that aside");
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
          <button onClick={() => void refreshNow()} disabled={refreshing} className={buttonSecondary}>
            {refreshing ? "Checking…" : "Check the sites now"}
          </button>
        }
      />

      {/* The filters a caller actually sorts by before a shift: the biggest
          first when there is an hour, the freshest first when there is a
          morning, and the repeat triers when neither is working. */}
      <div className="mb-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-slate-500">
          How far back
          <Select
            value={days}
            onChange={setDays}
            className="mt-1 w-full"
            options={[
              { value: "1", label: "Today" },
              { value: "7", label: "Last 7 days" },
              { value: "30", label: "Last 30 days" },
              { value: "90", label: "Last 90 days" },
              { value: "365", label: "Last year" },
            ]}
          />
        </label>
        <label className="text-xs text-slate-500">
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
        <label className="text-xs text-slate-500">
          What happened
          <Select
            value={status}
            onChange={setStatus}
            className="mt-1 w-full"
            options={[
              { value: "", label: "Any outcome" },
              { value: "failed", label: "Payment failed" },
              { value: "pending,created", label: "Never completed" },
            ]}
          />
        </label>
        <label className="text-xs text-slate-500">
          Order
          <Select
            value={sort}
            onChange={setSort}
            className="mt-1 w-full"
            options={[
              { value: "recent", label: "Most recent first" },
              { value: "amount", label: "Biggest amount first" },
              { value: "attempts", label: "Most attempts first" },
              { value: "oldest", label: "Oldest first" },
            ]}
          />
        </label>

        <div className="text-xs text-slate-500">
          Amount between
          <div className="mt-1 flex items-center gap-1.5">
            <input
              value={minAmount}
              onChange={(e) => setMinAmount(e.target.value.replace(/\D/g, ""))}
              placeholder="any"
              inputMode="numeric"
              className={`${inputClass} w-full tabular-nums`}
            />
            <span className="text-slate-400">to</span>
            <input
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value.replace(/\D/g, ""))}
              placeholder="any"
              inputMode="numeric"
              className={`${inputClass} w-full tabular-nums`}
            />
          </div>
        </div>

        <label className="text-xs text-slate-500 lg:col-span-2">
          Find
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, number or email"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>

        {(minAmount || maxAmount || status || search || days !== "30" || site || sort !== "recent") && (
          <button
            onClick={() => {
              setMinAmount("");
              setMaxAmount("");
              setStatus("");
              setSearch("");
              setDays("30");
              setSite("");
              setSort("recent");
            }}
            className="self-end rounded-lg px-3 py-2 text-xs text-slate-500 hover:bg-slate-100"
          >
            Clear filters
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {notice}
        </div>
      )}
      {/* A site being unreachable, or never connected, must not look like a
          quiet week. And the page now reads a stored copy, so when that copy
          was last refreshed is part of what the number means. */}
      {data?.sites.map((st) => (
        st.error ? (
          <div
            key={st.site}
            className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            {SITE_LABELS[st.site] ?? st.site}: {st.error} Nothing from it is listed below.
          </div>
        ) : null
      ))}

      {data && (
        <p className="mb-4 text-xs text-slate-500">
          {data.sites
            .filter((st) => !st.error)
            .map((st) =>
              st.last_synced_at
                ? `${SITE_LABELS[st.site] ?? st.site} last checked ${relativeDate(st.last_synced_at)}`
                : `${SITE_LABELS[st.site] ?? st.site} not checked yet`
            )
            .join(" · ")}
          {data.sites.some((st) => st.refreshing) && " · checking again now"}
        </p>
      )}

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
                  <tr key={r.id} className="hover:bg-slate-50/60">
                    <Td>
                      <div className="font-medium text-slate-900">{r.name || "Name not given"}</div>
                      <div className="text-xs tabular-nums text-slate-500">{r.phone}</div>
                    </Td>
                    <Td align="right" className="tabular-nums font-medium text-slate-900">
                      {r.amount ? currency(Number(r.amount)) : <span className="text-slate-300">—</span>}
                    </Td>
                    <Td className="text-sm text-slate-600">
                      {r.purpose || <span className="text-slate-300">—</span>}
                      <div className="text-[11px] text-slate-400">{SITE_LABELS[r.source_site] ?? r.source_site}</div>
                    </Td>
                    <Td className="text-xs text-slate-500">
                      {shortDate(r.attempted_at)}
                      <div className="text-slate-400">{relativeDate(r.attempted_at)}</div>
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
                        <button
                          onClick={() => void dismiss(r)}
                          disabled={busy === r.phone}
                          title="Not worth a call — hide them, and keep them hidden after the next refresh"
                          className="rounded-lg px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
                        >
                          Set aside
                        </button>
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
            Kept in DRM and refreshed from both sites in the background, so this screen opens instantly instead of
            waiting on two websites every time. Press <strong>Check the sites now</strong> if you have just watched a
            donation fail. Anyone who has since given — on either site, by any means, including cash — is removed
            before the list reaches you, because chasing money that has already arrived is worse than not calling at
            all; that check runs on every load, not on the refresh, so it is never out of date.
          </p>
        </div>
      </Card>
    </div>
  );
}
