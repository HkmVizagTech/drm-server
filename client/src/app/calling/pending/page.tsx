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
//
// WHY EVERY CALL GOES THROUGH THE CALL SCREEN
// The Call button here used to be a bare tel: link. The phone rang, the donor
// answered, and DRM never heard about it - no outcome, no follow-up, and the
// next caller rang the same person an hour later. Now a row that is not yet a
// lead is added first (one request, the same rules as adding many), and the
// call opens on the call screen where its outcome is recorded.
//
// WHY THERE IS A SELECTION
// The useful unit of work is "these twenty", not one row at a time: a caller
// with an hour picks the big amounts from this week and starts ringing. Ticking
// them and pressing one button replaces twenty "Add as lead" clicks and then
// hunting for the same twenty people on another screen.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { callHref, formatPhone, runHref, startRun } from "@/lib/calling";
import { currency, number, relativeDate, shortDate } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
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
import { toast } from "@/components/toast";
import { SelectAllBanner, SelectionBar } from "@/components/bulk/selection-bar";

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
  /** The lead's own state, so a row can say "do not call" or "Arjun's lead". */
  lead_do_not_call?: boolean | null;
  lead_assigned_to?: string | null;
  lead_last_outcome?: string | null;
  lead_last_contacted_at?: string | null;
  set_aside_at?: string | null;
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

/** POST /leads/abandoned/adopt-bulk */
interface AdoptResult {
  requested: number;
  created: number;
  already_yours: number;
  already_others: number;
  do_not_call: number;
  gave_anyway: number;
  lead_ids: string[];
}

interface Config {
  users: { id: string; name: string; role: string }[];
  dispositions: { slug: string; label: string }[];
}

type View = "open" | "set_aside";

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

const who = (r: Row) => r.name || formatPhone(r.phone);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * What adding a batch actually did, in one line.
 *
 * A bare "Done" after adding forty people hides the four that were somebody
 * else's and the one who asked never to be rung - and those are exactly the
 * ones the caller would otherwise go looking for. Zero parts are left out so
 * the usual case reads as one short phrase.
 */
function summarise(r: AdoptResult, opts: { mine: boolean; owners: string[] }): string {
  const parts: string[] = [];
  if (r.created) parts.push(`${number(r.created)} added as ${plural(r.created, "a lead", "leads")}`);
  if (r.already_yours)
    parts.push(
      `${number(r.already_yours)} ${
        opts.mine
          ? plural(r.already_yours, "was already yours", "were already yours")
          : plural(r.already_yours, "was already a lead", "were already leads")
      }`
    );
  if (r.already_others)
    parts.push(
      `${number(r.already_others)} ${plural(r.already_others, "belongs", "belong")} to ${
        opts.owners.length === 1 ? opts.owners[0] : "other callers"
      }`
    );
  if (r.do_not_call) parts.push(`${number(r.do_not_call)} asked not to be called`);
  if (r.gave_anyway) parts.push(`${number(r.gave_anyway)} gave anyway`);
  const accounted = r.created + r.already_yours + r.already_others + r.do_not_call + r.gave_anyway;
  const rest = r.requested - accounted;
  if (rest > 0) parts.push(`${number(rest)} could not be added`);
  return parts.join(" · ") || "Nobody to add";
}

