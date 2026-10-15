"use client";

// On a laptop: every Call button rings from the caller's own phone when that
// phone is on DRM's Laptop dialer screen.
//
// Every Call button in DRM is a tel: link, so one listener here covers the call
// screen, Leads, Nearly gave, Sankalpam and the rest. When the phone is ready
// the click is sent to it and the laptop follows along in a toast ("Ringing on
// your phone" -> "Calling on your phone"). When it is not, the click is left
// alone and the laptop calls the way it always has - nothing gets stuck
// waiting for a phone that is not there.
//
// Inside the app none of this runs: the phone dials itself (phone-app-bridge).

import { useEffect } from "react";
import { useInApp } from "@/lib/phone-app";
import { dialState, dialerStatus, phoneNotReady, refreshDialer, sendToPhone, useDialerStatus } from "@/lib/phone-dialer";
import { formatPhone } from "@/lib/calling";
import { toast } from "./toast";
import { Icon } from "./icons";

/** Follow one click until the phone has placed it, failed, or never picked it up. */
async function follow(id: string, number: string, phoneName: string) {
  let note = toast("Sending to your phone…", { tone: "info", body: `${formatPhone(number)} · ${phoneName}`, ms: 20_000 });
  let shownRinging = false;
  const until = Date.now() + 22_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 700));
    let s;
    try {
      s = await dialState(id);
    } catch {
      continue;
    }
    if (s.state === "ringing" && !shownRinging) {
      shownRinging = true;
      note();
      note = toast("Ringing on your phone", { tone: "info", body: formatPhone(number), ms: 15_000 });
    } else if (s.state === "placed") {
      note();
      toast.success("Calling on your phone", `${formatPhone(number)}. Save the result here as usual.`);
      return;
    } else if (s.state === "failed") {
      note();
      toast.error("Your phone could not call", s.error ?? undefined);
      return;
    } else if (s.state === "expired" || s.state === "replaced") {
      note();
      if (s.state === "expired") {
        toast.warn("Your phone did not pick it up", "Is DRM open on the Laptop dialer screen? Try again.");
        void refreshDialer();
      }
      return;
    }
  }
  note();
}

export function PhoneDialerBridge() {
  const app = useInApp();
  // Subscribing starts the 15-second check; in the app there is nothing to check.
  useDialerStatus(!app);

  useEffect(() => {
    if (app) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href^="tel:"]') as HTMLAnchorElement | null;
      if (!a) return;
      const s = dialerStatus();
      if (!s?.ready) return; // not ready: the ordinary call link does its job
      const href = a.getAttribute("href")!;
      const number = href.slice(4).replace(/\D/g, "").slice(-10);
      if (number.length !== 10) return;
      e.preventDefault();
      sendToPhone(number, a.dataset.leadId ?? null)
        .then((r) => follow(r.id, number, r.phone))
        .catch((err) => {
          if (phoneNotReady(err)) {
            // It went away between checks (app closed, phone locked). Call the
            // usual way rather than leave the click doing nothing.
            void refreshDialer();
            toast.info("Your phone is not on the Laptop dialer", "Calling from this computer instead.");
            window.location.href = href;
          } else {
            toast.error("Could not send the call to your phone", err instanceof Error ? err.message : undefined);
          }
        });
    };
    // Capture, so it runs before the page's own click handlers can navigate.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [app]);

  return null;
}

/**
 * "Phone ready" in the top bar on a laptop, for anyone with the app linked.
 * Hidden for people who have never installed it, and inside the app.
 */
export function DialerChip() {
  const app = useInApp();
  const s = useDialerStatus(!app);
  if (app || !s?.has_phone) return null;
  return (
    <button
      type="button"
      onClick={() =>
        s.ready
          ? toast.info("Calls ring from your phone", `${s.phone ?? "Your phone"} is on the Laptop dialer. Click any Call button.`)
          : toast.info(
              "To call from your phone",
              "Open DRM on your phone, go to Laptop dialer, and leave it open beside the laptop."
            )
      }
      className={`hidden h-8 items-center gap-1.5 rounded-pill px-2.5 text-xs font-medium ring-1 ring-inset transition-colors lg:inline-flex ${
        s.ready
          ? "bg-good-wash text-good ring-good/25 hover:bg-good-wash/70"
          : "bg-surface text-ink-muted ring-line-strong hover:bg-sunken"
      }`}
      title={s.ready ? `Calls ring from ${s.phone ?? "your phone"}` : "Your phone is not on the Laptop dialer"}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.ready ? "bg-good" : "bg-ink-muted/60"}`} aria-hidden />
      <Icon name="phone" size={13} />
      {s.ready ? "Phone ready" : "Phone off"}
    </button>
  );
}
