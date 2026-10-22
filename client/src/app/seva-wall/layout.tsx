"use client";

import { ReactNode } from "react";
import DashboardLayout from "@/components/dashboard-layout";
import { BrandMark } from "@/components/brand-mark";
import { Icon } from "@/components/icons";
import { Toaster } from "@/components/toast";
import { useAuth } from "@/lib/auth-context";

/**
 * A brick printer gets a bare page: no sidebar, no search, no calling alerts.
 * They have one job on one screen, and the rest of the shell would only show
 * them things the server refuses them. Everybody else gets the normal admin shell.
 */
function PrinterShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen bg-page text-ink">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-line-soft bg-surface px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <BrandMark />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">HKM Vizag</p>
            <p className="truncate text-xs text-ink-muted">Brick printing</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-ink-muted sm:inline">{user?.name}</span>
          <button
            type="button"
            onClick={logout}
            className="inline-flex items-center gap-1.5 rounded-control px-3 py-2 text-sm font-medium text-ink-soft ring-1 ring-inset ring-line-soft transition-colors hover:bg-sunken"
          >
            <Icon name="logout" size={16} />
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
      <Toaster />
    </div>
  );
}

export default function SevaWallLayout({ children }: LayoutProps<"/seva-wall">) {
  const { user, ready } = useAuth();
  // Say nothing until we know who this is: the admin shell starts polling the
  // calling endpoints the moment it mounts, which a printer's token is refused.
  if (!ready || !user) return null;
  if (user.role === "brick_printer") return <PrinterShell>{children}</PrinterShell>;
  return <DashboardLayout>{children}</DashboardLayout>;
}
