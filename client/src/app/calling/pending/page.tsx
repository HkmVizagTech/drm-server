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
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  LinkButton,
  PageHeader,
  SearchInput,
  Select,
  SkeletonRows,
  StatTile,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
  Toolbar,
  buttonClass,
} from "@/components/ui";
import { ExportButton } from "@/components/export-button";

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
  /** How many times they tried within the period and sites being viewed. */
  attempts_in_view: number;
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
  /** False when the table is showing only the first 500 of a longer list. */
  complete: boolean;
  /** Per site: when it was last asked, what went wrong, whether it is being asked now. */
  sites: {
    site: string;
    last_synced_at: string | null;
    synced_days: number | null;
    error: string | null;
    refreshing: boolean;
    rows_skipped: number;
    truncated: boolean;
  }[];
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

  /**
   * The filters, described once.
   *
   * The list request and the download both read this. Rebuilding the query for
   * the export is how somebody narrows to last week's failed payments, presses
   * download, and hands the office a file covering thirty days — and the office
   * rings from the file, not from the screen.
   */
  const filterParams = useCallback(() => {
    const q = new URLSearchParams({ days, sort });
    if (site) q.set("sites", site);
    if (minAmount) q.set("min_amount", minAmount);
    if (maxAmount) q.set("max_amount", maxAmount);
    if (status) q.set("status", status);
    if (debounced.trim()) q.set("search", debounced.trim());
    return q;
  }, [days, site, minAmount, maxAmount, status, sort, debounced]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiClient.get<Answer>(`/api/crm/leads/abandoned?${filterParams()}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the list");
    } finally {
      setLoading(false);
    }
  }, [filterParams]);

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
      // The window on screen, so pressing this on a year view fetches the
      // year rather than ninety days and then resetting the staleness clock.
      await apiClient.post("/api/crm/leads/abandoned/refresh", {
        sites: site || undefined,
        days: Number(days),
      });
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
  // Counted rather than tested as one boolean, because the Toolbar says how
  // many filters are on as well as offering to clear them. The defaults are
  // part of the count: a 30-day window sorted by recency is "no filters".
  const activeFilters = [
    minAmount,
    maxAmount,
    status,
    search,
    site,
    days !== "30" ? days : "",
    sort !== "recent" ? sort : "",
  ].filter(Boolean).length;

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="Nearly gave"
        subtitle="Donations started on the websites and never completed — the warmest calls in DRM"
        actions={
          <>
            <Button
              variant="secondary"
              icon="refresh"
              loading={refreshing}
              onClick={() => void refreshNow()}
            >
              {refreshing ? "Checking…" : "Check the sites now"}
            </Button>
            <ExportButton
              path="/api/crm/leads/abandoned/export"
              params={filterParams()}
              filename="nearly-gave"
              hint={data ? `${number(data.open)} people match these filters` : undefined}
            />
          </>
        }
      />

      {/* The filters a caller actually sorts by before a shift: the biggest
          first when there is an hour, the freshest first when there is a
          morning, and the repeat triers when neither is working. */}
      <Toolbar
        activeCount={activeFilters}
        onClear={() => {
          setMinAmount("");
          setMaxAmount("");
          setStatus("");
          setSearch("");
          setDays("30");
          setSite("");
          setSort("recent");
        }}
      >
        <Field label="How far back" className="w-36">
          <Select
            value={days}
            onChange={setDays}
            ariaLabel="How far back"
            options={[
              { value: "1", label: "Today" },
              { value: "7", label: "Last 7 days" },
              { value: "30", label: "Last 30 days" },
              { value: "90", label: "Last 90 days" },
              { value: "365", label: "Last year" },
            ]}
          />
        </Field>
        <Field label="Site" className="w-52">
          <Select
            value={site}
            onChange={setSite}
            ariaLabel="Site"
            options={[
              { value: "", label: "Both sites" },
              { value: "hkmv", label: SITE_LABELS.hkmv },
              { value: "annadan", label: SITE_LABELS.annadan },
            ]}
          />
        </Field>
        <Field label="What happened" className="w-44">
          <Select
            value={status}
            onChange={setStatus}
            ariaLabel="What happened"
            options={[
              { value: "", label: "Any outcome" },
              { value: "failed", label: "Payment failed" },
              { value: "pending,created", label: "Never completed" },
            ]}
          />
        </Field>
        <Field label="Order" className="w-48">
          <Select
            value={sort}
            onChange={setSort}
            ariaLabel="Order"
            options={[
              { value: "recent", label: "Most recent first" },
              { value: "amount", label: "Biggest amount first" },
              { value: "attempts", label: "Most attempts first" },
              { value: "oldest", label: "Oldest first" },
            ]}
          />
        </Field>

        <Field label="Amount between" className="w-56">
          <div className="flex items-center gap-1.5">
            <Input
              value={minAmount}
              onChange={(e) => setMinAmount(e.target.value.replace(/\D/g, ""))}
              placeholder="any"
              inputMode="numeric"
              aria-label="Smallest amount"
              className="tabular-nums"
            />
            <span className="text-xs text-ink-faint">to</span>
            <Input
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value.replace(/\D/g, ""))}
              placeholder="any"
              inputMode="numeric"
              aria-label="Largest amount"
              className="tabular-nums"
            />
          </div>
        </Field>

        <Field label="Find" htmlFor="pending-search" className="min-w-[16rem] flex-1">
          <SearchInput
            id="pending-search"
            value={search}
            onChange={setSearch}
            placeholder="Name, number or email…"
          />
        </Field>
      </Toolbar>

      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="good">{notice}</Alert>}

      {/* A site being unreachable, or never connected, must not look like a
          quiet week. And the page now reads a stored copy, so when that copy
          was last refreshed is part of what the number means. */}
      {/* An error means the last good copy is what you are reading, not that
          the site's rows are missing — saying "nothing from it is listed
          below" was simply untrue, since last night's rows are still in the
          table and still in the totals. */}
      {data?.sites.map((st) =>
        st.error ? (
          <Alert
            key={st.site}
            tone="warn"
            title={`${SITE_LABELS[st.site] ?? st.site} could not be reached.`}
          >
            {st.error}{" "}
            {st.last_synced_at
              ? `What you see from it is the copy taken ${relativeDate(st.last_synced_at)}.`
              : "Nothing from it has ever been fetched, so none of it is listed below."}
          </Alert>
        ) : null
      )}

      {/* A crawl that stopped at its ceiling, or rows the site returned that
          DRM could not use. Either makes the total a floor. */}
      {data?.sites.map((st) =>
        !st.error && (st.truncated || st.rows_skipped > 0) ? (
          <Alert key={`${st.site}-partial`} tone="info">
            {SITE_LABELS[st.site] ?? st.site}:{" "}
            {st.truncated && "there are more attempts than DRM fetched in one go, so the figures below are a floor. "}
            {st.rows_skipped > 0 &&
              `${number(st.rows_skipped)} row${st.rows_skipped === 1 ? "" : "s"} could not be used — no number to ring, or nothing to identify them by.`}
          </Alert>
        ) : null
      )}

      {data && (
        <p className="mb-4 text-xs text-ink-muted">
          {data.sites
            .map((st) =>
              st.last_synced_at
                ? `${SITE_LABELS[st.site] ?? st.site} last checked ${relativeDate(st.last_synced_at)}${
                    st.synced_days && st.synced_days < Number(days)
                      ? ` (last ${st.synced_days} days only)`
                      : ""
                  }`
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

      <TableShell>
        <Thead>
          <Th>Who</Th>
          <Th align="right">Tried to give</Th>
          <Th>For</Th>
          <Th>When</Th>
          <Th>What happened</Th>
          <Th align="right"> </Th>
        </Thead>

        {loading ? (
          <SkeletonRows rows={6} cols={6} />
        ) : (
          <Tbody>
            {!rows.length ? (
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
                  <tr key={r.id}>
                    <Td>
                      <div className="font-medium text-ink">{r.name || "Name not given"}</div>
                      <div className="text-xs tabular-nums text-ink-muted">{r.phone}</div>
                    </Td>
                    <Td align="right" className="font-medium tabular-nums text-ink">
                      {r.amount ? currency(Number(r.amount)) : <span className="text-ink-faint">—</span>}
                    </Td>
                    <Td>
                      {r.purpose || <span className="text-ink-faint">—</span>}
                      <div className="text-xs text-ink-faint">{SITE_LABELS[r.source_site] ?? r.source_site}</div>
                    </Td>
                    <Td className="text-xs text-ink-muted">
                      {shortDate(r.attempted_at)}
                      <div className="text-ink-faint">{relativeDate(r.attempted_at)}</div>
                    </Td>
                    <Td>
                      <Badge tone={word.tone}>{word.label}</Badge>
                      {r.attempts_in_view > 1 && (
                        <div className="mt-0.5 text-xs text-ink-muted">
                          tried {number(r.attempts_in_view)} times
                        </div>
                      )}
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1.5">
                        <LinkButton href={`tel:+91${r.phone}`} variant="primary" size="sm" icon="phone">
                          Call
                        </LinkButton>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void dismiss(r)}
                          disabled={busy === r.phone}
                          title="Not worth a call — hide them, and keep them hidden after the next refresh"
                        >
                          Set aside
                        </Button>
                        {r.lead_id ? (
                          // A next/link anchor wearing the button class rather
                          // than LinkButton: LinkButton is a plain <a>, which
                          // would drop out of the client router.
                          <Link
                            href={`/leads/${r.lead_id}`}
                            className={buttonClass("secondary", "sm")}
                          >
                            Open lead
                          </Link>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void adopt(r)}
                            loading={busy === r.phone}
                          >
                            Add as lead
                          </Button>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })
            )}
          </Tbody>
        )}
      </TableShell>

      {data && !data.complete && (
        <Alert tone="warn" className="mt-4">
          Showing the first {number(rows.length)} of {number(data.open)}. The totals above cover all of them — narrow
          the filters to work through the rest.
        </Alert>
      )}

      <p className="mt-4 text-xs text-ink-muted">
        Kept in DRM and refreshed from both sites in the background, so this screen opens instantly instead of waiting
        on two websites every time. Press <strong>Check the sites now</strong> if you have just watched a donation
        fail. Anyone who has since given — on either site, by any means, including cash — is removed before the list
        reaches you, because chasing money that has already arrived is worse than not calling at all; that check runs
        on every load, not on the refresh, so it is never out of date.
      </p>
    </div>
  );
}
