"use client";

// Charts are hand-rolled SVG rather than a charting library: the dashboard
// needs exactly two forms, and adding a runtime dependency (plus its React 19
// compatibility risk) to draw a dozen rectangles isn't a trade worth making.
//
// Design rules applied here:
//   * Single measure => ONE hue, taken from the brand ramp. Colouring each
//     column or category differently would spend the identity channel
//     re-encoding what bar length already shows.
//   * Hover is not optional on an interactive chart - and neither is the
//     keyboard: every column is focusable and announces the same figures a
//     hover shows, so a tooltip enhances the chart rather than gating it.
//   * Axes and gridlines are recessive; the data is the loudest ink.
//   * Values are direct-labelled where they earn it, so no figure on this
//     dashboard is reachable only by holding a mouse still.

import { useState } from "react";
import { currency, currencyCompact, monthLabel, number, titleCase } from "@/lib/format";
import { EmptyState } from "@/components/ui";

// THE COLOURS ARE TOKENS, NOT HEXES.
//
// Both charts used to carry their own `#2a78d6` blue so that a bar would not
// be mistaken for a button. The separation is worth keeping, but it does not
// need a second palette to get it: the brand ramp already has nine steps, so
// the data sits on brand-600 while every button on the page is brand-600 *with
// a border, a shadow and a hover step* - different enough in form that nobody
// tries to click a column, and on-palette rather than beside it.
//
// Validated against the WHITE card surface these render on, not the pale blue
// page behind it: brand-600 is 6.2:1 there and brand-800 (the hovered step)
// 10.4:1, both far clear of the 3:1 a chart mark needs. This admin is
// deliberately light-only (see globals.css), so there is no second mode to
// re-check these against.
//
// Written as Tailwind utilities rather than `fill="var(--brand-600)"` because
// a CSS variable in an SVG presentation *attribute* is not reliably honoured -
// the utility compiles to a real CSS rule, which is.
const MARK = "fill-brand-600";
const MARK_ACTIVE = "fill-brand-800";

/* ------------------------------------------------- monthly trend (columns) */

// Geometry is in user units on a fixed viewBox, so the whole chart scales with
// the card. padT leaves room for the direct label that sits ON TOP of the
// tallest column, and padB for the month names - a plot sized to the bars
// alone pushes its own axis out of the box.
const W = 720;
const H = 260;
const PAD_L = 56;
const PAD_R = 10;
const PAD_T = 24;
const PAD_B = 30;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

/**
 * Round an axis maximum up to a number a person can divide by eye.
 *
 * Scaling straight off the largest month gives ticks like ₹3.7L and ₹1.8L,
 * which are unreadable as a scale - you cannot tell at a glance whether a
 * column is two thirds of the way up. The multipliers are the ones that stay
 * clean when quartered, so every gridline lands on a round figure.
 */
function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const n = value / magnitude;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * A column with a rounded cap and a square foot.
 *
 * `rx` on a <rect> rounds all four corners, which lifts the bar off its own
 * baseline and makes short months look like floating pills. Only the data end
 * gets the radius; the end sitting on the axis stays square.
 */
function columnPath(x: number, y: number, w: number, h: number, radius = 4): string {
  const r = Math.max(0, Math.min(radius, w / 2, h));
  const base = y + h;
  return `M${x} ${base}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${base}Z`;
}

