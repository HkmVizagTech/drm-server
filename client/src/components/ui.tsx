"use client";

// Shared UI primitives for the admin. Every screen composes from these so
// spacing, radii, borders and empty/loading states stay consistent instead of
// each page inventing its own card and table styling.

import { ReactNode } from "react";
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
