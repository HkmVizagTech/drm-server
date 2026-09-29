"use client";

// Reminders — the commitments donors have actually made.
//
// Deliberately NOT the same screen as Follow-ups. A follow-up is the caller's
// own working note ("ring them back around the 20th"); a reminder is something
// the donor said out loud ("I'll give on Govardhan Puja evening, after the
// arati"). Putting both in one list is how the handful of real commitments
// drown among hundreds of routine callbacks, people stop reading, and the
// commitments get missed anyway.
//
// Ordered by urgency, not by date, because the only question a caller has when
// opening this is "what have I got to do right now". Missed comes first and
// stays first: a promise the temple broke is worse than one it hasn't kept yet.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, number, shortDate } from "@/lib/format";
import { Badge, Card, CardHeader, EmptyState, PageHeader, buttonPrimary, buttonSecondary } from "@/components/ui";

interface Reminder {
  id: string;
  lead_id: string;
  title: string;
  note: string | null;
  occasion: string | null;
  due_at: string;
  expected_amount: string | null;
  lead_times: number[];
  status: string;
  snooze_count: number;
  lead_name: string | null;
  lead_phone: string;
  assigned_to_name: string | null;
  total_donated: string | null;
  donation_count: number | null;
}

interface Board {
  buckets: Record<string, Reminder[]>;
  counts: Record<string, number>;
}

// Urgency order. The keys match what the server groups into, and the copy says
// what each one means rather than repeating the label.
const BUCKETS: { key: string; title: string; caption: string; tone: "danger" | "warn" | "neutral" | "muted" }[] = [
  { key: "missed", title: "Missed", caption: "The moment they named has passed", tone: "danger" },
  { key: "now", title: "Right now", caption: "Within half an hour either way", tone: "warn" },
  { key: "today", title: "Later today", caption: "", tone: "neutral" },
  { key: "tomorrow", title: "Tomorrow", caption: "", tone: "neutral" },
  { key: "this_week", title: "This week", caption: "", tone: "muted" },
  { key: "later", title: "Later", caption: "Nothing to do yet", tone: "muted" },
];

const SNOOZE = [
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "This evening", minutes: 60 * 6 },
  { label: "Tomorrow", minutes: 60 * 24 },
  { label: "Next week", minutes: 60 * 24 * 7 },
];

function whenText(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((d.getTime() - Date.now()) / 60_000);
  const clock = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (mins < -60 * 24) return `${shortDate(iso)} at ${clock} · ${Math.abs(Math.round(mins / 1440))} days ago`;
  if (mins < -60) return `${clock} · ${Math.abs(Math.round(mins / 60))} hours ago`;
  if (mins < -1) return `${clock} · ${Math.abs(mins)} minutes ago`;
  if (mins <= 1) return `${clock} · now`;
  if (mins < 60) return `${clock} · in ${mins} minutes`;
  if (mins < 60 * 24) return `${clock} · in ${Math.round(mins / 60)} hours`;
  return `${shortDate(iso)} at ${clock}`;
}

