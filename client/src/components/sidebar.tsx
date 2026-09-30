"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useCallingAlerts } from "./calling-alerts";

// Grouped so the nav reads as "what am I looking at" vs "what do I need to do"
// rather than one undifferentiated list of nine links.
//
// ROLES
// `roles` on a group or an item names who may see it; absent means everyone.
// This hides what a person cannot use — the server refuses it either way, and
// a nav full of links that answer 403 is its own kind of broken.
type NavItem = { href: string; label: string; icon: string; roles?: string[] };
const CALLING_AND_UP = ["admin", "caller"];

const navGroups: { heading: string; items: NavItem[]; roles?: string[] }[] = [
  {
    heading: "Overview",
    items: [
      // A caller's first stop is the shift, not the money. Listed above the
      // dashboard for everyone, because on a calling day it is what the admin
      // wants too.
      {
        href: "/calling/start",
        label: "Start calling",
        icon: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
        roles: CALLING_AND_UP,
      },
      { href: "/dashboard", label: "Dashboard", icon: "M3 12h4l3 8 4-16 3 8h4", roles: ["admin", "accountant", "volunteer_coordinator"] },
    ],
  },
  {
    heading: "Donors",
    items: [
      { href: "/people", label: "People", icon: "M16 19v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6m13 12v-2a4 4 0 0 0-3-3.9" },
      { href: "/people/conflicts", label: "Name mismatches", icon: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", roles: ["admin"] },
      { href: "/donations", label: "Donations", icon: "M12 2v20M17 6.5C17 4.6 14.8 3.5 12 3.5S7 4.6 7 6.5 9.2 10 12 11s5 2.1 5 4-2.2 3.5-5 3.5-5-1.6-5-3.5" },
      // Where the money came from, page by page - the drill-down behind the
      // dashboard's three bucket tiles.
      { href: "/pages", label: "Donation pages", icon: "M4 4h16v6H4zM4 14h7v6H4zM15 14h5v6h-5z", roles: ["admin", "accountant"] },
      { href: "/subscriptions", label: "Recurring", icon: "M21 12a9 9 0 1 1-3-6.7M21 4v5h-5", roles: ["admin", "accountant"] },
    ],
  },
  {
    heading: "Fulfilment",
    roles: ["admin", "accountant", "volunteer_coordinator"],
    items: [
      { href: "/prasadam", label: "Prasadam", icon: "M3 9h18M5 9V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" },
      { href: "/seva", label: "Seva Bookings", icon: "M8 2v4M16 2v4M3 10h18M5 6h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" },
      { href: "/events", label: "Events", icon: "M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0zM12 8v4l3 2" },
    ],
  },
  {
    // Phone outreach. Its own group rather than tucked under Donors, because it
    // is a different job done by different people - a caller lives on these
    // three screens all day and never opens the donation list.
    heading: "Calling",
    roles: CALLING_AND_UP,
    items: [
      { href: "/calling", label: "Overview", icon: "M3 3v18h18M7 15l3-4 3 3 5-7", roles: ["admin"] },
      // Lists are the unit of work now, so they sit at the top of the group.
      { href: "/calling/lists", label: "Lists", icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
      { href: "/leads", label: "Leads", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M20 8v6M23 11h-6" },
      { href: "/follow-ups", label: "Follow-ups", icon: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
      // Separate from follow-ups on purpose: a follow-up is the caller's own
      // working note, a reminder is a promise the donor made at a moment they
      // chose. One list for both is how the real promises get lost.
      { href: "/calling/reminders", label: "Reminders", icon: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" },
      // A caller's own presets, set up before a shift rather than mid-call.
      { href: "/calling/links", label: "My links", icon: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" },
      { href: "/calling/payments", label: "QR payments", icon: "M3 11h8V3H3v8zm2-6h4v4H5V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zM13 3v8h8V3h-8zm6 6h-4V5h4v4zM13 13h2v2h-2zM17 13h2v2h-2zM15 15h2v2h-2zM13 17h2v2h-2zM17 17h2v2h-2zM19 15h2v2h-2zM19 19h2v2h-2z" },
      { href: "/calling/uploads", label: "Uploaded sheets", icon: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" },
    ],
  },
  {
    heading: "Insight",
    roles: ["admin", "accountant"],
    items: [{ href: "/reports", label: "Reports", icon: "M3 3v18h18M7 15l3-4 3 3 5-7" }],
  },
  {
    heading: "Setup",
    roles: ["admin"],
    items: [
      { href: "/team", label: "Team", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" },
      { href: "/calling/settings", label: "Calling setup", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" },
    ],
  },
];

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

  return (
    // h-full, not h-screen: on a phone this renders inside a drawer that is
    // already the height of the viewport, and h-screen there would overflow
    // behind the browser chrome.
    <aside className="w-60 flex-none h-full bg-[var(--sidebar)] border-r border-[var(--line-soft)] flex flex-col">
      <div className="px-4 py-4 border-b border-[var(--line-soft)]">
        <div className="flex items-center gap-2">
          <span className="w-8 h-8 rounded-lg bg-[var(--accent)] text-white grid place-items-center text-sm font-bold flex-none">
            H
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold leading-tight truncate text-slate-900">HKM Vizag</h1>
            <p className="text-[11px] text-slate-500 leading-tight truncate">Donor Relationship Manager</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {groups.map((group) => (
          <div key={group.heading}>
            <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {group.heading}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    /* Active state is a soft green fill with dark green ink -
                       #A8DF8E can't carry white text (1.5:1) but reads at 5.9:1
                       against #1e5128. */
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                      active
                        ? "bg-[var(--accent-soft)] text-[var(--accent-ink)] font-semibold"
                        : "text-slate-600 hover:bg-white/70 hover:text-slate-900"
                    }`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="w-4 h-4 flex-none"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d={item.icon} />
                    </svg>
                    <span className="truncate">{item.label}</span>
                    {item.href === "/calling/reminders" && dueCount > 0 && (
                      <span className="ml-auto min-w-[1.25rem] px-1.5 h-5 rounded-full bg-red-600 text-white text-[10px] font-semibold grid place-items-center tabular-nums flex-none">
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

      <div className="p-3 border-t border-[var(--line-soft)]">
        {user && (
          <div className="flex items-center gap-2.5 px-2 py-2 mb-1">
            <span className="w-7 h-7 rounded-full bg-[var(--accent-soft)] text-[var(--accent-ink)] grid place-items-center text-xs font-semibold flex-none">
              {user.name?.[0]?.toUpperCase() ?? "?"}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate leading-tight text-slate-900">{user.name}</p>
              <p className="text-[11px] text-slate-500 capitalize leading-tight">
                {user.role?.replace(/_/g, " ")}
              </p>
            </div>
          </div>
        )}
        <button
          onClick={logout}
          className="w-full px-3 py-2 text-sm rounded-lg text-slate-600 hover:bg-white/70 hover:text-slate-900 transition-colors text-left"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
