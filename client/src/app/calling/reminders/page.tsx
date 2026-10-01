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
import { currency, IST, number, shortDate } from "@/lib/format";
import { alertSummary } from "@/lib/reminders";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  DropdownMenu,
  EmptyState,
  Field,
  LinkButton,
  PageHeader,
  SegmentedControl,
  Skeleton,
  Toolbar,
  buttonPrimary,
} from "@/components/ui";
import { ExportButton } from "@/components/export-button";

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
  const clock = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: IST });
  if (mins < -60 * 24) return `${shortDate(iso)} at ${clock} · ${Math.abs(Math.round(mins / 1440))} days ago`;
  if (mins < -60) return `${clock} · ${Math.abs(Math.round(mins / 60))} hours ago`;
  if (mins < -1) return `${clock} · ${Math.abs(mins)} minutes ago`;
  if (mins <= 1) return `${clock} · now`;
  if (mins < 60) return `${clock} · in ${mins} minutes`;
  if (mins < 60 * 24) return `${clock} · in ${Math.round(mins / 60)} hours`;
  return `${shortDate(iso)} at ${clock}`;
}



export default function RemindersPage() {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [mine, setMine] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The filters, described once.
   *
   * The board and the download both read this. Build it twice and a caller
   * looking at their own open reminders downloads the whole temple's, which
   * reads as a list of promises they personally owe.
   */
  const filterParams = useCallback(() => {
    return new URLSearchParams({ scope: showDone ? "all" : "open", mine: String(mine) });
  }, [mine, showDone]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBoard(await apiClient.get<Board>(`/api/crm/reminders?${filterParams()}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load reminders");
    } finally {
      setLoading(false);
    }
  }, [filterParams]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: string, minutes?: number) {
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
        eyebrow="Calling"
        title="Reminders"
        subtitle="Donors who named a day, an occasion or a time — and what the temple owes them"
        actions={
          <>
            <ExportButton
              path="/api/crm/reminders/export"
              params={filterParams()}
              filename="reminders"
            />
            {/* A next/link anchor wearing the button class rather than
                LinkButton: LinkButton is a plain <a>, which would drop out of
                the client router. */}
            <Link href="/calling/queue" className={buttonPrimary}>
              Start calling
            </Link>
          </>
        }
      />

      <Toolbar
        activeCount={(mine ? 1 : 0) + (showDone ? 1 : 0)}
        onClear={() => {
          setMine(false);
          setShowDone(false);
        }}
      >
        <Field label="Whose">
          <SegmentedControl
            options={[
              { value: "everyone", label: "Everyone" },
              { value: "mine", label: "Just mine" },
            ]}
            value={mine ? "mine" : "everyone"}
            onChange={(v) => setMine(v === "mine")}
          />
        </Field>
        <div className="flex h-9.5 items-center">
          <Checkbox checked={showDone} onChange={setShowDone} label="Include finished" />
        </div>
      </Toolbar>

      {error && <Alert tone="danger">{error}</Alert>}

      {!loading && urgent > 0 && (
        <Alert
          tone="warn"
          title={`${number(urgent)} reminder${urgent === 1 ? "" : "s"} need${urgent === 1 ? "s" : ""} you now.`}
        >
          These donors chose the moment themselves — being late to one is worse than being early to any of the rest.
        </Alert>
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
              : "border-line-soft";

          return (
            <Card key={b.key} padded={false} className={accent}>
              <div className="px-5 pt-5">
                <CardHeader title={`${b.title}${rows.length ? ` · ${number(rows.length)}` : ""}`} subtitle={b.caption || undefined} />
              </div>

              {loading ? (
                <div className="space-y-2 px-5 pb-5">
                  {[0, 1].map((i) => (
                    <Skeleton key={i} className="h-14" />
                  ))}
                </div>
              ) : (
                <ul className="divide-y divide-line-soft border-t border-line-soft">
                  {rows.map((r) => (
                    <li key={r.id} className="px-5 py-3.5 transition-colors hover:bg-brand-50/60">
                      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link href={`/leads/${r.lead_id}`} className="font-medium text-ink hover:text-brand-700">
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
                          <p className="mt-1 text-sm text-ink-soft">{r.title}</p>
                          {r.note && <p className="mt-0.5 text-xs text-ink-muted">“{r.note}”</p>}

                          <p className="mt-1 text-xs text-ink-muted">
                            <span className={b.tone === "danger" ? "font-medium text-danger" : b.tone === "warn" ? "font-medium text-warn" : ""}>
                              {whenText(r.due_at)}
                            </span>
                            <span className="text-ink-faint"> · {`alerts ${alertSummary(r.lead_times)}`}</span>
                            {r.assigned_to_name && <span className="text-ink-faint"> · {r.assigned_to_name}</span>}
                            {r.donation_count ? (
                              <span className="text-ink-faint"> · has given {currency(Number(r.total_donated ?? 0))}</span>
                            ) : null}
                          </p>
                        </div>

                        {r.status === "open" ? (
                          <div className="flex items-center gap-1.5">
                            <LinkButton href={`tel:+91${r.lead_phone}`} variant="primary" size="sm" icon="phone">
                              Call
                            </LinkButton>
                            <DropdownMenu
                              items={SNOOZE.map((s) => ({
                                label: s.label,
                                onSelect: () => void act(r.id, "snooze", s.minutes),
                              }))}
                              trigger={({ open, toggle }) => (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={toggle}
                                  aria-expanded={open}
                                  aria-haspopup="menu"
                                >
                                  Snooze
                                </Button>
                              )}
                            />
                            <Button variant="secondary" size="sm" onClick={() => void act(r.id, "done")}>
                              Done
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void act(r.id, "dismiss")}
                              title="Not happening — take it off the list without marking it done"
                            >
                              Drop
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Badge tone={r.status === "done" ? "good" : "neutral"}>
                              {r.status === "done" ? "Done" : "Dropped"}
                            </Badge>
                            <Button variant="ghost" size="xs" onClick={() => void act(r.id, "reopen")}>
                              Reopen
                            </Button>
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
