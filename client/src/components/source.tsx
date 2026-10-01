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
    <div className="flex flex-col items-start gap-1">
      <SiteBadge site={site} />
      {page ? (
        <span className="max-w-[12rem] truncate font-mono text-xs text-ink-muted" title={page}>
          {page}
        </span>
      ) : (
        <span className="text-xs text-ink-faint">no page recorded</span>
      )}
      {campaign && (
        <span className="max-w-[12rem] truncate text-2xs text-ink-faint" title={campaign}>
          campaign: {campaign}
        </span>
      )}
    </div>
  );
}
