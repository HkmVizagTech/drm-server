"use client";

// The devotee's day at a glance: what is due, how their leads stand, what they have raised, and
// one tap to add a lead or a brick record.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { currency, relativeDate } from "@/lib/format";
import { LEADS_CHANGED, STATUS, STATUS_ORDER, tileMoney, type DevoteeLead, type LeadActivity, type LeadStatus } from "@/lib/devotee";
import { Alert, Card, EmptyState, LinkButton, Skeleton, StatTile } from "@/components/ui";
import { Icon } from "@/components/icons";
import { LeadRow } from "@/components/devotee/lead-bits";
import { LogFollowUpDialog } from "@/components/devotee/log-follow-up";
import { ReminderCard } from "@/components/devotee/reminder-card";
import { CallRecordingCard } from "@/components/devotee/phone-recording";

interface Summary {
  total: number;
  overdue: number;
  due_today: number;
  upcoming_week: number;
  donors: number;
  donated_total: number;
  added_today: number;
  by_status: Partial<Record<LeadStatus, number>>;
  donated_this_month: number;
  gifts_this_month: number;
  follow_ups_done_today: number;
  due: DevoteeLead[];
  recent: LeadActivity[];
}

function greeting(): string {
  const h = Number(new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function DevoteeHomePage() {
  const { user } = useAuth();
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState<DevoteeLead | null>(null);

  const load = useCallback(() => {
    apiClient
      .get<Summary>("/api/devotee/summary")
      .then((r) => {
        setS(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(LEADS_CHANGED, load);
    return () => window.removeEventListener(LEADS_CHANGED, load);
  }, [load]);

  const dueNow = s ? s.overdue + s.due_today : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-ink-muted">{greeting()}, Hare Krishna</p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{user?.name?.split(" ")[0] ?? "Prabhu"}</h1>
        </div>
        {/* A phone: Add lead across the top, the other two side by side under it - never wider than the screen. */}
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
          <LinkButton href="/devotee/leads/new" variant="primary" icon="userPlus" className="col-span-2 justify-center sm:order-last">
            Add lead
          </LinkButton>
          <LinkButton href="/seva-wall/devotee" variant="secondary" icon="box" className="justify-center">
            Brick record
          </LinkButton>
          <LinkButton href="/devotee/receipts" variant="secondary" icon="receipt" className="justify-center">
            Receipts
          </LinkButton>
        </div>
      </div>

      <ReminderCard />
      <CallRecordingCard />
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Follow-ups due" value={dueNow} sub={s ? `${s.overdue} overdue · ${s.upcoming_week} this week` : undefined} accent={s?.overdue ? "danger" : "brand"} icon="bell" loading={!s} href="/devotee/follow-ups" />
        <StatTile label="My leads" value={s?.total ?? 0} sub={s ? `${s.added_today} added today` : undefined} icon="users" loading={!s} href="/devotee/leads" />
        <StatTile label="Raised this month" value={tileMoney(s?.donated_this_month ?? 0)} sub={s ? `${currency(s.donated_this_month)} · ${s.gifts_this_month} gift${s.gifts_this_month === 1 ? "" : "s"}` : undefined} accent="good" icon="rupee" loading={!s} />
        <StatTile label="Donors" value={s?.donors ?? 0} sub={s ? `${currency(s.donated_total)} in all` : undefined} icon="star" loading={!s} href="/devotee/leads?status=donated" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">Due now and today</h2>
            <Link href="/devotee/follow-ups" className="text-sm font-medium text-brand-700 hover:underline">
              All follow-ups
            </Link>
          </div>
          {!s ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-20 w-full" rounded="rounded-card" />
              ))}
            </div>
          ) : s.due.length === 0 ? (
            <Card>
              <EmptyState
                icon="checkCircle"
                title={s.total ? "Nothing due today" : "Add your first lead"}
                message={s.total ? "You are up to date. Follow-ups you set will show here on their day." : "Save the people you meet, and DRM will remind you when to follow up."}
                action={!s.total ? <LinkButton href="/devotee/leads/new" icon="userPlus">Add lead</LinkButton> : undefined}
              />
            </Card>
          ) : (
            <ul className="space-y-2">
              {s.due.map((l) => (
                <LeadRow key={l.id} lead={l} onLog={setLogging} />
              ))}
            </ul>
          )}
        </section>

        <aside className="space-y-5">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">Where your leads stand</h2>
            {!s ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <ul className="space-y-1.5">
                {STATUS_ORDER.map((st) => (
                  <li key={st}>
                    <Link href={`/devotee/leads?status=${st}`} className="flex items-center justify-between rounded-control px-2 py-1.5 text-sm hover:bg-sunken">
                      <span className="flex items-center gap-2 text-ink-soft">
                        <Icon name={STATUS[st].icon} size={15} />
                        {STATUS[st].label}
                      </span>
                      <span className="font-semibold tabular-nums text-ink">{s.by_status[st] ?? 0}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">Recent activity</h2>
            {!s ? (
              <Skeleton className="h-24 w-full" />
            ) : s.recent.length === 0 ? (
              <p className="text-sm text-ink-muted">Your follow-ups will appear here.</p>
            ) : (
              <ul className="space-y-2.5">
                {s.recent.map((a) => (
                  <li key={a.id} className="text-sm">
                    <Link href={`/devotee/leads/${a.lead_id}`} className="font-medium text-ink hover:underline">
                      {a.lead_name}
                    </Link>
                    <span className="text-ink-muted">
                      {" · "}
                      {a.outcome ? STATUS[a.outcome].label : "Note"}
                      {a.amount ? ` ${currency(a.amount)}` : ""}
                    </span>
                    <p className="text-xs text-ink-faint">{relativeDate(a.created_at)}</p>
                  </li>
                ))}
              </ul>
            )}
            {s && s.follow_ups_done_today > 0 && (
              <p className="mt-3 border-t border-line-soft pt-3 text-xs text-ink-muted">{s.follow_ups_done_today} follow-ups logged today.</p>
            )}
          </Card>
        </aside>
      </div>

      {logging && <LogFollowUpDialog lead={logging} onClose={() => setLogging(null)} />}
    </div>
  );
}
