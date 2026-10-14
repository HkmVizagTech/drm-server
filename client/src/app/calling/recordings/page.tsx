"use client";

// Calls and recordings - every call the DRM app saw on the callers' phones.
//
// For a caller: their own calls, and the recording of each, in one place -
// "did that call get recorded?" answered without opening every lead.
// For an admin, who does not make calls: the team's calls, filtered by caller,
// and from here into any one call (/calling/recordings/[id]).
//
// The filters live in the URL, so the overview's tiles open this list already
// narrowed, and Back from a call returns to the same view.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { istDateKey, istDayPlus, istToday, number } from "@/lib/format";
import { dayHeading, talk, type PhoneCallRow, type PhoneCallTotals } from "@/lib/phone-calls";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Pagination,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
  StatTile,
  Toolbar,
} from "@/components/ui";
import { PhoneCallItem } from "@/components/calls/phone-call-item";

type Period = "today" | "week" | "month" | "all" | "custom";

const PERIODS: { value: Exclude<Period, "custom">; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "7 days" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

const LIMIT = 50;

function rangeOf(period: Period, from: string, to: string): { from: string; to: string } {
  const today = istToday();
  if (period === "today") return { from: today, to: today };
  if (period === "week") return { from: istDayPlus(-6), to: today };
  if (period === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (period === "custom") return { from, to };
  return { from: "", to: "" };
}

export default function RecordingsPage() {
  return (
    <Suspense fallback={null}>
      <Recordings />
    </Suspense>
  );
}

function Recordings() {
  const sp = useSearchParams();
  const router = useRouter();
  const { user } = useAuth();
  const reviewer = user?.role === "admin" || user?.role === "volunteer_coordinator";

  const param = (k: string) => sp.get(k) ?? "";
  const customFrom = param("from");
  const customTo = param("to");
  const asked = param("period") as Period;
  const period: Period = PERIODS.some((p) => p.value === asked)
    ? asked
    : customFrom || customTo
      ? "custom"
      : "week";
  const range = rangeOf(period, customFrom, customTo);
  const direction = param("direction");
  const recording = param("recording");
  const userId = reviewer ? param("user_id") : "";
  const urlSearch = param("search");
  const page = Math.max(1, Number(param("page")) || 1);

  const setParams = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!("page" in updates)) next.delete("page");
      const qs = next.toString();
      router.replace(qs ? `/calling/recordings?${qs}` : "/calling/recordings", { scroll: false });
    },
    [sp, router]
  );

  // The search box, pushed to the URL after a pause.
  const [search, setSearch] = useState(urlSearch);
  useEffect(() => {
    const v = search.trim();
    if (v === urlSearch) return;
    const t = setTimeout(() => setParams({ search: v || null }), 300);
    return () => clearTimeout(t);
  }, [search, urlSearch, setParams]);

  // On a phone the selects sit behind a Filters button, so the calls are
  // on the first screen rather than below four form fields.
  const [showFilters, setShowFilters] = useState(false);

  const [users, setUsers] = useState<{ id: string; name: string; role: string }[]>([]);
  useEffect(() => {
    if (!reviewer) return;
    apiClient
      .get<{ users: { id: string; name: string; role: string }[] }>("/api/crm/config")
      .then((c) => setUsers(c.users ?? []))
      .catch(() => undefined);
  }, [reviewer]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (range.from) p.set("from", range.from);
    if (range.to) p.set("to", range.to);
    if (direction) p.set("direction", direction);
    if (recording) p.set("recording", recording);
    if (userId) p.set("user_id", userId);
    if (urlSearch) p.set("search", urlSearch);
    p.set("page", String(page));
    p.set("limit", String(LIMIT));
    return p.toString();
  }, [range.from, range.to, direction, recording, userId, urlSearch, page]);

  const [data, setData] = useState<{ calls: PhoneCallRow[]; totals: PhoneCallTotals } | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ calls: PhoneCallRow[]; totals: PhoneCallTotals }>(`/api/app/calls?${query}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
        setLoadedFor(query);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load. Try again.");
        setLoadedFor(query);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);
  const loading = loadedFor !== query;

  const t = data?.totals;
  const days = useMemo(() => {
    const out: { key: string; rows: PhoneCallRow[] }[] = [];
    for (const r of data?.calls ?? []) {
      const k = istDateKey(r.started_at);
      const last = out[out.length - 1];
      if (last && last.key === k) last.rows.push(r);
      else out.push({ key: k, rows: [r] });
    }
    return out;
  }, [data]);
  const today = istToday();
  const yesterday = istDayPlus(-1);

  // A tile opens the same list narrowed to what it counts.
  const tileHref = (extra: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const k of ["direction", "recording", "page"]) next.delete(k);
    for (const [k, v] of Object.entries(extra)) if (v) next.set(k, v);
    return `/calling/recordings?${next}`;
  };

  const filtered = !!(direction || recording || urlSearch || userId);

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title={reviewer ? "Calls and recordings" : "My calls and recordings"}
        subtitle={
          reviewer
            ? "Every call the DRM app saw on the callers' phones. Open one to hear it."
            : "Every call your phone made or took with a donor. Open one to hear it."
        }
      />

      <Toolbar>
        <Field label="Period">
          <SegmentedControl
            className="flex-wrap"
            options={PERIODS}
            value={period === "custom" ? ("" as Exclude<Period, "custom">) : period}
            onChange={(v) => setParams({ period: v === "week" ? null : v, from: null, to: null })}
          />
        </Field>
        <Field label="Find" htmlFor="rec-search" className="basis-full md:order-last md:min-w-[14rem] md:flex-1 md:basis-auto">
          <div className="flex gap-2">
            <SearchInput id="rec-search" value={search} onChange={setSearch} placeholder="Donor name or number" className="flex-1" />
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
        <div className={showFilters || filtered ? "contents" : "hidden md:contents"}>
        {reviewer && (
          <Field label="Caller" className="w-full sm:w-48">
            <Select
              value={userId}
              onChange={(v) => setParams({ user_id: v || null })}
              ariaLabel="Caller"
              options={[
                { value: "", label: "Everyone" },
                ...users.filter((u) => u.role === "caller" || u.role === "admin").map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
          </Field>
        )}
        <Field label="Calls" className="w-full sm:w-44">
          <Select
            value={direction}
            onChange={(v) => setParams({ direction: v || null })}
            ariaLabel="Which calls"
            options={[
              { value: "", label: "All calls" },
              { value: "outbound", label: "Called them" },
              { value: "inbound", label: "They rang back" },
              { value: "missed", label: "Missed their call" },
            ]}
          />
        </Field>
        <Field label="Recording" className="w-full sm:w-44">
          <Select
            value={recording}
            onChange={(v) => setParams({ recording: v || null })}
            ariaLabel="Recording"
            options={[
              { value: "", label: "Any" },
              { value: "uploaded", label: "Recorded" },
              { value: "none", label: "No recording found" },
              { value: "waiting", label: "On its way" },
            ]}
          />
        </Field>
        </div>
      </Toolbar>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Calls made"
          value={number(t?.outbound ?? 0)}
          sub={t ? `${number(t.answered_out)} answered` : undefined}
          icon="phoneOutgoing"
          loading={loading && !data}
          href={tileHref({ direction: "outbound" })}
        />
        <StatTile
          label="They rang back"
          value={number(t?.inbound ?? 0)}
          sub={t ? `${number(t.missed)} missed` : undefined}
          icon="phoneIncoming"
          loading={loading && !data}
          href={tileHref({ direction: t && t.missed > 0 ? "missed" : "inbound" })}
        />
        <StatTile
          label="Talk time"
          value={talk(t?.talk_seconds ?? 0)}
          sub={t && t.spoke ? `avg ${talk(t.talk_seconds / t.spoke)} a call` : undefined}
          icon="clock"
          loading={loading && !data}
        />
        <StatTile
          label="Recorded"
          value={t ? `${number(t.recorded)} of ${number(t.spoke)}` : "0"}
          sub={
            t
              ? t.no_recording > 0
                ? `${number(t.no_recording)} not found on the phone`
                : t.waiting > 0
                  ? `${number(t.waiting)} on the way`
                  : "calls where someone spoke"
              : undefined
          }
          accent={t && t.no_recording > 0 ? "warn" : "brand"}
          icon="mic"
          loading={loading && !data}
          href={tileHref({ recording: t && t.no_recording > 0 ? "none" : "uploaded" })}
        />
      </div>

      {loading && !data ? (
        <Skeleton className="h-64" />
      ) : !days.length ? (
        <Card>
          <EmptyState
            icon="mic"
            title={filtered ? "No calls match" : "No calls yet"}
            message={
              filtered
                ? "Try another filter or a longer period."
                : reviewer
                  ? "Calls appear here once a caller uses the DRM app on their phone."
                  : "Calls you make or take with the DRM app on your phone appear here, with their recordings."
            }
          />
        </Card>
      ) : (
        <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
          {days.map((d) => (
            <Card key={d.key} padded={false}>
              <h2 className="border-b border-line-soft px-4 py-2.5 text-sm font-semibold text-ink sm:px-5">
                {dayHeading(d.key, today, yesterday)}
                <span className="ml-2 font-normal text-ink-muted">
                  {d.rows.length} call{d.rows.length === 1 ? "" : "s"}
                </span>
              </h2>
              <ul className="divide-y divide-line-soft px-4 sm:px-5">
                {d.rows.map((c) => (
                  <PhoneCallItem key={c.id} call={c} showCaller={reviewer} timeOnly />
                ))}
              </ul>
            </Card>
          ))}
          {t && t.calls > LIMIT && (
            <Pagination
              page={page}
              limit={LIMIT}
              total={t.calls}
              totalPages={Math.ceil(t.calls / LIMIT)}
              onPage={(p) => setParams({ page: p > 1 ? String(p) : null })}
              unit="calls"
            />
          )}
        </div>
      )}
    </div>
  );
}
