"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useCallingAlerts } from "./calling-alerts";
import { Icon, type IconName } from "./icons";

// Grouped so the nav reads as "what am I looking at" vs "what do I need to do"
// rather than one undifferentiated list of nine links.
//
// ROLES
// `roles` on a group or an item names who may see it; absent means everyone.
// This hides what a person cannot use — the server refuses it either way, and
// a nav full of links that answer 403 is its own kind of broken.
//
// ICONS
// Named, not drawn. These used to be raw SVG path strings stored on each item,
// which is why the set had drifted to three different stroke weights: a path
// carries no weight of its own, so every renderer chose one. A name resolves
// to a glyph in components/icons.tsx that is drawn like every other icon in
// the product.
export type NavItem = { href: string; label: string; icon: IconName; roles?: string[] };
export type NavGroup = { heading: string; items: NavItem[]; roles?: string[] };

const CALLING_AND_UP = ["admin", "caller"];

export const navGroups: NavGroup[] = [
  {
    heading: "Overview",
    items: [
      // A caller's first stop is the shift, not the money. Listed above the
      // dashboard for everyone, because on a calling day it is what the admin
      // wants too.
      { href: "/calling/start", label: "Start calling", icon: "phoneOutgoing", roles: CALLING_AND_UP },
      { href: "/dashboard", label: "Dashboard", icon: "home", roles: ["admin", "accountant", "volunteer_coordinator"] },
    ],
  },
  {
    heading: "Donors",
    items: [
      { href: "/people", label: "People", icon: "users" },
      { href: "/people/conflicts", label: "Name mismatches", icon: "alert", roles: ["admin"] },
      { href: "/donations", label: "Donations", icon: "rupee" },
      // Where the money came from, page by page - the drill-down behind the
      // dashboard's three bucket tiles.
      { href: "/pages", label: "Donation pages", icon: "sheet", roles: ["admin", "accountant"] },
      { href: "/subscriptions", label: "Recurring", icon: "refresh", roles: ["admin", "accountant"] },
    ],
  },
  {
    heading: "Fulfilment",
    roles: ["admin", "accountant", "volunteer_coordinator"],
    items: [
      { href: "/prasadam", label: "Prasadam", icon: "box" },
      // Seva Bookings and Events were nav entries with nothing behind them -
      // a link that opens an empty screen teaches people the app is broken.
      // The server routes stay, so the day either is actually built the link
      // comes back here and nothing else has to be rebuilt.
    ],
  },
  {
    // Phone outreach. Its own group rather than tucked under Donors, because it
    // is a different job done by different people - a caller lives on these
    // three screens all day and never opens the donation list.
    heading: "Calling",
    roles: CALLING_AND_UP,
    items: [
      // Shown to callers too. It used to be admin-only, which meant a caller
      // had no screen answering "how is my day going" - and the restriction
      // was only this line: the page and its endpoint served the whole team's
      // figures to anyone who typed the URL. The endpoint now scopes itself by
      // role, so a caller opening this sees their own work and the link can be
      // theirs honestly.
      { href: "/calling", label: "Overview", icon: "chart" },
      // Lists are the unit of work now, so they sit at the top of the group.
      { href: "/calling/lists", label: "Lists", icon: "list" },
      { href: "/leads", label: "Leads", icon: "userPlus" },
      { href: "/follow-ups", label: "Follow-ups", icon: "clock" },
      // Separate from follow-ups on purpose: a follow-up is the caller's own
      // working note, a reminder is a promise the donor made at a moment they
      // chose. One list for both is how the real promises get lost.
      { href: "/calling/reminders", label: "Reminders", icon: "bell" },
      // A caller's own presets, set up before a shift rather than mid-call.
      { href: "/calling/links", label: "My links", icon: "link" },
      // Donations started on the sites and never finished. High in the group
      // on purpose: it is the warmest list a caller can work, and a list
      // nobody finds is a list nobody rings.
      { href: "/calling/pending", label: "Nearly gave", icon: "inbox" },
      { href: "/calling/payments", label: "QR payments", icon: "qr" },
      // The two money screens, under Calling rather than under Donors: the
      // question they answer is "what came in under this caller", which is a
      // fact about the phone work and not about the donor.
      //
      // Shown to callers as well as admins. Both endpoints scope themselves by
      // role server-side, so a caller opening either sees their own money and
      // nothing else - which is the thing they most need to be able to check
      // without asking an admin.
      // "Money raised" rather than "What I raised": one label has to serve a
      // caller reading their own ledger and an admin reading the team's, and
      // it is also what the breadcrumb prints at the top of the page.
      { href: "/calling/earnings", label: "Money raised", icon: "trendUp" },
      { href: "/calling/collected", label: "Collected by PhonePe", icon: "rupee" },
      { href: "/calling/uploads", label: "Uploaded sheets", icon: "upload" },
    ],
  },
  {
    heading: "Insight",
    roles: ["admin", "accountant"],
    items: [{ href: "/reports", label: "Reports", icon: "trendUp" }],
  },
  {
    heading: "Setup",
    roles: ["admin"],
    items: [
      { href: "/team", label: "Team", icon: "shield" },
      { href: "/calling/settings", label: "Calling setup", icon: "settings" },
    ],
  },
];

/**
 * Which nav entry a URL belongs to.
 *
 * Exported because the top bar builds its breadcrumb from it. Deriving the
 * trail from the same list the sidebar renders is the only way the two can
 * never disagree about which section a page is in.
 *
 * Longest match wins: /calling and /calling/lists are both prefixes of
 * /calling/lists, and without that rule every calling screen would claim to be
 * "Overview".
 */
