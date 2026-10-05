"use client";

// The keys, written down where they are used.
//
// Shortcuts nobody can discover are shortcuts nobody uses; a caller with one
// hand on the handset is exactly who they are for. "?" opens this, as it does
// in most tools a caller will have met.

import { useEffect, useRef } from "react";
import type { Disposition } from "@/lib/calling";

export function ShortcutHelp({
  dispositions,
  keys,
  inRun,
  onClose,
}: {
  dispositions: Disposition[];
  keys: Map<string, number>;
  inRun: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const keyed = [...keys.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([slug, n]) => ({ n, label: dispositions.find((d) => d.slug === slug)?.label ?? slug }));

  const rows: [string, string][] = [
    ...(inRun
      ? ([
          ["←", "Previous person"],
          ["→", "Next person"],
          ["S", "Skip"],
        ] as [string, string][])
      : []),
    ["U", "Undo last call"],
    ["N", "Write a note"],
    ["R", "Add a promise"],
    ["C", "Copy number"],
    ["W", "Send WhatsApp link"],
    ["Esc", "Leave text box"],
  ];

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="fade-rise absolute right-0 z-50 mt-2 w-80 rounded-control border border-line-strong bg-surface p-4 shadow-float"
    >
      <p className="text-sm font-semibold text-ink">Keyboard shortcuts</p>

      <ul className="mt-3 space-y-1 text-sm">
        {keyed.map((k) => (
          <li key={k.n} className="flex items-center justify-between gap-3">
            <span className="text-ink-soft">{k.label}</span>
            <kbd className="rounded border border-line-strong bg-sunken px-1.5 text-xs tabular-nums">{k.n}</kbd>
          </li>
        ))}
      </ul>
      <ul className="mt-3 space-y-1 border-t border-line-soft pt-3 text-sm">
        {rows.map(([k, label]) => (
          <li key={k} className="flex items-center justify-between gap-3">
            <span className="text-ink-soft">{label}</span>
            <kbd className="rounded border border-line-strong bg-sunken px-1.5 text-xs">{k}</kbd>
          </li>
        ))}
      </ul>

    </div>
  );
}
