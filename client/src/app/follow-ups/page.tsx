"use client";

// Follow-ups - the promises the temple has made.
//
// Every row here is somebody who was told they would be rung back. That is why
// overdue comes first and is the loudest thing on the screen: a missed callback
// is not an admin tidiness problem, it is a donor who was told something that
// turned out not to be true.
//
// Three buckets, in the order they matter: overdue, today, then the week ahead.
// Each row can be acted on without leaving the page - ring it, push it, or drop
// it - because a board that forces a detour to the lead screen for every line
// stops being worked after the first twenty.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { currency, dueLabel, number, shortDate } from "@/lib/format";
import { Badge, Card, CardHeader, EmptyState, PageHeader, buttonPrimary, buttonSecondary } from "@/components/ui";

interface Lead {
  id: string;
  phone: string;
  name: string | null;
  city: string | null;
  status_label: string | null;
  next_follow_up_at: string | null;
  follow_up_note: string | null;
  remarks: string | null;
  call_attempts: number;
  expected_amount: string | null;
  assigned_to_name: string | null;
  total_donated: string | null;
  donation_count: number | null;
}

interface Bucket {
  key: string;
  title: string;
  caption: string;
  query: string;
  tone: "danger" | "warn" | "neutral";
}

const BUCKETS: Bucket[] = [
  {
    key: "overdue",
    title: "Overdue",
    caption: "Promised a call that hasn't happened",
    query: "due=overdue",
    tone: "danger",
  },
  {
    key: "today",
    title: "Due today",
    caption: "Booked for today",
    query: "due=today_only",
    tone: "warn",
  },
  {
    key: "upcoming",
    title: "Coming up",
    caption: "Booked for later — nothing to do yet",
    query: "due=upcoming",
    tone: "neutral",
  },
];

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

export default function FollowUpsPage() {
  const [data, setData] = useState<Record<string, Lead[]>>({});
  const [loading, setLoading] = useState(true);
  const [mineOnly, setMineOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Who is signed in, so "just mine" can filter without asking. Comes from the
  // auth context rather than localStorage: the context is the one place that
  // knows whether the session is still valid.
  const { user } = useAuth();
  const me = user?.id ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const results = await Promise.all(
        BUCKETS.map((b) =>
          apiClient.get<{ leads: Lead[] }>(
            `/api/crm/leads?${b.query}&sort=due&limit=100${mineOnly && me ? `&assigned_to=${me}` : ""}`
          )
        )
      );
      setData(Object.fromEntries(BUCKETS.map((b, i) => [b.key, results[i].leads])));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load follow-ups");
    } finally {
      setLoading(false);
    }
  }, [mineOnly, me]);

  useEffect(() => {
    void load();
  }, [load]);

  async function push(id: string, days: number) {
    await apiClient.post(`/api/crm/leads/${id}/follow-up`, { at: inDays(days) });
    await load();
  }

  async function drop(id: string) {
    await apiClient.put(`/api/crm/leads/${id}`, { next_follow_up_at: null });
    await load();
  }

  const overdueCount = data.overdue?.length ?? 0;

  return (
    <div>
      <PageHeader
        title="Follow-ups"
        subtitle="Calls the temple said it would make"
        actions={
          <div className="flex gap-2">
            <button
              onClick={() => setMineOnly((v) => !v)}
              className={mineOnly ? buttonPrimary : buttonSecondary}
              disabled={!me}
            >
              {mineOnly ? "Showing just mine" : "Just mine"}
            </button>
            <Link href="/calling/queue" className={buttonPrimary}>
              Start calling
            </Link>
          </div>
        }
      />

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {!loading && overdueCount === 0 && (
        <Card className="mb-5 border-emerald-200 bg-emerald-50/60">
          <p className="text-sm font-medium text-emerald-900">Nothing is overdue.</p>
          <p className="text-xs text-emerald-800 mt-0.5">Every callback that was promised has either happened or is still in the future.</p>
        </Card>
      )}

      <div className="space-y-6">
        {BUCKETS.map((b) => {
          const rows = data[b.key] ?? [];
          return (
            <Card key={b.key} padded={false}>
              <div className="px-5 pt-5">
                <CardHeader
                  title={`${b.title}${rows.length ? ` · ${number(rows.length)}` : ""}`}
                  subtitle={b.caption}
                />
              </div>

              {loading ? (
                <div className="px-5 pb-5 space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-12 rounded-lg bg-slate-100 animate-pulse" />
                  ))}
                </div>
              ) : !rows.length ? (
                <div className="px-5 pb-5">
                  <p className="text-sm text-slate-500">Nothing here.</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 border-t border-[var(--line-soft)]">
                  {rows.map((l) => (
                    <li key={l.id} className="px-5 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 hover:bg-slate-50/60">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={`/leads/${l.id}`} className="font-medium text-slate-900 hover:text-[var(--accent)] truncate">
                            {l.name || l.phone}
                          </Link>
                          {l.status_label && <Badge tone="info">{l.status_label}</Badge>}
                          {l.donation_count ? (
                            <span className="block text-xs text-slate-500 mb-1">
                              given {currency(Number(l.total_donated ?? 0))}
                            </span>
                          ) : null}
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          <span className={b.tone === "danger" ? "text-amber-700 font-medium" : ""}>
                            {l.next_follow_up_at
                              ? `${shortDate(l.next_follow_up_at)} · ${dueLabel(l.next_follow_up_at)}`
                              : ""}
                          </span>
                          {l.follow_up_note && <> — “{l.follow_up_note}”</>}
                          {!l.follow_up_note && l.remarks && <> — “{l.remarks}”</>}
                          {l.assigned_to_name && <> · {l.assigned_to_name}</>}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <a
                          href={`tel:+91${l.phone}`}
                          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                        >
                          Call
                        </a>
                        <button
                          onClick={() => void push(l.id, 1)}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                        >
                          Tomorrow
                        </button>
                        <button
                          onClick={() => void push(l.id, 7)}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                        >
                          Next week
                        </button>
                        <button
                          onClick={() => void drop(l.id)}
                          title="Remove the callback without changing the lead"
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
                        >
                          Drop
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      {!loading && !Object.values(data).some((r) => r.length) && (
        <Card padded={false} className="mt-5">
          <EmptyState
            title="No callbacks booked"
            message="Follow-ups appear here as callers book them during calls — there is nothing to set up."
            action={
              <Link href="/calling/queue" className={buttonPrimary}>
                Start calling
              </Link>
            }
          />
        </Card>
      )}
    </div>
  );
}
