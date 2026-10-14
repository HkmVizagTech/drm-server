"use client";

// Inside the Android app, three things happen on every page:
//   1. the phone is linked to whoever is signed in (once per person);
//   2. every tel: link - the Call buttons on the call screen, Leads, Sankalpam -
//      rings straight from the SIM through the app, so the call is saved;
//   3. if the phone has not been allowed to read calls or recordings yet, a
//      thin bar says so and links to the setup screen.
// In a browser none of this renders or runs.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { ensureLinked, missing, placeCall, useInApp, type PhoneInfo } from "@/lib/phone-app";
import { Icon } from "./icons";

const DISMISS_KEY = "drm-phone-bar-dismissed";

export function PhoneAppBridge() {
  const app = useInApp();
  const { user } = useAuth();
  const pathname = usePathname();
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return typeof window !== "undefined" && sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Link the phone to this person. Re-checked on every page change, which is
  // cheap (no request once linked) and picks up permissions granted meanwhile.
  useEffect(() => {
    if (!app || !user?.id) return;
    let cancelled = false;
    ensureLinked(user.id)
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [app, user?.id, pathname]);

  // Every tel: link rings through the app.
  useEffect(() => {
    if (!app) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="tel:"]') as HTMLAnchorElement | null;
      if (!a) return;
      const number = a.getAttribute("href")!.slice(4).replace(/\D/g, "").slice(-10);
      if (number.length !== 10) return;
      e.preventDefault();
      void placeCall(number, a.dataset.leadId ?? null);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [app]);

  const todo = missing(info);
  if (!app || !info || todo.length === 0 || dismissed || pathname.startsWith("/calling/phone")) return null;

  return (
    <div className="mb-4 flex items-center gap-2.5 rounded-card border border-amber-200 bg-warn-wash px-3.5 py-2.5 text-sm text-amber-900">
      <Icon name="alert" size={16} className="flex-none text-warn" />
      <p className="min-w-0 flex-1">
        {todo.includes("calls")
          ? "Allow the app to make calls and read the call log, so your calls are saved."
          : "Allow the app to read recordings, so your call recordings are saved."}
      </p>
      <Link href="/calling/phone" className="flex-none font-semibold text-brand-700 underline">
        Set up
      </Link>
      <button
        aria-label="Hide for now"
        className="flex-none text-amber-900/70"
        onClick={() => {
          setDismissed(true);
          try {
            sessionStorage.setItem(DISMISS_KEY, "1");
          } catch {
            // Private mode: it just comes back next page.
          }
        }}
      >
        <Icon name="x" size={15} />
      </button>
    </div>
  );
}
