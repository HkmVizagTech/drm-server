"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useWhatsAppUnread } from "@/lib/wa-unread";
import { useCallingAlerts } from "./calling-alerts";
import { Icon, type IconName } from "./icons";
import { useInApp } from "@/lib/phone-app";
import { BrandMark } from "@/components/brand-mark";

// THE SHAPE OF THE MENU
//
// It used to be nine headings and about forty links on one scrolling list, twenty of them under
// "Calling" - so a caller had to scroll to find Follow-ups and could not tell the
// "Overview" heading from the "Overview" link. Now:
//
//   - Pinned: the four places people open all day. No heading, always visible.
//   - Sections: a handful of links each, closed unless you are in one. The section you are in opens
//     by itself; the others stay out of the way, and what you open or close is remembered.
//   - A closed section still shows a number if something inside it needs you (a reminder due, a patron
//     request), so collapsing never hides work.
//
// Labels are each screen's own title, so the menu and the page never disagree.
//
// ROLES
// `roles` on a group or an item names who may see it; absent means everyone. This hides what a person
// cannot use - the server refuses it either way, and a nav full of links that answer 403 is its own
// kind of broken.
//
// ICONS
// Named, not drawn: a name resolves to a glyph in components/icons.tsx drawn like every other icon.
// `appOnly` items show only inside the DRM Android app (see lib/phone-app.ts).
export type NavItem = { href: string; label: string; icon: IconName; roles?: string[]; appOnly?: boolean };
export type NavGroup = { heading: string; icon: IconName; items: NavItem[]; roles?: string[]; pinned?: boolean };

const CALLING_AND_UP = ["admin", "caller"];
const OFFICE = ["admin", "accountant", "volunteer_coordinator"];

