"use client";

// The frame around a call: where the caller is in the run, and the way to the
// next person.
//
// WHY THE NAVIGATION IS A BAR AT THE BOTTOM
// Callers dial from their own phones. They tap the number, talk, come back to
// this tab and tap an outcome - and then they want the next person, which is a
// thumb's reach from the bottom of the screen, not a scroll back to the top.
// So on a phone the bar is pinned to the bottom edge (clear of the home
// indicator), and it is the same bar at every point in the run.

import type { ComponentProps, ReactNode } from "react";
import { number } from "@/lib/format";
import { Badge, Button } from "@/components/ui";
import type { RunCounts } from "@/lib/calling";

/** One bar, four colours: done, skipped, stepped past, still to ring. */
export function RunProgress({ counts }: { counts: RunCounts }) {
  const t = Math.max(1, counts.total);
  const pct = (n: number) => `${(n / t) * 100}%`;
  return (
    <div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-pill bg-sunken"
        role="img"
        aria-label={`${counts.done} called, ${counts.skipped} skipped, ${counts.pending} still to call, of ${counts.total}`}
      >
        <span className="h-full bg-brand-600 transition-[width] duration-500" style={{ width: pct(counts.done) }} />
        <span className="h-full bg-warn transition-[width] duration-500" style={{ width: pct(counts.skipped) }} />
        <span className="h-full bg-line-strong transition-[width] duration-500" style={{ width: pct(counts.taken) }} />
      </div>
      <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-muted">
        <span>
          <span className="font-semibold tabular-nums text-ink">{number(counts.done)}</span> called
        </span>
        {counts.skipped > 0 && (
          <span>
            <span className="font-semibold tabular-nums text-warn">{number(counts.skipped)}</span> skipped
          </span>
        )}
        {counts.taken > 0 && (
          <span>
            <span className="font-semibold tabular-nums">{number(counts.taken)}</span> with colleagues
          </span>
        )}
        <span>
          <span className="font-semibold tabular-nums text-ink">{number(counts.ahead)}</span> still ahead
        </span>
      </p>
    </div>
  );
}

export function RunHeader({
  label,
  counts,
  finished,
  paused,
  actions,
}: {
  label: string;
  counts: RunCounts;
  finished: boolean;
  paused: boolean;
  actions: ReactNode;
}) {
  return (
    <div className="mb-4 border-b border-line-soft pb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-brand-600">Calling</p>
          <h1 className="truncate text-lg font-semibold tracking-tight text-ink sm:text-2xl">{label}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <span className="tabular-nums">
              {finished ? "All the way through" : `${number(counts.index)} of ${number(counts.total)}`}
            </span>
            {paused && (
              <Badge tone="warn" dot>
                Paused
              </Badge>
            )}
          </p>
        </div>
        <div className="flex flex-none items-center gap-1.5">{actions}</div>
      </div>
      <div className="mt-3">
        <RunProgress counts={counts} />
      </div>
    </div>
  );
}

/**
 * Previous / Skip / Next.
 *
 * On a person not yet called, "next" and "skip" are the same move on the
 * server - moving on from somebody uncalled is skipping them - so the bar
 * offers one button for it, named for what it does. Once the call is logged
 * that same slot becomes "Next person", the primary action of the screen.
 */
export function NavBar({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className="sticky bottom-0 z-20 -mx-4 mt-4 border-t border-line-soft bg-surface/95 px-4 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] backdrop-blur-md sm:-mx-6 sm:px-6">
      <div className="mx-auto flex max-w-6xl items-center gap-2">
        <div className="flex flex-1 gap-2 sm:flex-none">{left}</div>
        <div className="flex flex-[2] justify-end gap-2 sm:flex-1">{right}</div>
      </div>
    </div>
  );
}

export function NavButton(props: ComponentProps<typeof Button>) {
  // Tall enough for a thumb, and as wide as the bar allows on a phone.
  return <Button size="lg" {...props} className={`flex-1 sm:flex-none ${props.className ?? ""}`} />;
}
