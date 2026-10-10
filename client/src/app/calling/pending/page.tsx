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

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { callHref, formatPhone, runHref, startRun } from "@/lib/calling";
import { clockTime, currency, dateTime, istDateKey, istToday, istDayPlus, number, relativeDate } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DropdownMenu,
  EmptyState,
  Icon,
  Field,
  Input,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
  Toolbar,
} from "@/components/ui";
import { ExportButton } from "@/components/export-button";
import { toast } from "@/components/toast";
import { SelectAllBanner, SelectionBar } from "@/components/bulk/selection-bar";
import { LinkDonationDialog } from "@/components/calling/link-donation";
import { CALL_EDGE, CallStateChip, callState } from "@/components/calling/call-state";
import { useCallingAlerts } from "@/components/calling-alerts";
import { CallFilterChips, type CallFilter } from "@/components/calling/call-filter";

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
  /** Rung since they tried - with gave_anyway, they paid after the call. */
  called_since?: boolean;
  lead_id?: string | null;
  lead_status?: string | null;
  assigned_to_name?: string | null;
  /** The lead's own state, so a row can say "do not call" or "Arjun's lead". */
  lead_do_not_call?: boolean | null;
  lead_assigned_to?: string | null;
  lead_last_outcome?: string | null;
  lead_last_contacted_at?: string | null;
  /** Every call to them, the ones nobody answered, and the ones where they rang back. */
  lead_call_attempts?: number | null;
  lead_calls_missed?: number | null;
  lead_calls_in?: number | null;
  set_aside_at?: string | null;
  /** False when the lead is with somebody who does not make calls (an admin). */
  lead_owner_calls?: boolean | null;
}