export const navGroups: NavGroup[] = [
  {
    heading: "Main",
    icon: "home",
    pinned: true,
    items: [
      // A caller's first stop is the shift, not the money.
      { href: "/calling/start", label: "Start calling", icon: "phoneOutgoing", roles: CALLING_AND_UP },
      { href: "/dashboard", label: "Dashboard", icon: "home", roles: OFFICE },
      // Chat with donors on WhatsApp: replies, pictures, files. Admin and callers.
      { href: "/whatsapp", label: "WhatsApp chats", icon: "message", roles: CALLING_AND_UP },
      // The puja on a donor's special day, filmed and sent to them: a job with a deadline every day.
      { href: "/sankalpam", label: "Sankalpam", icon: "sparkle", roles: CALLING_AND_UP },
    ],
  },
  {
    // The people to ring and what to do about them.
    heading: "Calling",
    icon: "phone",
    roles: CALLING_AND_UP,
    items: [
      // Lists are the unit of work now, so they sit near the top.
      { href: "/leads", label: "Leads", icon: "userPlus" },
      { href: "/calling/lists", label: "Lists", icon: "list" },
      { href: "/follow-ups", label: "Follow-ups", icon: "clock" },
      // Separate from follow-ups on purpose: a follow-up is the caller's own working note, a reminder is
      // a promise the donor made at a moment they chose. One list for both is how promises get lost.
      { href: "/calling/reminders", label: "Reminders", icon: "bell" },
      // Donations started on the sites and never finished: the warmest list a caller can work.
      { href: "/calling/pending", label: "Nearly gave", icon: "inbox" },
      // People who asked, on the website, to become a patron - each one a lead to ring.
      { href: "/calling/patrons", label: "Patron requests", icon: "sparkle" },
      { href: "/calling/uploads", label: "Uploaded sheets", icon: "upload" },
    ],
  },
  {
    // What was done, and what it brought in. A caller sees their own; an admin sees the team's - both
    // endpoints scope themselves by role, so the same link is honest for both.
    heading: "Calls and money",
    icon: "rupee",
    roles: CALLING_AND_UP,
    items: [
      { href: "/calling", label: "Overview", icon: "chart" },
      { href: "/calling/calls", label: "My calls", icon: "phone" },
      // Calls the DRM app saw on callers' phones, with their recordings.
      { href: "/calling/recordings", label: "Recordings", icon: "mic" },
      // A call from a number DRM did not know, added from its recording.
      { href: "/calling/unmatched", label: "Unmatched calls", icon: "phoneIncoming" },
      { href: "/calling/earnings", label: "Money raised", icon: "trendUp" },
      { href: "/calling/collected", label: "Collected by PhonePe", icon: "rupee" },
      { href: "/calling/payments", label: "QR payments", icon: "qr" },
      // A caller's own presets, set up before a shift rather than mid-call.
      { href: "/calling/links", label: "My links", icon: "link" },
    ],
  },
  {
    // The phone's half of "click Call on the laptop, ring from the phone", and the app's own setup.
    heading: "Phone app",
    icon: "settings",
    roles: CALLING_AND_UP,
    items: [
      { href: "/calling/dialer", label: "Laptop dialer", icon: "phoneOutgoing", appOnly: true },
      { href: "/calling/phone", label: "This phone", icon: "settings", appOnly: true },
    ],
  },
  {
    heading: "Donors",
    icon: "users",
    items: [
      { href: "/people", label: "People", icon: "users" },
      { href: "/donations", label: "Donations", icon: "rupee" },
      // Where the money came from, page by page - the drill-down behind the dashboard's tiles.
      { href: "/pages", label: "Donation pages", icon: "sheet", roles: ["admin", "accountant"] },
      { href: "/subscriptions", label: "Recurring", icon: "refresh", roles: ["admin", "accountant"] },
      { href: "/people/conflicts", label: "Name mismatches", icon: "alert", roles: ["admin"] },
    ],
  },
  {
    // The names on the temple's bricks (donors of Rs 1,500+ to Mandir nirmana, Brick and Square foot
    // seva), from "to print" to "picture sent to the donor", and prasadam. Callers work the Seva wall
    // table and nothing else here; the printer has no sidebar at all.
    heading: "Seva",
    icon: "box",
    roles: [...OFFICE, "caller"],
    items: [
      { href: "/seva-wall", label: "Seva wall", icon: "sheet", roles: [...OFFICE, "caller"] },
      { href: "/seva-wall/print", label: "Bricks to print", icon: "box", roles: OFFICE },
      { href: "/seva-wall/all", label: "All records", icon: "list", roles: OFFICE },
      { href: "/prasadam", label: "Prasadam", icon: "box", roles: OFFICE },
    ],
  },
  {
    heading: "Reports",
    icon: "chart",
    roles: ["admin", "accountant"],
    items: [
      { href: "/reports", label: "Reports", icon: "trendUp", roles: ["admin", "accountant"] },
      // What each caller did today: calls, answered, talk time, breaks, targets. Admin only.
      { href: "/team-activity", label: "Team activity", icon: "chart", roles: ["admin"] },
    ],
  },
  {
    heading: "Admin",
    icon: "shield",
    roles: ["admin"],
    items: [
      { href: "/team", label: "Team", icon: "shield" },
      { href: "/calling/settings", label: "Calling setup", icon: "settings" },
      // Every phone with the app: is it saving calls and recordings?
      { href: "/calling/phones", label: "Phones", icon: "phone" },
      { href: "/whatsapp-thanks", label: "WhatsApp thanks", icon: "message" },
      // The sevas a receipt is raised for, with the Seva Code DCC expects.
      { href: "/seva-categories", label: "Seva categories", icon: "list" },
    ],
  },
];

/**
 * Which nav entry a URL belongs to.
 *
 * Exported because the top bar builds its breadcrumb from it. Deriving the trail from the same list the
 * sidebar renders is the only way the two can never disagree about which section a page is in.
 *
 * Longest match wins: /calling and /calling/lists are both prefixes of /calling/lists, and without that
 * rule every calling screen would claim to be "Overview".
 */
