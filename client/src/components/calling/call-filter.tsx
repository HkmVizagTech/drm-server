"use client";

// The caller's quick filter, the same on Leads and Nearly gave:
//   All · Not called today · Called today · Not answered
// One tap, always in view - not hidden behind "Filters".

export type CallFilter = "" | "not_today" | "today" | "no_answer";

export const CALL_FILTERS: { value: CallFilter; label: string }[] = [
  { value: "", label: "All" },
  { value: "not_today", label: "Not called today" },
  { value: "today", label: "Called today" },
  { value: "no_answer", label: "Not answered" },
];

export function CallFilterChips({
  value,
  onChange,
  counts,
  className = "",
}: {
  value: CallFilter;
  onChange: (v: CallFilter) => void;
  /** How many behind each, keyed "all" | "not_today" | "today" | "no_answer". */
  counts?: Partial<Record<"all" | "not_today" | "today" | "no_answer", number>> | null;
  className?: string;
}) {
  return (
    <div role="group" aria-label="Calls" className={`flex flex-wrap gap-1.5 ${className}`}>
      {CALL_FILTERS.map((f) => {
        const on = f.value === value;
        const n = counts?.[f.value || "all"];
        return (
          <button
            key={f.value || "all"}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(f.value)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-pill px-3 text-sm font-medium ring-1 ring-inset transition-colors ${
              on
                ? "bg-brand-700 text-white ring-brand-700"
                : "bg-surface text-ink-soft ring-line-strong hover:bg-sunken hover:text-ink"
            }`}
          >
            {f.label}
            {n != null && (
              <span className={`tabular-nums text-xs ${on ? "text-white/80" : "text-ink-muted"}`}>{n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
