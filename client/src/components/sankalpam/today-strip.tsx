"use client";

// The daily reminder, where the caller and admin start their day: how many
// Sankalpam videos are due today, missed, and coming tomorrow.

import Link from "next/link";
import { useCallingAlerts } from "@/components/calling-alerts";
import { Icon, buttonClass } from "@/components/ui";

export function SankalpamStrip({ className = "" }: { className?: string }) {
  const { sankalpam: s } = useCallingAlerts();
  if (!s || (!s.today && !s.missed && !s.tomorrow)) return null;
  const parts = [
    s.today ? `${s.today} to send today` : null,
    s.missed ? `${s.missed} missed` : null,
    s.tomorrow ? `${s.tomorrow} tomorrow` : null,
  ].filter(Boolean);
  const urgent = s.missed > 0;
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-card border px-4 py-3 ${
        urgent ? "border-red-200 bg-danger-wash/60" : "border-amber-200 bg-amber-50"
      } ${className}`}
    >
      <span className={`grid h-9 w-9 flex-none place-items-center rounded-control ${urgent ? "bg-red-100 text-danger" : "bg-amber-100 text-amber-800"}`}>
        <Icon name="sparkle" size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">Sankalpam videos</span>
        <span className="block text-sm text-ink-soft">{parts.join(" · ")}</span>
      </span>
      <Link href="/sankalpam" className={buttonClass(urgent ? "primary" : "secondary", "sm", "max-sm:h-11")}>
        Open
        <Icon name="arrowRight" size={14} />
      </Link>
    </div>
  );
}
