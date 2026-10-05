"use client";

// The two pieces every "tick some, act on them" screen needs: the bar that
// says what is ticked and offers what to do with it, and the line that turns
// "these 50" into "all 212 that match".
//
// WHY THE BAR STICKS TO THE BOTTOM
// Callers work on a phone. A bar at the top of a list scrolls away the moment
// the third row is ticked, and the person then has to scroll back up past
// everything they just chose to find the button. At the bottom it sits under
// the thumb for the whole time the selection exists, and disappears with it.
//
// WHY "ALL MATCHING" IS SPELLED OUT
// Selecting a page and selecting a filter are different acts with different
// consequences - fifty people versus two thousand - and the second must never
// happen by accident. So it is a separate, explicit step, and once taken the
// bar says so in words rather than with a number that merely got bigger.

import type { ReactNode } from "react";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icons";
import { number } from "@/lib/format";

export function SelectionBar({
  count,
  unit = "selected",
  allMatching = false,
  onClear,
  children,
  note,
}: {
  count: number;
  /** "people", "leads" - read as "12 leads selected". */
  unit?: string;
  allMatching?: boolean;
  onClear: () => void;
  /** The actions. Each stretches to share the width on a phone. */
  children: ReactNode;
  /** A line under the count, for anything the actions need explaining. */
  note?: ReactNode;
}) {
  if (count <= 0) return null;
  return (
    <div
      role="region"
      aria-label="Selected"
      // -mx-4 cancels the shell's phone gutter so the bar runs edge to edge;
      // from sm up it floats as a card above the content instead.
      className="sticky bottom-0 z-30 -mx-4 mt-4 border-t border-brand-200 bg-surface/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-dialog backdrop-blur-md sm:bottom-4 sm:mx-0 sm:rounded-card sm:border"
    >
      <div className="flex items-center gap-2">
        <span className="grid h-6 min-w-6 place-items-center rounded-pill bg-brand-600 px-1.5 text-xs font-semibold tabular-nums text-white">
          {number(count)}
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {unit} selected
          {allMatching && <span className="text-ink-muted"> · all matching</span>}
        </p>
        <Button variant="ghost" size="sm" icon="x" onClick={onClear}>
          Clear
        </Button>
      </div>
      {note && <div className="mt-1 text-xs text-ink-muted">{note}</div>}
      {/* Grow, not flex-1: each action keeps its natural width as the basis,
          so two buttons share a phone's row and a third wraps beneath them
          instead of all three being squeezed until their labels clip. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2 [&>*]:grow sm:[&>*]:grow-0">{children}</div>
    </div>
  );
}

/**
 * "All 50 on this page are selected. Select all 212 matching" - and, once
 * chosen, "All 212 matching are selected. Clear".
 */
export function SelectAllBanner({
  pageCount,
  total,
  allMatching,
  loading = false,
  unit = "people",
  onSelectAll,
  onClear,
  truncatedAt,
}: {
  pageCount: number;
  total: number;
  allMatching: boolean;
  loading?: boolean;
  unit?: string;
  onSelectAll: () => void;
  onClear: () => void;
  /** Set when the server capped "all" - says so rather than overstating it. */
  truncatedAt?: number | null;
}) {
  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-brand-200 bg-brand-50 px-3.5 py-2.5 text-sm text-ink"
    >
      <Icon name="checkCircle" size={16} className="text-brand-600" />
      {allMatching ? (
        <>
          <span>
            All <strong className="tabular-nums">{number(truncatedAt ?? total)}</strong> matching {unit} selected
            {truncatedAt ? ` (first ${number(truncatedAt)} of ${number(total)})` : ""}.
          </span>
          <button
            type="button"
            onClick={onClear}
            className="font-semibold text-brand-700 underline-offset-2 hover:underline"
          >
            Clear selection
          </button>
        </>
      ) : (
        <>
          <span>
            All <strong className="tabular-nums">{number(pageCount)}</strong> on this page selected.
          </span>
          <button
            type="button"
            onClick={onSelectAll}
            disabled={loading}
            className="font-semibold text-brand-700 underline-offset-2 hover:underline disabled:opacity-50"
          >
            {loading ? "Selecting…" : `Select all ${number(total)} matching`}
          </button>
        </>
      )}
    </div>
  );
}
