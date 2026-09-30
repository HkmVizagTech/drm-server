"use client";

// Shared UI primitives for the admin. Every screen composes from these so
// spacing, radii, borders and empty/loading states stay consistent instead of
// each page inventing its own card and table styling.

import { Children, Fragment, isValidElement, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { currency, number, percentChange } from "@/lib/format";

/* ---------------------------------------------------------------- surfaces */

export function Card({
  children,
  className = "",
  padded = true,
  id,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  // Lets a card be an anchor target, so a link like /pages#donate scrolls
  // straight to the section instead of dumping you at the top of the screen.
  id?: string;
}) {
  return (
    <div
      id={id}
      className={`bg-[var(--surface)] rounded-xl border border-[var(--line-soft)] shadow-sm ${padded ? "p-5" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- stat tiles */

// A stat tile is a hero number, not a chart - so no plot, no color-coded
// background. Tone is carried by a small label and an optional delta, keeping
// the number itself the loudest thing on the tile.
export function StatTile({
  label,
  value,
  sub,
  delta,
  accent = "default",
}: {
  label: string;
  value: string | number;
  sub?: string;
  delta?: { current: number; previous: number; label?: string };
  accent?: "default" | "brand" | "good" | "warn";
}) {
  const accents: Record<string, string> = {
    default: "text-slate-900",
    brand: "text-[var(--accent)]",
    good: "text-emerald-700",
    warn: "text-amber-700",
  };

  const pct = delta ? percentChange(delta.current, delta.previous) : null;

  return (
    <Card className="min-w-0">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-semibold mt-2 tabular-nums truncate ${accents[accent]}`}>{value}</p>
      <div className="mt-1.5 flex items-center gap-2 min-h-[1.25rem]">
        {pct !== null && (
          <span
            className={`inline-flex items-center gap-0.5 text-xs font-medium ${
              pct >= 0 ? "text-emerald-700" : "text-red-700"
            }`}
          >
            {/* arrow + sign, so direction never relies on color alone */}
            <span aria-hidden>{pct >= 0 ? "▲" : "▼"}</span>
            {pct >= 0 ? "+" : ""}
            {pct.toFixed(0)}%
            {delta?.label && <span className="text-slate-400 font-normal ml-1">{delta.label}</span>}
          </span>
        )}
        {sub && <span className="text-xs text-slate-500 truncate">{sub}</span>}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ badges */

type BadgeTone = "neutral" | "good" | "warn" | "info" | "danger" | "brand";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  good: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  info: "bg-sky-50 text-sky-800 ring-sky-200",
  danger: "bg-red-50 text-red-800 ring-red-200",
  brand: "bg-[var(--accent-wash)] text-[var(--accent)] ring-[var(--accent)]/25",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ring-1 ring-inset whitespace-nowrap ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

// Status text always ships with its own label (never color alone), so a
// colorblind reader or a greyscale print still reads the state.
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, BadgeTone> = {
    active: "good",
    completed: "good",
    delivered: "good",
    confirmed: "good",
    paused: "warn",
    pending: "warn",
    packed: "info",
    shipped: "info",
    cancelled: "neutral",
    returned: "danger",
    failed: "danger",
  };
  return <Badge tone={map[status] ?? "neutral"}>{status.replace(/_/g, " ")}</Badge>;
}

/* ------------------------------------------------------------------ avatar */

export function Avatar({ name }: { name: string }) {
  // Deterministic tint from the name so the same donor keeps the same chip
  // colour across screens. Decorative only - never the sole carrier of meaning.
  const tints = [
    "bg-sky-100 text-sky-800",
    "bg-emerald-100 text-emerald-800",
    "bg-amber-100 text-amber-800",
    "bg-violet-100 text-violet-800",
    "bg-rose-100 text-rose-800",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const tint = tints[hash % tints.length];
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();

  return (
    <span
      className={`flex-none w-8 h-8 rounded-full grid place-items-center text-xs font-semibold ${tint}`}
      aria-hidden
    >
      {letters || "?"}
    </span>
  );
}

/* ------------------------------------------------------------------ tables */

export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="bg-[var(--surface)] rounded-xl border border-[var(--line-soft)] shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">{children}</table>
      </div>
    </div>
  );
}

// Alignment classes are looked up from a literal map rather than built as
// `text-${align}` - Tailwind scans source for complete class strings at build
// time, so an interpolated name is never generated and silently does nothing.
const ALIGN: Record<"left" | "right" | "center", string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

export function Th({
  children,
  align = "left",
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return (
    <th
      className={`px-4 py-3 font-medium text-xs uppercase tracking-wide text-slate-500 ${ALIGN[align]} ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return <td className={`px-4 py-3 ${ALIGN[align]} ${className}`}>{children}</td>;
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="py-16 px-6 text-center">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function SkeletonRows({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <tbody className="divide-y divide-slate-100">
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-4 py-3">
              <div className="h-3 rounded bg-slate-100 animate-pulse" style={{ width: c === 0 ? "60%" : "40%" }} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/* -------------------------------------------------------------- pagination */

// The bug this fixes: the list showed 20 rows while the API reported thousands,
// with no way to reach page 2. Always renders the range so the count on screen
// and the total agree visibly.
export function Pagination({
  page,
  limit,
  total,
  totalPages,
  onPage,
  unit = "records",
}: {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  onPage: (page: number) => void;
  unit?: string;
}) {
  if (!total) return null;

  const first = (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);

  // A compact window around the current page - a 4,000-record list has 160
  // pages and rendering every number is unusable.
  const pages: (number | "gap")[] = [];
  const push = (p: number) => { if (!pages.includes(p)) pages.push(p); };
  push(1);
  if (page - 2 > 2) pages.push("gap");
  for (let p = Math.max(2, page - 1); p <= Math.min(totalPages - 1, page + 1); p++) push(p);
  if (page + 2 < totalPages - 1) pages.push("gap");
  if (totalPages > 1) push(totalPages);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-[var(--line-soft)] bg-[var(--page)]/60">
      <p className="text-xs text-slate-600 tabular-nums">
        Showing <span className="font-medium text-slate-900">{number(first)}</span>–
        <span className="font-medium text-slate-900">{number(last)}</span> of{" "}
        <span className="font-medium text-slate-900">{number(total)}</span> {unit}
      </p>

      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          className="px-2.5 py-1.5 text-xs rounded-md border border-[var(--line-strong)] bg-white text-slate-700 hover:bg-[var(--page)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        {pages.map((p, i) =>
          p === "gap" ? (
            <span key={`gap-${i}`} className="px-1 text-xs text-slate-400">
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p)}
              aria-current={p === page ? "page" : undefined}
              className={`min-w-[2rem] px-2 py-1.5 text-xs rounded-md border tabular-nums ${
                p === page
                  ? "border-[var(--accent)] bg-[var(--accent)] text-white font-medium"
                  : "border-[var(--line-strong)] bg-white text-slate-700 hover:bg-[var(--page)]"
              }`}
            >
              {p}
            </button>
          )
        )}
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
          className="px-2.5 py-1.5 text-xs rounded-md border border-[var(--line-strong)] bg-white text-slate-700 hover:bg-[var(--page)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

export const inputClass =
  "px-3 py-2 text-sm border border-[var(--line-strong)] rounded-lg bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]";

export const buttonPrimary =
  "inline-flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3.5 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

export const buttonSecondary =
  "inline-flex items-center gap-1.5 border border-[var(--line-strong)] bg-white hover:bg-[var(--page)] text-slate-700 px-3.5 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

export function MoneyCell({ value }: { value: number | string }) {
  return <span className="font-semibold tabular-nums text-slate-900">{currency(value)}</span>;
}

/* ----------------------------------------------------------------- select */

// A dropdown in the temple's own colours.
//
// WHY THIS EXISTS AT ALL, when <select> is right there: a native select's
// CLOSED box can be styled, but the list that drops out of it is drawn by
// Windows, not by the page. No CSS reaches it. So a screen full of native
// selects looks half-themed - green everywhere except the one part people
// actually look at while choosing, which is grey with a blue highlight.
//
// This is a button plus a listbox, so the options carry the same accent green
// as the rest of DRM. The cost of doing that is having to re-implement what the
// browser gave for free, so the things people actually rely on are all here:
// arrow keys and Home/End move through the options, Enter and Space choose,
// Escape and a click outside close, type-ahead jumps to an option by its first
// letters, the open list scrolls the selected option into view, and the whole
// thing is labelled as a listbox for screen readers.
//
// One deliberate limitation: this does not render inside a native <form>
// submission. Everything in DRM posts through fetch, so nothing needs it.

export interface SelectOption {
  value: string;
  label: string;
  // An optional second line - "12 leads", "last called 3 days ago". Worth more
  // than it sounds: most dropdown choices in this admin are made on a number
  // the person would otherwise have to go and look up.
  hint?: string;
  disabled?: boolean;
  // Options carrying a group render under a small heading, and options without
  // one render first and bare. Used where a list mixes two kinds of thing a
  // person thinks about differently - a caller's own presets and the temple's
  // shared links, say - because a flat list of both reads as one pile.
  group?: string;
}

export function Select({
  value,
  onChange,
  options,
  children,
  placeholder = "Select…",
  className = "",
  disabled = false,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Either pass options directly… */
  options?: SelectOption[];
  /** …or pass <option> children, so this drops straight into existing markup. */
  children?: ReactNode;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  // Reading <option> children rather than demanding an options array is what
  // let every dropdown in DRM switch over in one pass instead of each screen
  // being rewritten by hand - and it keeps the familiar shape for anyone
  // adding a dropdown later. Children.toArray flattens the arrays that
  // {list.map(...)} produces and drops nulls, which is exactly the shape these
  // call sites already have.
  const fromChildren: SelectOption[] = useMemo(() => {
    if (!children) return [];
    return Children.toArray(children)
      .filter(isValidElement)
      .map((el) => {
        const props = (el as React.ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>).props;
        const label = typeof props.children === "string" || typeof props.children === "number"
          ? String(props.children)
          // An <option> whose text is built from an expression ({u.name}) comes
          // through as an array of nodes; join the string-ish parts rather than
          // rendering "[object Object]".
          : Children.toArray(props.children).filter((c) => typeof c === "string" || typeof c === "number").join("");
        return { value: String(props.value ?? ""), label, disabled: props.disabled };
      });
  }, [children]);

  const opts = options ?? fromChildren;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ buffer: "", at: 0 });

  const selectedIndex = opts.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? opts[selectedIndex] : null;

  // Close when the click lands anywhere else. Pointerdown rather than click so
  // the list closes before the thing underneath reacts.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Open on the current choice, not at the top: a list of twenty stages should
  // not make you scroll back to where you already were.
  useEffect(() => {
    if (open) setActive(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    // Query the options rather than indexing children: group headings are
    // siblings in the same list, so children[active] would point at the wrong
    // element the moment a list has headings in it.
    listRef.current.querySelectorAll('[role="option"]')[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const commit = (i: number) => {
    const opt = opts[i];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  };

  const step = (delta: number) => {
    if (!opts.length) return;
    let i = active;
    // Skip over disabled options rather than landing on one and doing nothing.
    for (let n = 0; n < opts.length; n++) {
      i = (i + delta + opts.length) % opts.length;
      if (!opts[i].disabled) break;
    }
    setActive(i);
  };

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;

    if (!open && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;

    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); step(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); step(-1); return; }
    if (e.key === "Home") { e.preventDefault(); setActive(0); return; }
    if (e.key === "End") { e.preventDefault(); setActive(opts.length - 1); return; }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); commit(active); return; }
    if (e.key === "Tab") { setOpen(false); return; }

    // Type-ahead. Letters typed within a second of each other build up a
    // prefix, so "vi" finds Visakhapatnam rather than stopping at Vizag.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typed.current.buffer = now - typed.current.at > 1000 ? e.key : typed.current.buffer + e.key;
      typed.current.at = now;
      const q = typed.current.buffer.toLowerCase();
      const hit = opts.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(q));
      if (hit >= 0) setActive(hit);
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left rounded-lg border bg-white transition-colors
          ${disabled ? "opacity-50 cursor-not-allowed" : "hover:border-[var(--accent)]/50 cursor-pointer"}
          ${open ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/25" : "border-[var(--line-strong)]"}`}
      >
        <span className={`truncate ${selected ? "text-slate-900" : "text-slate-400"}`}>
          {selected?.label ?? placeholder}
        </span>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden
          className={`w-4 h-4 flex-none text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          className="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-[var(--line-strong)] bg-white py-1 shadow-lg"
        >
          {!opts.length && <li className="px-3 py-2 text-sm text-slate-400">Nothing to choose from</li>}
          {opts.map((o, i) => {
            const isSelected = o.value === value;
            // A heading whenever the group changes. Rendered as a sibling
            // rather than a nested <ul>, so arrow-key movement still walks one
            // flat list of options and never lands on a heading.
            const heading = o.group && o.group !== opts[i - 1]?.group ? o.group : null;
            return (
              <Fragment key={o.value}>
              {heading && (
                <li
                  role="presentation"
                  className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400"
                >
                  {heading}
                </li>
              )}
              <li
                role="option"
                aria-selected={isSelected}
                aria-disabled={o.disabled || undefined}
                onPointerEnter={() => !o.disabled && setActive(i)}
                onClick={() => commit(i)}
                className={`px-3 py-2 text-sm flex items-start justify-between gap-3
                  ${o.disabled ? "text-slate-300 cursor-not-allowed" : "cursor-pointer"}
                  ${!o.disabled && i === active ? "bg-[var(--accent-wash)]" : ""}
                  ${isSelected ? "text-[var(--accent-ink)] font-medium" : o.disabled ? "" : "text-slate-700"}`}
              >
                <span className="min-w-0">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && <span className="block text-[11px] text-slate-400 truncate">{o.hint}</span>}
                </span>
                {isSelected && (
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 flex-none mt-0.5">
                    <path d="M5 10l3.5 3.5L15 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}


/**
 * A dialog.
 *
 * Lived privately inside the leads screen until three screens wanted one and
 * the choice was to copy it twice more or move it here. Deliberately plain:
 * no focus trap or portal, because every use is a short form inside the admin
 * shell and the browser's own behaviour is adequate for that.
 *
 * Escape closes it, and the backdrop does not — a mis-click while filling in a
 * list of assignees should not throw the form away.
 */
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`mt-12 w-full ${wide ? "max-w-3xl" : "max-w-2xl"} rounded-xl bg-white shadow-xl`}
      >
        <div className="flex items-center justify-between border-b border-[var(--line-soft)] px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-600 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}


/**
 * An on/off switch.
 *
 * role="switch" with aria-checked rather than a styled checkbox: a screen
 * reader then says "on"/"off" instead of "checked", which is what the control
 * actually means everywhere it is used here — an account that can sign in, a
 * preacher still in the dropdowns.
 */
export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        on ? "bg-[var(--accent)]" : "bg-slate-200"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          on ? "translate-x-4.5" : "translate-x-1"
        }`}
      />
    </button>
  );
}
