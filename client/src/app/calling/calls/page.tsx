"use client";

// "What calls have I made, and to whom."
//
// WHY THIS SCREEN EXISTS
// A caller rings forty people in a morning. By the afternoon the questions are
// "did I already ring that man from Gajuwaka?", "who did I promise to call
// back?", "the lady who didn't pick up at eleven - did she give in the end?".
// Every call was recorded, but only on each lead's own page, so answering any
// of them meant remembering a name first. This is the caller's own phone log,
// newest first, with what came of each call SINCE - the stage the person is in
// now, the callback booked, and the money if they gave afterwards.
//
// WHY "SOMEONE RANG ME" LIVES HERE
// The other half of the same problem: a lead who did not answer rings back
// later and gives on that call. The call screen only opens on somebody DRM
// queued, so that call - often the one that brought the money in - had nowhere
// to go. The button in the header finds them by the number on the phone and
// opens the call screen marked as a call they made, so it is logged and
// credited like any other.
//
// FILTERS LIVE IN THE URL
// So "Call again" can come back to exactly this view, and so the call screen
// can link here with ?lead_id= to show every call with one person.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { callHref, formatPhone } from "@/lib/calling";
import { IST, clockTime, currency, dateTime, dueLabel, istDateKey, istDayPlus, istToday, number } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Pagination,
  SearchInput,
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
import { OutcomePicker } from "@/components/calls/outcome-picker";
import { RangMeDialog } from "@/components/calls/rang-me-dialog";

/* ------------------------------------------------------------------ types */

interface CallRow {
  id: string;
  occurred_at: string;
  created_at: string;
  disposition: string | null;
  disposition_label: string | null;
  connected: boolean | null;
  duration_seconds: number | null;
  note: string | null;
  direction: "inbound" | "outbound";
  session_id: string | null;
  run_label: string | null;
  user_id: string | null;
  caller_name: string | null;
  lead_id: string;
  lead_name: string | null;
  lead_phone: string;
  lead_alt_phone: string | null;
  lead_status: string | null;
  lead_status_label: string | null;
  next_follow_up_at: string | null;
  converted_at: string | null;
  converted_amount: string | number | null;
  do_not_call: boolean;
  undoable: boolean;
}

interface Totals {
  calls: number;
  connected: number;
  people: number;
  inbound: number;
  gave_since: number;
  seconds: number;
  by_outcome: { disposition: string | null; label: string | null; n: number }[];
}

interface Answer {
  calls: CallRow[];
  totals: Totals;
  page: number;
  limit: number;
}

interface Config {
  users: { id: string; name: string; role: string }[];
  dispositions: { slug: string; label: string; counts_connected?: boolean }[];
}

/* ---------------------------------------------------------------- periods */

type Period = "today" | "yesterday" | "last_7" | "this_month" | "all" | "custom";

const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7", label: "Last 7 days" },
  { value: "this_month", label: "This month" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Pick dates" },
];

/** IST calendar days. Resolved here because the call log takes plain from/to dates. */
function resolveRange(period: Period, from: string, to: string): { from: string; to: string } {
  const today = istToday();
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = istDayPlus(-1);
      return { from: y, to: y };
    }
    case "last_7":
      return { from: istDayPlus(-6), to: today };
    case "this_month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "custom":
      return { from, to };
    default:
      return { from: "", to: "" };
  }
}

const LIMIT = 50;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "Today", "Yesterday", "Mon 3 Oct" - and the year when it is not this one. */
function dayHeading(key: string): string {
  if (key === istToday()) return "Today";
  if (key === istDayPlus(-1)) return "Yesterday";
  const d = new Date(`${key}T12:00:00+05:30`);
  const sameYear = key.slice(0, 4) === istToday().slice(0, 4);
  return d
    .toLocaleDateString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "numeric" }),
      timeZone: IST,
    })
    .replace(/,/g, "");
}

