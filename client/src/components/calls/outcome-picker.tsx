"use client";

// Choosing several call outcomes at once.
//
// The questions a caller asks of their own calls are rarely about one outcome:
// "who didn't pick up" is No answer + Busy + Switched off, and "who said
// they'd give" is three or four outcomes too. So the two common bundles sit at
// the top as one tap each, and every outcome below is a checkbox. The list
// stays open while ticking - a dropdown that closes after each tick makes
// choosing three outcomes three trips.

import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Icon } from "@/components/ui";

export interface OutcomeOption {
  slug: string;
  label: string;
}

/** The bundles a caller actually reaches for. Slugs missing from Settings are dropped. */
const BUNDLES: { label: string; slugs: string[] }[] = [
  { label: "Didn't pick up", slugs: ["no_answer", "busy", "switched_off"] },
  { label: "Said they'd give", slugs: ["promised", "interested", "will_donate", "will_pay_qr"] },
  { label: "Gave on the call", slugs: ["donated"] },
];

export function OutcomePicker({
  options,
  value,
  onChange,
}: {
  options: OutcomeOption[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const known = new Set(options.map((o) => o.slug));
  const bundles = BUNDLES.map((b) => ({ ...b, slugs: b.slugs.filter((s) => known.has(s)) })).filter(
    (b) => b.slugs.length
  );
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

  const summary = !value.length
    ? "Any outcome"
    : bundles.find((b) => same(b.slugs, value))?.label ??
      (value.length === 1
        ? options.find((o) => o.slug === value[0])?.label ?? value[0].replace(/_/g, " ")
        : `${value.length} outcomes`);

  const toggle = (slug: string) =>
    onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9.5 w-full items-center justify-between gap-2 rounded-control border bg-surface px-3 text-left text-sm shadow-flat transition-[border-color,box-shadow] hover:border-brand-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 ${
          open ? "border-brand-600 ring-2 ring-accent/25" : "border-line-strong"
        }`}
      >
        <span className={`truncate ${value.length ? "text-ink" : "text-ink-faint"}`}>{summary}</span>
        <Icon
          name="chevronDown"
          size={15}
          className={`flex-none text-ink-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose outcomes"
          className="fade-rise absolute left-0 right-0 z-50 mt-1 min-w-64 rounded-control border border-line-strong bg-surface shadow-float sm:right-auto"
        >
          {bundles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-line-soft p-2.5">
              {bundles.map((b) => {
                const on = same(b.slugs, value);
                return (
                  <button
                    key={b.label}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onChange(on ? [] : b.slugs)}
                    className={`rounded-control border px-2.5 py-1.5 text-xs transition-colors ${
                      on
                        ? "border-brand-600 bg-brand-50 font-medium text-brand-800"
                        : "border-line-strong bg-surface text-ink-soft hover:border-brand-400 hover:bg-sunken"
                    }`}
                  >
                    {b.label}
                  </button>
                );
              })}
            </div>
          )}
          <div className="max-h-64 overflow-y-auto py-1">
            {options.map((o) => (
              <div key={o.slug} className="px-3 py-2 hover:bg-brand-50">
                <Checkbox checked={value.includes(o.slug)} onChange={() => toggle(o.slug)} label={o.label} />
              </div>
            ))}
            {!options.length && <p className="px-3 py-2 text-sm text-ink-faint">Loading outcomes…</p>}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-line-soft bg-sunken px-2.5 py-2">
            <Button size="sm" variant="ghost" onClick={() => onChange([])} disabled={!value.length}>
              Any outcome
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