interface Answer {
  rows: Row[];
  total: number;
  open: number;
  gave_anyway: number;
  already_leads: number;
  value_at_stake: number;
  /** How many behind each quick call filter (All, Not called today, ...). */
  call_counts?: { all: number; not_today: number; today: number; no_answer: number };
  /** False when the list is showing only part of what the filters match. */
  complete: boolean;
  /** Which page came back, and how many there are over the whole filter. */
  page: number;
  limit: number;
  total_pages: number;
  /** Rows the filters match - what the pager counts through. */
  matching: number;
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
  pending: { label: "Not finished", tone: "warn" },
  created: { label: "Not finished", tone: "warn" },
  failed: { label: "Payment failed", tone: "danger" },
  halted: { label: "Stopped", tone: "danger" },
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
  if (r.created) parts.push(`${number(r.created)} added`);
  if (r.already_yours)
    parts.push(
      `${number(r.already_yours)} ${
        opts.mine
          ? "already yours"
          : "already leads"
      }`
    );
  if (r.already_others)
    parts.push(
      `${number(r.already_others)} with ${opts.owners.length === 1 ? opts.owners[0] : "other callers"}`
    );
  if (r.do_not_call) parts.push(`${number(r.do_not_call)} do not call`);
  if (r.gave_anyway) parts.push(`${number(r.gave_anyway)} gave anyway`);
  const accounted = r.created + r.already_yours + r.already_others + r.do_not_call + r.gave_anyway;
  const rest = r.requested - accounted;
  if (rest > 0) parts.push(`${number(rest)} not added`);
  return parts.join(" · ") || "No one to add";
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
  /* Not-called-yet first, newest within that - the order a shift starts from.

     "Newest first" alone mixes the people a caller spoke to yesterday in among
     the ones nobody has touched, so finding the next real call is done by eye
     on every page.

     Related to the `called` quick filter below but not the same question:
     that one hides people, this one orders them. Somebody scanning the whole
     list still wants the untouched ones first. */
  const [sort, setSort] = useState("uncalled");
  const [called, setCalled] = useState<CallFilter>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [assign, setAssign] = useState("me");
  const [bulkBusy, setBulkBusy] = useState<"add" | "call" | null>(null);
  const [callingAll, setCallingAll] = useState(false);
  /** The person whose donation from another number is being looked for. */
  const [linking, setLinking] = useState<{ leadId: string; name: string | null } | null>(null);
  const closeLinking = useCallback(() => setLinking(null), []);

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
    if (fromDate) q.set("from_date", fromDate);
    if (toDate) q.set("to_date", toDate);
    if (site) q.set("sites", site);
    if (minAmount) q.set("min_amount", minAmount);
    if (maxAmount) q.set("max_amount", maxAmount);
    if (status) q.set("status", status);
    if (debounced.trim()) q.set("search", debounced.trim());
    if (view === "set_aside") q.set("set_aside", "true");
    if (called) q.set("called", called);
    return q;
  }, [days, site, minAmount, maxAmount, status, sort, debounced, view, called, fromDate, toDate]);

  /* The page number rides OUTSIDE filterParams, deliberately.

     filterParams is also what the download and "add all matching" are built
     from, and both of those mean every row the filters match - not the twenty
     currently on screen. Putting the page in there would quietly turn
     "Download" into "download this page", which is the kind of bug somebody
     finds out about from a spreadsheet that is missing most of its rows. */
  const PER_PAGE = 25;
  const listParams = useCallback(() => {
    const q = filterParams();
    q.set("page", String(page));
    q.set("limit", String(PER_PAGE));
    return q;
  }, [filterParams, page]);

  // Any change to the filters puts you back on page 1 - including the quick
  // call filter. Staying on page 7 of a list that now has two pages shows an
  // empty screen that reads as "nobody matched" when the truth is "you are
  // past the end".
  const filterKey = filterParams().toString();
  useEffect(() => setPage(1), [filterKey]);

  /* Back to the top of the list when the page changes.

     The pager is at the BOTTOM, so pressing Next without this leaves you
     looking at the end of the new page - which reads as nothing having
     happened. scrollIntoView on an anchor rather than window.scrollTo because
     the shell scrolls <main>, not the window (see dashboard-layout.tsx), so
     scrolling the window moves nothing at all.

     Skipped on first render, or the screen jumps the moment it opens. */
  const topRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [page]);

  // Loading is DERIVED: the screen is loading whenever the answer on it was
  // fetched for different filters than the ones now chosen. Holding it as a
  // flag meant setting it at the top of every fetch, and a fetch that loses a
  // race to a newer one then cleared it under the newer one's feet.
  const key = listParams().toString();
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
        (e) => settle(k, null, e instanceof Error ? e.message : "Could not load. Try again.")
      ),
    [settle]
  );

  useEffect(() => {
    latest.current = key;
    void load(key);
  }, [key, load]);

  /** Re-read what is on screen, quietly - no skeleton for a refresh. */
  const reload = useCallback(() => load(latest.current), [load]);

  // Kept live. The list used to load once and sit there, so a payment that
  // failed while it was open rang the bell but never appeared here until the
  // page was reloaded. Now it re-reads the moment the bell hears of a new
  // one, and every minute anyway while the tab is in front.
  const { notifications } = useCallingAlerts();
  const newestNearlyGave = notifications.find((n) => n.kind === "nearly_gave")?.id ?? "";
  const lastHeard = useRef(newestNearlyGave);
  useEffect(() => {
    if (newestNearlyGave === lastHeard.current) return;
    lastHeard.current = newestNearlyGave;
    void reload();
  }, [newestNearlyGave, reload]);
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) void reload();
    }, 60_000);
    return () => clearInterval(t);
  }, [reload]);

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
  /**
   * Parked: the lead is with somebody who does not make calls - typically an
   * admin who added the list for themselves. A caller calling it takes it
   * over. Before, these rows showed no Call button at all, and with one
   * caller ringing everybody that left them stuck.
   */
  const parked = (r: Row) => isOthers(r) && r.lead_owner_calls === false;
  /** Can this person be rung from here, by whoever is looking? */
  const canCall = (r: Row) => !r.gave_anyway && !r.lead_do_not_call && (!isOthers(r) || parked(r) || elevated);
  // A row that cannot be called is not offered for ticking either.
  const canPick = (r: Row) => view === "open" && canCall(r);
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
      toast("Updated");
    } catch (e) {
      toast.error("Could not update. Try again.", e instanceof Error ? e.message : undefined);
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
        toast.info("No one here can be called", line);
        return;
      }
      const run = await startRun({ kind: "selection", lead_ids: res.lead_ids, label: "Nearly gave" });
      if (run.empty || !run.session) {
        toast.info("No one here can be called now", line);
        return;
      }
      toast(line);
      router.push(runHref(run.session.id));
    } catch (e) {
      toast.error("Could not add. Try again.", e instanceof Error ? e.message : undefined);
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
        toast.info("No one to call right now");
        return;
      }
      if (run.adopted?.created) toast(`${number(run.adopted.created)} new leads added`);
      router.push(runHref(run.session.id));
    } catch (e) {
      toast.error("Could not start calling. Try again.", e instanceof Error ? e.message : undefined);
    } finally {
      setCallingAll(false);
    }
  }

  /**
   * Ring one person. A lead already - straight to the call screen. Not yet -
   * added first, as theirs, so the call is recorded against somebody.
   */
  async function callRow(r: Row) {
    // Straight to the call screen when the lead is already reachable; added
    // (or taken over, when parked with an admin) first otherwise.
    if (r.lead_id && !(parked(r) && !elevated)) {
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
        toast.warn(`${who(r)} cannot be called`, summarise(res, { mine: true, owners: [] }));
        void reload();
        return;
      }
      if (res.created) toast(`${who(r)} is now your lead`);
      router.push(callHref(id, "/calling/pending"));
    } catch (e) {
      toast.error(`Could not call ${who(r)}. Try again.`, e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  /**
   * "They gave - just not from this number." A failed payment is often
   * finished on a son's UPI or a neighbour's phone, which DRM files under a
   * stranger, so this person would be chased for money already given. The
   * dialog finds that donation and links it. Someone not yet a lead is added
   * first, as with Call, so the donation has somebody to be linked to.
   */
  async function gaveAnotherWay(r: Row) {
    if (r.lead_id && !(parked(r) && !elevated)) {
      setLinking({ leadId: r.lead_id, name: r.name });
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
        toast.warn(`Could not open ${who(r)}`, summarise(res, { mine: true, owners: [] }));
        void reload();
        return;
      }
      if (res.created) toast(`${who(r)} is now your lead`);
      void reload();
      setLinking({ leadId: id, name: r.name });
    } catch (e) {
      toast.error(`Could not open ${who(r)}`, e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  /** "Add to my leads" without calling now. Takes over a parked lead too. */
  async function adopt(r: Row) {
    setBusy(r.id);
    try {
      const res = await apiClient.post<AdoptResult>("/api/crm/leads/abandoned/adopt-bulk", {
        ids: [r.id],
        filters: Object.fromEntries(filterParams()),
        assign: "me",
      });
      toast(res.lead_ids.length ? `${who(r)} is in your leads` : summarise(res, { mine: true, owners: [] }));
      void reload();
    } catch (e) {
      toast.error(`Could not add ${who(r)}. Try again.`, e instanceof Error ? e.message : undefined);
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
      toast.error(`Could not bring ${who(r)} back. Try again.`, e instanceof Error ? e.message : undefined);
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
      toast.error("Could not set aside. Try again.", e instanceof Error ? e.message : undefined);
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
    { value: "none", label: "No caller" },
    ...(config?.users ?? [])
      .filter((u) => u.id !== user?.id)
      .map((u) => ({ value: u.id, label: u.name, hint: u.role?.replace(/_/g, " ") })),
  ];

  /* ------------------------------------------------------ row pieces */

  // Always read as days: a heading for each date, and that day's people under
  // it. Newest day first ("Oldest first" turns the days round); within a day
  // the chosen order holds - not rung first, biggest first, most tries, time.
  const byDay = true;
  const dayCounts = new Map<string, number>();
  const dayAmounts = new Map<string, number>();
  for (const r of rows) {
    const k = istDateKey(r.attempted_at);
    dayCounts.set(k, (dayCounts.get(k) ?? 0) + 1);
    dayAmounts.set(k, (dayAmounts.get(k) ?? 0) + (Number(r.amount) || 0));
  }
  const dayKeys = [...dayCounts.keys()].sort((a, b) => (sort === "oldest" ? a.localeCompare(b) : b.localeCompare(a)));
  const dayRank = new Map(dayKeys.map((k, i) => [k, i]));
  // A stable sort by day keeps the server's order (the chosen sort) inside each day.
  const listed = rows
    .map((r, i) => ({ r, i, d: dayRank.get(istDateKey(r.attempted_at)) ?? 0 }))
    .sort((x, y) => x.d - y.d || x.i - y.i)
    .map((x) => x.r);
  function dayHeading(k: string) {
    const d = new Date(`${k}T12:00:00+05:30`);
    const words = d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
    const rel = k === istToday() ? "Today · " : k === istDayPlus(-1) ? "Yesterday · " : "";
    return `${rel}${words}`;
  }

  /** One line under the name: what happened, in plain words. */
  function story(r: Row) {
    const word = STATUS_WORDS[r.status]?.label ?? r.status;
    // The exact moment they tried. Under a day heading the time is enough;
    // sorted by amount or tries, the day is said too.
    const when = byDay ? `at ${clockTime(r.attempted_at)}` : `on ${dateTime(r.attempted_at)}`;
    const bits = [
      `${word} ${when}`,
      r.attempts_in_view > 1 ? `tried ${number(r.attempts_in_view)} times` : null,
      r.purpose || null,
      SITE_LABELS[r.source_site] ?? r.source_site,
    ].filter(Boolean);
    return bits.join(" · ");
  }

  /** Where the conversation is, if anyone has rung them. */
  function lastCall(r: Row) {
    if (view === "set_aside" && r.set_aside_at) return `Set aside ${relativeDate(r.set_aside_at).toLowerCase()}`;
    if (!r.lead_last_outcome && !r.lead_last_contacted_at) return null;
    return `Last call: ${r.lead_last_outcome ? outcomeLabel(r.lead_last_outcome) : "—"}${
      r.lead_last_contacted_at ? ` · ${relativeDate(r.lead_last_contacted_at).toLowerCase()}` : ""
    }${callCounts(r)}`;
  }

  /** " · 4 calls (3 not answered, they rang back once)" */
  function callCounts(r: Row) {
    const n = Number(r.lead_call_attempts ?? 0);
    if (!n) return "";
    const missed = Number(r.lead_calls_missed ?? 0);
    const back = Number(r.lead_calls_in ?? 0);
    const extra = [
      missed ? `${missed} not answered` : null,
      back ? `they rang back ${back === 1 ? "once" : `${back} times`}` : null,
    ].filter(Boolean);
    return ` · ${n} call${n === 1 ? "" : "s"}${extra.length ? ` (${extra.join(", ")})` : ""}`;
  }

  /** Call, and everything else behind "⋯". One button to look for, not five. */
  function actions(r: Row) {
    if (view === "set_aside") {
      return (
        <Button variant="secondary" size="sm" icon="refresh" onClick={() => void restore(r)}>
          Bring back
        </Button>
      );
    }
    // Paid after the call: kept on the list so the call that did it is seen.
    if (r.gave_anyway) return <Badge tone="good" icon="check">Donated after the call</Badge>;
    if (r.lead_do_not_call) return <Badge tone="danger" icon="xCircle">Do not call</Badge>;
    if (!canCall(r)) {
      // Another caller's lead. Only possible with more than one caller.
      return <Badge tone="info" icon="user">{r.assigned_to_name ? `${r.assigned_to_name}'s` : "Taken"}</Badge>;
    }
    // "Open lead" only for a lead that is already theirs; anything else -
    // not a lead yet, a lead nobody has, a lead parked with an admin - offers
    // "Add to my leads". It used to show "Open lead" for any lead at all, so a
    // caller often could not take somebody on.
    const mineAlready = !!r.lead_id && (r.lead_assigned_to === user?.id || (elevated && !!r.lead_assigned_to));
    return (
      <div className="flex items-center gap-1">
        <Button size="sm" icon="phone" loading={busy === r.id} onClick={() => void callRow(r)}>
          Call
        </Button>
        <DropdownMenu
          trigger={({ toggle, open }) => (
            <Button
              variant="secondary"
              size="sm"
              icon="more"
              aria-label={`More for ${who(r)}`}
              aria-expanded={open}
              disabled={busy === r.id}
              onClick={toggle}
            />
          )}
          items={[
            {
              label: "Gave another way",
              icon: "rupee",
              hint: "Paid from another number or name",
              onSelect: () => void gaveAnotherWay(r),
            },
            ...(mineAlready
              ? [{ label: "Open lead", icon: "user" as const, onSelect: () => router.push(`/leads/${r.lead_id}`) }]
              : [{ label: "Add to my leads", icon: "userPlus" as const, hint: "Call later", onSelect: () => void adopt(r) }]),
            { label: "Set aside", icon: "inbox", hint: "Hide from this list", onSelect: () => void dismiss(r) },
          ]}
        />
      </div>
    );
  }

  const emptyState =
    view === "set_aside" ? (
      <EmptyState icon="inbox" title="No one set aside" message="People you set aside show here." />
    ) : (
      <EmptyState
        title="No one to call"
        message={
          called === "today"
            ? "Nobody has been called today yet."
            : called === "not_today"
            ? "Everyone has been called today."
            : called === "no_answer"
            ? "No one whose last call went unanswered."
            : data?.gave_anyway
            ? `All ${number(data.gave_anyway)} have given since.`
            : "No unfinished donations in this period."
        }
      />
    );

  const callable = rows.filter(canCall).length;
  const siteTrouble = data?.sites.filter((st) => st.error) ?? [];
  const oldest = data?.sites
    .map((st) => st.last_synced_at)
    .filter(Boolean)
    .sort()[0] as string | undefined;

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="Nearly gave"
        subtitle="Started a donation online but did not finish."
        actions={
          <>
            {/* The one-press way in: everybody, as a run, new ones added on
                the way. */}
            <Button icon="phoneOutgoing" loading={callingAll} onClick={() => void callEveryone()}>
              {view === "open" && data && !loading ? `Call all (${number(data.open)})` : "Call all"}
            </Button>
            {elevated && (
              <ExportButton
                path="/api/crm/leads/abandoned/export"
                params={filterParams()}
                filename="nearly-gave"
                hint={data ? `${number(data.open)} people` : undefined}
              />
            )}
          </>
        }
      />

      {/* Search always; the rest behind Filters. Six dropdowns above the list
          was the first thing a caller had to read past every morning. */}
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
        <div className="flex w-full gap-2">
          <SearchInput
            id="pending-search"
            value={search}
            onChange={setSearch}
            placeholder="Name, mobile or e-mail"
            className="flex-1"
          />
          <Button
            variant="secondary"
            icon="filter"
            aria-expanded={showFilters}
            onClick={() => setShowFilters((v) => !v)}
          >
            {activeFilters - (search ? 1 : 0) > 0 ? `Filters (${activeFilters - (search ? 1 : 0)})` : "Filters"}
          </Button>
        </div>
        {showFilters && (
          <>
            <Field label="Period" className="w-full sm:w-36">
              <Select
                value={days}
                onChange={setDays}
                ariaLabel="Period"
                options={[
                  { value: "1", label: "Today" },
                  { value: "7", label: "Last 7 days" },
                  { value: "30", label: "Last 30 days" },
                  { value: "90", label: "Last 90 days" },
                  { value: "365", label: "Last year" },
                ]}
              />
            </Field>
            <Field label="Sort" className="w-full sm:w-48">
              <Select
                value={sort}
                onChange={setSort}
                ariaLabel="Sort"
                options={[
                  { value: "uncalled", label: "Not called yet, newest" },
                  { value: "recent", label: "Newest first" },
                  { value: "amount", label: "Biggest amount first" },
                  { value: "attempts", label: "Most tries first" },
                  { value: "oldest", label: "Oldest first" },
                ]}
              />
            </Field>
            {/* An explicit range, for "what happened over Kartik" rather than
                "the last N days". It NARROWS the period above rather than
                replacing it: the period also decides how far back the sites
                are crawled, so a range outside it would ask the database for
                rows nothing has ever fetched and answer an honest-looking
                zero. Widen the period first, then pick the dates. */}
            <Field label="From" className="w-full sm:w-40">
              <Input
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="From date"
              />
            </Field>
            <Field label="To" className="w-full sm:w-40">
              <Input
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                aria-label="To date"
              />
            </Field>
            <Field label="Status" className="w-full sm:w-44">
              <Select
                value={status}
                onChange={setStatus}
                ariaLabel="Status"
                options={[
                  { value: "", label: "Any" },
                  { value: "failed", label: "Payment failed" },
                  { value: "pending,created", label: "Not finished" },
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
            <Field label="Amount" className="w-full sm:w-56">
              <div className="flex items-center gap-1.5">
                <Input
                  value={minAmount}
                  onChange={(e) => setMinAmount(e.target.value.replace(/\D/g, ""))}
                  placeholder="any"
                  inputMode="numeric"
                  aria-label="Min amount"
                  className="tabular-nums"
                />
                <span className="text-xs text-ink-faint">to</span>
                <Input
                  value={maxAmount}
                  onChange={(e) => setMaxAmount(e.target.value.replace(/\D/g, ""))}
                  placeholder="any"
                  inputMode="numeric"
                  aria-label="Max amount"
                  className="tabular-nums"
                />
              </div>
            </Field>
          </>
        )}
      </Toolbar>

      {error && <Alert tone="danger">{error}</Alert>}

      {/* One line for the figures, and one for how fresh the list is - in
          place of four boxes and a warning per site. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <SegmentedControl<View>
          options={[
            { value: "open", label: "To call", icon: "phone" },
            { value: "set_aside", label: "Set aside", icon: "inbox" },
          ]}
          value={view}
          onChange={setView}
          size="sm"
        />
        {data && !loading && (
          <p className="text-sm text-ink-soft">
            {view === "open" ? (
              <>
                <span className="font-semibold text-ink">{number(data.open)}</span> to call ·{" "}
                <span className="font-semibold text-ink">{currency(data.value_at_stake)}</span> they tried to give
                {data.gave_anyway > 0 && (
                  <span className="text-ink-muted"> · {number(data.gave_anyway)} gave later (hidden)</span>
                )}
              </>
            ) : (
              `${number(data.open)} set aside`
            )}
          </p>
        )}
      </div>

      {view === "open" && (
        <CallFilterChips className="mb-3" value={called} onChange={setCalled} counts={data?.call_counts} />
      )}

      {data && (
        <p className={`mb-3 flex flex-wrap items-center gap-x-2 text-xs ${siteTrouble.length ? "text-warn" : "text-ink-muted"}`}>
          <span>
            {siteTrouble.length
              ? `Could not reach ${siteTrouble.map((st) => SITE_LABELS[st.site] ?? st.site).join(" and ")}. Showing the list from ${
                  oldest ? relativeDate(oldest).toLowerCase() : "before"
                }.`
              : oldest
              ? `Updated ${relativeDate(oldest).toLowerCase()}${data.sites.some((st) => st.refreshing) ? " · updating now" : ""}`
              : "Not updated yet"}
          </span>
          <Button variant="ghost" size="xs" icon="refresh" loading={refreshing} onClick={() => void refreshNow()}>
            Refresh
          </Button>
        </p>
      )}

      {view === "open" && pickable.length > 0 && !loading && (
        <div className="mb-2 flex items-center justify-between px-1">
          <Checkbox
            checked={allOnPage}
            indeterminate={someOnPage}
            onChange={togglePage}
            label={`Select all ${number(pickable.length)}`}
          />
          {callable < rows.length && (
            <span className="text-xs text-ink-muted">{number(rows.length - callable)} can&apos;t be called</span>
          )}
        </div>
      )}

      {view === "open" && allOnPage && (moreThanShown || allMatching) && data && (
        <SelectAllBanner
          pageCount={pickable.length}
          total={data.open}
          allMatching={allMatching}
          onSelectAll={() => setSel({ key, ids: new Set(pickable.map((r) => r.id)), all: true })}
          onClear={clearSelection}
        />
      )}

      {/* One card per person, at every width: name and amount, one line on
          what happened, Call, and "⋯" for the rest.

          Cards rather than a table on purpose, and it is worth saying why,
          because a paginated list looks like it wants to be a table: callers
          dial from their own phones. A table of six columns on a 390px screen
          is a horizontal scrollbar over the one screen in this product that is
          used on a phone more than a desktop. The pagination below is what was
          actually slow; the layout was not. */}
      <div ref={topRef} className="scroll-mt-20 space-y-2">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} padded={false} className="p-4">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="mt-2 h-3 w-1/3" />
            </Card>
          ))
        ) : !rows.length ? (
          <Card padded={false}>{emptyState}</Card>
        ) : (
          listed.map((r, i) => {
            const day = istDateKey(r.attempted_at);
            const newDay = byDay && (i === 0 || istDateKey(listed[i - 1].attempted_at) !== day);
            const on = picked.has(r.id) || (allMatching && canPick(r));
            const last = lastCall(r);
            // The same colours as search and Leads: rung before or not.
            const cs = callState({
              do_not_call: r.lead_do_not_call,
              last_contacted_at: r.lead_last_contacted_at,
              last_outcome_label: r.lead_last_outcome ? outcomeLabel(r.lead_last_outcome) : null,
            });
            return (
              <Fragment key={r.id}>
              {newDay && (
                <h3
                  className={`sticky top-14 z-10 -mx-1 flex items-center justify-between gap-3 rounded-control border border-line-soft bg-sunken/95 px-3 py-2 text-sm font-semibold text-ink backdrop-blur ${
                    i === 0 ? "" : "mt-5"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Icon name="calendar" size={14} className="text-ink-muted" />
                    {dayHeading(day)}
                  </span>
                  <span className="text-xs font-normal text-ink-muted">
                    {number(dayCounts.get(day) ?? 0)} {plural(dayCounts.get(day) ?? 0, "person", "people")}
                    {dayAmounts.get(day) ? ` · ${currency(dayAmounts.get(day) ?? 0)}` : ""}
                  </span>
                </h3>
              )}
              <Card
                padded={false}
                tone={on ? "brand" : "default"}
                className={`border-l-[3px] px-3 py-3 sm:px-4 ${CALL_EDGE[cs.tone]} ${r.gave_anyway ? "bg-good-wash/60" : ""}`}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 w-5 flex-none">
                    {canPick(r) && (
                      <Checkbox
                        checked={on}
                        onChange={() => toggleRow(r)}
                        label={<span className="sr-only">Select {who(r)}</span>}
                      />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate font-medium text-ink">{r.name || "No name"}</span>
                      <span className="text-sm tabular-nums text-ink-muted">{formatPhone(r.phone)}</span>
                      {view === "open" && <CallStateChip state={cs} />}
                    </div>
                    <p className="mt-0.5 text-sm text-ink-soft">{story(r)}</p>
                    {last && <p className="mt-0.5 text-xs text-ink-muted">{last}</p>}
                  </div>
                  <div className="flex flex-none flex-col items-end gap-2 sm:flex-row sm:items-center sm:gap-4">
                    <span className="font-semibold tabular-nums text-ink">
                      {r.amount ? currency(Number(r.amount)) : <span className="text-ink-faint">—</span>}
                    </span>
                    {actions(r)}
                  </div>
                </div>
              </Card>
              </Fragment>
            );
          })
        )}
      </div>

      {/* The pager.

          WHY THIS REPLACED "Showing 500 of 199. Use filters to see more."
          That notice was the old shape of this problem: the endpoint answered
          with a bare LIMIT 500, so a long list was silently truncated and the
          only remedy offered was to narrow the filters until it fitted. On a
          thirty-day view across two sites that meant five hundred rows of
          joins rebuilt on every keystroke, for a screen nobody scrolls past
          the first twenty of.

          Rendered only when there IS more than one page: a pager under a list
          of nine is noise. */}
      {data && data.total_pages > 1 && !loading && (
        <nav
          className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-3"
          aria-label="Pages"
        >
          <p className="text-sm text-ink-muted" aria-live="polite">
            {/* The row numbers, not just the page number: "showing 26-50 of
                199" is the thing somebody reads to know where they are in a
                shift. Math.min on the upper bound so the last page says
                "176-199", not "176-200". */}
            Showing{" "}
            <strong className="tabular-nums text-ink">
              {number((data.page - 1) * data.limit + 1)}–
              {number(Math.min(data.page * data.limit, data.matching))}
            </strong>{" "}
            of <strong className="tabular-nums text-ink">{number(data.matching)}</strong>
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon="chevronLeft"
              disabled={data.page <= 1}
              onClick={() => setPage((n) => Math.max(1, n - 1))}
            >
              Previous
            </Button>
            <span className="px-1 text-sm tabular-nums text-ink-muted">
              {number(data.page)} / {number(data.total_pages)}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={data.page >= data.total_pages}
              onClick={() => setPage((n) => n + 1)}
            >
              Next
            </Button>
          </div>
        </nav>
      )}

      {linking && (
        <LinkDonationDialog
          leadId={linking.leadId}
          leadName={linking.name}
          onClose={closeLinking}
          // A converted lead counts as "gave anyway", so they leave To call.
          onLinked={() => void reload()}
        />
      )}

      <SelectionBar
        count={selectedCount}
        unit={plural(selectedCount, "person", "people")}
        allMatching={allMatching}
        onClear={clearSelection}
        note={elevated ? undefined : "They become your leads."}
      >
        {elevated && (
          <Select
            value={assign}
            onChange={setAssign}
            ariaLabel="Caller"
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
          Add to leads
        </Button>
        <Button
          icon="phoneOutgoing"
          loading={bulkBusy === "call"}
          disabled={bulkBusy !== null}
          onClick={() => void adoptSelected(true)}
        >
          Call these {number(selectedCount)}
        </Button>
      </SelectionBar>
    </div>
  );
}
