"use client";

// Where a donation came from, shown consistently everywhere.
//
// Two separate facts, deliberately not merged into one string:
//   site - which donation site took the money (main site vs annadan vs one
//          keyed in here directly). These are run and reported separately.
//   page - which page or campaign on that site produced it (/donate,
//          /janmashtami, /govardhan...).
// A donation can have a site with no page (older rows synced before attribution
// existed, or a manual entry), so the page half degrades quietly.

import { Badge } from "@/components/ui";

export const SITE_LABELS: Record<string, string> = {
  hkmv: "HKMV site",
  annadan: "Annadan site",
  drm: "Entered here",
};

export function siteLabel(site?: string | null): string {
  if (!site) return "Unknown";
  return SITE_LABELS[site] ?? site;
}

export function SiteBadge({ site }: { site?: string | null }) {
  const tone = site === "annadan" ? "info" : site === "drm" ? "neutral" : "brand";
  return <Badge tone={tone}>{siteLabel(site)}</Badge>;
}

export function SourceCell({
  site,
  page,
  campaign,
}: {
  site?: string | null;
  page?: string | null;
  campaign?: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 items-start">
      <SiteBadge site={site} />
      {page ? (
        <span className="text-xs text-slate-500 font-mono truncate max-w-[12rem]" title={page}>
          {page}
        </span>
      ) : (
        <span className="text-xs text-slate-300">no page recorded</span>
      )}
      {campaign && (
        <span className="text-[11px] text-slate-400 truncate max-w-[12rem]" title={campaign}>
          campaign: {campaign}
        </span>
      )}
    </div>
  );
}
