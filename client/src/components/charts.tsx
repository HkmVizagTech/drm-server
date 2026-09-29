"use client";

// Charts are hand-rolled SVG rather than a charting library: the dashboard
// needs exactly two forms, and adding a runtime dependency (plus its React 19
// compatibility risk) to draw a dozen rectangles isn't a trade worth making.
//
// Design rules applied here:
//   * Single measure => ONE hue. Colouring each bar differently would imply the
//     categories are separate series when they're the same measure sliced up.
//   * Hover is not optional on an interactive chart - both forms ship a tooltip.
//   * Axes and gridlines are recessive; the data is the loudest ink.
//   * Values are direct-labelled where they fit, so meaning never depends on
//     reading a colour against an axis.

import { useState } from "react";
import { currency, currencyCompact, monthLabel, number, titleCase } from "@/lib/format";

// Data stays blue while the interactive chrome is green: a static bar painted
// in the same colour as every button on the page reads as clickable. Blue also
// keeps a clear separation from the green active states in the sidebar and
// the soft green fills used for selection.
//
// This step is validated against the white card surface (not the pale blue
// page behind it) - contrast and CVD results are only meaningful against the
// surface the mark actually sits on.
const SERIES = "#2a78d6";
const SERIES_HOVER = "#1c5cab";
const GRID = "rgba(172, 186, 196, 0.45)";
const AXIS_BASE = "rgba(172, 186, 196, 0.9)";
const AXIS_TEXT = "#64748b";

/* ------------------------------------------------- monthly trend (columns) */

export function MonthlyTrendChart({
  data,
}: {
  data: { month: string; total: number; count: number }[];
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (!data.length) return <ChartEmpty message="No donations recorded yet." />;

  const max = Math.max(...data.map((d) => d.total), 1);
  const W = 720;
  const H = 240;
  const padL = 52;
  const padR = 8;
  const padT = 12;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const slot = plotW / data.length;
  const barW = Math.min(38, slot * 0.6);

  // Four gridlines is enough to read magnitude without the grid competing
  // with the bars for attention.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    v: max * f,
    y: padT + plotH - plotH * f,
  }));

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Monthly donations trend">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={t.y} y2={t.y} stroke={GRID} strokeWidth={1} />
            <text x={padL - 8} y={t.y + 4} textAnchor="end" fontSize={10} fill={AXIS_TEXT}>
              {currencyCompact(t.v)}
            </text>
          </g>
        ))}

        {data.map((d, i) => {
          const h = Math.max(d.total > 0 ? 2 : 0, (d.total / max) * plotH);
          const x = padL + slot * i + (slot - barW) / 2;
          const y = padT + plotH - h;
          const active = hover === i;
          return (
            <g key={d.month}>
              {/* Full-height hit target: a 2px-tall bar for a quiet month would
                  otherwise be almost impossible to hover. */}
              <rect
                x={padL + slot * i}
                y={padT}
                width={slot}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={4}
                fill={active ? SERIES_HOVER : SERIES}
                pointerEvents="none"
              />
              <text
                x={padL + slot * i + slot / 2}
                y={H - 8}
                textAnchor="middle"
                fontSize={10}
                fill={active ? "#0f172a" : AXIS_TEXT}
                fontWeight={active ? 600 : 400}
                pointerEvents="none"
              >
                {monthLabel(d.month)}
              </text>
            </g>
          );
        })}

        <line x1={padL} x2={W - padR} y1={padT + plotH} y2={padT + plotH} stroke={AXIS_BASE} strokeWidth={1} />
      </svg>

      {hover !== null && (
        <div
          className="absolute -top-1 pointer-events-none bg-slate-900 text-white text-xs rounded-lg px-2.5 py-1.5 shadow-lg whitespace-nowrap"
          style={{
            left: `${((hover + 0.5) / data.length) * 100}%`,
            transform: "translateX(-50%)",
          }}
        >
          <div className="font-medium">{monthLabel(data[hover].month, true)}</div>
          <div className="tabular-nums">{currency(data[hover].total)}</div>
          <div className="text-white/70 tabular-nums">
            {number(data[hover].count)} {data[hover].count === 1 ? "donation" : "donations"}
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------- category breakdown (h-bars) */

// Horizontal bars, because category names are words - rotating them under
// vertical columns to fit is a readability tax with no upside.
export function CategoryBars({
  data,
  labelKey,
  valueKey,
}: {
  data: Record<string, string | number>[];
  labelKey: string;
  valueKey: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (!data.length) return <ChartEmpty message="Nothing to break down yet." />;

  const max = Math.max(...data.map((d) => Number(d[valueKey])), 1);
  const total = data.reduce((sum, d) => sum + Number(d[valueKey]), 0);

  return (
    <div className="space-y-2.5">
      {data.map((d, i) => {
        const value = Number(d[valueKey]);
        const pct = (value / max) * 100;
        const share = total ? (value / total) * 100 : 0;
        return (
          <div
            key={String(d[labelKey])}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            className="group"
          >
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className="text-xs font-medium text-slate-700 truncate">
                {titleCase(String(d[labelKey]))}
              </span>
              {/* Direct label - the value is always readable without hovering
                  or measuring the bar against an axis. */}
              <span className="text-xs tabular-nums text-slate-600 flex-none">
                {currency(value)}
                <span className="text-slate-400 ml-1.5">{share.toFixed(0)}%</span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-[var(--page)] overflow-hidden">
              <div
                className="h-full rounded-full transition-colors"
                style={{
                  width: `${Math.max(pct, 1.5)}%`,
                  backgroundColor: hover === i ? SERIES_HOVER : SERIES,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="h-40 grid place-items-center text-sm text-slate-400 border border-dashed border-slate-200 rounded-lg">
      {message}
    </div>
  );
}
