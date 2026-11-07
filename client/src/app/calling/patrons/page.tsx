"use client";

// People who asked to become a patron on the temple site.
//
// Each request is already a lead (see server routes/crmPatron.ts), so this
// screen only has to do three things: show who is waiting, make "Call" open the
// ordinary call screen (where the outcome, status, reminder and the phone
// app's recording all attach to the lead), and show how far each one has got.
// Nothing about calling is re-implemented here.
//
// LAID OUT LIKE SANKALPAM'S DAY BOARD
// The day's work first, coloured by how much it needs doing: overdue (red),
// new and due today (amber), then the evening retry (rung this morning, no
// answer - held until the evening), then later. The sidebar carries the same
// "needs a call now" count.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSessionState } from "@/lib/session-state";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { callHref, formatPhone } from "@/lib/calling";
import { clockTime, currency, dateTime, number, relativeDate } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Card,
  DropdownMenu,
  EmptyState,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Skeleton,
  StatTile,
} from "@/components/ui";
import { toast } from "@/components/toast";
import { useCallingAlerts } from "@/components/calling-alerts";
import { CALL_EDGE, CallStateChip, callState } from "@/components/calling/call-state";

interface Row {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  message: string | null;
  requested_at: string;
  lead_id: string | null;
  dismissed_at: string | null;
  lead_status: string | null;
  lead_status_label: string | null;
  lead_status_open: boolean | null;
  lead_assigned_to: string | null;
  assigned_to_name: string | null;
  lead_owner_calls: boolean | null;
  lead_do_not_call: boolean | null;
  lead_last_outcome_label: string | null;
  lead_last_contacted_at: string | null;
  lead_call_attempts: number | null;
  lead_next_follow_up_at: string | null;
  lead_converted_at: string | null;
  lead_converted_amount: string | null;
  bucket: Bucket;
  lead_retry_hold_until: string | null;
}

type Bucket = "new" | "overdue" | "today" | "evening" | "later" | "waiting" | "done";

interface Answer {
  rows: Row[];
  counts: Record<Bucket | "all", number>;
  sync: { last_synced_at: string | null; last_error: string | null };
}

