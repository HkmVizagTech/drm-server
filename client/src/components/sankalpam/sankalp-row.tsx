"use client";

// One special day on the list: whose it is, how to reach them, and the one or
// two buttons that move it along (To do -> Video ready -> Sent).

import { clockTime, relativeDate } from "@/lib/format";
import { KIND, MONTHS, dayKind, sameName, type Occurrence, type SankalpStatus } from "@/lib/sankalpam";
import { Badge, Button, DropdownMenu, Icon } from "@/components/ui";
import { SourceChip } from "./source-chip";

export function DateTile({ day, month, kind }: { day: number; month: number; kind: ReturnType<typeof dayKind> }) {
  return (
    <span
      className={`grid h-12 w-12 flex-none place-items-center rounded-card text-center leading-none ${KIND[kind].tile}`}
      aria-hidden
    >
      <span>
        <span className="block text-lg font-semibold tabular-nums">{day}</span>
        <span className="block text-2xs font-medium uppercase tracking-wide">{MONTHS[month - 1]}</span>
      </span>
    </span>
  );
}

export function SankalpRow({
  o,
  busy,
  selected,
  onSelect,
  onStatus,
  onEdit,
  lateBy,
}: {
  o: Occurrence;
  busy?: boolean;
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  onStatus: (o: Occurrence, status: SankalpStatus) => void;
  onEdit: (donorId: string) => void;
  /** "2 days late", for the missed list. */
  lateBy?: string | null;
}) {
  const kind = dayKind(o.occasion);
  const done = o.status === "sent" || o.status === "skipped";
  const tel = o.phone ? `tel:+91${o.phone}` : null;

  return (
    <li
      className={`flex flex-wrap items-start gap-x-3 gap-y-2.5 px-4 py-3.5 transition-colors sm:px-5 ${
        done ? "bg-sunken/40" : "hover:bg-brand-50/50"
      } ${selected ? "bg-brand-50" : ""}`}
    >
      {onSelect && !done && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={(e) => onSelect(e.target.checked)}
          aria-label={`Select ${o.donor_name}`}
          className="mt-4 h-4 w-4 flex-none accent-brand-700"
        />
      )}
      <DateTile day={o.day} month={o.month} kind={kind} />

      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`font-semibold ${done ? "text-ink-soft" : "text-ink"}`}>{o.occasion}</span>
          <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium ring-1 ring-inset ${KIND[kind].chip}`}>
            <Icon name={KIND[kind].icon} size={11} />
            {KIND[kind].label}
          </span>
          <SourceChip source={o.source} />
          {lateBy && <Badge tone="danger">{lateBy}</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-ink-soft">
          <button type="button" onClick={() => onEdit(o.donor_id)} className="font-medium text-ink hover:text-brand-700 hover:underline">
            {o.donor_name}
          </button>
          {!sameName(o.sevak_name, o.donor_name) && <span className="text-ink-muted"> · on the name of {o.sevak_name}</span>}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-ink-muted">
          {tel ? (
            <a href={tel} className="inline-flex items-center gap-1 tabular-nums text-brand-700 hover:underline">
              <Icon name="phone" size={12} />
              {o.phone}
            </a>
          ) : (
            <span className="text-warn">No mobile number</span>
          )}
          {o.preacher && <span title={o.preacher_name ?? undefined}>{o.preacher_name ? `${o.preacher_name} (${o.preacher})` : o.preacher}</span>}
          {o.patron_number && <span className="tabular-nums">{o.patron_number}</span>}
        </p>
        {o.date_notes && <p className="mt-0.5 text-xs text-ink-muted">“{o.date_notes}”</p>}
      </div>

      <div className="flex w-full flex-wrap items-center justify-end gap-1.5 sm:w-auto sm:flex-nowrap">
        {o.status === "todo" && (
          <>
            <Button variant="secondary" size="sm" className="max-sm:h-11" loading={busy} onClick={() => onStatus(o, "ready")}>
              Video ready
            </Button>
            <Button size="sm" icon="check" className="max-sm:h-11" loading={busy} onClick={() => onStatus(o, "sent")}>
              Sent
            </Button>
          </>
        )}
        {o.status === "ready" && (
          <>
            <Badge tone="info" icon="checkCircle">
              Video ready
            </Badge>
            <Button size="sm" icon="check" className="max-sm:h-11" loading={busy} onClick={() => onStatus(o, "sent")}>
              Sent
            </Button>
          </>
        )}
        {done && (
          <>
            <span className="text-right">
              <Badge tone={o.status === "sent" ? "good" : "neutral"} icon={o.status === "sent" ? "checkCircle" : undefined}>
                {o.status === "sent" ? "Sent" : "Skipped this year"}
              </Badge>
              {o.done_at && (
                <span className="mt-0.5 block text-2xs text-ink-faint">
                  {o.done_by_name ? `${o.done_by_name} · ` : ""}
                  {relativeDate(o.done_at)} {clockTime(o.done_at)}
                </span>
              )}
            </span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onStatus(o, "todo")}>
              Undo
            </Button>
          </>
        )}
        <DropdownMenu
          items={[
            ...(o.status === "ready" ? [{ label: "Back to to do", icon: "arrowLeft" as const, onSelect: () => onStatus(o, "todo") }] : []),
            ...(!done ? [{ label: "Skip this year", icon: "x" as const, onSelect: () => onStatus(o, "skipped") }] : []),
            { label: "Edit donor and days", icon: "edit" as const, onSelect: () => onEdit(o.donor_id) },
          ]}
          trigger={({ open, toggle }) => (
            <Button
              variant="ghost"
              size="sm"
              icon="more"
              className="max-sm:h-11"
              onClick={toggle}
              aria-expanded={open}
              aria-haspopup="menu"
              aria-label="More"
            />
          )}
        />
      </div>
    </li>
  );
}
