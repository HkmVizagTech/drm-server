"use client";

// Where a shift begins.
//
// WHAT THIS REPLACES
// "Start calling" used to go straight to the queue, which handed over whatever
// was most overdue across every lead in DRM. The order was right; the unit of
// work was wrong. A caller sits down to work THE JANMASHTAMI SHEET, not "the
// queue", and when they stop at forty they need to open the same sheet
// tomorrow and carry on at forty-one.
//
// So this screen asks one question - which list - and answers the two things a
// caller needs to choose: how much is left in each, and where they were.
//
// THE RESUME BANNER IS THE POINT
// If there is an unfinished run, it is the first thing on the screen and one
// press away from continuing. Everything else here is for the day you start
// something new.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { currency, number, relativeDate } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  buttonPrimary,
  buttonSecondary,
} from "@/components/ui";

interface CallingList {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  origin: string;
  tag: string | null;
  city: string | null;
  preacher_code: string | null;
  preacher_name: string | null;
  batch_filename: string | null;
  batch_sheet: string | null;
  min_external_total: string | null;
  assigned_to_me: boolean;
  assignment_note: string | null;
  total: number;
  to_call: number;
  never_called: number;
  called: number;
  converted: number;
  session_id: string | null;
  session_calls: number | null;
  session_last_active: string | null;
}

interface CurrentSession {
  id: string;
  list_id: string | null;
  list_name: string | null;
  calls_logged: number;
  connected: number;
  started_at: string;
  last_active_at: string;
}

/** What a list is made of, said in the words the office uses. */
function describe(l: CallingList): string {
  const bits: string[] = [];
  if (l.batch_filename) {
    bits.push(l.batch_sheet ? `${l.batch_filename} · ${l.batch_sheet}` : l.batch_filename);
  }
  if (l.tag) bits.push(`tagged ${l.tag}`);
  if (l.preacher_code) bits.push(`${l.preacher_name || l.preacher_code}'s donors`);
  if (l.city) bits.push(l.city);
  if (l.min_external_total) bits.push(`given over ${currency(Number(l.min_external_total))}`);
  return bits.join(" · ");
}

