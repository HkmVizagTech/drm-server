"use client";

// The admin shell.
//
// WHY THIS IS RESPONSIVE NOW
// Callers dial from their own phones: they tap the number on the calling
// screen, talk, and come back to tap an outcome. That makes a phone the primary
// device for at least one screen in this app, and a 240px sidebar that never
// collapses left about 150px for the content on a 390px-wide phone - the
// calling screen was unusable on the only device it was designed for.
//
// So below `lg` the sidebar becomes a drawer behind a menu button, and above it
// nothing changes at all: the desktop layout is exactly what it was.

import { ReactNode, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { ReminderBell } from "./reminder-bell";
import { CallingAlertsProvider } from "./calling-alerts";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close on navigation. Without this, tapping a link on a phone leaves the
  // drawer covering the page you just asked for.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape closes it, and the body doesn't scroll behind an open drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    // One provider around the whole shell: the bell, the nav count and the
    // calling screen all read the same poll, so they can never disagree and
    // cannot race each other for an alert.
    <CallingAlertsProvider>
    <div className="flex h-screen bg-[var(--page)] text-slate-900">
      {/* Desktop: unchanged. */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* Phone and tablet: a drawer. */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="relative z-10 h-full shadow-xl">
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
          <button
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="flex-1 bg-slate-900/40"
          />
        </div>
      )}

      {/* min-w-0 matters: without it a wide table inside a flex child refuses to
          shrink and pushes the whole layout sideways instead of scrolling. */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        {/* ONE header, at both sizes, and exactly ONE ReminderBell in the whole
            app. That matters: the bell polls the server every minute, and a
            second copy - say one in the sidebar for desktop and one here for
            phones - would mount both (Tailwind's lg:hidden hides an element,
            it does not stop it running) and quietly double every caller's
            request count while racing itself for the same alerts.

            On a phone this is a real bar with the menu button; on a desktop the
            menu and logo drop away and it becomes a thin strip carrying just
            the bell, because the sidebar is already showing the branding. */}
        <div className="sticky top-0 z-30 flex items-center gap-3 px-4 py-2.5 border-b border-[var(--line-soft)] bg-[var(--surface)] lg:border-0 lg:bg-transparent lg:py-2">
          <button
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="lg:hidden rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
              <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
            </svg>
          </button>
          <span className="lg:hidden flex items-center gap-2 min-w-0">
            <span className="w-6 h-6 rounded-md bg-[var(--accent)] text-white grid place-items-center text-xs font-bold flex-none">
              H
            </span>
            <span className="text-sm font-semibold truncate text-slate-900">HKM Vizag</span>
          </span>
          <div className="ml-auto">
            <ReminderBell />
          </div>
        </div>

        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 pb-5 sm:pb-7 pt-3 sm:pt-4">{children}</div>
      </main>
    </div>
    </CallingAlertsProvider>
  );
}
