"use client";

// Small confirmations after an action: "Logged — No answer", "38 added as
// leads", "Couldn't save that".
//
// WHY A MODULE-LEVEL STORE AND NOT A CONTEXT
// The thing that wants to say "done" is usually an async handler several
// components deep, sometimes after the component that started it has
// unmounted (save, then navigate). A context hook would have to be threaded
// into every one of those. `toast()` is a plain function: call it from
// anywhere, and the one <Toaster/> in the shell draws it.
//
// One Toaster, in DashboardLayout. A second would draw every toast twice.

import { useEffect, useState } from "react";
import { Icon, type IconName } from "./icons";

export type ToastTone = "good" | "info" | "warn" | "danger";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  action?: ToastAction;
  ms: number;
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(items));

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

/**
 * Show a toast. Returns a function that removes it early.
 *
 *   toast("Saved")
 *   toast.error("Could not save that", err.message)
 *   toast("Call logged", { action: { label: "Undo", onClick: undo } })
 */
function show(
  title: string,
  opts: { tone?: ToastTone; body?: string; action?: ToastAction; ms?: number } = {}
): () => void {
  const id = nextId++;
  // An action needs time to be read and reached; a plain note does not.
  const ms = opts.ms ?? (opts.action ? 7000 : opts.tone === "danger" ? 6000 : 3500);
  // Four at most - a burst of bulk actions should not stack a column of them.
  items = [...items.slice(-3), { id, title, tone: opts.tone ?? "good", body: opts.body, action: opts.action, ms }];
  emit();
  return () => dismiss(id);
}

export const toast = Object.assign(show, {
  success: (title: string, body?: string) => show(title, { tone: "good", body }),
  info: (title: string, body?: string) => show(title, { tone: "info", body }),
  warn: (title: string, body?: string) => show(title, { tone: "warn", body }),
  error: (title: string, body?: string) => show(title, { tone: "danger", body }),
});

const TONE: Record<ToastTone, { icon: IconName; ring: string; iconClass: string }> = {
  good: { icon: "checkCircle", ring: "ring-good/30", iconClass: "text-good" },
  info: { icon: "info", ring: "ring-info/25", iconClass: "text-info" },
  warn: { icon: "alert", ring: "ring-warn/35", iconClass: "text-warn" },
  danger: { icon: "xCircle", ring: "ring-danger/30", iconClass: "text-danger" },
};

function ToastCard({ t }: { t: ToastItem }) {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (hover) return;
    const timer = window.setTimeout(() => dismiss(t.id), t.ms);
    return () => window.clearTimeout(timer);
  }, [hover, t.id, t.ms]);
  const tone = TONE[t.tone];
  return (
    <div
      role={t.tone === "danger" ? "alert" : "status"}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`pointer-events-auto flex w-full items-start gap-3 rounded-card bg-surface px-4 py-3 shadow-dialog ring-1 ${tone.ring} sm:w-96`}
    >
      <Icon name={tone.icon} size={18} className={`mt-0.5 flex-none ${tone.iconClass}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{t.title}</p>
        {t.body && <p className="mt-0.5 text-sm text-ink-muted">{t.body}</p>}
      </div>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            t.action!.onClick();
            dismiss(t.id);
          }}
          className="flex-none rounded-control px-2 py-1 text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismiss(t.id)}
        className="-mr-1 grid h-6 w-6 flex-none place-items-center rounded-md text-ink-faint hover:bg-sunken hover:text-ink-soft"
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}

/** Mounted once, in the shell. */
export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  if (!list.length) return null;
  return (
    // Bottom-centre on a phone, where the thumb is and nothing else is;
    // bottom-right on a desktop, out of the way of the page.
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-3 sm:items-end sm:p-5">
      {list.map((t) => (
        <ToastCard key={t.id} t={t} />
      ))}
    </div>
  );
}