// Screens that are not in the nav but belong to an entry that is. The call
// screen is reached from "Start calling"; without this it matched /calling
// and lit up "Overview", with a breadcrumb reading "Overview > Details".
const NAV_ALIASES: [prefix: string, href: string][] = [["/calling/queue", "/calling/start"]];

export function navLocation(pathname: string): { group: string; item: NavItem } | null {
  const alias = NAV_ALIASES.find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
  if (alias) pathname = alias[1];
  let best: { group: string; item: NavItem } | null = null;
  for (const group of navGroups) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
        if (!best || item.href.length > best.item.href.length) best = { group: group.heading, item };
      }
    }
  }
  return best;
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  // Late, due now, or due today. Counting every future reminder would leave a
  // permanent number beside Reminders that means nothing and gets ignored
  // within a week - which is worse than no badge at all.
  const { dueCount } = useCallingAlerts();

  // Hide what this person cannot use. The server refuses it regardless, so
  // this is not the security boundary - it is so a caller's nav is the five
  // things they need rather than fourteen, nine of which answer 403.
  const role = user?.role ?? "";
  const may = (roles?: string[]) => !roles || !role || roles.includes(role);
  const groups = navGroups
    .filter((g) => may(g.roles))
    .map((g) => ({ ...g, items: g.items.filter((i) => may(i.roles)) }))
    .filter((g) => g.items.length > 0);

  // ONE ITEM IS ACTIVE, NEVER TWO.
  //
  // The old test was `pathname === href || pathname.startsWith(href + "/")`
  // applied to each item independently - and /calling/pending starts with
  // /calling/, so opening "Nearly gave" lit up the Calling group's "Overview"
  // as well. Nine of the fourteen links in this nav sit under /calling, so the
  // nav was telling a caller they were in two places at once on most of the
  // screens they use. navLocation resolves it by longest match, which is the
  // same rule the breadcrumb uses - so the sidebar and the trail at the top of
  // the page can never name different sections.
  const activeHref = navLocation(pathname)?.item.href ?? null;

  return (
    // h-full, not h-screen: on a phone this renders inside a drawer that is
    // already the height of the viewport, and h-screen there would overflow
    // behind the browser chrome.
    <aside className="flex h-full w-64 flex-none flex-col border-r border-line-soft bg-sidebar">
      <div className="border-b border-line-soft px-4 py-4">
        <Link
          href="/dashboard"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-control outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {/* A ring and an inner highlight rather than a flat square. At 36px a
              plain filled rectangle reads as a placeholder; this reads as a
              mark. */}
          <span className="grid h-9 w-9 flex-none place-items-center rounded-[11px] bg-gradient-to-b from-brand-500 to-brand-700 text-base font-bold text-white shadow-button ring-1 ring-brand-800/40">
            H
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-tight text-ink">
              HKM Vizag
            </span>
            <span className="block truncate text-2xs leading-tight text-ink-muted">
              Donor Relationship Manager
            </span>
          </span>
        </Link>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {groups.map((group) => (
          <div key={group.heading}>
            <p className="mb-1.5 px-3 text-2xs font-semibold uppercase tracking-[0.1em] text-ink-faint">
              {group.heading}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = item.href === activeHref;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    /* Active state is a soft green fill with dark green ink -
                       #A8DF8E can't carry white text (1.5:1) but reads at 5.9:1
                       against #1e5128. The rail on the left is what makes the
                       current screen findable at a glance in a group of nine;
                       a fill alone was too quiet against the pale green
                       sidebar. */
                    className={`group relative flex items-center gap-2.5 rounded-control py-2 pl-3 pr-2 text-sm transition-colors ${
                      active
                        ? "bg-brand-300/70 font-semibold text-brand-800"
                        : "text-ink-soft hover:bg-white/75 hover:text-ink"
                    }`}
                  >
                    {active && (
                      <span
                        className="absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-brand-700"
                        aria-hidden
                      />
                    )}
                    <Icon
                      name={item.icon}
                      size={16}
                      className={active ? "text-brand-700" : "text-ink-muted group-hover:text-ink-soft"}
                    />
                    <span className="truncate">{item.label}</span>
                    {item.href === "/calling/reminders" && dueCount > 0 && (
                      <span className="ml-auto grid h-5 min-w-5 flex-none place-items-center rounded-full bg-danger px-1.5 text-2xs font-semibold tabular-nums text-white shadow-flat">
                        {dueCount > 99 ? "99+" : dueCount}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-line-soft p-3">
        {user && (
          <div className="mb-1 flex items-center gap-2.5 rounded-control px-2 py-2">
            <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-brand-300 text-xs font-semibold text-brand-800 ring-1 ring-inset ring-brand-500/30">
              {user.name?.[0]?.toUpperCase() ?? "?"}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium leading-tight text-ink">{user.name}</p>
              <p className="truncate text-2xs capitalize leading-tight text-ink-muted">
                {user.role?.replace(/_/g, " ")}
              </p>
            </div>
          </div>
        )}
        <button
          onClick={logout}
          className="flex w-full items-center gap-2.5 rounded-control px-3 py-2 text-left text-sm text-ink-muted transition-colors hover:bg-white/75 hover:text-danger"
        >
          <Icon name="logout" size={16} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
