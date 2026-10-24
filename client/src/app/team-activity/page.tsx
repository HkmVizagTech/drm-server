"use client";

// Team activity: what each telecaller actually did, day by day. Admin only.
//
// Everything on this page is read from what DRM already records when callers work - the call
// log, the phone app, follow-ups and money credited - so it is only as complete as callers'
// logging. A call nobody logs is not here, and talk time is only real when it came from the
// phone app; a duration a caller typed is shown separately, as typed.

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient, isAbort } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { clockTime, currency, istDayPlus, istToday, number, shortDate } from "@/lib/format";
import { ExportButton } from "@/components/export-button";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  Modal,
  PageHeader,
  SkeletonRows,
  StatTile,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
} from "@/components/ui";

interface Caller {
  id: string;
  name: string;
  role: string;
  last_login_at: string | null;
  calls: number;
  connected: number;
  unanswered: number;
  answered_pct: number | null;
  talk_real_seconds: number;
  talk_logged_seconds: number;
  first_call_at: string | null;
  last_call_at: string | null;
  active_minutes: number;
  idle_gaps: number;
  longest_gap_minutes: number;
  seva_wall_calls: number;
  inbound_calls: number;
  donors_reached: number;
  overdue_followups: number;
  due_today_followups: number;
  untouched_leads: number;
  raised: number;
  credits: number;
  links_sent: number;
  trend_7d: number[];
  status: "live" | "idle" | "not_started" | "before_hours" | null;
  minutes_since_last_call: number | null;
}

interface Overview {
  date: string;
  today: boolean;
  callers: Caller[];
  totals: {
    callers: number;
    working_now: number;
    not_started: number;
    calls: number;
    connected: number;
    talk_real_seconds: number;
    talk_logged_seconds: number;
    raised: number;
    overdue_followups: number;
    untouched_leads: number;
  };
}

interface Detail {
  caller: { id: string; name: string };
  date: string;
  timeline: {
    id: string;
    occurred_at: string;
    direction: string | null;
    outcome: string | null;
    disposition: string | null;
    connected: boolean | null;
    duration_seconds: number | null;
    source: string;
    note: string | null;
    recording_url: string | null;
    lead_id: string | null;
    donor_name: string | null;
    phone: string | null;
  }[];
  hourly: { hour: number; calls: number; connected: number }[];
  outcomes: { outcome: string; n: number }[];
  trend_14d: { date: string; calls: number; connected: number }[];
  sessions: { id: string; started_at: string; ended_at: string | null; calls_logged: number; connected: number }[];
}