export default function StartCallingPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [lists, setLists] = useState<CallingList[]>([]);
  const [current, setCurrent] = useState<CurrentSession | null>(null);
  const [everything, setEverything] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, s, q] = await Promise.all([
        apiClient.get<{ lists: CallingList[] }>("/api/crm/lists"),
        apiClient.get<{ session: CurrentSession | null }>("/api/crm/sessions/current"),
        // Asked for one lead only: this is just to put a number on the
        // Everything card, and pulling twenty-five leads to count them would
        // be wasteful on a screen nobody is calling from yet.
        apiClient.get<{ to_call: number }>("/api/crm/queue?limit=1"),
      ]);
      setLists(l.lists);
      setCurrent(s.session);
      setEverything(q.to_call);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your calling lists");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function start(listId: string | null) {
    setStarting(listId ?? "all");
    setError(null);
    try {
      // Opening a session is idempotent on the server, so this is also the
      // resume path - pressing Continue and pressing Start on the same list do
      // the same thing, and neither can split a day's tally into two sessions.
      const r = await apiClient.post<{ session: { id: string } }>("/api/crm/sessions", {
        list_id: listId ?? undefined,
      });
      const q = listId ? `?list=${listId}&session=${r.session.id}` : `?session=${r.session.id}`;
      router.push(`/calling/queue${q}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start calling");
      setStarting(null);
    }
  }

  const assigned = lists.filter((l) => l.assigned_to_me);
  const others = lists.filter((l) => !l.assigned_to_me);

  return (
    <div>
      <PageHeader
        eyebrow="Overview"
        title={user?.name ? `Ready when you are, ${user.name.split(" ")[0]}` : "Start calling"}
        subtitle="Pick a list. You can stop whenever you like and pick up from the same place."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/calling/lists" className={buttonSecondary}>
              Manage lists
            </Link>
            <Link href="/calling" className={buttonSecondary}>
              Overview
            </Link>
          </div>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {/* ------------------------------------------------------------ resume */}
      {current && (
        <Card tone="brand" className="mb-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-brand-700">
                Where you left off
              </p>
              <p className="mt-1 text-lg font-semibold text-ink">
                {current.list_name || "Everything"}
              </p>
              <p className="mt-0.5 text-sm text-ink-soft">
                {number(current.calls_logged)} call{current.calls_logged === 1 ? "" : "s"} logged
                {current.connected > 0 && ` · ${number(current.connected)} got through`}
                {" · last "}
                {relativeDate(current.last_active_at)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {/* The one thing this screen exists to offer, at the size that
                  says so — a caller coming back from lunch should not have to
                  hunt for it among four same-sized buttons. */}
              <Button
                size="lg"
                icon="phoneOutgoing"
                onClick={() => void start(current.list_id)}
                disabled={starting !== null}
                // Spins only for the run it actually started: `start` keys the
                // flag by list id, with "all" standing in for the global queue,
                // so matching on that is what stops every button on the screen
                // spinning when one of them is pressed.
                loading={starting === (current.list_id ?? "all")}
              >
                Continue
              </Button>
              <Button
                variant="secondary"
                size="lg"
                onClick={async () => {
                  try {
                    await apiClient.post(`/api/crm/sessions/${current.id}/end`, {});
                    await load();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Could not finish that");
                  }
                }}
              >
                Finish it
              </Button>
            </div>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="mt-2 h-3 w-3/5" />
              <Skeleton rounded="rounded-pill" className="mt-4 h-1.5 w-full" />
            </Card>
          ))}
        </div>
      ) : (
        <>
          {assigned.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
                Given to you
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {assigned.map((l) => (
                  <ListCard key={l.id} list={l} starting={starting} onStart={() => void start(l.id)} />
                ))}
              </div>
            </section>
          )}

          <section className="mb-6">
            <h2 className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
              {assigned.length ? "Other lists" : "Lists"}
            </h2>

            {!others.length && !assigned.length ? (
              <Card>
                <EmptyState
                  icon="list"
                  title="No lists yet"
                  message="A list is made every time you apply an uploaded sheet. You can also build one by hand from a tag, a preacher or a city."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Link href="/calling/uploads" className={buttonPrimary}>Upload a sheet</Link>
                      <Link href="/calling/lists" className={buttonSecondary}>Build a list</Link>
                    </div>
                  }
                />
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {others.map((l) => (
                  <ListCard key={l.id} list={l} starting={starting} onStart={() => void start(l.id)} />
                ))}
              </div>
            )}
          </section>

          {/* Kept, and kept last. Calling everything is the old behaviour and
              still the right answer on a quiet day when the follow-ups matter
              more than any one sheet. */}
          <section>
            <h2 className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
              Or call everyone
            </h2>
            <Card className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-medium text-ink">Everything that is due</p>
                <p className="mt-0.5 text-sm text-ink-soft">
                  Every lead of yours across all lists, most overdue first.
                  {everything !== null && ` ${number(everything)} ready now.`}
                </p>
              </div>
              <Button
                variant="secondary"
                size="lg"
                onClick={() => void start(null)}
                disabled={starting !== null}
                loading={starting === "all"}
              >
                {starting === "all" ? "Starting…" : "Start"}
              </Button>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}

function ListCard({
  list,
  starting,
  onStart,
}: {
  list: CallingList;
  starting: string | null;
  onStart: () => void;
}) {
  const detail = describe(list);
  // Against the whole list rather than against what is left, so the bar only
  // ever moves forward. Measured on "has been called at least once", which is
  // the question a progress bar is actually answering.
  const pct = list.total ? Math.round((list.called / list.total) * 100) : 0;
  const done = list.to_call === 0;

  return (
    <Card className={done ? "opacity-70" : undefined}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{list.name}</p>
          {detail && <p className="mt-0.5 truncate text-xs text-ink-muted">{detail}</p>}
        </div>
        {list.session_id && <Badge tone="brand" dot>In progress</Badge>}
      </div>

      {list.assignment_note && (
        <Alert tone="warn" className="mt-2 mb-0">
          {list.assignment_note}
        </Alert>
      )}

      <div className="mt-3">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-semibold tabular-nums text-ink">
            {done ? "All done" : `${number(list.to_call)} to call`}
          </span>
          <span className="text-xs tabular-nums text-ink-muted">
            {number(list.called)} of {number(list.total)} reached
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-pill bg-sunken">
          <div
            className="h-full rounded-pill bg-brand-600 transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-ink-muted">
          {list.converted > 0 && `${number(list.converted)} donated`}
        </span>
        <div className="flex gap-2">
          <Link href={`/leads?list=${list.id}`} className={buttonSecondary}>
            See them
          </Link>
          <Button onClick={onStart} disabled={starting !== null || done} loading={starting === list.id}>
            {starting === list.id ? "Starting…" : list.session_id ? "Continue" : "Start"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
