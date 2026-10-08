"use client";

// The admin shell.
//
// WHY THIS IS RESPONSIVE
// Callers dial from their own phones: they tap the number on the calling
// screen, talk, and come back to tap an outcome. That makes a phone the primary
// device for at least one screen in this app, and a 240px sidebar that never
// collapses left about 150px for the content on a 390px-wide phone - the
// calling screen was unusable on the only device it was designed for.
//
// So below `lg` the sidebar becomes a drawer behind a menu button.
//
// WHY THE DESKTOP TOP BAR IS A REAL BAR NOW
// It used to drop its border and background at `lg` and become a transparent
// strip holding one bell icon. On a phone there was a header; on a desktop
// there was, in effect, nothing - a floating icon over the page. Combined with
// a nav group of nine calling screens and no breadcrumb anywhere, there was
// nothing on screen telling you where in the product you were. The bar now
// carries the trail, and on a long list it stays stuck to the top so the
// answer does not scroll away.

import { ReactNode, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Sidebar, navLocation } from "./sidebar";
import { ReminderBell } from "./reminder-bell";
import { CallingAlertsProvider } from "./calling-alerts";
import { NotificationPopups } from "./notification-popups";
import { Icon } from "./icons";
import { GlobalSearch } from "./global-search";
import { Toaster } from "./toast";

function Breadcrumb() {
  const pathname = usePathname();
  const here = navLocation(pathname);
  if (!here) return null;

  // A detail page (/leads/abc-123) is one level below its list, so the list
  // becomes a link back. Without it the only way out of a donor record is the
  // browser's back button, which is not a thing people look for inside an app.
  const isDetail = pathname !== here.item.href;

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
      <span className="hidden text-ink-faint sm:inline">{here.group}</span>
      <Icon name="chevronRight" size={13} className="hidden text-ink-faint/70 sm:inline" />
      {isDetail ? (
        <>
          <Link
            href={here.item.href}
            className="truncate rounded text-ink-muted transition-colors hover:text-brand-700"
          >
            {here.item.label}
          </Link>
          <Icon name="chevronRight" size={13} className="text-ink-faint/70" />
          <span className="truncate font-medium text-ink">Details</span>
        </>
      ) : (
        <span className="truncate font-medium text-ink">{here.item.label}</span>
      )}
    </nav>
  );
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // On a phone the search box takes the whole bar, so it opens on demand.
  const [searching, setSearching] = useState(false);
  const pathname = usePathname();

  // Close on navigation. Without this, tapping a link on a phone leaves the
  // drawer covering the page you just asked for.
  useEffect(() => {
    setOpen(false);
    setSearching(false);
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
      <div className="flex h-screen bg-page text-ink">
        {/* Desktop. */}
        <div className="hidden lg:flex">
          <Sidebar />
        </div>

        {/* Phone and tablet: a drawer. */}
        {open && (
          <div className="fixed inset-0 z-50 flex lg:hidden">
            <div className="relative z-10 h-full shadow-dialog">
              <Sidebar onNavigate={() => setOpen(false)} />
            </div>
            <button
              aria-label="Close menu"
              onClick={() => setOpen(false)}
              className="backdrop-in flex-1 bg-ink/45"
            />
          </div>
        )}

        {/* min-w-0 matters: without it a wide table inside a flex child refuses to
            shrink and pushes the whole layout sideways instead of scrolling. */}
        {/* `relative` is load-bearing, not decoration.
            Tailwind's `sr-only` is `position: absolute`, and an absolutely
            positioned element with no positioned ancestor is laid out against
            the initial containing block - so it escapes this scroller's
            clipping entirely. Every hidden file input and screen-reader label
            deep inside a long page was landing thousands of pixels down the
            DOCUMENT, giving the window a second scrollbar that dragged the whole
            fixed-height shell out of view and left a screenful of blank page
            below it.
            Making this the containing block puts them back inside, where the
            overflow rule can clip them. */}
        <main className="relative min-w-0 flex-1 overflow-y-auto">
          {/* ONE header, at both sizes, and exactly ONE ReminderBell in the whole
              app. That matters: the bell polls the server every minute, and a
              second copy - say one in the sidebar for desktop and one here for
              phones - would mount both (Tailwind's lg:hidden hides an element,
              it does not stop it running) and quietly double every caller's
              request count while racing itself for the same alerts. */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line-soft bg-surface/85 px-4 backdrop-blur-md sm:px-6">
            <button
              onClick={() => setOpen(true)}
              aria-label="Open menu"
              className="-ml-1 grid h-9 w-9 flex-none place-items-center rounded-control text-ink-soft transition-colors hover:bg-sunken lg:hidden"
            >
              <Icon name="menu" size={19} />
            </button>

            {/* The mark only appears on a phone, where the sidebar is hidden and
                nothing else says which product this is. */}
            <Link href="/dashboard" className="flex min-w-0 items-center gap-2 lg:hidden">
              <span className="grid h-7 w-7 flex-none place-items-center rounded-lg bg-gradient-to-b from-brand-500 to-brand-700 text-xs font-bold text-white shadow-button">
                H
              </span>
              <span className="truncate text-sm font-semibold text-ink">HKM Vizag</span>
            </Link>

            <div className="hidden min-w-0 lg:flex">
              <Breadcrumb />
            </div>

            {/* Search: in the bar from tablet width up; behind an icon on a
                phone, where it opens as its own row below the bar. */}
            <div className="ml-auto hidden w-full max-w-md md:block">
              <GlobalSearch />
            </div>

            <div className="ml-auto flex items-center gap-1 md:ml-2">
              <button
                onClick={() => setSearching((v) => !v)}
                aria-label="Search"
                aria-expanded={searching}
                className="grid h-9 w-9 place-items-center rounded-control text-ink-soft transition-colors hover:bg-sunken md:hidden"
              >
                <Icon name={searching ? "x" : "search"} size={18} />
              </button>
              <ReminderBell />
            </div>
          </header>
          {searching && (
            <div className="sticky top-14 z-30 border-b border-line-soft bg-surface px-4 py-2 md:hidden">
              <GlobalSearch autoFocus />
            </div>
          )}

          <div className="mx-auto max-w-[1400px] px-4 pb-8 pt-5 sm:px-6 sm:pt-6">{children}</div>
        </main>
        <Toaster />
      </div>
      <NotificationPopups />
    </CallingAlertsProvider>
  );
}