/** 125 -> "2h 05m", 40 -> "40m". */
const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`);
const fromSeconds = (s: number) => minutes(Math.round(s / 60));

/** Seven small bars, oldest first, the last being the day shown. */
function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-7 items-end gap-0.5" aria-label={`Last 7 days: ${values.join(", ")}`}>
      {values.map((v, i) => (
        <span
          key={i}
          title={`${v} call${v === 1 ? "" : "s"}`}
          className={`w-1.5 rounded-sm ${i === values.length - 1 ? "bg-brand-600" : "bg-brand-300"}`}
          style={{ height: `${Math.max(8, Math.round((v / max) * 100))}%`, opacity: v ? 1 : 0.3 }}
        />
      ))}
    </div>
  );
}

function StatusChip({ c }: { c: Caller }) {
  switch (c.status) {
    case "live":
      return <Badge tone="good" dot>Calling now</Badge>;
    case "idle":
      return <Badge tone="warn" dot>Idle {minutes(c.minutes_since_last_call ?? 0)}</Badge>;
    case "not_started":
      return <Badge tone="danger" dot>Not started</Badge>;
    case "before_hours":
      return <Badge tone="neutral" dot>Before hours</Badge>;
    default:
      return null;
  }
}

export default function TeamActivityPage() {
  const { user } = useAuth();
  const [day, setDay] = useState(istToday());
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Caller | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setData(await apiClient.get<Overview>(`/api/crm/team-activity?date=${day}`, { signal }));
        setError(null);
      } catch (e) {
        if (isAbort(e)) return;
        setError((e as Error).message);
      }
    },
    [day]
  );

  useEffect(() => {
    setData(null);
    const c = new AbortController();
    void load(c.signal);
    // Today's page keeps itself fresh; a past day does not change.
    const t = day === istToday() ? setInterval(() => void load(), 60_000) : null;
    return () => {
      c.abort();
      if (t) clearInterval(t);
    };
  }, [load, day]);

  const rows = useMemo(() => [...(data?.callers ?? [])].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)), [data]);
  const isToday = day === istToday();

  if (user && user.role !== "admin") {
    return <EmptyState icon="shield" title="Admins only" message="This page shows every caller's activity and is for admins." />;
  }

  const t = data?.totals;
  const answeredPct = t && t.calls ? Math.round((t.connected / t.calls) * 100) : null;

  return (
    <div>
      <PageHeader
        title="Team activity"
        subtitle="What each caller did, from the call log. Every answered call counts, whether the caller rang the donor or the donor rang them, and every call to the same donor counts again. A call that is not logged in DRM is not counted, and talk time is real only for calls made through the phone app."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportButton path="/crm/team-activity/export" params={{ date: day }} filename={`team-activity-${day}`} />
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <IconButton name="chevronLeft" label="Previous day" variant="secondary" onClick={() => setDay(istDayPlus(-1, day))} />
        <Input type="date" value={day} max={istToday()} onChange={(e) => e.target.value && setDay(e.target.value)} className="w-44" />
        <IconButton name="chevronRight" label="Next day" variant="secondary" disabled={isToday} onClick={() => setDay(istDayPlus(1, day))} />
        {!isToday && (
          <Button variant="ghost" onClick={() => setDay(istToday())}>
            Today
          </Button>
        )}
        <span className="ml-1 text-sm text-ink-muted">{shortDate(day)}</span>
      </div>

      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={isToday ? "Calling now" : "Callers"}
          value={t ? (isToday ? `${t.working_now} of ${t.callers}` : t.callers) : "-"}
          sub={isToday && t ? `${t.not_started} not started yet` : undefined}
          accent={isToday && t && t.not_started > 0 ? "warn" : "brand"}
          icon="phone"
          loading={!t}
        />
        <StatTile
          label="Calls made"
          value={t ? number(t.calls) : "-"}
          icon="phoneOutgoing"
          loading={!t}
        />
        <StatTile
          label="Answered"
          value={t ? `${number(t.connected)}${answeredPct !== null ? ` (${answeredPct}%)` : ""}` : "-"}
          accent="good"
          icon="checkCircle"
          loading={!t}
        />
        <StatTile
          label="Talk time"
          value={t ? fromSeconds(t.talk_real_seconds) : "-"}
          sub={t && t.talk_logged_seconds ? `+ ${fromSeconds(t.talk_logged_seconds)} typed by callers` : "From the phone app"}
          icon="clock"
          loading={!t}
        />
        <StatTile label="Money credited" value={t ? currency(t.raised) : "-"} icon="rupee" accent="brand" loading={!t} />
        <StatTile
          label="Follow-ups overdue"
          value={t ? number(t.overdue_followups) : "-"}
          sub="Right now, not for the day chosen"
          accent={t && t.overdue_followups > 0 ? "danger" : "default"}
          icon="calendar"
          loading={!t}
        />
        <StatTile
          label="Leads never called"
          value={t ? number(t.untouched_leads) : "-"}
          sub="Assigned to callers, right now"
          accent={t && t.untouched_leads > 0 ? "warn" : "default"}
          icon="users"
          loading={!t}
        />
      </div>

      <TableShell>
        <Thead>
          <Th>Caller</Th>
          <Th>Calls</Th>
          <Th>Answered</Th>
          <Th>Talk time</Th>
          <Th>First - last call</Th>
          <Th>Active / breaks</Th>
          <Th align="right">Donors reached</Th>
          <Th align="right">Overdue</Th>
          <Th align="right">Never called</Th>
          <Th align="right">Credited</Th>
          <Th>7 days</Th>
        </Thead>
        {!data ? (
          <SkeletonRows rows={5} cols={11} />
        ) : (
          <Tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11}>
                  <EmptyState icon="users" title="No callers yet" message="Add callers in Team and their activity shows here." />
                </td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr key={c.id} className="cursor-pointer" onClick={() => setOpen(c)}>
                  <Td>
                    <span className="font-medium text-ink">{c.name}</span>
                    <span className="mt-1 block">
                      <StatusChip c={c} />
                    </span>
                  </Td>
                  <Td>
                    <span className="font-medium tabular-nums text-ink">{c.calls}</span>
                  </Td>
                  <Td>
                    <span className="font-medium tabular-nums text-ink">{c.connected}</span>
                    {c.answered_pct !== null && <span className="text-xs text-ink-muted"> ({c.answered_pct}%)</span>}
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {c.talk_real_seconds ? fromSeconds(c.talk_real_seconds) : <span className="text-ink-faint">-</span>}
                    {c.talk_logged_seconds > 0 && (
                      <span className="block text-xs text-ink-muted">+{fromSeconds(c.talk_logged_seconds)} typed</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {c.first_call_at ? (
                      <>
                        {clockTime(c.first_call_at)} - {clockTime(c.last_call_at)}
                      </>
                    ) : (
                      <span className="text-ink-faint">-</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {c.calls ? minutes(c.active_minutes) : <span className="text-ink-faint">-</span>}
                    {c.idle_gaps > 0 && (
                      <span className="block text-xs text-warn">
                        {c.idle_gaps} break{c.idle_gaps === 1 ? "" : "s"} over 30m (longest {minutes(c.longest_gap_minutes)})
                      </span>
                    )}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {c.donors_reached}
                  </Td>
                  <Td align="right" className={`tabular-nums ${c.overdue_followups ? "font-medium text-danger" : ""}`}>
                    {c.overdue_followups}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {c.untouched_leads}
                  </Td>
                  <Td align="right" className="whitespace-nowrap tabular-nums">
                    {c.raised ? currency(c.raised) : <span className="text-ink-faint">-</span>}
                  </Td>
                  <Td>
                    <Spark values={c.trend_7d} />
                  </Td>
                </tr>
              ))
            )}
          </Tbody>
        )}
      </TableShell>
      <p className="mt-3 text-xs text-ink-muted">
        Active time counts the gap between a caller's calls up to 10 minutes each; a longer gap is a break. Overdue and
        never-called are as of now, not the day chosen. Click a caller for their day, call by call.
      </p>

      {open && <CallerDay caller={open} day={day} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* ----------------------------------------------------------- one caller's day */

function CallerDay({ caller, day, onClose }: { caller: Caller; day: string; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    apiClient
      .get<Detail>(`/api/crm/team-activity/${caller.id}?date=${day}`, { signal: c.signal })
      .then(setD)
      .catch((e) => !isAbort(e) && setError((e as Error).message));
    return () => c.abort();
  }, [caller.id, day]);

  const maxHour = Math.max(1, ...(d?.hourly.map((h) => h.calls) ?? [1]));
  const maxDay = Math.max(1, ...(d?.trend_14d.map((x) => x.calls) ?? [1]));
  const hours = Array.from({ length: 13 }, (_, i) => i + 8); // 8:00 - 20:00

  return (
    <Modal title={`${caller.name} - ${shortDate(day)}`} onClose={onClose} wide>
      {error && (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone="brand">{caller.calls} call{caller.calls === 1 ? "" : "s"}</Badge>
        <Badge tone="good">{caller.connected} answered</Badge>
        {caller.talk_real_seconds > 0 && <Badge tone="neutral">Talk {fromSeconds(caller.talk_real_seconds)}</Badge>}
        {caller.inbound_calls > 0 && <Badge tone="neutral">{caller.inbound_calls} from donors</Badge>}
        {caller.seva_wall_calls > 0 && <Badge tone="neutral">{caller.seva_wall_calls} Seva wall</Badge>}
        {caller.last_login_at && <Badge tone="neutral">Last login {shortDate(caller.last_login_at)} {clockTime(caller.last_login_at)}</Badge>}
      </div>

      {!d ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <>
          <div className="mb-5 grid gap-5 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-muted">Calls by hour</h3>
              <div className="flex h-24 items-end gap-1">
                {hours.map((h) => {
                  const row = d.hourly.find((x) => x.hour === h);
                  const n = row?.calls ?? 0;
                  return (
                    <div key={h} className="flex flex-1 flex-col items-center gap-1" title={`${h}:00 - ${n} call${n === 1 ? "" : "s"}, ${row?.connected ?? 0} answered`}>
                      <div className="flex h-16 w-full items-end">
                        <div className={`w-full rounded-t ${n ? "bg-brand-500" : "bg-sunken"}`} style={{ height: `${n ? Math.max(8, (n / maxHour) * 100) : 4}%` }} />
                      </div>
                      <span className="text-2xs text-ink-faint">{h}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-muted">Last 14 days</h3>
              <div className="flex h-24 items-end gap-1">
                {d.trend_14d.map((x) => (
                  <div key={x.date} className="flex flex-1 flex-col items-center gap-1" title={`${shortDate(x.date)}: ${x.calls} calls, ${x.connected} answered`}>
                    <div className="flex h-16 w-full items-end">
                      <div
                        className={`w-full rounded-t ${x.date === day ? "bg-brand-700" : "bg-brand-300"}`}
                        style={{ height: `${x.calls ? Math.max(8, (x.calls / maxDay) * 100) : 4}%`, opacity: x.calls ? 1 : 0.35 }}
                      />
                    </div>
                    <span className="text-2xs text-ink-faint">{Number(x.date.slice(8))}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {d.outcomes.length > 0 && (
            <div className="mb-5 flex flex-wrap gap-2">
              {d.outcomes.map((o) => (
                <Badge key={o.outcome} tone="neutral">
                  {o.outcome}: {o.n}
                </Badge>
              ))}
            </div>
          )}

          {d.sessions.length > 0 && (
            <p className="mb-4 text-sm text-ink-muted">
              Calling runs:{" "}
              {d.sessions
                .map((s) => `${clockTime(s.started_at)}${s.ended_at ? ` - ${clockTime(s.ended_at)}` : " (not finished)"} (${s.calls_logged} calls)`)
                .join(", ")}
            </p>
          )}

          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-muted">Every call, newest first</h3>
          {d.timeline.length === 0 ? (
            <p className="text-sm text-ink-muted">No calls logged this day.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-control ring-1 ring-line-soft">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-sunken text-left text-2xs uppercase tracking-[0.06em] text-ink-muted">
                  <tr>
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Donor</th>
                    <th className="px-3 py-2">Outcome</th>
                    <th className="px-3 py-2">Length</th>
                    <th className="px-3 py-2">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {d.timeline.map((x) => (
                    <tr key={x.id}>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{clockTime(x.occurred_at)}</td>
                      <td className="px-3 py-2">
                        {x.donor_name || "-"}
                        {x.phone && <span className="block text-xs text-ink-muted">{x.phone}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={x.connected ? "good" : "warn"}>{x.outcome ?? x.disposition ?? "-"}</Badge>
                        {x.direction === "inbound" && <span className="ml-1 text-xs text-ink-muted">incoming</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                        {x.duration_seconds ? fromSeconds(x.duration_seconds) : "-"}
                        <span className="block text-xs text-ink-muted">{x.source === "manual" ? "typed" : "phone app"}</span>
                        {x.recording_url && (
                          <a href={x.recording_url} target="_blank" rel="noreferrer" className="text-xs text-brand-700 underline">
                            Recording
                          </a>
                        )}
                      </td>
                      <td className="max-w-xs px-3 py-2 text-ink-soft">{x.note || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
