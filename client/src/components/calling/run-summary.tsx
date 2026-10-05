"use client";

// The end of a run: what it came to, and what is left.
//
// Not a vanity screen. "Go back to the 6 you skipped" is the most useful
// button a caller sees all day - skipping is cheap mid-run precisely because
// this offers the way back - and "₹12,000 promised" is the only feedback the
// work gives that is not a number of taps.

import { currency, number } from "@/lib/format";
import { Badge, Button, Card, Skeleton } from "@/components/ui";
import type { RunSummary } from "@/lib/calling";

export function RunSummaryCard({
  label,
  summary,
  skipped,
  busy,
  onRevisit,
  onFinish,
  onChooseAnother,
}: {
  label: string;
  summary: RunSummary | null;
  /** From the run's own counts, so the button is right even before the summary loads. */
  skipped: number;
  busy: "revisit" | "finish" | null;
  onRevisit: () => void;
  onFinish: () => void;
  onChooseAnother: () => void;
}) {
  return (
    <Card tone="brand" padded={false} className="p-4 sm:p-6">
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-brand-700">End of the run</p>
      <h2 className="mt-1 text-xl font-semibold text-ink">You reached the end of {label}</h2>

      {!summary ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" rounded="rounded-card" />
          ))}
        </div>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tally label="Calls logged" value={number(summary.calls)} />
            <Tally
              label="Got through"
              value={number(summary.connected)}
              sub={summary.calls ? `${Math.round((summary.connected / summary.calls) * 100)}% of calls` : undefined}
            />
            <Tally
              label="Promised"
              value={number(summary.promised)}
              sub={summary.promised_amount ? currency(summary.promised_amount) : undefined}
            />
            <Tally
              label="Donated"
              value={number(summary.donated)}
              sub={summary.donated_amount ? currency(summary.donated_amount) : undefined}
            />
          </dl>
          {summary.credited > 0 && (
            <p className="mt-3 text-sm text-ink-soft">
              <span className="font-semibold text-good">{currency(summary.credited)}</span> credited to you since you
              started, from links and QRs as well as calls.
            </p>
          )}
          {summary.outcomes.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {summary.outcomes.map((o) => (
                <Badge key={o.disposition} tone="neutral">
                  {o.label} · {o.n}
                </Badge>
              ))}
            </div>
          )}
          {summary.taken > 0 && (
            <p className="mt-3 text-xs text-ink-muted">
              {number(summary.taken)} were stepped past because a colleague had them.
            </p>
          )}
        </>
      )}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {skipped > 0 && (
          <Button size="lg" icon="arrowLeft" loading={busy === "revisit"} disabled={busy !== null} onClick={onRevisit}>
            Go back to {number(skipped)} skipped
          </Button>
        )}
        <Button
          size="lg"
          variant={skipped > 0 ? "secondary" : "primary"}
          icon="check"
          loading={busy === "finish"}
          disabled={busy !== null}
          onClick={onFinish}
        >
          Finish
        </Button>
        <Button size="lg" variant="secondary" disabled={busy !== null} onClick={onChooseAnother}>
          Choose another list
        </Button>
      </div>
    </Card>
  );
}

function Tally({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card bg-surface px-3 py-2.5 shadow-flat">
      <dt className="text-2xs font-medium uppercase tracking-[0.06em] text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums text-ink">{value}</dd>
      {sub && <dd className="text-xs tabular-nums text-ink-soft">{sub}</dd>}
    </div>
  );
}
