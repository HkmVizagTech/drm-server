"use client";

// Shared UI primitives for the admin.
//
// WHAT CHANGED AND WHY IT MATTERS
//
// This file used to export a Button as two strings:
//
//   export const buttonPrimary = "inline-flex items-center gap-1.5 bg-…"
//
// A string cannot have a loading state, cannot own its disabled behaviour,
// cannot carry an icon, and cannot be given a variant it does not already
// have. So whenever a screen needed a small button, or a destructive one, or
// one with a spinner, the author wrote their own class string - and an audit
// counted fourteen distinct hand-rolled button styles, five paddings, three
// different hover treatments and four different disabled opacities across
// twenty-six pages. Buttons were, in the words of the person who uses this
// every day, "basic and hard to find".
//
// They are components now. The two strings are still exported, and still
// work, but they are generated from the same source as the component - so the
// ninety-odd places that reference them picked up the new look without being
// touched, and the next person who needs a variant finds one instead of
// inventing it.
//
// The same reasoning applies to everything added here: Tabs (three
// incompatible implementations existed), Alert (eighteen copies of one error
// banner), Spinner (none existed at all, so every page invented a loading
// treatment), Checkbox, Field, Toolbar, SegmentedControl, DropdownMenu and
// ExportButton. If a thing appears on more than one screen it belongs in this
// file, because the alternative is not "a bit of duplication" - it is drift.