// Screens that are not in the nav but belong to an entry that is. The call screen is reached from "Start
// calling"; without this it matched /calling and lit up "Overview", with a breadcrumb reading "Overview > Details".
const NAV_ALIASES: [prefix: string, href: string][] = [["/calling/queue", "/calling/start"]];

export function navLocation(pathname: string): { group: string; pinned: boolean; item: NavItem } | null {
  const alias = NAV_ALIASES.find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
  if (alias) pathname = alias[1];
  let best: { group: string; pinned: boolean; item: NavItem } | null = null;
  for (const group of navGroups) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
        if (!best || item.href.length > best.item.href.length) best = { group: group.heading, pinned: !!group.pinned, item };
      }
    }
  }
  return best;
}

const OPEN_KEY = "drm-nav-open";

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function Count({ n, tone }: { n: number; tone: "wa" | "amber" | "danger" }) {
  const bg = tone === "wa" ? "bg-[#25D366]" : tone === "danger" ? "bg-danger" : "bg-amber-500";
  return (
    <span className={`ml-auto grid h-5 min-w-5 flex-none place-items-center rounded-full px-1.5 text-2xs font-semibold tabular-nums text-white ${bg}`}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  // Late, due now, or due today. Counting every future reminder would leave a permanent number beside
  // Reminders that means nothing and gets ignored within a week - worse than no badge at all.
  const { dueCount, sankalpam, patrons } = useCallingAlerts();
  // Chats waiting for an answer: one shared poll (lib/wa-unread.ts), also behind the phone's bottom bar.
  const waUnread = useWhatsAppUnread(user?.role);
  // Videos due today plus any missed: the day's job, not tomorrow's.
  const sankalpDue = sankalpam ? sankalpam.today + sankalpam.missed : 0;

  // Hide what this person cannot use. The server refuses it regardless, so this is not the security
  // boundary - it is so a caller's nav is what they need rather than forty links, thirty of which answer 403.
  const role = user?.role ?? "";
  const may = (roles?: string[]) => !roles || !role || roles.includes(role);
  const app = useInApp();
  const groups = navGroups
    .filter((g) => may(g.roles))
    .map((g) => ({ ...g, items: g.items.filter((i) => may(i.roles) && (!i.appOnly || app)) }))
    .filter((g) => g.items.length > 0);

  // ONE ITEM IS ACTIVE, NEVER TWO. navLocation resolves by longest match - the same rule the breadcrumb
  // uses - so the sidebar and the trail at the top of the page can never name different sections.
  const here = navLocation(pathname);
  const activeHref = here?.item.href ?? null;

  const badge = (href: string): { n: number; tone: "wa" | "amber" | "danger" } | null => {
    if (href === "/whatsapp" && waUnread > 0) return { n: waUnread, tone: "wa" };
    if (href === "/sankalpam" && sankalpDue > 0) return { n: sankalpDue, tone: "amber" };
    if (href === "/calling/patrons" && (patrons?.now ?? 0) > 0) return { n: patrons?.now ?? 0, tone: "amber" };
    if (href === "/calling/reminders" && dueCount > 0) return { n: dueCount, tone: "danger" };
    return null;
  };

  // What the person opened or closed is remembered. Until they have chosen, the section they are in is
  // open and the rest are shut. Read after mount - the server render has no localStorage.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  useEffect(() => setChosen(readOpen()), []);
  const isOpen = (heading: string) => (heading in chosen ? chosen[heading] : heading === here?.group);
  const toggle = (heading: string) =>
    setChosen((c) => {
      const next = { ...c, [heading]: !isOpen(heading) };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        /* a convenience */
      }
      return next;
    });
  // Going to a screen opens its section, even one that was shut before.
  const group = here?.group;
  useEffect(() => {
    if (group) setChosen((c) => (c[group] === false ? { ...c, [group]: true } : c));
  }, [group, pathname]);

  const linkClass = (active: boolean) =>
    `group relative flex items-center gap-2.5 rounded-control text-[13.5px] transition-colors ${
      active ? "bg-brand-50 font-semibold text-brand-800" : "text-ink-soft hover:bg-sunken hover:text-ink"
    }`;

  return (
    // h-full, not h-screen: on a phone this renders inside a drawer that is already the height of the
    // viewport, and h-screen there would overflow behind the browser chrome.
    <aside className="flex h-full w-64 flex-none flex-col border-r border-line-soft bg-sidebar">
      <div className="px-4 py-4">
        <Link
          href="/dashboard"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-control outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <BrandMark className="h-9 w-9" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-tight text-ink">HKM Vizag</span>
            <span className="block truncate text-2xs leading-tight text-ink-muted">Donor manager</span>
          </span>
        </Link>
      </div>

      <nav aria-label="Menu" className="flex-1 overflow-y-auto px-3 pb-4">
        {groups.map((g) => {
          if (g.pinned) {
            return (
              <div key={g.heading} className="mb-3 space-y-0.5 border-b border-line-soft pb-3">
                {g.items.map((item) => {
                  const active = item.href === activeHref;
                  const b = badge(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={`${linkClass(active)} px-3 py-2.5 font-medium`}
                    >
                      <Icon name={item.icon} size={18} className={active ? "text-brand-600" : "text-ink-muted group-hover:text-ink-soft"} />
                      <span className="truncate">{item.label}</span>
                      {b && <Count n={b.n} tone={b.tone} />}
                    </Link>
                  );
                })}
              </div>
            );
          }

          const open = isOpen(g.heading);
          const containsActive = g.heading === here?.group;
          // A closed section still tells you if something inside it needs you.
          const waiting = g.items.reduce((sum, i) => sum + (badge(i.href)?.n ?? 0), 0);
          const panel = `nav-${g.heading.replace(/\W+/g, "-").toLowerCase()}`;
          return (
            <div key={g.heading} className="mb-0.5">
              <button
                type="button"
                onClick={() => toggle(g.heading)}
                aria-expanded={open}
                aria-controls={panel}
                className={`flex w-full items-center gap-2.5 rounded-control px-3 py-2 text-left text-[13.5px] font-semibold transition-colors hover:bg-sunken ${
                  containsActive ? "text-ink" : "text-ink-soft"
                }`}
              >
                <Icon name={g.icon} size={18} className={containsActive ? "text-brand-600" : "text-ink-muted"} />
                <span className="truncate">{g.heading}</span>
                {!open && waiting > 0 && (
                  <span className="ml-auto mr-1 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1.5 text-2xs font-semibold tabular-nums text-white">
                    {waiting > 99 ? "99+" : waiting}
                  </span>
                )}
                <Icon
                  name="chevronDown"
                  size={15}
                  className={`flex-none text-ink-faint transition-transform ${open ? "" : "-rotate-90"} ${!open && waiting > 0 ? "" : "ml-auto"}`}
                />
              </button>
              {open && (
                <div id={panel} className="ml-[21px] mt-0.5 space-y-0.5 border-l border-line-soft pl-2.5">
                  {g.items.map((item) => {
                    const active = item.href === activeHref;
                    const b = badge(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={`${linkClass(active)} px-2.5 py-1.5`}
                      >
                        <span className="truncate">{item.label}</span>
                        {b && <Count n={b.n} tone={b.tone} />}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-line-soft p-3">
        {user && (
          <div className="mb-1 flex items-center gap-2.5 rounded-control px-2 py-2">
            <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800 ring-1 ring-inset ring-brand-500/25">
              {user.name?.[0]?.toUpperCase() ?? "?"}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium leading-tight text-ink">{user.name}</p>
              <p className="truncate text-2xs capitalize leading-tight text-ink-muted">{user.role?.replace(/_/g, " ")}</p>
            </div>
          </div>
        )}
        <button
          onClick={logout}
          className="flex w-full items-center gap-2.5 rounded-control px-3 py-2 text-left text-sm text-ink-muted transition-colors hover:bg-sunken hover:text-danger"
        >
          <Icon name="logout" size={16} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
