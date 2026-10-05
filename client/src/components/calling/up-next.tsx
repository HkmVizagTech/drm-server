"use client";

// Everybody in the run, in order, with what became of each.
//
// The server owns the order and the caller's place in it; this only draws it.
// A row can be tapped to go straight to that person - "Ravi said ring back in
// ten minutes" is answered by finding Ravi here, not by skipping forward to
// him. A colleague may be holding somebody, in which case the server refuses
// the jump and says who; the screen shows that rather than pretending.
//
// A run can hold thousands. The list shows a window around the person on
// screen - a few behind, a page ahead - because that is what "up next" means,
// with the whole run one tap away for the rare search through it.

import { useMemo, useState } from "react";
import { dueLabel } from "@/lib/format";
import { Badge, Button, Icon, Skeleton, Spinner } from "@/components/ui";
import { formatPhone, type RunListItem } from "@/lib/calling";

const BEHIND = 3;
const AHEAD = 25;

function StateChip({ item }: { item: RunListItem }) {
  if (item.state === "done")
    return (
      <Badge tone="good" icon="check">
        {item.outcome_label ?? "Called"}
      </Badge>
    );
  if (item.state === "skipped") return <Badge tone="warn">Skipped</Badge>;
  if (item.state === "taken") return <Badge tone="neutral">{item.note || "With a colleague"}</Badge>;
  return null;
}

export function UpNextList({
  items,
  position,
  loading,
  jumping,
  onJump,
}: {
  items: RunListItem[] | null;
  position: number;
  loading: boolean;
  /** The position being jumped to, so only that row spins. */
  jumping: number | null;
  onJump: (position: number) => void;
}) {
  const [all, setAll] = useState(false);

  const shown = useMemo(() => {
    if (!items) return [];
    if (all) return items;
    const at = items.findIndex((i) => i.position >= position);
    const from = Math.max(0, (at === -1 ? items.length : at) - BEHIND);
    return items.slice(from, from + BEHIND + AHEAD + 1);
  }, [items, position, all]);

  if (!items && loading)
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  if (!items?.length) return <p className="text-sm text-ink-muted">Nobody in this run.</p>;

  return (
    <div>
      <ol className="divide-y divide-line-soft">
        {shown.map((it) => {
          const current = it.position === position;
          return (
            <li key={it.position}>
              <button
                type="button"
                disabled={current || jumping !== null}
                onClick={() => onJump(it.position)}
                aria-current={current ? "true" : undefined}
                className={`flex min-h-12 w-full items-center gap-2.5 rounded-control px-2 py-2 text-left transition-colors disabled:cursor-default ${
                  current ? "bg-brand-50 ring-1 ring-inset ring-brand-200" : "hover:bg-sunken"
                } ${it.state === "done" || it.state === "taken" ? "opacity-75" : ""}`}
              >
                <span className="w-7 flex-none text-right text-2xs tabular-nums text-ink-faint">{it.position}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={`truncate text-sm ${current ? "font-semibold text-brand-800" : "text-ink"}`}>
                      {it.name || formatPhone(it.phone)}
                    </span>
                    {it.nearly_gave && <Icon name="sparkle" size={12} className="flex-none text-warn" aria-label="Nearly gave" />}
                  </span>
                  <span className="block truncate text-2xs text-ink-muted">
                    {current
                      ? "On screen now"
                      : [it.city, it.next_follow_up_at ? `callback ${dueLabel(it.next_follow_up_at)}` : null]
                          .filter(Boolean)
                          .join(" · ") || (it.call_attempts ? `${it.call_attempts} attempts` : "Never rung")}
                  </span>
                </span>
                <span className="flex flex-none items-center">
                  {jumping === it.position ? <Spinner size={14} /> : <StateChip item={it} />}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {items.length > shown.length || all ? (
        <Button variant="ghost" size="sm" block className="mt-2" onClick={() => setAll((v) => !v)}>
          {all ? "Show only around where I am" : `Show all ${items.length}`}
        </Button>
      ) : null}
    </div>
  );
}