import {
  Children,
  Fragment,
  isValidElement,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { currency, number, percentChange } from "@/lib/format";
import { Icon, Spinner, type IconName } from "./icons";

export { Icon, Spinner };
export type { IconName };

/* ------------------------------------------------------------------ tokens */

/**
 * The focus treatment, in one place.
 *
 * Every interactive thing in the product gets the same ring. Written as a
 * constant rather than a global rule because a ring needs an offset colour to
 * sit against, and that differs between a white card and a green sidebar.
 */
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

/* ---------------------------------------------------------------- surfaces */

export function Card({
  children,
  className = "",
  padded = true,
  id,
  /** Lifts the card and shows a pointer, for a card that is itself a link. */
  interactive = false,
  tone,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  // Lets a card be an anchor target, so a link like /pages#donate scrolls
  // straight to the section instead of dumping you at the top of the screen.
  id?: string;
  interactive?: boolean;
  tone?: "default" | "brand" | "warn" | "danger";
}) {
  const tones = {
    default: "bg-surface border-line-soft",
    brand: "bg-brand-50 border-brand-200",
    warn: "bg-warn-wash border-amber-200",
    danger: "bg-danger-wash border-red-200",
  } as const;
  return (
    <div
      id={id}
      className={`rounded-card border shadow-card ${tones[tone ?? "default"]} ${
        padded ? "p-5" : ""
      } ${
        interactive
          ? "transition-[box-shadow,border-color,transform] duration-150 hover:-translate-y-px hover:border-brand-300 hover:shadow-raised"
          : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  icon,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && (
          <span className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-control bg-brand-50 text-brand-700">
            <Icon name={icon} size={15} />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

/**
 * The top of a page.
 *
 * The eyebrow is new and does real work: the desktop shell has no breadcrumb
 * trail, so on a product with nine calling screens there was nothing on the
 * page itself saying which section you were in. One grey line costs nothing
 * and answers it.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-line-soft pb-5">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-brand-600">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The row of filters above a list.
 *
 * Four different filter layouts existed - a bare flex-wrap, a Card wrapping a
 * six-column grid, a labelled four-column grid, and a labelled flex-end row -
 * so the same act looked different on every screen and a filter was genuinely
 * hard to spot. This is the one shape: a sunken bar that reads as a control
 * strip rather than as more content.
 */
export function Toolbar({
  children,
  className = "",
  onClear,
  activeCount = 0,
}: {
  children: ReactNode;
  className?: string;
  /** Shown only when something is actually filtered, so it is never noise. */
  onClear?: () => void;
  activeCount?: number;
}) {
  return (
    <div
      className={`mb-4 rounded-card border border-line-soft bg-surface p-3 shadow-flat ${className}`}
    >
      <div className="flex flex-wrap items-end gap-2.5">{children}</div>
      {onClear && activeCount > 0 && (
        <div className="mt-2.5 flex items-center gap-2 border-t border-line-soft pt-2.5">
          <span className="text-xs text-ink-muted">
            {activeCount} filter{activeCount === 1 ? "" : "s"} applied
          </span>
          <Button size="xs" variant="ghost" icon="x" onClick={onClear}>
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}

/** A labelled control inside a Toolbar or a form. */
export function Field({
  label,
  children,
  hint,
  error,
  required,
  className = "",
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-xs font-medium text-ink-soft"
      >
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {children}
      {error ? (
        <p className="mt-1 flex items-center gap-1 text-xs text-danger">
          <Icon name="alert" size={12} />
          {error}
        </p>
      ) : (
        hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ button */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "dangerSoft"
  | "whatsapp";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

const SIZES: Record<ButtonSize, string> = {
  xs: "h-7 gap-1 px-2 text-xs rounded-md",
  sm: "h-8 gap-1.5 px-2.5 text-xs rounded-control",
  md: "h-9.5 gap-1.5 px-3.5 text-sm rounded-control",
  lg: "h-11 gap-2 px-5 text-base rounded-control",
};

// Every variant carries a border, even where the border matches the fill. It
// keeps the metrics identical between a filled and an outlined button, so a
// row of mixed buttons lines up instead of being a pixel out.
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border border-brand-700 bg-brand-600 text-white shadow-button hover:bg-brand-700 hover:border-brand-800 active:bg-brand-800 active:shadow-none",
  secondary:
    "border border-line-strong bg-surface text-ink-soft shadow-flat hover:bg-sunken hover:border-brand-400 hover:text-ink active:bg-brand-50 active:shadow-none",
  ghost:
    "border border-transparent bg-transparent text-ink-muted hover:bg-brand-50 hover:text-brand-800 active:bg-brand-100",
  danger:
    "border border-red-700 bg-danger text-white shadow-button hover:bg-red-700 active:bg-red-800 active:shadow-none",
  dangerSoft:
    "border border-red-200 bg-surface text-danger shadow-flat hover:bg-danger-wash hover:border-red-300 active:bg-red-100",
  // WhatsApp's own green, because a button that opens WhatsApp is recognised
  // by that colour and nothing else. Two different hover treatments for it
  // existed in two files; this is the one.
  whatsapp:
    "border border-[#1da851] bg-[#25D366] text-white shadow-button hover:bg-[#1da851] active:bg-[#17803d] active:shadow-none",
};

const BUTTON_BASE =
  "inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none";

export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  extra = ""
): string {
  return `${BUTTON_BASE} ${SIZES[size]} ${VARIANTS[variant]} ${FOCUS} ${extra}`;
}

/**
 * KEPT, AND NOW GENERATED.
 *
 * Around ninety call sites use these two strings. Regenerating them from the
 * same source as the component means every one of those picked up the new
 * styling without being edited, and they cannot drift from `<Button>` later.
 * New code should use the component - it gets the loading state and the icon
 * handling, which a class string cannot give.
 */
export const buttonPrimary = buttonClass("primary", "md");
export const buttonSecondary = buttonClass("secondary", "md");
export const buttonGhost = buttonClass("ghost", "md");
export const buttonDanger = buttonClass("dangerSoft", "md");

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  /**
   * Shows a spinner and blocks the click. The label stays put rather than
   * being replaced - a button that changes width mid-save moves the thing
   * beside it, and on a form that is how somebody double-submits.
   */
  loading?: boolean;
  block?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  loading = false,
  block = false,
  className = "",
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const iconSize = size === "lg" ? 18 : size === "xs" ? 13 : 15;
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, `${block ? "w-full" : ""} ${className}`)}
      {...rest}
    >
      {loading ? (
        <Spinner size={iconSize} />
      ) : (
        icon && <Icon name={icon} size={iconSize} />
      )}
      {children}
      {iconRight && !loading && <Icon name={iconRight} size={iconSize} />}
    </button>
  );
}

/**
 * A button that is really a link.
 *
 * Separate component rather than an `as` prop: an anchor and a button take
 * different attributes, and conflating them produces a control that is
 * neither keyboard-correct nor type-safe.
 */
export function LinkButton({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  className = "",
  children,
  ...rest
}: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "className"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  className?: string;
}) {
  const iconSize = size === "lg" ? 18 : size === "xs" ? 13 : 15;
  return (
    <a className={buttonClass(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={iconSize} />}
      {children}
      {iconRight && <Icon name={iconRight} size={iconSize} />}
    </a>
  );
}

/** A square button carrying only an icon. The label is required, not optional. */
export function IconButton({
  name,
  label,
  variant = "ghost",
  size = "md",
  className = "",
  loading = false,
  ...rest
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  name: IconName;
  /** Announced to a screen reader and shown as the tooltip. Never skip it. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  loading?: boolean;
}) {
  const box = { xs: "h-7 w-7", sm: "h-8 w-8", md: "h-9.5 w-9.5", lg: "h-11 w-11" }[size];
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={rest.disabled || loading}
      className={`${BUTTON_BASE} ${box} rounded-control ${VARIANTS[variant]} ${FOCUS} ${className}`}
      {...rest}
    >
      {loading ? <Spinner size={15} /> : <Icon name={name} size={size === "lg" ? 18 : 15} />}
    </button>
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
  icon,
  loading = false,
}: {
  label: string;
  value: string | number;
  sub?: string;
  delta?: { current: number; previous: number; label?: string };
  accent?: "default" | "brand" | "good" | "warn" | "danger";
  icon?: IconName;
  loading?: boolean;
}) {
  const accents: Record<string, string> = {
    default: "text-ink",
    brand: "text-brand-700",
    good: "text-good",
    warn: "text-warn",
    danger: "text-danger",
  };
  const chips: Record<string, string> = {
    default: "bg-sunken text-ink-muted",
    brand: "bg-brand-100 text-brand-700",
    good: "bg-good-wash text-good",
    warn: "bg-warn-wash text-warn",
    danger: "bg-danger-wash text-danger",
  };

  const pct = delta ? percentChange(delta.current, delta.previous) : null;

  return (
    <Card className="min-w-0">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
        {icon && (
          <span className={`grid h-7 w-7 flex-none place-items-center rounded-control ${chips[accent]}`}>
            <Icon name={icon} size={15} />
          </span>
        )}
      </div>
      {loading ? (
        <div className="mt-2.5 h-7 w-24 rounded shimmer" />
      ) : (
        <p className={`mt-2 truncate text-2xl font-semibold tabular-nums ${accents[accent]}`}>
          {value}
        </p>
      )}
      <div className="mt-1.5 flex min-h-[1.25rem] items-center gap-2">
        {pct !== null && (
          <span
            className={`inline-flex items-center gap-0.5 text-xs font-medium ${
              pct >= 0 ? "text-good" : "text-danger"
            }`}
          >
            {/* arrow + sign, so direction never relies on color alone */}
            <Icon name={pct >= 0 ? "arrowUp" : "arrowDown"} size={12} />
            {pct >= 0 ? "+" : ""}
            {pct.toFixed(0)}%
            {delta?.label && <span className="ml-1 font-normal text-ink-faint">{delta.label}</span>}
          </span>
        )}
        {sub && <span className="truncate text-xs text-ink-muted">{sub}</span>}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ badges */

type BadgeTone = "neutral" | "good" | "warn" | "info" | "danger" | "brand";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-sunken text-ink-soft ring-line-soft",
  good: "bg-good-wash text-good ring-emerald-200",
  warn: "bg-warn-wash text-warn ring-amber-200",
  info: "bg-info-wash text-info ring-sky-200",
  danger: "bg-danger-wash text-danger ring-red-200",
  brand: "bg-brand-100 text-brand-800 ring-brand-300",
};

export function Badge({
  children,
  tone = "neutral",
  icon,
  /** A filled dot before the label, for a status that reads as a state. */
  dot = false,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  icon?: IconName;
  dot?: boolean;
}) {
  const dots: Record<BadgeTone, string> = {
    neutral: "bg-ink-faint",
    good: "bg-good",
    warn: "bg-warn",
    info: "bg-info",
    danger: "bg-danger",
    brand: "bg-brand-600",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE_TONES[tone]}`}
    >
      {dot && <span className={`h-1.5 w-1.5 flex-none rounded-full ${dots[tone]}`} aria-hidden />}
      {icon && <Icon name={icon} size={12} />}
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
    converted: "good",
    paid: "good",
    captured: "good",
    paused: "warn",
    pending: "warn",
    created: "warn",
    attempted: "warn",
    packed: "info",
    shipped: "info",
    cancelled: "neutral",
    returned: "danger",
    failed: "danger",
  };
  return (
    <Badge tone={map[status] ?? "neutral"} dot>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

/* ------------------------------------------------------------------ avatar */

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
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

  const box = {
    sm: "w-6 h-6 text-2xs",
    md: "w-8 h-8 text-xs",
    lg: "w-10 h-10 text-sm",
  }[size];

  return (
    <span
      className={`grid flex-none place-items-center rounded-full font-semibold ring-1 ring-inset ring-black/5 ${box} ${tint}`}
      aria-hidden
    >
      {letters || "?"}
    </span>
  );
}

/* ------------------------------------------------------------------ tables */

export function TableShell({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-card border border-line-soft bg-surface shadow-card ${className}`}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">{children}</table>
      </div>
    </div>
  );
}

/**
 * The header row.
 *
 * New, and the reason is counted: twenty-four <thead> elements across the app
 * carried three different treatments - `bg-slate-50/80 border-b`,
 * `bg-slate-50/80` with no border, and a legacy `bg-gray-50 text-gray-600`.
 * Having a component means a table cannot be built with the wrong one.
 */
export function Thead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-line-soft bg-sunken">
      <tr>{children}</tr>
    </thead>
  );
}

/** The body, with the row dividers and hover applied once. */
export function Tbody({
  children,
  hoverable = true,
}: {
  children: ReactNode;
  hoverable?: boolean;
}) {
  return (
    <tbody
      className={`divide-y divide-line-soft ${
        hoverable ? "[&>tr]:transition-colors [&>tr:hover]:bg-brand-50/60" : ""
      }`}
    >
      {children}
    </tbody>
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
  /** Turns the header into a sort control. */
  sort,
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  sort?: { active: boolean; direction?: "asc" | "desc"; onSort: () => void };
}) {
  const base = `px-4 py-2.5 text-2xs font-semibold uppercase tracking-[0.06em] text-ink-muted ${ALIGN[align]} ${className}`;
  if (!sort) return <th className={base}>{children}</th>;
  return (
    <th className={base} aria-sort={sort.active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={sort.onSort}
        className={`inline-flex items-center gap-1 rounded transition-colors hover:text-brand-700 ${
          sort.active ? "text-brand-700" : ""
        } ${FOCUS}`}
      >
        {children}
        <Icon
          name={sort.active && sort.direction === "asc" ? "chevronUp" : "chevronDown"}
          size={12}
          className={sort.active ? "opacity-100" : "opacity-35"}
        />
      </button>
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className = "",
  colSpan,
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className={`px-4 py-3 text-ink-soft ${ALIGN[align]} ${className}`}>
      {children}
    </td>
  );
}

export function EmptyState({
  title,
  message,
  action,
  icon = "inbox",
}: {
  title: string;
  message: string;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="px-6 py-14 text-center">
      {/* An empty table with nothing but two lines of grey text reads as a
          page that failed to load. A mark gives it a centre and says "this is
          a state, not a breakage". */}
      <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-brand-50 text-brand-500 ring-1 ring-inset ring-brand-100">
        <Icon name={icon} size={20} />
      </span>
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{message}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function SkeletonRows({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <tbody className="divide-y divide-line-soft">
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-4 py-3.5">
              <div className="h-3 rounded shimmer" style={{ width: c === 0 ? "62%" : "40%" }} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/**
 * A loading block for anything that is not a table.
 *
 * Ten files each wrote their own `animate-pulse` div because the only shared
 * skeleton was table-shaped. This is the other shape.
 */
export function Skeleton({
  className = "",
  rounded = "rounded-control",
}: {
  className?: string;
  rounded?: string;
}) {
  return <div className={`shimmer ${rounded} ${className}`} aria-hidden />;
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
  const push = (p: number) => {
    if (!pages.includes(p)) pages.push(p);
  };
  push(1);
  if (page - 2 > 2) pages.push("gap");
  for (let p = Math.max(2, page - 1); p <= Math.min(totalPages - 1, page + 1); p++) push(p);
  if (page + 2 < totalPages - 1) pages.push("gap");
  if (totalPages > 1) push(totalPages);

  const pageButton =
    "min-w-8 h-8 px-2 text-xs rounded-control border tabular-nums transition-colors";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft bg-sunken px-4 py-2.5">
      <p className="text-xs tabular-nums text-ink-muted">
        Showing <span className="font-semibold text-ink">{number(first)}</span>–
        <span className="font-semibold text-ink">{number(last)}</span> of{" "}
        <span className="font-semibold text-ink">{number(total)}</span> {unit}
      </p>

      <div className="flex items-center gap-1">
        <IconButton
          name="chevronLeft"
          label="Previous page"
          size="sm"
          variant="secondary"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
        />
        {pages.map((p, i) =>
          p === "gap" ? (
            <span key={`gap-${i}`} className="px-1 text-xs text-ink-faint">
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p)}
              aria-current={p === page ? "page" : undefined}
              className={`${pageButton} ${FOCUS} ${
                p === page
                  ? "border-brand-700 bg-brand-600 font-semibold text-white shadow-button"
                  : "border-line-strong bg-surface text-ink-soft hover:border-brand-400 hover:bg-brand-50"
              }`}
            >
              {p}
            </button>
          )
        )}
        <IconButton
          name="chevronRight"
          label="Next page"
          size="sm"
          variant="secondary"
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

export const inputClass =
  "w-full h-9.5 px-3 text-sm border border-line-strong rounded-control bg-surface text-ink shadow-flat placeholder:text-ink-faint transition-[border-color,box-shadow] hover:border-brand-400 focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-accent/25 disabled:bg-sunken disabled:text-ink-faint";

export const textareaClass =
  "w-full px-3 py-2 text-sm border border-line-strong rounded-control bg-surface text-ink shadow-flat placeholder:text-ink-faint transition-[border-color,box-shadow] hover:border-brand-400 focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-accent/25";

export function Input({
  className = "",
  invalid = false,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      className={`${inputClass} ${invalid ? "border-danger focus:border-danger focus:ring-red-200" : ""} ${className}`}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export function Textarea({
  className = "",
  rows = 3,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} className={`${textareaClass} ${className}`} {...rest} />;
}

/**
 * A search box with its icon inside it.
 *
 * The plain input was indistinguishable from every other field in the filter
 * row, so on screens with five controls the search box had to be found by
 * reading the placeholder. The magnifier and the clear button make it the one
 * obvious thing in the row, which is what it should be.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className = "",
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <Icon
        name="search"
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
      />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} pl-9 ${value ? "pr-9" : ""} [&::-webkit-search-cancel-button]:appearance-none`}
        {...rest}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className={`absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-ink-faint transition-colors hover:bg-sunken hover:text-ink-soft ${FOCUS}`}
        >
          <Icon name="x" size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * A checkbox that can actually be seen.
 *
 * Table-row checkboxes were `<input type="checkbox" className="rounded
 * border-slate-300" />` - the browser default, at browser default size, in a
 * green product. A real control with the accent fill makes a selected row
 * obvious, which matters most on the bulk-assign screens where getting the
 * selection wrong changes somebody else's work.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  indeterminate = false,
  disabled = false,
  className = "",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  indeterminate?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);

  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-2 ${
        disabled ? "cursor-not-allowed opacity-50" : ""
      } ${className}`}
    >
      <span className="relative grid h-4 w-4 flex-none place-items-center">
        <input
          ref={ref}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 h-full w-full cursor-inherit appearance-none rounded-[5px] border border-line-strong bg-surface transition-colors checked:border-brand-700 checked:bg-brand-600 indeterminate:border-brand-700 indeterminate:bg-brand-600 hover:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-1 disabled:bg-sunken"
        />
        <Icon
          name={indeterminate && !checked ? "menu" : "check"}
          size={11}
          className="pointer-events-none relative text-white opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-100"
        />
      </span>
      {label && <span className="text-sm text-ink-soft">{label}</span>}
    </label>
  );
}

export function MoneyCell({ value, tone }: { value: number | string; tone?: "default" | "muted" }) {
  return (
    <span
      className={`font-semibold tabular-nums ${tone === "muted" ? "text-ink-muted" : "text-ink"}`}
    >
      {currency(value)}
    </span>
  );
}

/* -------------------------------------------------------------------- tabs */

export interface TabItem {
  key: string;
  label: string;
  count?: number;
  icon?: IconName;
}

/**
 * Tabs.
 *
 * Three incompatible implementations existed - underline tabs on the settings
 * screen, pill tabs on prasadam, and a third set of pills on subscriptions
 * with different sizes and greys. Same control, three looks, so moving between
 * screens meant re-learning where to click.
 */
export function Tabs({
  items,
  value,
  onChange,
  variant = "underline",
  className = "",
}: {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  variant?: "underline" | "pill";
  className?: string;
}) {
  if (variant === "pill") {
    return (
      <div
        role="tablist"
        className={`inline-flex flex-wrap gap-1 rounded-control bg-sunken p-1 ring-1 ring-inset ring-line-soft ${className}`}
      >
        {items.map((t) => {
          const on = t.key === value;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={on}
              onClick={() => onChange(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-xs font-medium transition-all ${FOCUS} ${
                on
                  ? "bg-surface text-brand-800 shadow-flat"
                  : "text-ink-muted hover:bg-surface/60 hover:text-ink-soft"
              }`}
            >
              {t.icon && <Icon name={t.icon} size={13} />}
              {t.label}
              {t.count !== undefined && (
                <span
                  className={`rounded-pill px-1.5 text-2xs tabular-nums ${
                    on ? "bg-brand-100 text-brand-800" : "bg-line-soft text-ink-muted"
                  }`}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div role="tablist" className={`flex gap-1 overflow-x-auto border-b border-line-soft ${className}`}>
      {items.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={`-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors ${FOCUS} ${
              on
                ? "border-brand-600 font-semibold text-brand-800"
                : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink-soft"
            }`}
          >
            {t.icon && <Icon name={t.icon} size={14} />}
            {t.label}
            {t.count !== undefined && (
              <span
                className={`rounded-pill px-1.5 py-0.5 text-2xs tabular-nums ${
                  on ? "bg-brand-100 text-brand-800" : "bg-sunken text-ink-muted"
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A two-or-three-way switch.
 *
 * Replaces the pattern `mineOnly ? buttonPrimary : buttonSecondary`, which
 * used a primary button to mean "on". A primary button means "this is the
 * action to take", so using it as a state made two different things look
 * identical on the same screen.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className = "",
}: {
  options: { value: T; label: string; icon?: IconName }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const pad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";
  return (
    <div
      className={`inline-flex rounded-control bg-sunken p-0.5 ring-1 ring-inset ring-line-soft ${className}`}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={`inline-flex items-center gap-1.5 rounded-[7px] font-medium transition-all ${pad} ${FOCUS} ${
              on
                ? "bg-surface text-brand-800 shadow-flat"
                : "text-ink-muted hover:text-ink-soft"
            }`}
          >
            {o.icon && <Icon name={o.icon} size={13} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ alerts */

export type AlertTone = "info" | "good" | "warn" | "danger";

/**
 * A message about what just happened, or what is about to.
 *
 * The exact string
 *   "mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
 * appeared eighteen times in this codebase, with four looser variants beside
 * it. Every one of those was somebody needing to tell the user something and
 * finding no component for it.
 */
export function Alert({
  tone = "info",
  title,
  children,
  onDismiss,
  action,
  className = "",
}: {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
  onDismiss?: () => void;
  action?: ReactNode;
  className?: string;
}) {
  const tones: Record<AlertTone, { box: string; icon: IconName; mark: string }> = {
    info: { box: "border-sky-200 bg-info-wash text-sky-900", icon: "info", mark: "text-info" },
    good: { box: "border-emerald-200 bg-good-wash text-emerald-900", icon: "checkCircle", mark: "text-good" },
    warn: { box: "border-amber-200 bg-warn-wash text-amber-900", icon: "alert", mark: "text-warn" },
    danger: { box: "border-red-200 bg-danger-wash text-red-900", icon: "xCircle", mark: "text-danger" },
  };
  const t = tones[tone];

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`mb-4 flex items-start gap-2.5 rounded-card border px-3.5 py-3 text-sm shadow-flat ${t.box} ${className}`}
    >
      <Icon name={t.icon} size={16} className={`mt-0.5 ${t.mark}`} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}
      </div>
      {action}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className={`-mr-1 -mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-md opacity-60 transition-opacity hover:opacity-100 ${FOCUS}`}
        >
          <Icon name="x" size={13} />
        </button>
      )}
    </div>
  );
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
        className={`flex h-9.5 w-full items-center justify-between gap-2 rounded-control border bg-surface px-3 text-left text-sm shadow-flat transition-[border-color,box-shadow]
          ${disabled ? "cursor-not-allowed bg-sunken opacity-60" : "cursor-pointer hover:border-brand-400"}
          ${open ? "border-brand-600 ring-2 ring-accent/25" : "border-line-strong"}`}
      >
        <span className={`truncate ${selected ? "text-ink" : "text-ink-faint"}`}>
          {selected?.label ?? placeholder}
        </span>
        <Icon
          name="chevronDown"
          size={15}
          className={`text-ink-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          className="fade-rise absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-control border border-line-strong bg-surface py-1 shadow-float"
        >
          {!opts.length && <li className="px-3 py-2 text-sm text-ink-faint">Nothing to choose from</li>}
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
                  className="px-3 pt-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-ink-faint"
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
                className={`mx-1 flex items-start justify-between gap-3 rounded-md px-2 py-2 text-sm
                  ${o.disabled ? "cursor-not-allowed text-ink-faint/60" : "cursor-pointer"}
                  ${!o.disabled && i === active ? "bg-brand-50" : ""}
                  ${isSelected ? "font-medium text-brand-800" : o.disabled ? "" : "text-ink-soft"}`}
              >
                <span className="min-w-0">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && <span className="block truncate text-xs text-ink-faint">{o.hint}</span>}
                </span>
                {isSelected && <Icon name="check" size={14} className="mt-0.5 text-brand-600" />}
              </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- dropdown */

/**
 * A menu hanging off a button.
 *
 * Added for the download control, which needs to offer CSV or Excel from one
 * button rather than putting two buttons in every page header. Closes on
 * Escape, on a click outside, and after a choice.
 */
export function DropdownMenu({
  trigger,
  items,
  align = "right",
  className = "",
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: {
    label: string;
    icon?: IconName;
    onSelect: () => void;
    hint?: string;
    disabled?: boolean;
    tone?: "default" | "danger";
  }[];
  align?: "left" | "right";
  className?: string;
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

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {trigger({ open, toggle })}
      {open && (
        <div
          role="menu"
          className={`fade-rise absolute z-50 mt-1 min-w-52 overflow-hidden rounded-control border border-line-strong bg-surface py-1 shadow-float ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm transition-colors disabled:opacity-40 ${
                item.tone === "danger"
                  ? "text-danger hover:bg-danger-wash"
                  : "text-ink-soft hover:bg-brand-50 hover:text-brand-800"
              }`}
            >
              {item.icon && <Icon name={item.icon} size={15} className="mt-0.5" />}
              <span className="min-w-0">
                <span className="block">{item.label}</span>
                {item.hint && <span className="block text-xs text-ink-faint">{item.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ dialog */

/**
 * A dialog.
 *
 * Lived privately inside the leads screen until three screens wanted one and
 * the choice was to copy it twice more or move it here. Seven hand-rolled
 * overlays with four different backdrops still existed beside it; this is now
 * the only one.
 *
 * Escape closes it, and the backdrop does not — a mis-click while filling in a
 * list of assignees should not throw the form away.
 *
 * Focus is moved into the dialog on open and returned to whatever opened it on
 * close, and Tab is kept inside while it is open. That was missing before, and
 * without it a keyboard user tabs straight out of an open dialog into the page
 * behind, which they cannot see.
 */
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  footer,
  tone,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  /** A sticky action row, so the buttons do not scroll away on a long form. */
  footer?: ReactNode;
  tone?: "default" | "danger";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const labelId = useId();

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // The first real control, not the close button: on a form dialog the
    // person is here to type, and landing on "×" makes Enter dismiss it.
    const focusable = panel?.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]), textarea, select, button, [href], [tabindex]:not([tabindex="-1"])'
    );
    const first = Array.from(focusable ?? []).find((el) => !el.hasAttribute("data-dialog-close"));
    (first ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      returnTo.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="backdrop-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/45 p-4 backdrop-blur-[2px]">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        className={`dialog-in mt-12 mb-12 w-full ${
          wide ? "max-w-3xl" : "max-w-2xl"
        } overflow-hidden rounded-panel bg-surface shadow-dialog outline-none`}
      >
        <div className="flex items-center justify-between gap-4 border-b border-line-soft px-5 py-3.5">
          <h2
            id={labelId}
            className={`text-sm font-semibold ${tone === "danger" ? "text-danger" : "text-ink"}`}
          >
            {title}
          </h2>
          <button
            data-dialog-close
            onClick={onClose}
            aria-label="Close"
            className={`grid h-7 w-7 place-items-center rounded-md text-ink-muted transition-colors hover:bg-sunken hover:text-ink ${FOCUS}`}
          >
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="p-5">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft bg-sunken px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ toggle */

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
  disabled = false,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      type="button"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`inline-flex h-5.5 w-10 flex-none items-center rounded-full p-0.5 transition-colors disabled:opacity-50 ${FOCUS} ${
        on ? "bg-brand-600" : "bg-line"
      }`}
    >
      <span
        className={`inline-block h-4.5 w-4.5 rounded-full bg-white shadow-flat transition-transform ${
          on ? "translate-x-4.5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

/* ----------------------------------------------------------- alert picker */

/**
 * Choosing when to be warned about a reminder.
 *
 * Chips rather than a multi-select, because the answer is almost always two or
 * three of a short list and a caller is doing this mid-call with a donor
 * waiting. Each one is a real toggle button with aria-pressed, so it announces
 * as on or off rather than as an unlabelled control.
 *
 * The empty case says out loud what silence means. A reminder with no alerts
 * is a row on a board nobody will look at in time, and that is worth one line
 * of warning rather than letting somebody discover it a month later.
 */
export function AlertPicker({
  value,
  onChange,
  options,
  emptyWarning = "With nothing ticked this is only a date on a board — nothing will alert you.",
}: {
  value: number[];
  onChange: (next: number[]) => void;
  options: { minutes: number; label: string }[];
  emptyWarning?: string;
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = value.includes(o.minutes);
          return (
            <button
              key={o.minutes}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange(
                  on
                    ? value.filter((m) => m !== o.minutes)
                    : [...value, o.minutes].sort((a, b) => b - a)
                )
              }
              className={`inline-flex items-center gap-1 rounded-control border px-2.5 py-1.5 text-xs transition-colors ${FOCUS} ${
                on
                  ? "border-brand-600 bg-brand-50 font-medium text-brand-800"
                  : "border-line-strong bg-surface text-ink-muted hover:border-brand-400 hover:bg-sunken"
              }`}
            >
              {on && <Icon name="check" size={11} />}
              {o.label}
            </button>
          );
        })}
      </div>
      {!value.length && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-warn">
          <Icon name="alert" size={12} />
          {emptyWarning}
        </p>
      )}
    </div>
  );
}
