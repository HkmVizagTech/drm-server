"use client";

// Where a shift begins: whom do you want to call?
//
// WHAT THIS REPLACES
// "Start calling" used to go straight to one global queue, and this screen
// only offered the uploaded lists beside it. But callers do not think in lists
// alone. They think "ring the people who nearly gave this week", "ring
// everyone who promised for today", "ring my own leads" - so each of those is
// a card here, with the number it will actually hold, and one tap starts it.
//
// THE NUMBERS ARE EXACT
// Every count comes from the server running the same query the run would
// snapshot, so "14" on a card is fourteen people on the call screen - not an
// estimate that turns out to be six. A card with nobody behind it says so and
// cannot be started, rather than opening an empty call screen.
//
// CARRYING ON COMES FIRST
// An unfinished run is the first thing on the screen and one tap from
// continuing. Starting the same source again also carries on with it - the
// server never splits a morning's place in two - so "Start over" is the only
// way to throw a place away, and it asks twice.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { number, relativeDate } from "@/lib/format";
import {
  endRun,
  getSources,
  runHref,
  startRun,
  type ListSourceCard,
  type OpenRun,
  type RunSource,
  type SourceCard,
  type SourceKind,
  type SourcesResponse,
} from "@/lib/calling";
import {
  Alert,
  Badge,
  Button,
  Card,
  Icon,
  PageHeader,
  Skeleton,
  Spinner,
  buttonClass,
  type IconName,
} from "@/components/ui";
import { toast } from "@/components/toast";

/** How each fixed source is described, in the order they matter. */
const FIXED: Record<
  Exclude<SourceKind, "list" | "selection">,
  { icon: IconName; blurb: string; empty: string }
> = {
  nearly_gave: {
    icon: "sparkle",
    blurb: "Tried to give online but did not finish.",
    empty: "No one right now",
  },
  reminders: {
    icon: "bell",
    blurb: "Promised to give today.",
    empty: "No promises today",
  },
  follow_ups: {
    icon: "calendar",
    blurb: "Due today or late.",
    empty: "No follow-ups today",
  },
  mine: {
    icon: "user",
    blurb: "Your leads due a call.",
    empty: "None due today",
  },
  everything: {
    icon: "users",
    blurb: "All leads due a call.",
    empty: "None due today",
  },
};
const ORDER: (keyof typeof FIXED)[] = ["nearly_gave", "reminders", "follow_ups", "mine", "everything"];

function sourceFor(kind: SourceKind, listId: string | null): RunSource {
  return kind === "list" && listId ? { kind, list_id: listId } : { kind };
}

export default function StartCallingPage() {
  // useSearchParams (for ?list=) needs a Suspense boundary in this Next.
  return (
    <Suspense fallback={<StartSkeleton />}>
      <StartCalling />
    </Suspense>
  );
}

function StartSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Card key={i}>
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="mt-3 h-8 w-16" />
          <Skeleton className="mt-3 h-3 w-4/5" />
        </Card>
      ))}
    </div>
  );
}