export function MonthlyTrendChart({
  data,
}: {
  data: { month: string; total: number; count: number }[];
}) {
  const [active, setActive] = useState<number | null>(null);

  if (!data.length) {
    return (
      <ChartEmpty
        title="No donations yet"
        message="The last 12 months show here."
      />
    );
  }

  const max = niceCeil(Math.max(...data.map((d) => d.total), 0));
  const slot = PLOT_W / data.length;
  // Capped at 24px and never filling its slot: the leftover is the air that
  // keeps twelve columns from reading as one striped block.
  const barW = Math.min(24, slot * 0.62);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    value: max * f,
    y: PAD_T + PLOT_H - PLOT_H * f,
  }));

  const columnY = (total: number) =>
    PAD_T + PLOT_H - Math.max(total > 0 ? 2 : 0, (total / max) * PLOT_H);

  // Label the extreme and the endpoint, nothing else. A figure over every
  // column is twelve numbers nobody reads; the busiest month and the month we
  // are in are the two a fundraiser actually looks for, and the axis carries
  // the rest. The second label is dropped when it would sit next to the first,
  // because two values a slot apart collide instead of informing.
  const peak = data.reduce((best, d, i) => (d.total > data[best].total ? i : best), 0);
  const last = data.length - 1;
  const labelled = new Set<number>([peak]);
  if (last !== peak && last - peak >= 2 && data[last].total > 0) labelled.add(last);

  const hovered = active === null ? null : data[active];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="group"
        aria-label="Donations per month, last 12 months"
      >
        {ticks.map((t) => (
          <g key={t.y}>
            {/* Solid hairlines one step off the surface. A dashed grid reads as
                a threshold or a projection when it is only a ruler. */}
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={t.y}
              y2={t.y}
              className="stroke-line-soft"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 10}
              y={t.y + 3.5}
              textAnchor="end"
              fontSize={10}
              className="fill-ink-muted tabular-nums"
            >
              {currencyCompact(t.value)}
            </text>
          </g>
        ))}

        {data.map((d, i) => {
          const y = columnY(d.total);
          const h = PAD_T + PLOT_H - y;
          const centre = PAD_L + slot * i + slot / 2;
          const on = active === i;
          const donations = `${number(d.count)} ${d.count === 1 ? "donation" : "donations"}`;
          return (
            <g key={d.month}>
              {/* Full-height hit target, and the only focusable thing in the
                  plot: a 2px column for a quiet month is impossible to hover
                  and worse to tab onto, and the aria-label is what makes every
                  figure reachable for somebody who never sees the tooltip. */}
              <rect
                x={PAD_L + slot * i}
                y={PAD_T}
                width={slot}
                height={PLOT_H}
                fill="transparent"
                tabIndex={0}
                role="img"
                aria-label={`${monthLabel(d.month, true)}: ${currency(d.total)} from ${donations}`}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              />
              <path
                d={columnPath(centre - barW / 2, y, barW, h)}
                className={`${on ? MARK_ACTIVE : MARK} transition-colors`}
                pointerEvents="none"
              />
              {labelled.has(i) && (
                <text
                  x={centre}
                  y={y - 7}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={600}
                  className="fill-ink tabular-nums"
                  pointerEvents="none"
                >
                  {currencyCompact(d.total)}
                </text>
              )}
              <text
                x={centre}
                y={H - 10}
                textAnchor="middle"
                fontSize={10}
                fontWeight={on ? 600 : 400}
                className={on ? "fill-ink" : "fill-ink-muted"}
                pointerEvents="none"
              >
                {monthLabel(d.month)}
              </text>
            </g>
          );
        })}

        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={PAD_T + PLOT_H}
          y2={PAD_T + PLOT_H}
          className="stroke-line-strong"
          strokeWidth={1}
        />
      </svg>

      {hovered && active !== null && (() => {
        // Anchored to the column's own geometry rather than to the container:
        // the plot starts 56 units in, so a tooltip placed at a flat share of
        // the full width drifts further left of its column the further right
        // you hover - which is how the December readout ended up sitting over
        // October.
        const x = (PAD_L + slot * (active + 0.5)) / W;
        const capY = columnY(hovered.total);
        // Near the edges the tooltip hangs off the column instead of
        // straddling it, and over a tall column it drops below the cap. Both
        // are flips rather than clamps, so the readout stays attached to the
        // column it describes and cannot spill out of the card at any width.
        const alignX = x < 0.25 ? "0" : x > 0.75 ? "-100%" : "-50%";
        const alignY = capY < PAD_T + PLOT_H * 0.3 ? "8px" : "calc(-100% - 8px)";
        return (
          <div
            className="pointer-events-none absolute z-10 max-w-48 whitespace-nowrap rounded-control bg-ink px-2.5 py-1.5 text-xs text-white shadow-float"
            style={{
              left: `${x * 100}%`,
              top: `${(capY / H) * 100}%`,
              transform: `translate(${alignX}, ${alignY})`,
            }}
          >
            {/* The value leads and the month follows: whoever is hovering
                already knows which column they are on and came for the
                number. */}
            <div className="font-semibold tabular-nums">{currency(hovered.total)}</div>
            <div className="text-white/70">
              {monthLabel(hovered.month, true)} · <span className="tabular-nums">{number(hovered.count)}</span>{" "}
              {hovered.count === 1 ? "donation" : "donations"}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* --------------------------------------------- category breakdown (h-bars) */

// Horizontal bars, because category names are words - rotating them under
// vertical columns to fit is a readability tax with no upside.
//
// No tooltip here, deliberately: every row already carries its rupee figure
// and its share as text, so there is nothing a hover could reveal. The hover
// is emphasis only, and it is pure CSS - a React state update per row the
// pointer crosses buys nothing when the only change is a colour.
export function CategoryBars({
  data,
  labelKey,
  valueKey,
}: {
  data: Record<string, string | number>[];
  labelKey: string;
  valueKey: string;
}) {
  if (!data.length) {
    return <ChartEmpty title="No donations yet" message="Donations by purpose show here." />;
  }

  const max = Math.max(...data.map((d) => Number(d[valueKey])), 1);
  const total = data.reduce((sum, d) => sum + Number(d[valueKey]), 0);

  return (
    <div className="space-y-2.5">
      {data.map((d) => {
        const value = Number(d[valueKey]);
        const pct = (value / max) * 100;
        const share = total ? (value / total) * 100 : 0;
        return (
          <div key={String(d[labelKey])} className="group">
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="truncate text-xs font-medium text-ink-soft">
                {titleCase(String(d[labelKey]))}
              </span>
              {/* Direct label - the value is always readable without hovering
                  or measuring the bar against an axis. */}
              <span className="flex-none text-xs tabular-nums text-ink-muted">
                {currency(value)}
                <span className="ml-1.5 text-ink-faint">{share.toFixed(0)}%</span>
              </span>
            </div>
            {/* The unfilled track is a lighter step of the same ramp rather
                than the page's blue, so the whole bar reads as one scale
                instead of a green thing sitting in a blue slot. */}
            <div className="h-2 overflow-hidden rounded-pill bg-brand-100">
              <div
                className="h-full rounded-r-pill bg-brand-600 transition-colors group-hover:bg-brand-800"
                style={{ width: `${Math.max(pct, 1.5)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// An empty chart drawn as a dashed grey box reads as a panel that failed to
// load. EmptyState is the shape the rest of the product uses to say "this is a
// state, not a breakage", so a blank dashboard says it the same way.
function ChartEmpty({ title, message }: { title: string; message: string }) {
  return <EmptyState icon="chart" title={title} message={message} />;
}
