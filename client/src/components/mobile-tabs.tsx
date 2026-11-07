"use client";

// The bottom bar on a phone: the few places somebody goes all day, one tap away, plus the full menu.
// Hidden from a laptop (the sidebar is there) and, on a phone, while a WhatsApp conversation is open
// so the message box gets the whole screen, as in WhatsApp itself.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./icons";
import { useAuth } from "@/lib/auth-context";
import { useWhatsAppUnread } from "@/lib/wa-unread";

type Tab = { href: string; label: string; icon: IconName };

const TABS: Record<string, Tab[]> = {
  admin: [
    { href: "/dashboard", label: "Home", icon: "home" },
    { href: "/calling/start", label: "Calling", icon: "phoneOutgoing" },
    { href: "/whatsapp", label: "WhatsApp", icon: "message" },
    { href: "/people", label: "People", icon: "users" },
  ],
  caller: [
    { href: "/calling/start", label: "Calling", icon: "phoneOutgoing" },
    { href: "/follow-ups", label: "Follow-ups", icon: "clock" },
    { href: "/whatsapp", label: "WhatsApp", icon: "message" },
    { href: "/calling/calls", label: "My calls", icon: "phone" },
  ],
  other: [
    { href: "/dashboard", label: "Home", icon: "home" },
    { href: "/people", label: "People", icon: "users" },
    { href: "/donations", label: "Donations", icon: "rupee" },
  ],
};

export function MobileTabs({ onMenu }: { onMenu: () => void }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const unread = useWhatsAppUnread(user?.role);
  const tabs = TABS[user?.role ?? ""] ?? TABS.other;

  return (
    <nav
      aria-label="Main"
      className="mobile-tabs fixed inset-x-0 bottom-0 z-40 border-t border-line-soft bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
    >
      <ul className="mx-auto grid h-16 max-w-xl" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
        {tabs.map((t) => {
          const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
          const badge = t.href === "/whatsapp" ? unread : 0;
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? "page" : undefined} className={`relative flex h-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${active ? "text-brand-700" : "text-ink-muted"}`}>
                <span className={`relative grid h-7 w-12 place-items-center rounded-full transition-colors ${active ? "bg-brand-100" : ""}`}>
                  <Icon name={t.icon} size={20} />
                  {badge > 0 && (
                    <span className="absolute -right-0.5 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[#25D366] px-1 text-[10px] font-semibold leading-none text-white">{badge > 99 ? "99+" : badge}</span>
                  )}
                </span>
                {t.label}
              </Link>
            </li>
          );
        })}
        <li>
          <button onClick={onMenu} className="flex h-full w-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-ink-muted" aria-label="Open the full menu">
            <span className="grid h-7 w-12 place-items-center"><Icon name="menu" size={20} /></span>
            Menu
          </button>
        </li>
      </ul>
    </nav>
  );
}