function StartCalling() {
  const router = useRouter();
  const params = useSearchParams();
  const autoList = params.get("list");
  const { user } = useAuth();
  const canManage = user?.role === "admin" || user?.role === "accountant";

  const [data, setData] = useState<SourcesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The key of the card being started, so only that card spins. */
  const [starting, setStarting] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await getSources());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
    }
  }, []);

  useEffect(() => {
    getSources()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load. Try again."));
  }, []);

  const start = useCallback(
    /** Resolves true once it has navigated to the run. */
    async (key: string, source: RunSource, opts: { restart?: boolean } = {}): Promise<boolean> => {
      setStarting(key);
      try {
        const s = await startRun(source, opts);
        if (s.empty || !s.session) {
          toast.info("No one to call here right now");
          setStarting(null);
          void reload();
          return false;
        }
        if (s.adopted?.created) {
          toast.success(
            `Added ${number(s.adopted.created)} new ${s.adopted.created === 1 ? "person" : "people"}`
          );
        }
        if (opts.restart) toast.success("Started over");
        else if (s.resumed) toast.info("Continuing where you stopped");
        router.push(runHref(s.session.id));
        return true;
      } catch (e) {
        toast.error("Could not start calling", e instanceof Error ? e.message : undefined);
        setStarting(null);
        return false;
      }
    },
    [router, reload]
  );

  // ?list=<id>: the "Call this list" buttons elsewhere land here and start it.
  // Once per visit, even if the effect runs twice.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoList || autoStarted.current) return;
    autoStarted.current = true;
    void Promise.resolve()
      .then(() => start(`list:${autoList}`, { kind: "list", list_id: autoList }))
      // Not navigated means it found nobody (or failed): drop ?list= so a
      // refresh does not try, and toast, all over again.
      .then((went) => {
        if (!went) router.replace("/calling/start", { scroll: false });
      });
  }, [autoList, start, router]);

  async function finishRun(run: OpenRun) {
    try {
      const r = await endRun(run.id);
      toast.success(`Finished ${run.label}`, `${r.summary.calls} call${r.summary.calls === 1 ? "" : "s"}`);
      await reload();
    } catch (e) {
      toast.error("Could not finish. Try again.", e instanceof Error ? e.message : undefined);
    }
  }

  const openByKey = new Map((data?.open ?? []).map((o) => [o.key, o]));
  const fixed = ORDER.map((k) => data?.sources.find((s) => s.kind === k)).filter((s): s is SourceCard => !!s);


  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="Whom do you want to call?"
        subtitle="Pick who to call."
        actions={
          <>
            {canManage && (
              <Link href="/calling/lists" className={buttonClass("secondary", "md")}>
                Manage lists
              </Link>
            )}
            <Link href="/calling" className={buttonClass("secondary", "md")}>
              Overview
            </Link>
          </>
        }
      />

      {error && (
        <Alert tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void reload()}>Try again</Button>}>
          {error}
        </Alert>
      )}

      {autoList && starting === `list:${autoList}` && (
        <Alert tone="info">
          <span className="inline-flex items-center gap-2">
            <Spinner size={14} /> Opening list…
          </span>
        </Alert>
      )}

      {!data && !error && <StartSkeleton />}

      {data && (
        <>
          {/* ----------------------------------------------- carry on */}
          {data.open.length > 0 && (
            <section className="mb-7">
              <h2 className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
                Continue
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {data.open.map((r) => (
                  <OpenRunCard
                    key={r.id}
                    run={r}
                    busy={starting !== null}
                    restarting={starting === `restart:${r.id}`}
                    onContinue={() => router.push(runHref(r.id))}
                    onRestart={
                      r.kind === "selection"
                        ? undefined
                        : () => void start(`restart:${r.id}`, sourceFor(r.kind, r.list_id), { restart: true })
                    }
                    onFinish={() => void finishRun(r)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ------------------------------------------------ who to ring */}
          <section className="mb-7">
            <h2 className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
              {data.open.length ? "Or start new" : "Who to call"}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {fixed.map((s) => {
                const meta = FIXED[s.kind as keyof typeof FIXED];
                const fresh = s.kind === "nearly_gave" ? s.new_attempts ?? 0 : 0;
                return (
                  <SourceTile
                    key={s.key}
                    icon={meta.icon}
                    label={s.label}
                    count={s.count}
                    blurb={meta.blurb}
                    extra={
                      fresh > 0
                        ? `${number(fresh)} new will be added`
                        : undefined
                    }
                    empty={meta.empty}
                    // Starting Nearly gave adds the new website attempts
                    // first, so it is worth starting even when it holds
                    // nobody yet.
                    enabled={s.count > 0 || fresh > 0}
                    emphasis={s.kind === "nearly_gave"}
                    open={openByKey.get(s.key)}
                    starting={starting === s.key}
                    busy={starting !== null}
                    onStart={() => void start(s.key, { kind: s.kind })}
                  />
                );
              })}
            </div>
          </section>

          {/* ----------------------------------------------------- lists */}
          <section>
            <h2 className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">Your lists</h2>
            {data.lists.length === 0 ? (
              <Card>
                <p className="text-sm text-ink-muted">No lists yet.</p>
                {canManage && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link href="/calling/uploads" className={buttonClass("secondary", "md")}>
                      Upload a sheet
                    </Link>
                    <Link href="/calling/lists" className={buttonClass("secondary", "md")}>
                      Build a list
                    </Link>
                  </div>
                )}
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {data.lists.map((l: ListSourceCard) => (
                  <SourceTile
                    key={l.key}
                    icon="list"
                    label={l.label}
                    count={l.count}
                    blurb={l.description || undefined}
                    badge={l.assigned_to_me ? "Yours" : undefined}
                    empty="None due today"
                    enabled={l.count > 0}
                    open={openByKey.get(l.key)}
                    starting={starting === l.key}
                    busy={starting !== null}
                    onStart={() => void start(l.key, { kind: "list", list_id: l.list_id })}
                    seeHref={`/leads?list=${l.list_id}&callable=true`}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the cards */

function OpenRunCard({
  run,
  busy,
  restarting,
  onContinue,
  onRestart,
  onFinish,
}: {
  run: OpenRun;
  busy: boolean;
  restarting: boolean;
  onContinue: () => void;
  onRestart?: () => void;
  onFinish: () => void;
}) {
  // "Start over" throws a place away, so it takes a second tap within a few
  // seconds - the same rule as "never call them" on the call screen.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  const pct = run.total ? Math.round(((run.done + run.skipped) / run.total) * 100) : 0;
  const donePct = run.total ? (run.done / run.total) * 100 : 0;
  const skipPct = run.total ? (run.skipped / run.total) * 100 : 0;

  return (
    <Card tone="brand" padded={false} className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-ink">{run.label}</p>
          <p className="mt-0.5 text-xs text-ink-muted">Last used {relativeDate(run.last_active_at).toLowerCase()}</p>
        </div>
        {run.paused && (
          <Badge tone="warn" dot>
            Paused
          </Badge>
        )}
      </div>

      <div className="mt-3">
        <div className="flex h-2 w-full overflow-hidden rounded-pill bg-surface" aria-label={`${pct}% done`}>
          <span className="h-full bg-brand-600" style={{ width: `${donePct}%` }} />
          <span className="h-full bg-warn" style={{ width: `${skipPct}%` }} />
        </div>
        <p className="mt-1.5 text-xs text-ink-soft">
          <span className="font-semibold tabular-nums text-ink">{number(run.done)}</span> of{" "}
          <span className="tabular-nums">{number(run.total)}</span> called
          {run.skipped > 0 && (
            <>
              {" "}
              · <span className="tabular-nums text-warn">{number(run.skipped)}</span> skipped
            </>
          )}
          {" "}· <span className="tabular-nums">{number(run.pending)}</span> left
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="lg" icon="phoneOutgoing" disabled={busy} onClick={onContinue} className="flex-1 sm:flex-none">
          Continue
        </Button>
        {onRestart && (
          <Button
            size="sm"
            variant={armed ? "dangerSoft" : "ghost"}
            disabled={busy && !restarting}
            loading={restarting}
            onClick={() => {
              if (!armed) return setArmed(true);
              setArmed(false);
              onRestart();
            }}
          >
            {armed ? "Tap again to start over" : "Start over"}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onFinish} title="Mark as done">
          Finish
        </Button>
      </div>
    </Card>
  );
}

function SourceTile({
  icon,
  label,
  count,
  blurb,
  extra,
  badge,
  empty,
  enabled,
  emphasis = false,
  open,
  starting,
  busy,
  onStart,
  seeHref,
}: {
  icon: IconName;
  label: string;
  count: number;
  blurb?: string;
  /** A second line that matters ("3 new from the website will be added"). */
  extra?: string;
  badge?: string;
  /** Why it cannot be started, said in place of the count. */
  empty: string;
  enabled: boolean;
  /** Nearly gave: the warmest list, so it stands out. */
  emphasis?: boolean;
  open?: OpenRun;
  starting: boolean;
  busy: boolean;
  onStart: () => void;
  seeHref?: string;
}) {
  return (
    <Card
      padded={false}
      tone={emphasis && enabled ? "warn" : undefined}
      interactive={enabled && !busy}
      className={`flex flex-col ${enabled ? "" : "opacity-60"} ${emphasis && enabled ? "ring-1 ring-amber-300" : ""}`}
    >
      {/* The whole card is the button: on a phone a tile is tapped anywhere,
          and a small "Start" in its corner is the part people miss. */}
      <button
        type="button"
        disabled={!enabled || busy}
        onClick={onStart}
        className="flex min-h-28 w-full flex-1 flex-col items-stretch rounded-card p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 disabled:cursor-not-allowed"
      >
        <span className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={`grid h-8 w-8 flex-none place-items-center rounded-control ${
                emphasis && enabled ? "bg-surface text-warn" : "bg-brand-50 text-brand-700"
              }`}
            >
              <Icon name={icon} size={16} />
            </span>
            <span className="truncate font-semibold text-ink">{label}</span>
          </span>
          {starting ? (
            <Spinner size={18} label="Starting" />
          ) : enabled ? (
            <Icon name="arrowRight" size={16} className="mt-1 flex-none text-brand-700" />
          ) : null}
        </span>

        {badge && (
          <span className="mt-2">
            <Badge tone="brand" icon="user">
              {badge}
            </Badge>
          </span>
        )}

        <span className="mt-2 flex items-baseline gap-2">
          {enabled ? (
            <>
              <span className="text-2xl font-semibold tabular-nums text-ink">{number(count)}</span>
              <span className="text-sm text-ink-muted">to call</span>
            </>
          ) : (
            <span className="text-sm font-medium text-ink-muted">{empty}</span>
          )}
        </span>

        {extra && (
          <span className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-amber-900">
            <Icon name="plus" size={13} />
            {extra}
          </span>
        )}
        {blurb && <span className="mt-1 line-clamp-2 text-xs text-ink-muted">{blurb}</span>}
        {open && (
          <span className="mt-2 text-xs font-medium text-brand-700">
            In progress · {number(open.done)} of {number(open.total)} called
          </span>
        )}
      </button>
      {seeHref && (
        <div className="border-t border-line-soft px-4 py-2">
          <Link href={seeHref} className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
            See leads
            <Icon name="arrowRight" size={12} />
          </Link>
        </div>
      )}
    </Card>
  );
}
