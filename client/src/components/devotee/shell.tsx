"use client";

// The devotee's app: their own leads and follow-ups, the map, and Add record for bricks.
//
// A bare shell rather than the admin one: no sidebar, no search, no calling alerts - those poll
// endpoints a devotee's token is refused, and show things that are not theirs. Tabs along the
// bottom on a phone (where devotees mostly are), along the top on a wider screen.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { Icon, type IconName } from "@/components/icons";
import { Toaster } from "@/components/toast";
import { homeFor, useAuth } from "@/lib/auth-context";
import { DevoteeProvider, useDevotee } from "@/lib/devotee-context";
import { DevoteePhoneBridge } from "./phone-recording";
import { DialerChip, PhoneDialerBridge } from "@/components/phone-dialer-bridge";

interface Tab {
  href: string;
  label: string;
  icon: IconName;
  /** Other paths that light this tab up. */
  also?: string[];
}

const TABS: Tab[] = [
  { href: "/devotee/home", label: "Home", icon: "home" },
  { href: "/devotee/leads", label: "Leads", icon: "users" },
  { href: "/devotee/follow-ups", label: "Follow-ups", icon: "bell" },
  { href: "/devotee/map", label: "Map", icon: "mapPin" },
  { href: "/devotee/receipts", label: "Receipts", icon: "receipt" },
  { href: "/seva-wall/devotee", label: "Bricks", icon: "box" },
];

const isOn = (path: string, t: Tab) => path === t.href || path.startsWith(`${t.href}/`) || !!t.also?.some((a) => path.startsWith(a));

function DueBadge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="absolute -right-2 -top-1.5 min-w-4.5 rounded-full bg-danger px-1 text-center text-2xs font-semibold leading-4.5 text-white">
      {n > 99 ? "99+" : n}
    </span>
  );
}

function Chrome({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { dueCount } = useDevotee();
  const path = usePathname() ?? "";

  return (
    <div className="min-h-screen bg-page text-ink">
      <header className="sticky top-0 z-30 border-b border-line-soft bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <Link href="/devotee/home" className="flex min-w-0 items-center gap-3">
            <BrandMark />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">HKM Vizag</p>
              <p className="truncate text-xs text-ink-muted">{user?.name ?? "Devotee"}</p>
            </div>
          </Link>
          <nav aria-label="Devotee" className="hidden items-center gap-1 md:flex">
            {TABS.map((t) => {
              const on = isOn(path, t);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={on ? "page" : undefined}
                  className={`relative inline-flex items-center gap-1.5 rounded-control px-3 py-2 text-sm font-medium transition-colors ${
                    on ? "bg-brand-50 text-brand-700" : "text-ink-soft hover:bg-sunken"
                  }`}
                >
                  <span className="relative">
                    <Icon name={t.icon} size={16} />
                    {t.href === "/devotee/follow-ups" && <DueBadge n={dueCount} />}
                  </span>
                  {t.label}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-2">
          {/* On a laptop: "Phone ready" when the devotee's phone is on its Laptop dialer screen. */}
          <DialerChip />
          <button
            type="button"
            onClick={logout}
            className="inline-flex items-center gap-1.5 rounded-control px-3 py-2 text-sm font-medium text-ink-soft ring-1 ring-inset ring-line-soft transition-colors hover:bg-sunken"
          >
            <Icon name="logout" size={16} />
            <span className="hidden sm:inline">Sign out</span>
          </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-28 pt-5 sm:px-6 md:pb-10">{children}</main>

      <nav
        aria-label="Devotee"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-line-soft bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {TABS.map((t) => {
          const on = isOn(path, t);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={on ? "page" : undefined}
              className={`flex flex-col items-center gap-0.5 py-2 text-2xs font-medium ${on ? "text-brand-700" : "text-ink-muted"}`}
            >
              <span className="relative">
                <Icon name={t.icon} size={21} />
                {t.href === "/devotee/follow-ups" && <DueBadge n={dueCount} />}
              </span>
              {t.label}
            </Link>
          );
        })}
      </nav>
      <DevoteePhoneBridge />
      {/* On a laptop: Call clicks ring from the devotee's phone when it is on the Laptop dialer. */}
      <PhoneDialerBridge />
      <Toaster />
    </div>
  );
}

/** Wraps every devotee screen. Anyone who is not a devotee is sent to their own home. */
export function DevoteeShell({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace("/login");
    else if (user.role !== "devotee") router.replace(homeFor(user.role));
  }, [ready, user, router]);

  if (!ready || !user || user.role !== "devotee") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page px-4">
        <p className="text-sm text-ink-muted">Opening…</p>
      </div>
    );
  }
  return (
    <DevoteeProvider>
      <Chrome>{children}</Chrome>
    </DevoteeProvider>
  );
}
