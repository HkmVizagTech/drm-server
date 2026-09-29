"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

// Grouped so the nav reads as "what am I looking at" vs "what do I need to do"
// rather than one undifferentiated list of nine links.
const navGroups: { heading: string; items: { href: string; label: string; icon: string }[] }[] = [
  {
    heading: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: "M3 12h4l3 8 4-16 3 8h4" }],
  },
  {
    heading: "Donors",
    items: [
      { href: "/people", label: "People", icon: "M16 19v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6m13 12v-2a4 4 0 0 0-3-3.9" },
      { href: "/donations", label: "Donations", icon: "M12 2v20M17 6.5C17 4.6 14.8 3.5 12 3.5S7 4.6 7 6.5 9.2 10 12 11s5 2.1 5 4-2.2 3.5-5 3.5-5-1.6-5-3.5" },
      // Where the money came from, page by page - the drill-down behind the
      // dashboard's three bucket tiles.
      { href: "/pages", label: "Donation pages", icon: "M4 4h16v6H4zM4 14h7v6H4zM15 14h5v6h-5z" },
      { href: "/subscriptions", label: "Recurring", icon: "M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" },
    ],
  },
  {
    heading: "Fulfilment",
    items: [
      { href: "/prasadam", label: "Prasadam", icon: "M3 9h18M5 9V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" },
      { href: "/seva", label: "Seva Bookings", icon: "M8 2v4M16 2v4M3 10h18M5 6h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" },
      { href: "/events", label: "Events", icon: "M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0zM12 8v4l3 2" },
    ],
  },
  {
    heading: "Insight",
    items: [{ href: "/reports", label: "Reports", icon: "M3 3v18h18M7 15l3-4 3 3 5-7" }],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  return (
    <aside className="w-60 flex-none bg-[var(--sidebar)] border-r border-[var(--line-soft)] flex flex-col">
      <div className="px-5 py-5 border-b border-[var(--line-soft)]">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg bg-[var(--accent)] text-white grid place-items-center text-sm font-bold flex-none">
            H
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold leading-tight truncate text-slate-900">HKM Vizag</h1>
            <p className="text-[11px] text-slate-500 leading-tight">Donor Relationship Manager</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {navGroups.map((group) => (
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