export default function PendingPaymentsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const elevated = user?.role === "admin" || user?.role === "accountant";

  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [view, setView] = useState<View>("open");
  const [days, setDays] = useState("30");
  const [site, setSite] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("recent");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [assign, setAssign] = useState("me");
  const [bulkBusy, setBulkBusy] = useState<"add" | "call" | null>(null);
  const [callingAll, setCallingAll] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    apiClient
      .get<Config>("/api/crm/config")
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  /**
   * The filters, described once.
   *
   * The list request, the download and "add all matching" all read this.
   * Rebuilding the query for any of them is how somebody narrows to last
   * week's failed payments, presses a button, and acts on thirty days instead.
   */
  const filterParams = useCallback(() => {
    const q = new URLSearchParams({ days, sort });
    if (site) q.set("sites", site);
    if (minAmount) q.set("min_amount", minAmount);
    if (maxAmount) q.set("max_amount", maxAmount);
    if (status) q.set("status", status);
    if (debounced.trim()) q.set("search", debounced.trim());
    if (view === "set_aside") q.set("set_aside", "true");
    return q;
  }, [days, site, minAmount, maxAmount, status, sort, debounced, view]);

  // Loading is DERIVED: the screen is loading whenever the answer on it was
  // fetched for different filters than the ones now chosen. Holding it as a
  // flag meant setting it at the top of every fetch, and a fetch that loses a
  // race to a newer one then cleared it under the newer one's feet.
  const key = filterParams().toString();
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadedKey !== key;
  const latest = useRef("");

  // Only the answer to the newest question lands. Typing a name fires a
  // request per pause, and an older, slower one must not overwrite it.
  const settle = useCallback((k: string, d: Answer | null, err: string | null) => {
    if (latest.current !== k) return;
    if (d) setData(d);
    setError(err);
    setLoadedKey(k);
  }, []);

  const load = useCallback(
    (k: string) =>
      apiClient.get<Answer>(`/api/crm/leads/abandoned?${k}`).then(
        (d) => settle(k, d, null),
        (e) => settle(k, null, e instanceof Error ? e.message : "Could not load the list")
      ),
    [settle]
  );

  useEffect(() => {
    latest.current = key;
    void load(key);
  }, [key, load]);

  /** Re-read what is on screen, quietly - no skeleton for a refresh. */
  const reload = useCallback(() => load(latest.current), [load]);

  /* --------------------------------------------------------- selection */

  // Tied to the filters it was made under. Ticking ten people and then
  // changing the period must not leave ten invisible people selected, and
  // "all matching" means all matching THOSE filters, not whatever is chosen
  // by the time the button is pressed.
  const [sel, setSel] = useState<{ key: string; ids: Set<string>; all: boolean }>({
    key: "",
    ids: new Set(),
    all: false,
  });
  const picked = sel.key === key ? sel.ids : new Set<string>();
  const allMatching = sel.key === key && sel.all;
  const clearSelection = () => setSel({ key, ids: new Set(), all: false });
  const editIds = (fn: (s: Set<string>) => void) =>
    setSel((prev) => {
      const next = new Set(prev.key === key ? prev.ids : []);
      fn(next);
      return { key, ids: next, all: false };
    });

  const rows = data?.rows ?? [];
  const isOthers = (r: Row) => !!r.lead_assigned_to && r.lead_assigned_to !== user?.id;
  // A row that cannot be added is not offered for ticking: a do-not-call, or
  // a colleague's lead, would only come back as "could not be added".
  const canPick = (r: Row) => view === "open" && !r.lead_do_not_call && !isOthers(r);
  const pickable = rows.filter(canPick);
  const allOnPage = pickable.length > 0 && pickable.every((r) => picked.has(r.id));
  const someOnPage = pickable.some((r) => picked.has(r.id));
  const selectedCount = allMatching ? data?.open ?? 0 : picked.size;
  const moreThanShown = !!data && data.open > rows.length;

  const togglePage = () =>
    editIds((s) => (allOnPage ? pickable.forEach((r) => s.delete(r.id)) : pickable.forEach((r) => s.add(r.id))));
  const toggleRow = (r: Row) => editIds((s) => (s.has(r.id) ? s.delete(r.id) : s.add(r.id)));

  const outcomeLabel = (slug: string) =>
    config?.dispositions.find((d) => d.slug === slug)?.label ?? slug.replace(/_/g, " ");

  /* ----------------------------------------------------------- actions */

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
    try {
      // The window on screen, so pressing this on a year view fetches the
      // year rather than ninety days and then resetting the staleness clock.
      await apiClient.post("/api/crm/leads/abandoned/refresh", {
        sites: site || undefined,
        days: Number(days),
      });
      await reload();
      toast("Checked both sites just now");
    } catch (e) {
      toast.error("Could not reach the sites", e instanceof Error ? e.message : undefined);
    } finally {
      setRefreshing(false);
    }
  }

  /** Who the selection would be added for, as a user id (null = nobody). */
  const assignTarget = assign === "me" ? user?.id ?? null : assign === "none" ? null : assign;

  async function adoptSelected(thenCall: boolean) {
    if (!selectedCount) return;
    setBulkBusy(thenCall ? "call" : "add");
    const filters = Object.fromEntries(filterParams());
    // Names for "2 belong to Arjun", from the rows the request covers. The
    // server counts them but does not name them; the screen already knows.
    const scope = allMatching ? rows : rows.filter((r) => picked.has(r.id));
    const owners = [
      ...new Set(
        scope
          .filter((r) => r.lead_assigned_to && r.lead_assigned_to !== assignTarget && r.assigned_to_name)
          .map((r) => r.assigned_to_name as string)
      ),
    ];
    try {
      const res = await apiClient.post<AdoptResult>("/api/crm/leads/abandoned/adopt-bulk", {
        ...(allMatching ? { all: true } : { ids: [...picked] }),
        filters,
        assign,
      });
      const line = summarise(res, { mine: assign === "me", owners });
      clearSelection();
      void reload();

      if (!thenCall) {
        toast(line);
        return;
      }
      if (!res.lead_ids.length) {
        toast.info("Nobody among those can be rung", line);
        return;
      }
      const run = await startRun({ kind: "selection", lead_ids: res.lead_ids, label: "Nearly gave" });
      if (run.empty || !run.session) {
        toast.info("Nobody among those can be rung right now", line);
        return;
      }
      toast(line);
      router.push(runHref(run.session.id));
    } catch (e) {
      toast.error("Could not add those as leads", e instanceof Error ? e.message : undefined);
    } finally {
      setBulkBusy(null);
    }
  }

  /** Everyone who nearly gave, as one run - the server adds the new ones first. */
  async function callEveryone() {
    setCallingAll(true);
    try {
      const run = await startRun({ kind: "nearly_gave" });
      if (run.empty || !run.session) {
        toast.info("Nobody to ring", "Everyone who nearly gave has been rung, set aside, or given since.");
        return;
      }
      if (run.adopted?.created) toast(`${number(run.adopted.created)} added as leads before starting`);
      router.push(runHref(run.session.id));
    } catch (e) {
      toast.error("Could not start calling", e instanceof Error ? e.message : undefined);
    } finally {
      setCallingAll(false);
    }
  }

  /**
   * Ring one person. A lead already - straight to the call screen. Not yet -
   * added first, as theirs, so the call is recorded against somebody.
   */
  async function callRow(r: Row) {
    if (r.lead_id) {
      router.push(callHref(r.lead_id, "/calling/pending"));
      return;
    }
    setBusy(r.id);
    try {
      const res = await apiClient.post<AdoptResult>("/api/crm/leads/abandoned/adopt-bulk", {
        ids: [r.id],
        filters: Object.fromEntries(filterParams()),
        assign: "me",
      });
      const id = res.lead_ids[0];
      if (!id) {
        toast.warn(`${who(r)} cannot be rung`, summarise(res, { mine: true, owners: [] }));
        void reload();
        return;
      }
      if (res.created) toast(`${who(r)} is now your lead`);
      router.push(callHref(id, "/calling/pending"));
    } catch (e) {
      toast.error(`Could not open a call to ${who(r)}`, e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function adopt(r: Row) {
    setBusy(r.id);
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
                x.phone === r.phone
                  ? { ...x, lead_id: res.lead.id, lead_status: "new", lead_assigned_to: user?.id ?? null }
                  : x
              ),
            }
          : d
      );
      toast(
        res.created
          ? `${who(r)} is now a lead, assigned to you`
          : `${who(r)} was already a lead — kept rather than duplicated`
      );
    } catch (e) {
      toast.error(`Could not add ${who(r)}`, e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function restore(r: Row) {
    try {
      await apiClient.post(`/api/crm/leads/abandoned/${r.id}/restore`, {});
      toast(`${who(r)} is back on the list`);
      void reload();
    } catch (e) {
      toast.error(`Could not bring ${who(r)} back`, e instanceof Error ? e.message : undefined);
    }
  }

  // Set aside used to be a silent, one-way click: the row vanished and there
  // was no screen anywhere showing who had been set aside or by whom. Now it
  // says what it did, offers to undo it, and the "Set aside" view lists them.
  async function dismiss(r: Row) {
    setBusy(r.id);
    try {
      await apiClient.post(`/api/crm/leads/abandoned/${r.id}/dismiss`, {});
      setData((d) => (d ? { ...d, rows: d.rows.filter((x) => x.id !== r.id), open: d.open - 1 } : d));
      editIds((s) => s.delete(r.id));
      toast(`Set ${who(r)} aside`, { action: { label: "Undo", onClick: () => void restore(r) } });
    } catch (e) {
      toast.error("Could not set that aside", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

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

  const assignOptions = [
    { value: "me", label: "Me" },
    { value: "none", label: "Leave unassigned", hint: "Whoever rings them first" },
    ...(config?.users ?? [])
      .filter((u) => u.id !== user?.id)
      .map((u) => ({ value: u.id, label: u.name, hint: u.role?.replace(/_/g, " ") })),
  ];

  /* ------------------------------------------------------ row pieces */

  function chips(r: Row) {
    const word = STATUS_WORDS[r.status] ?? { label: r.status, tone: "info" as const };
    return (
      <>
        <Badge tone={word.tone}>{word.label}</Badge>
        {r.lead_do_not_call ? (
          <Badge tone="danger" icon="xCircle">Do not call</Badge>
        ) : r.lead_id && isOthers(r) ? (
          <Badge tone="info" icon="user">{r.assigned_to_name ? `${r.assigned_to_name}'s lead` : "Someone else's lead"}</Badge>
        ) : r.lead_id ? (
          <Badge tone="brand">{r.lead_assigned_to ? "Your lead" : "Lead · unassigned"}</Badge>
        ) : null}
      </>
    );
  }

  function lastCall(r: Row) {
    if (!r.lead_last_outcome && !r.lead_last_contacted_at) return null;
    return (
      <p className="mt-1 text-xs text-ink-muted">
        Last call: {r.lead_last_outcome ? outcomeLabel(r.lead_last_outcome) : "—"}
        {r.lead_last_contacted_at && <> · {relativeDate(r.lead_last_contacted_at)}</>}
      </p>
    );
  }

  /** The buttons on a row, shared by the table and the phone cards. */
  function actions(r: Row, phone: boolean) {
    const size = phone ? "md" : "sm";
    if (view === "set_aside") {
      return (
        <Button variant="secondary" size={size} icon="refresh" onClick={() => void restore(r)} className={phone ? "flex-1" : ""}>
          Bring back
        </Button>
      );
    }
    const others = !!r.lead_id && isOthers(r);
    return (
      <>
        {/* No Call for a do-not-call, and none for a colleague's lead: ringing
            somebody another caller is working is how a donor gets two calls
            in an afternoon. */}
        {!r.lead_do_not_call && !others && (
          <Button
            variant="primary"
            size={size}
            icon="phone"
            loading={busy === r.id}
            onClick={() => void callRow(r)}
            className={phone ? "flex-1" : ""}
          >
            Call
          </Button>
        )}
        {!r.lead_id && !r.lead_do_not_call && (
          <Button variant="secondary" size={size} onClick={() => void adopt(r)} disabled={busy === r.id}>
            {phone ? "Add" : "Add as lead"}
          </Button>
        )}
        {r.lead_id && (!others || elevated) && (
          // A next/link anchor wearing the button class rather than
          // LinkButton: LinkButton is a plain <a>, which would drop out of the
          // client router.
          <Link href={`/leads/${r.lead_id}`} className={buttonClass("secondary", size)}>
            {phone ? "Open" : "Open lead"}
          </Link>
        )}
        <Button
          variant="ghost"
          size={size}
          onClick={() => void dismiss(r)}
          disabled={busy === r.id}
          title="Not worth a call — hide them, and keep them hidden after the next refresh"
        >
          Set aside
        </Button>
      </>
    );
  }

  const emptyState =
    view === "set_aside" ? (
      <EmptyState
        icon="inbox"
        title="Nobody set aside"
        message="People you set aside in this period appear here, so the decision can be seen and undone."
      />
    ) : (
      <EmptyState
        title="Nobody to ring"
        message={
          data?.gave_anyway
            ? `Everyone who started a donation in this period has since given. ${number(data.gave_anyway)} of them, in fact.`
            : "No unfinished donations in this period."
        }
      />
    );

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="Nearly gave"
        subtitle="Donations started on the websites and never completed — the warmest calls in DRM"
        actions={
          <>
            {/* The one-press way in: every one of them, as a run, with the
                new attempts turned into leads on the way. */}
            <Button icon="phoneOutgoing" loading={callingAll} onClick={() => void callEveryone()}>
              Call everyone who nearly gave
            </Button>
            <Button variant="secondary" icon="refresh" loading={refreshing} onClick={() => void refreshNow()}>
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
          morning, and the repeat triers when neither is working.

          On a phone only the search shows until "Filters" is pressed - six
          stacked dropdowns would push the first person to ring below the
          fold. `contents` lets the same fields sit in the row on a desktop. */}
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
        <Field label="Find" htmlFor="pending-search" className="w-full flex-1 md:order-last md:w-auto md:min-w-[16rem]">
          <div className="flex gap-2">
            <SearchInput
              id="pending-search"
              value={search}
              onChange={setSearch}
              placeholder="Name, number or email…"
              className="flex-1"
            />
            <Button
              variant="secondary"
              icon="filter"
              className="md:hidden"
              aria-expanded={showFilters}
              onClick={() => setShowFilters((v) => !v)}
            >
              {activeFilters ? `Filters (${activeFilters})` : "Filters"}
            </Button>
          </div>
        </Field>
        <div className={showFilters ? "contents" : "hidden md:contents"}>
          <Field label="How far back" className="w-full sm:w-36">
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
          <Field label="Site" className="w-full sm:w-52">
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
          <Field label="What happened" className="w-full sm:w-44">
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
          <Field label="Order" className="w-full sm:w-48">
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
          <Field label="Amount between" className="w-full sm:w-56">
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
        </div>
      </Toolbar>

      {error && <Alert tone="danger">{error}</Alert>}

      {/* A site being unreachable, or never connected, must not look like a
          quiet week. And the page now reads a stored copy, so when that copy
          was last refreshed is part of what the number means. */}
      {/* An error means the last good copy is what you are reading, not that
          the site's rows are missing — saying "nothing from it is listed
          below" was simply untrue, since last night's rows are still in the
          table and still in the totals. */}
      {data?.sites.map((st) =>
        st.error ? (
          <Alert key={st.site} tone="warn" title={`${SITE_LABELS[st.site] ?? st.site} could not be reached.`}>
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
                    st.synced_days && st.synced_days < Number(days) ? ` (last ${st.synced_days} days only)` : ""
                  }`
                : `${SITE_LABELS[st.site] ?? st.site} not checked yet`
            )
            .join(" · ")}
          {data.sites.some((st) => st.refreshing) && " · checking again now"}
        </p>
      )}

      {/* The headline figures describe who is worth ringing, so they are
          shown for that view only - over the set-aside people they would
          read as money still in play. */}
      {view === "open" && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
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
            sub="in DRM already"
          />
          <StatTile
            label="Gave anyway"
            value={loading ? "—" : number(data?.gave_anyway ?? 0)}
            accent="good"
            sub="settled since — never shown here"
          />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<View>
          options={[
            { value: "open", label: "To call", icon: "phone" },
            { value: "set_aside", label: "Set aside", icon: "inbox" },
          ]}
          value={view}
          onChange={setView}
          size="sm"
        />
        {view === "set_aside" && data && !loading && (
          <p className="text-xs text-ink-muted">
            {number(data.open)} {plural(data.open, "person", "people")} set aside in this period
          </p>
        )}
        {/* The page checkbox lives in the table header on a desktop; phones
            have no header, so it is offered here. */}
        {view === "open" && pickable.length > 0 && !loading && (
          <Checkbox
            className="md:hidden"
            checked={allOnPage}
            indeterminate={someOnPage}
            onChange={togglePage}
            label={`Select all ${number(pickable.length)} shown`}
          />
        )}
      </div>

      {view === "open" && allOnPage && (moreThanShown || allMatching) && data && (
        <SelectAllBanner
          pageCount={pickable.length}
          total={data.open}
          allMatching={allMatching}
          onSelectAll={() => setSel({ key, ids: new Set(pickable.map((r) => r.id)), all: true })}
          onClear={clearSelection}
        />
      )}

      {/* ------------------------------------------------------ phone cards */}
      <div className="space-y-3 md:hidden">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} padded={false} className="p-4">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="mt-2 h-3 w-1/3" />
              <Skeleton className="mt-4 h-9 w-full" />
            </Card>
          ))
        ) : !rows.length ? (
          <Card padded={false}>{emptyState}</Card>
        ) : (
          rows.map((r) => {
            const on = picked.has(r.id) || (allMatching && canPick(r));
            return (
              <Card key={r.id} padded={false} tone={on ? "brand" : "default"} className="p-4">
                <div className="flex items-start gap-3">
                  {canPick(r) && (
                    <Checkbox
                      className="mt-0.5"
                      checked={on}
                      onChange={() => toggleRow(r)}
                      label={<span className="sr-only">Select {who(r)}</span>}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-ink">{r.name || "Name not given"}</p>
                        <p className="text-xs tabular-nums text-ink-muted">{formatPhone(r.phone)}</p>
                      </div>
                      <p className="flex-none font-semibold tabular-nums text-ink">
                        {r.amount ? currency(Number(r.amount)) : <span className="text-ink-faint">—</span>}
                      </p>
                    </div>
                    <p className="mt-1.5 text-sm text-ink-soft">
                      {r.purpose || "No purpose given"}
                      <span className="text-ink-faint"> · {SITE_LABELS[r.source_site] ?? r.source_site}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {view === "set_aside" && r.set_aside_at
                        ? `Set aside ${relativeDate(r.set_aside_at).toLowerCase()} · tried ${relativeDate(r.attempted_at).toLowerCase()}`
                        : `Tried ${relativeDate(r.attempted_at).toLowerCase()}`}
                      {r.attempts_in_view > 1 && ` · ${number(r.attempts_in_view)} times`}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1">{chips(r)}</div>
                    {lastCall(r)}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">{actions(r, true)}</div>
              </Card>
            );
          })
        )}
      </div>

      {/* ------------------------------------------------------ desktop table */}
      <div className="hidden md:block">
        <TableShell>
          <Thead>
            <Th className="w-10">
              {view === "open" && (
                <Checkbox
                  checked={allOnPage}
                  indeterminate={someOnPage}
                  disabled={!pickable.length}
                  onChange={togglePage}
                  label={<span className="sr-only">Select everyone shown</span>}
                />
              )}
            </Th>
            <Th>Who</Th>
            <Th align="right">Tried to give</Th>
            <Th>For</Th>
            <Th>When</Th>
            <Th>What happened</Th>
            <Th align="right"> </Th>
          </Thead>

          {loading ? (
            <SkeletonRows rows={6} cols={7} />
          ) : (
            <Tbody>
              {!rows.length ? (
                <tr>
                  <td colSpan={7}>{emptyState}</td>
                </tr>
              ) : (
                rows.map((r) => {
                  const on = picked.has(r.id) || (allMatching && canPick(r));
                  return (
                    <tr key={r.id} className={on ? "bg-brand-50" : ""}>
                      <Td>
                        {canPick(r) && (
                          <Checkbox
                            checked={on}
                            onChange={() => toggleRow(r)}
                            label={<span className="sr-only">Select {who(r)}</span>}
                          />
                        )}
                      </Td>
                      <Td>
                        <div className="font-medium text-ink">{r.name || "Name not given"}</div>
                        <div className="text-xs tabular-nums text-ink-muted">{formatPhone(r.phone)}</div>
                        {lastCall(r)}
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
                        {view === "set_aside" && r.set_aside_at && (
                          <div className="text-ink-faint">set aside {relativeDate(r.set_aside_at).toLowerCase()}</div>
                        )}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">{chips(r)}</div>
                        {r.attempts_in_view > 1 && (
                          <div className="mt-0.5 text-xs text-ink-muted">tried {number(r.attempts_in_view)} times</div>
                        )}
                      </Td>
                      <Td align="right">
                        <div className="flex justify-end gap-1.5">{actions(r, false)}</div>
                      </Td>
                    </tr>
                  );
                })
              )}
            </Tbody>
          )}
        </TableShell>
      </div>

      {data && !data.complete && !loading && (
        <Alert tone="warn" className="mt-4">
          Showing the first {number(rows.length)} of {number(data.open)}. The totals above cover all of them — narrow
          the filters to work through the rest, or tick the page and choose &ldquo;Select all matching&rdquo;.
        </Alert>
      )}

      <p className="mt-4 text-xs text-ink-muted">
        Kept in DRM and refreshed from both sites in the background, so this screen opens instantly instead of waiting
        on two websites every time. Press <strong>Check the sites now</strong> if you have just watched a donation
        fail. Anyone who has since given — on either site, by any means, including cash — is removed before the list
        reaches you, because chasing money that has already arrived is worse than not calling at all; that check runs
        on every load, not on the refresh, so it is never out of date.
      </p>

      <SelectionBar
        count={selectedCount}
        unit={plural(selectedCount, "person", "people")}
        allMatching={allMatching}
        onClear={clearSelection}
        note={
          elevated ? undefined : "They become your leads. Anyone already another caller's is left with them."
        }
      >
        {elevated && (
          <Select
            value={assign}
            onChange={setAssign}
            ariaLabel="Whose leads they become"
            options={assignOptions}
            className="w-full sm:w-48"
          />
        )}
        <Button
          variant="secondary"
          icon="userPlus"
          loading={bulkBusy === "add"}
          disabled={bulkBusy !== null}
          onClick={() => void adoptSelected(false)}
        >
          Add {number(selectedCount)} as leads
        </Button>
        <Button
          icon="phoneOutgoing"
          loading={bulkBusy === "call"}
          disabled={bulkBusy !== null}
          onClick={() => void adoptSelected(true)}
        >
          Add and start calling
        </Button>
      </SelectionBar>
    </div>
  );
}