// The alert schedule, said the way a person would.
function leadTimeText(mins: number[]): string {
  if (!mins?.length) return "no alerts";
  const one = (m: number) =>
    m === 0 ? "at the time" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} hr` : `${Math.round(m / 1440)} day`;
  return `alerts ${mins.map(one).join(", ")} before`;
}

export default function RemindersPage() {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [mine, setMine] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snoozeOpen, setSnoozeOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBoard(
        await apiClient.get<Board>(`/api/crm/reminders?scope=${showDone ? "all" : "open"}&mine=${mine}`)
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load reminders");
    } finally {
      setLoading(false);
    }
  }, [mine, showDone]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: string, minutes?: number) {
    setSnoozeOpen(null);
    try {
      await apiClient.put(`/api/crm/reminders/${id}`, { action, minutes });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update that reminder");
    }
  }

  const total = BUCKETS.reduce((n, b) => n + (board?.counts[b.key] ?? 0), 0);
  const urgent = (board?.counts.missed ?? 0) + (board?.counts.now ?? 0);

  return (
    <div>
      <PageHeader
        title="Reminders"
        subtitle="Donors who named a day, an occasion or a time — and what the temple owes them"
        actions={
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setMine((v) => !v)} className={mine ? buttonPrimary : buttonSecondary}>
              {mine ? "Showing just mine" : "Just mine"}
            </button>
            <button onClick={() => setShowDone((v) => !v)} className={buttonSecondary}>
              {showDone ? "Hide finished" : "Show finished"}
            </button>
            <Link href="/calling/queue" className={buttonPrimary}>
              Start calling
            </Link>
          </div>
        }
      />

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {!loading && urgent > 0 && (
        <Card className="mb-5 border-amber-200 bg-amber-50/60">
          <p className="text-sm font-semibold text-amber-900">
            {number(urgent)} reminder{urgent === 1 ? "" : "s"} need{urgent === 1 ? "s" : ""} you now.
          </p>
          <p className="text-xs text-amber-800 mt-0.5">
            These donors chose the moment themselves — being late to one is worse than being early to any of the rest.
          </p>
        </Card>
      )}

      {!loading && total === 0 && !showDone && (
        <Card padded={false}>
          <EmptyState
            title="No reminders yet"
            message="When a donor says they will give on a particular day or at a festival, set a reminder during the call — the box is right under the outcome buttons on the calling screen."
            action={
              <Link href="/calling/queue" className={buttonPrimary}>
                Go to the calling screen
              </Link>
            }
          />
        </Card>
      )}

      <div className="space-y-5">
        {BUCKETS.concat(showDone ? [{ key: "done", title: "Finished", caption: "Done or dismissed", tone: "muted" }] : []).map((b) => {
          const rows = board?.buckets[b.key] ?? [];
          if (!loading && !rows.length) return null;

          const accent =
            b.tone === "danger"
              ? "border-red-200"
              : b.tone === "warn"
              ? "border-amber-200"
              : "border-[var(--line-soft)]";

          return (
            <Card key={b.key} padded={false} className={accent}>
              <div className="px-5 pt-5">
                <CardHeader title={`${b.title}${rows.length ? ` · ${number(rows.length)}` : ""}`} subtitle={b.caption || undefined} />
              </div>

              {loading ? (
                <div className="px-5 pb-5 space-y-2">
                  {[0, 1].map((i) => (
                    <div key={i} className="h-14 rounded-lg bg-slate-100 animate-pulse" />
                  ))}
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 border-t border-[var(--line-soft)]">
                  {rows.map((r) => (
                    <li key={r.id} className="px-5 py-3.5 hover:bg-slate-50/60">
                      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link href={`/leads/${r.lead_id}`} className="font-medium text-slate-900 hover:text-[var(--accent)]">
                              {r.lead_name || r.lead_phone}
                            </Link>
                            {r.occasion && <Badge tone="brand">{r.occasion}</Badge>}
                            {r.expected_amount && (
                              <Badge tone="good">said {currency(Number(r.expected_amount))}</Badge>
                            )}
                            {r.snooze_count >= 3 && (
                              <Badge tone="warn">pushed back {r.snooze_count} times</Badge>
                            )}
                          </div>

                          {/* The donor's own words. The most important line on
                              the screen — it is what the caller opens with. */}
                          <p className="mt-1 text-sm text-slate-700">{r.title}</p>
                          {r.note && <p className="text-xs text-slate-500 mt-0.5">“{r.note}”</p>}

                          <p className="mt-1 text-xs text-slate-500">
                            <span className={b.tone === "danger" ? "text-red-700 font-medium" : b.tone === "warn" ? "text-amber-700 font-medium" : ""}>
                              {whenText(r.due_at)}
                            </span>
                            <span className="text-slate-400"> · {leadTimeText(r.lead_times)}</span>
                            {r.assigned_to_name && <span className="text-slate-400"> · {r.assigned_to_name}</span>}
                            {r.donation_count ? (
                              <span className="text-slate-400"> · has given {currency(Number(r.total_donated ?? 0))}</span>
                            ) : null}
                          </p>
                        </div>

                        {r.status === "open" ? (
                          <div className="flex items-center gap-1.5 relative">
                            <a
                              href={`tel:+91${r.lead_phone}`}
                              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                            >
                              Call
                            </a>
                            <div className="relative">
                              <button
                                onClick={() => setSnoozeOpen(snoozeOpen === r.id ? null : r.id)}
                                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                              >
                                Snooze
                              </button>
                              {snoozeOpen === r.id && (
                                <div className="absolute right-0 top-full mt-1 z-20 w-36 rounded-lg border border-[var(--line-strong)] bg-white py-1 shadow-lg">
                                  {SNOOZE.map((s) => (
                                    <button
                                      key={s.minutes}
                                      onClick={() => void act(r.id, "snooze", s.minutes)}
                                      className="block w-full px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-[var(--accent-wash)]"
                                    >
                                      {s.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => void act(r.id, "done")}
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                            >
                              Done
                            </button>
                            <button
                              onClick={() => void act(r.id, "dismiss")}
                              title="Not happening — take it off the list without marking it done"
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
                            >
                              Drop
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Badge tone={r.status === "done" ? "good" : "neutral"}>
                              {r.status === "done" ? "Done" : "Dropped"}
                            </Badge>
                            <button
                              onClick={() => void act(r.id, "reopen")}
                              className="text-xs text-[var(--accent)] hover:underline"
                            >
                              Reopen
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