/** 75 → "1m 15s", 3900 → "1h 5m". */
function talkTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m`;
  return s ? `${m}m ${s}s` : `${m}m`;
}

const who = (r: CallRow) => r.lead_name || formatPhone(r.lead_phone);
/** They gave after this call (not before it). */
const gaveSince = (r: CallRow) => !!r.converted_at && Date.parse(r.converted_at) >= Date.parse(r.occurred_at);

/* ------------------------------------------------------------------- page */

// useSearchParams needs a Suspense boundary in this Next, so the screen is split in two.
export default function MyCallsPage() {
  return (
    <Suspense
      fallback={
        <div>
          <PageHeader eyebrow="Calling" title="My calls" />
          <Card>
            <Skeleton className="h-40 w-full" />
          </Card>
        </div>
      }
    >
      <MyCalls />
    </Suspense>
  );
}

function MyCalls() {
  const router = useRouter();
  const sp = useSearchParams();
  const { user } = useAuth();
  // The server's rule: anyone but a caller may look at someone else's calls.
  const elevated = !!user?.role && user.role !== "caller";

  const param = (k: string) => sp.get(k) ?? "";
  const leadId = param("lead_id");
  const customFrom = param("from");
  const customTo = param("to");
  // One person's calls are a history, not a day - so with ?lead_id= the
  // screen opens on all of them.
  const defaultPeriod: Period = leadId ? "all" : "today";
  const askedPeriod = PERIODS.find((p) => p.value === sp.get("period"))?.value;
  const period: Period = askedPeriod ?? (customFrom || customTo ? "custom" : defaultPeriod);
  const range = resolveRange(period, customFrom, customTo);
  const outcomesKey = param("disposition");
  const outcomes = outcomesKey.split(",").filter(Boolean);
  const connected = param("connected");
  const direction = param("direction");
  const userId = elevated ? param("user_id") : "";
  const urlSearch = param("search");
  const page = Math.max(1, Number(sp.get("page")) || 1);
  // Where the call screen's Back returns to: this exact view.
  const here = `/calling/calls${sp.toString() ? `?${sp.toString()}` : ""}`;

  /** Change filters by changing the URL. Any filter change goes back to page one. */
  const setParams = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!("page" in updates) || next.get("page") === "1") next.delete("page");
      const qs = next.toString();
      router.replace(qs ? `/calling/calls?${qs}` : "/calling/calls", { scroll: false });
    },
    [sp, router]
  );

  const [config, setConfig] = useState<Config | null>(null);
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [rangMe, setRangMe] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);
  // Stable, because Modal re-runs its focus handling whenever onClose changes.
  const closeRangMe = useCallback(() => setRangMe(false), []);

  useEffect(() => {
    apiClient
      .get<Config>("/api/crm/config")
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  /* ------------------------------------------------------------ search */

  // Typed locally and pushed to the URL after a pause; follows the URL when
  // it changes for any other reason (Back, Clear all).
  const [search, setSearch] = useState(urlSearch);
  const [seenSearch, setSeenSearch] = useState(urlSearch);
  const [pushedSearch, setPushedSearch] = useState<string | null>(null);
  if (urlSearch !== seenSearch) {
    setSeenSearch(urlSearch);
    if (urlSearch !== pushedSearch) setSearch(urlSearch);
  }
  useEffect(() => {
    const v = search.trim();
    if (v === urlSearch) return;
    const t = setTimeout(() => {
      setPushedSearch(v);
      setParams({ search: v || null });
    }, 300);
    return () => clearTimeout(t);
  }, [search, urlSearch, setParams]);

  /* ----------------------------------------------------------- loading */

  /**
   * The filters, described once. The list and the download both read this,
   * so the file holds exactly the calls on screen.
   */
  const filterQuery = useCallback(() => {
    const p = new URLSearchParams();
    if (range.from) p.set("from", range.from);
    if (range.to) p.set("to", range.to);
    if (outcomesKey) p.set("disposition", outcomesKey);
    if (connected) p.set("connected", connected);
    if (direction) p.set("direction", direction);
    if (urlSearch) p.set("search", urlSearch);
    if (leadId) p.set("lead_id", leadId);
    if (userId) p.set("user_id", userId);
    return p;
  }, [range.from, range.to, outcomesKey, connected, direction, urlSearch, leadId, userId]);

  const query = useCallback(() => {
    const p = filterQuery();
    p.set("page", String(page));
    p.set("limit", String(LIMIT));
    return p;
  }, [filterQuery, page]);

  // Loading is derived from which question the rows on screen answer, so a
  // slow reply to an older filter can neither overwrite a newer one nor
  // switch the skeleton off underneath it.
  const key = query().toString();
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  // When the rows on screen were fetched - what "late" is measured against.
  const [loadedAt, setLoadedAt] = useState(0);
  const loading = loadedKey !== key;
  const latest = useRef("");

  const settle = useCallback((k: string, d: Answer | null, err: string | null) => {
    if (latest.current !== k) return;
    if (d) setData(d);
    setError(err);
    setLoadedKey(k);
    setLoadedAt(Date.now());
  }, []);

  const load = useCallback(
    (k: string) =>
      apiClient.get<Answer>(`/api/crm/calls?${k}`).then(
        (d) => settle(k, d, null),
        (e) => settle(k, null, e instanceof Error ? e.message : "Could not load. Try again.")
      ),
    [settle]
  );

  useEffect(() => {
    latest.current = key;
    void load(key);
  }, [key, load]);

  const reload = useCallback(() => load(latest.current), [load]);

  /* ----------------------------------------------------------- actions */

  async function undo(r: CallRow) {
    setUndoing(r.id);
    try {
      await apiClient.delete(`/api/crm/activities/${r.id}`);
      toast(`Call with ${who(r)} undone`);
      await reload();
    } catch (e) {
      toast.error("Could not undo. Try again.", e instanceof Error ? e.message : undefined);
    } finally {
      setUndoing(null);
    }
  }

  const choosePeriod = (v: string) => {
    const next = v as Period;
    if (next === "custom") {
      // Start the range on what was showing, so choosing it does not jump.
      const r = resolveRange(period, customFrom, customTo);
      const today = istToday();
      setParams({ period: "custom", from: r.from || today, to: r.to || today });
      return;
    }
    setParams({ period: next === defaultPeriod ? null : next, from: null, to: null });
  };

  const clearAll = () => {
    setSearch("");
    setPushedSearch("");
    setParams({
      period: null,
      from: null,
      to: null,
      disposition: null,
      connected: null,
      direction: null,
      search: null,
      user_id: null,
    });
  };

  /* ------------------------------------------------------------ derived */

  const rows = useMemo(() => data?.calls ?? [], [data]);
  const totals = data?.totals;
  const teamView = userId === "all";
  const viewingOther = !!userId && userId !== "all" && userId !== user?.id;
  const otherName = viewingOther ? config?.users.find((u) => u.id === userId)?.name : null;

  const activeFilters = [
    period !== defaultPeriod ? period : "",
    outcomes.length ? "o" : "",
    connected,
    direction,
    urlSearch,
    userId,
  ].filter(Boolean).length;

  // Rows grouped under their IST day, in the order the server sent them.
  const days = useMemo(() => {
    const out: { key: string; rows: CallRow[] }[] = [];
    for (const r of rows) {
      const k = istDateKey(r.occurred_at);
      const last = out[out.length - 1];
      if (last && last.key === k) last.rows.push(r);
      else out.push({ key: k, rows: [r] });
    }
    return out;
  }, [rows]);

  const leadLabel =
    leadId && rows[0]?.lead_id === leadId ? rows[0].lead_name || formatPhone(rows[0].lead_phone) : "this person";

  const connectedSlugs = new Set((config?.dispositions ?? []).filter((d) => d.counts_connected).map((d) => d.slug));
  const outcomeOptions = (config?.dispositions ?? []).map((d) => ({ slug: d.slug, label: d.label }));
  const maxOutcome = Math.max(1, ...(totals?.by_outcome ?? []).map((o) => o.n));
  const pct = totals && totals.calls ? Math.round((totals.connected / totals.calls) * 100) : 0;
  const totalPages = Math.max(1, Math.ceil((totals?.calls ?? 0) / LIMIT));

  const callerOptions = [
    { value: "", label: "Me" },
    { value: "all", label: "Whole team" },
    ...(config?.users ?? [])
      .filter((u) => u.id !== user?.id)
      .map((u) => ({ value: u.id, label: u.name, hint: u.role?.replace(/_/g, " ") })),
  ];

  const title = teamView ? "Team calls" : otherName ? `${otherName}'s calls` : "My calls";
  const periodLabel =
    period === "custom"
      ? "in these dates"
      : period === "all"
        ? "all time"
        : PERIODS.find((p) => p.value === period)?.label.toLowerCase() ?? "";

  /* ------------------------------------------------------------ pieces */

  function outcomeBadge(r: CallRow) {
    const label = r.disposition_label || (r.disposition ? r.disposition.replace(/_/g, " ") : "Call");
    return (
      <Badge tone={r.connected ? "good" : "neutral"} dot>
        {label}
      </Badge>
    );
  }

  function directionTag(r: CallRow) {
    const inbound = r.direction === "inbound";
    return (
      <span className={`inline-flex items-center gap-1 text-xs ${inbound ? "font-medium text-info" : "text-ink-muted"}`}>
        <Icon name={inbound ? "phone" : "phoneOutgoing"} size={12} />
        {inbound ? "They called" : "I called"}
      </span>
    );
  }

  /** What came of it: the stage now, a callback, money. */
  function since(r: CallRow) {
    const late = !!r.next_follow_up_at && Date.parse(r.next_follow_up_at) < loadedAt;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {gaveSince(r) && (
          <Badge tone="brand" icon="rupee">
            Donated {r.converted_amount ? currency(r.converted_amount) : ""}
          </Badge>
        )}
        {r.do_not_call && <Badge tone="danger">Do not call</Badge>}
        {r.lead_status_label && !gaveSince(r) && <Badge>{r.lead_status_label}</Badge>}
        {r.next_follow_up_at && !gaveSince(r) && (
          <span
            className={`inline-flex items-center gap-1 text-xs ${late ? "font-medium text-warn" : "text-ink-muted"}`}
            title={dateTime(r.next_follow_up_at)}
          >
            <Icon name="clock" size={12} />
            Follow-up {dueLabel(r.next_follow_up_at)}
          </span>
        )}
      </div>
    );
  }

  function details(r: CallRow) {
    const bits = [
      r.duration_seconds && r.duration_seconds > 0 ? talkTime(r.duration_seconds) : null,
      r.run_label ? `in ${r.run_label}` : null,
      teamView && r.caller_name ? `by ${r.caller_name}` : null,
    ].filter(Boolean);
    return bits.length ? <p className="mt-1 text-xs text-ink-faint">{bits.join(" · ")}</p> : null;
  }

  function actions(r: CallRow, phone: boolean) {
    const size = phone ? "lg" : "sm";
    const iconSize = phone ? 18 : 15;
    return (
      <>
        {!r.do_not_call && (
          // A next/link anchor wearing the button class: LinkButton is a plain
          // <a>, which would drop out of the client router.
          <Link href={callHref(r.lead_id, here)} className={buttonClass("primary", size, phone ? "flex-1" : "")}>
            <Icon name="phone" size={iconSize} />
            Call again
          </Link>
        )}
        <Link href={`/leads/${r.lead_id}`} className={buttonClass("secondary", size, phone && r.do_not_call ? "flex-1" : "")}>
          {phone ? "Open" : "Open lead"}
        </Link>
        {r.undoable && (
          <Button
            variant="ghost"
            size={size}
            loading={undoing === r.id}
            disabled={undoing !== null}
            onClick={() => void undo(r)}
            title="Undo within 30 minutes"
          >
            Undo
          </Button>
        )}
      </>
    );
  }

  const emptyState =
    activeFilters || leadId ? (
      <EmptyState
        icon="search"
        title="No calls match"
        message={
          leadId && !activeFilters
            ? "No calls with this person yet."
            : "Try a longer period or clear filters."
        }
        action={
          activeFilters ? (
            <Button variant="secondary" icon="x" onClick={clearAll}>
              Clear filters
            </Button>
          ) : undefined
        }
      />
    ) : (
      <EmptyState
        icon="phone"
        title={period === "today" ? "No calls yet today" : "No calls in this period"}
        message="Calls you log show here."
        action={
          <Link href="/calling/start" className={buttonClass("primary", "md")}>
            <Icon name="phoneOutgoing" size={15} />
            Start calling
          </Link>
        }
      />
    );

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title={title}
        subtitle="Calls you logged."
        actions={
          <>
            <Button icon="phone" onClick={() => setRangMe(true)}>
              Someone called me
            </Button>
            <ExportButton
              path="/api/crm/calls/export"
              params={filterQuery()}
              filename={teamView ? "team-calls" : "my-calls"}
              hint={totals ? `${number(totals.calls)} ${plural(totals.calls, "call", "calls")}` : undefined}
            />
          </>
        }
      />

      {/* On a phone only When and Find show until "Filters" is pressed, so the
          first call is above the fold. `contents` lets the same fields sit in
          one row on a desktop. */}
      <Toolbar activeCount={activeFilters} onClear={clearAll}>
        <Field label="When" className="w-full sm:w-44">
          <Select value={period} onChange={choosePeriod} ariaLabel="When" options={PERIODS} />
        </Field>
        {period === "custom" && (
          <>
            <Field label="From" htmlFor="calls-from" className="w-[calc(50%-0.3125rem)] sm:w-40">
              <Input
                id="calls-from"
                type="date"
                value={customFrom}
                max={customTo || istToday()}
                onChange={(e) => setParams({ period: "custom", from: e.target.value || null })}
              />
            </Field>
            <Field label="To" htmlFor="calls-to" className="w-[calc(50%-0.3125rem)] sm:w-40">
              <Input
                id="calls-to"
                type="date"
                value={customTo}
                min={customFrom || undefined}
                max={istToday()}
                onChange={(e) => setParams({ period: "custom", to: e.target.value || null })}
              />
            </Field>
          </>
        )}
        <Field label="Find" htmlFor="calls-search" className="w-full flex-1 md:order-last md:w-auto md:min-w-[15rem]">
          <div className="flex gap-2">
            <SearchInput
              id="calls-search"
              value={search}
              onChange={setSearch}
              placeholder="Name, mobile or note"
              className="flex-1"
            />
            <Button
              variant="secondary"
              icon="filter"
              className="md:hidden"
              aria-expanded={showFilters}
              onClick={() => setShowFilters((v) => !v)}
            >
              Filters
            </Button>
          </div>
        </Field>
        <div className={showFilters ? "contents" : "hidden md:contents"}>
          <Field label="Call result" className="w-full sm:w-48">
            <OutcomePicker
              options={outcomeOptions}
              value={outcomes}
              onChange={(next) => setParams({ disposition: next.length ? next.join(",") : null })}
            />
          </Field>
          <Field label="Answered" className="w-full sm:w-36">
            <Select
              value={connected}
              onChange={(v) => setParams({ connected: v || null })}
              ariaLabel="Answered"
              options={[
                { value: "", label: "Any" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ]}
            />
          </Field>
          <Field label="Who called" className="w-full sm:w-44">
            <Select
              value={direction}
              onChange={(v) => setParams({ direction: v || null })}
              ariaLabel="Who called"
              options={[
                { value: "", label: "Any" },
                { value: "outbound", label: "I called them" },
                { value: "inbound", label: "They called me" },
              ]}
            />
          </Field>
          {elevated && (
            <Field label="Caller" className="w-full sm:w-48">
              <Select
                value={userId}
                onChange={(v) => setParams({ user_id: v || null })}
                ariaLabel="Whose calls"
                options={callerOptions}
              />
            </Field>
          )}
        </div>
      </Toolbar>

      {leadId && (
        <div className="mb-4 flex">
          <span className="inline-flex max-w-full items-center gap-1 rounded-pill border border-brand-300 bg-brand-50 py-1 pl-3 pr-1 text-sm text-brand-800">
            <span className="truncate">
              Calls with <strong className="font-semibold">{leadLabel}</strong>
            </span>
            <button
              type="button"
              aria-label="Show all calls"
              onClick={() => setParams({ lead_id: null })}
              className="grid h-8 w-8 flex-none place-items-center rounded-full text-brand-700 transition-colors hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              <Icon name="x" size={14} />
            </button>
          </span>
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {/* ---------------------------------------------------- the numbers */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-6">
        <StatTile
          label="Calls"
          value={number(totals?.calls ?? 0)}
          loading={loading && !data}
          icon="phoneOutgoing"
          sub={periodLabel}
        />
        <StatTile
          label="Answered"
          value={number(totals?.connected ?? 0)}
          loading={loading && !data}
          accent="brand"
          sub={totals?.calls ? `${pct}% of calls` : undefined}
        />
        <StatTile
          label="People"
          value={number(totals?.people ?? 0)}
          loading={loading && !data}
          icon="users"
        />
        <StatTile
          label="They called me"
          value={number(totals?.inbound ?? 0)}
          loading={loading && !data}
          icon="phone"
        />
        <StatTile
          label="Gave after"
          value={number(totals?.gave_since ?? 0)}
          loading={loading && !data}
          accent="good"
          icon="rupee"
          sub="after a call"
        />
        {!!totals?.seconds && totals.seconds > 0 && (
          <StatTile label="Talk time" value={talkTime(totals.seconds)} icon="clock" />
        )}
      </div>

      {/* --------------------------------------------- outcome breakdown */}
      {totals && totals.by_outcome.length > 0 && (
        <Card className="mb-4" padded={false}>
          <div className="px-4 pb-1 pt-3.5">
            <h2 className="text-sm font-semibold text-ink">Call results</h2>
            <p className="text-xs text-ink-muted">Tap one to filter.</p>
          </div>
          <div className="grid gap-x-6 px-2 pb-2 sm:grid-cols-2 lg:grid-cols-3">
            {totals.by_outcome.map((o) => {
              const slug = o.disposition ?? "";
              const on = outcomes.length === 1 && outcomes[0] === slug;
              return (
                <button
                  key={slug || "none"}
                  type="button"
                  disabled={!slug}
                  aria-pressed={on}
                  onClick={() => setParams({ disposition: on ? null : slug })}
                  className={`rounded-control px-2 py-2 text-left transition-colors hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                    on ? "bg-brand-50" : ""
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-3 text-sm">
                    <span className={`truncate ${on ? "font-semibold text-brand-800" : "text-ink-soft"}`}>
                      {o.label || (slug ? slug.replace(/_/g, " ") : "No result")}
                    </span>
                    <span className="flex-none font-semibold tabular-nums text-ink">{number(o.n)}</span>
                  </span>
                  <span className="mt-1.5 block h-1.5 overflow-hidden rounded-pill bg-sunken">
                    <span
                      className={`block h-full rounded-pill ${connectedSlugs.has(slug) ? "bg-brand-500" : "bg-ink-faint/60"}`}
                      style={{ width: `${Math.max(4, (o.n / maxOutcome) * 100)}%` }}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------ phone cards */}
      <div className="md:hidden">
        {loading && !data ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} padded={false} className="p-4">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="mt-2 h-3 w-1/3" />
                <Skeleton className="mt-4 h-11 w-full" />
              </Card>
            ))}
          </div>
        ) : !rows.length ? (
          <Card padded={false}>{emptyState}</Card>
        ) : (
          <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
            {days.map((d) => (
              <section key={d.key}>
                <h3 className="mb-2 px-1 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
                  {dayHeading(d.key)}
                </h3>
                <div className="space-y-3">
                  {d.rows.map((r) => (
                    <Card key={r.id} padded={false} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink">{r.lead_name || "No name"}</p>
                          <p className="text-xs tabular-nums text-ink-muted">{formatPhone(r.lead_phone)}</p>
                        </div>
                        <div className="flex-none text-right">
                          <p className="text-sm font-medium tabular-nums text-ink">{clockTime(r.occurred_at)}</p>
                          {directionTag(r)}
                        </div>
                      </div>
                      <div className="mt-2.5">{outcomeBadge(r)}</div>
                      {r.note && <p className="mt-1.5 break-words text-sm text-ink-soft">{r.note}</p>}
                      {details(r)}
                      <div className="mt-2.5 border-t border-line-soft pt-2.5">
                        <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-faint">Now</p>
                        {since(r)}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">{actions(r, true)}</div>
                    </Card>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------ desktop table */}
      <div className="hidden md:block">
        <TableShell>
          <Thead>
            <Th className="w-24">Time</Th>
            <Th>Donor</Th>
            <Th>Call</Th>
            <Th>Now</Th>
            <Th align="right"> </Th>
          </Thead>
          {loading && !data ? (
            <SkeletonRows rows={6} cols={5} />
          ) : (
            <Tbody>
              {!rows.length ? (
                <tr>
                  <td colSpan={5}>{emptyState}</td>
                </tr>
              ) : (
                days.flatMap((d) => [
                  <tr key={`day-${d.key}`} className="bg-sunken/70">
                    <td colSpan={5} className="px-4 py-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
                      {dayHeading(d.key)}
                    </td>
                  </tr>,
                  ...d.rows.map((r) => (
                    <tr key={r.id} className={loading ? "opacity-60" : ""}>
                      <Td className="align-top">
                        <div className="font-medium tabular-nums text-ink">{clockTime(r.occurred_at)}</div>
                        <div className="mt-0.5">{directionTag(r)}</div>
                      </Td>
                      <Td className="align-top">
                        <div className="font-medium text-ink">{r.lead_name || "No name"}</div>
                        <div className="text-xs tabular-nums text-ink-muted">{formatPhone(r.lead_phone)}</div>
                      </Td>
                      <Td className="max-w-sm align-top">
                        {outcomeBadge(r)}
                        {r.note && <p className="mt-1 line-clamp-2 break-words text-sm text-ink-soft" title={r.note}>{r.note}</p>}
                        {details(r)}
                      </Td>
                      <Td className="align-top">{since(r)}</Td>
                      <Td align="right" className="align-top">
                        <div className="flex justify-end gap-1.5">{actions(r, false)}</div>
                      </Td>
                    </tr>
                  )),
                ])
              )}
            </Tbody>
          )}
        </TableShell>
      </div>

      {totals && totals.calls > LIMIT && (
        <div className="mt-3 overflow-hidden rounded-card border border-line-soft">
          <Pagination
            page={page}
            limit={LIMIT}
            total={totals.calls}
            totalPages={totalPages}
            onPage={(p) => setParams({ page: String(p) })}
            unit="calls"
          />
        </div>
      )}

      {rangMe && <RangMeDialog onClose={closeRangMe} back={here} />}
    </div>
  );
}
