"use client";

import { SOURCE, type SankalpSource } from "@/lib/sankalpam";

/** Where a donor came from: the uploaded sheet, DRM's donors, or added by hand. */
export function SourceChip({ source, className = "" }: { source: SankalpSource | null | undefined; className?: string }) {
  if (!source) return null;
  const s = SOURCE[source];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium ring-1 ring-inset ${s.chip} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />
      {s.short}
    </span>
  );
}