export default function PatronsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const elevated = user?.role === "admin";

  const [view, setViewRaw] = useSessionState<"open" | "set_aside">("patrons:view", "open");
  const [mine, setMineRaw] = useSessionState("patrons:mine", false);
  const [search, setSearchRaw] = useSessionState("patrons:search", "");
  const setView = setViewRaw;
  const setMine = setMineRaw;
  const setSearch = setSearchRaw;
  const { refresh: refreshBadges } = useCallingAlerts();
  const [data, setData] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    const p = new URLSearchParams({ view });
    if (mine) p.set("mine", "true");
    if (search.trim()) p.set("search", search.trim());
    setLoading(true);
    apiClient
      .get<Answer>(`/api/crm/patrons?${p.toString()}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message || "Could not load patron requests."))
      .finally(() => setLoading(false));
  }, [view, mine, search]);

  // Typing in search should not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  async function refreshNow() {
    setRefreshing(true);
    try {
      const r = await apiClient.post<{ seen: number }>("/api/crm/patrons/refresh", {});
      toast(`Updated · ${number(r.seen)} request${r.seen === 1 ? "" : "s"} from the website`);
      load();
      void refreshBadges();
    } catch (e) {
      toast((e as Error).message || "Could not reach the website.");
    } finally {
      setRefreshing(false);
    }
  }

  async function callRow(r: Row) {
    setBusy(r.id);
    try {
      const res = await apiClient.post<{ lead_id: string }>(`/api/crm/patrons/${r.id}/claim`, {});
      router.push(callHref(res.lead_id, "/calling/patrons"));
    } catch (e) {
      toast((e as Error).message || "Could not open this patron.");
      setBusy(null);
    }
  }

  async function setAside(r: Row, restore: boolean) {
    setBusy(r.id);
    try {
      await apiClient.post(`/api/crm/patrons/${r.id}/${restore ? "restore" : "dismiss"}`, {});
      load();
    } catch (e) {
      toast((e as Error).message || "Could not update.");
    } finally {
      setBusy(null);
    }
  }

  const counts = data?.counts;

  function canCall(r: Row) {
    if (r.lead_do_not_call) return false;
    if (!r.lead_assigned_to || r.lead_assigned_to === user?.id) return true;
    // An admin can take over; a caller only what an admin is merely holding.
    return elevated || r.lead_owner_calls === false;
  }

  /** One line saying why this person is where they are on the board. */
  function why(r: Row): { text: string; tone: "danger" | "warn" | "info" | null } {
    switch (r.bucket) {
      case "new":
        return { text: "New request - nobody has rung yet", tone: "warn" };
      case "overdue":
        return { text: `Call back was due ${relativeDate(r.lead_next_follow_up_at).toLowerCase()}`, tone: "danger" };
      case "today":
        return { text: "Call back due today", tone: "warn" };
      case "evening":
        return {
          text: `Did not pick up this morning - ring again this evening${r.lead_retry_hold_until ? ` from ${clockTime(r.lead_retry_hold_until)}` : ""}`,
          tone: "info",
        };
      case "later":
        return { text: `Call back ${relativeDate(r.lead_next_follow_up_at).toLowerCase()}`, tone: "info" };
      default:
        return { text: "", tone: null };
    }
  }

  function renderRow(r: Row) {
    const cs = callState({
      converted_at: r.lead_converted_at,
      do_not_call: r.lead_do_not_call,
      status_is_open: r.lead_status_open,
      status_label: r.lead_status_label,
      next_follow_up_at: r.lead_next_follow_up_at,
      last_contacted_at: r.lead_last_contacted_at,
      last_outcome_label: r.lead_last_outcome_label,
    });
    const place = [r.city, r.state].filter(Boolean).join(", ");
    const calls = Number(r.lead_call_attempts ?? 0);
    const w = why(r);
    const tint = r.bucket === "overdue" ? "bg-red-50/60" : r.bucket === "new" || r.bucket === "today" ? "bg-amber-50/60" : "";
    return (
      <li key={r.id} className={`border-l-[3px] px-4 py-3 sm:px-5 ${CALL_EDGE[cs.tone]} ${tint}`}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-medium text-ink">{r.name || "No name"}</span>
              <span className="text-sm tabular-nums text-ink-muted">{formatPhone(r.phone)}</span>
              {r.bucket === "new" && <Badge tone="warn" dot>New</Badge>}
              {r.bucket !== "new" && <CallStateChip state={cs} />}
              {r.lead_status_label && r.lead_status !== "new" && <Badge tone="neutral">{r.lead_status_label}</Badge>}
            </div>
            {w.text && (
              <p className={`mt-0.5 text-sm font-medium ${w.tone === "danger" ? "text-danger" : w.tone === "warn" ? "text-warn" : "text-info"}`}>
                {w.text}
              </p>
            )}
            <p className="mt-0.5 text-sm text-ink-soft">
              Asked {relativeDate(r.requested_at).toLowerCase()}
              {place ? ` · ${place}` : ""}
              {r.email ? ` · ${r.email}` : ""}
            </p>
            {r.message && (
              <p className="mt-1 line-clamp-2 rounded-control bg-sunken px-2.5 py-1.5 text-sm italic text-ink-soft">
                &ldquo;{r.message}&rdquo;
              </p>
            )}
            <p className="mt-1 text-xs text-ink-muted">
              {calls > 0
                ? `${calls} call${calls === 1 ? "" : "s"}${r.lead_last_outcome_label ? ` · last: ${r.lead_last_outcome_label}` : ""}${
                    r.lead_last_contacted_at ? ` · ${dateTime(r.lead_last_contacted_at)}` : ""
                  }`
                : r.lead_last_contacted_at && r.bucket !== "new"
                ? `Rung ${relativeDate(r.lead_last_contacted_at).toLowerCase()}${r.lead_last_outcome_label ? ` · ${r.lead_last_outcome_label}` : ""}`
                : "Not called yet"}
              {r.assigned_to_name ? ` · with ${r.assigned_to_name}` : " · unassigned"}
              {r.lead_converted_amount ? ` · ${currency(Number(r.lead_converted_amount))} given` : ""}
            </p>
          </div>
          <div className="flex flex-none items-center gap-1">
            {view === "set_aside" ? (
              <Button variant="secondary" size="sm" icon="refresh" loading={busy === r.id} onClick={() => void setAside(r, true)}>
                Bring back
              </Button>
            ) : r.lead_do_not_call ? (
              <Badge tone="danger" icon="xCircle">Do not call</Badge>
            ) : !canCall(r) ? (
              <Badge tone="info" icon="user">{r.assigned_to_name ? `${r.assigned_to_name}'s` : "Taken"}</Badge>
            ) : (
              <>
                <Button size="sm" icon="phone" loading={busy === r.id} onClick={() => void callRow(r)}>
                  Call
                </Button>
                <DropdownMenu
                  trigger={({ toggle, open }) => (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="more"
                      aria-label={`More for ${r.name || r.phone}`}
                      aria-expanded={open}
                      disabled={busy === r.id}
                      onClick={toggle}
                    />
                  )}
                  items={[
                    ...(r.lead_id
                      ? [{ label: "Open lead", icon: "user" as const, onSelect: () => router.push(`/leads/${r.lead_id}`) }]
                      : []),
                    { label: "Set aside", icon: "inbox" as const, hint: "Hide from this list", onSelect: () => void setAside(r, false) },
                  ]}
                />
              </>
            )}
          </div>
        </div>
      </li>
    );
  }

  const rows = data?.rows ?? [];
  const inBucket = (...b: Bucket[]) => rows.filter((r) => b.includes(r.bucket));
  const overdue = inBucket("overdue");
  const fresh = inBucket("new");
  const today = inBucket("today");
  const evening = inBucket("evening");
  const later = inBucket("later");
  const waiting = inBucket("waiting");
  const done = inBucket("done");
  const needNow = (counts?.new ?? 0) + (counts?.overdue ?? 0) + (counts?.today ?? 0);

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="Patron requests"
        subtitle="People who asked on the website to become a patron. Ring them, help them, and record what was said."
        actions={
          <Button variant="secondary" icon="refresh" loading={refreshing} onClick={() => void refreshNow()}>
            Refresh
          </Button>
        }
      />

      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
      {data?.sync.last_error && (
        <Alert tone="warn" className="mb-4">
          Could not reach the website just now ({data.sync.last_error}). Showing what was fetched {relativeDate(data.sync.last_synced_at).toLowerCase()}.
        </Alert>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Name, mobile or city" className="min-w-[14rem] flex-1" />
        <SegmentedControl
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: "open", label: "To call" },
            { value: "set_aside", label: "Set aside" },
          ]}
        />
        <SegmentedControl
          size="sm"
          value={mine ? "mine" : "all"}
          onChange={(v) => setMine(v === "mine")}
          options={[
            { value: "all", label: "Everyone's" },
            { value: "mine", label: "Mine" },
          ]}
        />
      </div>

      {loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} padded={false} className="p-4">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="mt-2 h-3 w-1/3" />
            </Card>
          ))}
        </div>
      ) : view === "set_aside" ? (
        <Card padded={false} className="overflow-hidden">
          {rows.length ? (
            <ul className="divide-y divide-line-soft">{rows.map(renderRow)}</ul>
          ) : (
            <EmptyState icon="inbox" title="Nothing set aside" message="Requests you set aside show here." />
          )}
        </Card>
      ) : !rows.length ? (
        <Card padded={false}>
          <EmptyState
            icon="inbox"
            title="No patron requests here"
            message="When someone fills in Become a Patron on the website, they appear here within a minute."
          />
        </Card>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="To call now"
              value={number(needNow)}
              sub={needNow ? "New, overdue or due today" : "All caught up"}
              icon="phone"
              accent={needNow ? "warn" : "good"}
            />
            <StatTile label="Overdue" value={number(counts?.overdue ?? 0)} sub="Call back missed" icon="alert" accent={counts?.overdue ? "danger" : "default"} />
            <StatTile label="Evening retry" value={number(counts?.evening ?? 0)} sub="No answer this morning" icon="clock" accent="brand" />
            <StatTile label="Coming up" value={number(counts?.later ?? 0)} sub="Call back booked" icon="calendar" />
          </div>

          {overdue.length > 0 && (
            <Board title="Overdue" subtitle="A call back was promised and is late - ring these first." tone="danger" count={overdue.length}>
              {overdue.map(renderRow)}
            </Board>
          )}
          {(fresh.length > 0 || today.length > 0) && (
            <Board
              title="Call today"
              subtitle="New requests, and call backs due today."
              tone="warn"
              count={fresh.length + today.length}
            >
              {[...fresh, ...today].map(renderRow)}
            </Board>
          )}
          {evening.length > 0 && (
            <Board title="Ring again this evening" subtitle="Did not pick up this morning. They come back to you from 4 PM." count={evening.length}>
              {evening.map(renderRow)}
            </Board>
          )}
          {later.length > 0 && (
            <Board title="Coming up" subtitle="Not picked up, or asked to be called later - a call back is booked." count={later.length}>
              {later.map(renderRow)}
            </Board>
          )}
          {waiting.length > 0 && (
            <Board title="Rung, nothing booked" subtitle="Spoken to, no next call set." count={waiting.length}>
              {waiting.map(renderRow)}
            </Board>
          )}
          {done.length > 0 && (
            <Board title="Done" subtitle="Became a patron, closed, or asked not to be called." tone="good" count={done.length}>
              {done.map(renderRow)}
            </Board>
          )}
        </div>
      )}
    </div>
  );
}

/** One coloured band of the board - the same shape as Sankalpam's sections. */
function Board({
  title,
  subtitle,
  tone,
  count,
  children,
}: {
  title: string;
  subtitle?: string;
  tone?: "danger" | "warn" | "good";
  count?: number;
  children: ReactNode;
}) {
  const border = tone === "danger" ? "border-red-200" : tone === "warn" ? "border-amber-200" : "border-line-soft";
  const dot = tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : tone === "good" ? "bg-good" : "bg-brand-500";
  return (
    <Card padded={false} className={`overflow-hidden ${border}`}>
      <div className="flex items-center gap-2.5 px-4 py-3.5 sm:px-5">
        <span className={`h-2.5 w-2.5 flex-none rounded-full ${dot}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">
            {title}
            {count ? <span className="ml-1.5 font-normal text-ink-muted">· {number(count)}</span> : null}
          </h2>
          {subtitle && <p className="text-xs text-ink-muted">{subtitle}</p>}
        </div>
      </div>
      <ul className="divide-y divide-line-soft border-t border-line-soft">{children}</ul>
    </Card>
  );
}
