"use client";

// New updates, popped up on screen the moment they arrive - a failed payment,
// a donation left unfinished, the morning's Sankalpam list - with a sound, so
// nobody has to open the bell to find out. Each card stays until it is closed
// or acted on (at most four at a time; the rest are in the bell).
//
// Also puts the count in the browser tab's title - "(3) DRM" - so it shows
// even when DRM is not the tab in front.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { clockTime } from "@/lib/format";
import { callHref, formatPhone } from "@/lib/calling";
import { Badge, Button, Icon, buttonClass } from "@/components/ui";
import { toast } from "./toast";
import { useCallingAlerts, type DrmNotification } from "./calling-alerts";

/**
 * Call from a Nearly gave notification, through the call screen so the call is
 * logged and counted. Somebody not yet a lead is made one first (yours), the
 * same as pressing Call on the Nearly gave screen.
 */
export function NearlyGaveCallButton({ n, onGo }: { n: DrmNotification; onGo?: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const label = `Call ${n.phone ? formatPhone(n.phone) : ""}`;
  if (n.lead_id) {
    return (
      <Link href={callHref(n.lead_id, "/calling/pending")} onClick={onGo} className={buttonClass("primary", "xs")}>
        <Icon name="phone" size={13} />
        {label}
      </Link>
    );
  }
  if (!n.attempt_id) {
    return n.phone ? (
      <a href={`tel:+91${n.phone}`} onClick={onGo} className={buttonClass("primary", "xs")}>
        <Icon name="phone" size={13} />
        {label}
      </a>
    ) : null;
  }
  return (
    <Button
      size="xs"
      icon="phone"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await apiClient.post<{ lead_ids: string[]; gave_anyway: number; do_not_call: number }>(
            "/api/crm/leads/abandoned/adopt-bulk",
            { ids: [n.attempt_id], filters: {}, assign: "me" }
          );
          const id = r.lead_ids[0];
          if (!id) {
            toast.warn(r.gave_anyway ? "They have donated since - no call needed." : "They cannot be called from here.");
            return;
          }
          onGo?.();
          router.push(callHref(id, "/calling/pending"));
        } catch (e) {
          toast.error("Could not start the call. Try again.", e instanceof Error ? e.message : undefined);
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

export function NotificationPopups() {
  const { popups, notifications, dismissPopup, unread, dueCount } = useCallingAlerts();
  const pathname = usePathname();
  const [canNotify, setCanNotify] = useState<string>(() =>
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported"
  );

  // "(3) DRM" in the tab. Re-applied on every page change, because each page
  // sets its own title.
  const count = unread + dueCount;
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\)\s*/, "");
    document.title = count > 0 ? `(${count > 99 ? "99+" : count}) ${base}` : base;
  }, [count, pathname]);

  const cards = popups
    .map((id) => notifications.find((n) => n.id === id))
    .filter((n): n is DrmNotification => !!n);
  if (!cards.length) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-14 z-[55] flex flex-col items-center gap-2 px-3 sm:inset-x-auto sm:right-4 sm:top-16 sm:items-end"
    >
      {cards.map((n) => (
        <PopupCard key={n.id} n={n} onClose={() => dismissPopup(n.id)} />
      ))}
      {canNotify === "default" && (
        <button
          type="button"
          onClick={() => void Notification.requestPermission().then((p) => setCanNotify(p))}
          className="pointer-events-auto rounded-pill bg-ink px-3 py-1.5 text-xs font-medium text-white shadow-float hover:bg-ink/90"
        >
          Also show these when DRM is in the background
        </button>
      )}
    </div>
  );
}

function PopupCard({ n, onClose }: { n: DrmNotification; onClose: () => void }) {
  const ng = n.kind === "nearly_gave";
  const failed = ng && /^Payment failed/.test(n.title);
  return (
    <div
      role="alert"
      className={`fade-rise pointer-events-auto w-full max-w-[24rem] rounded-card border bg-surface p-3.5 shadow-float ${
        failed ? "border-danger/40" : ng ? "border-warn/40" : "border-line-strong"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`grid h-8 w-8 flex-none place-items-center rounded-control ${
            failed ? "bg-danger/10 text-danger" : ng ? "bg-warn-wash text-warn" : "bg-amber-100 text-amber-800"
          }`}
        >
          <Icon name={ng ? "phone" : "sparkle"} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{n.title}</p>
          {n.body && <p className="mt-0.5 text-xs text-ink-muted">{n.body}</p>}
          <p className="mt-0.5 text-2xs text-ink-faint">{clockTime(n.created_at)}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {ng && n.paid_since ? (
              <Badge tone="good" dot>
                Donated since - no call needed
              </Badge>
            ) : ng ? (
              <NearlyGaveCallButton n={n} onGo={onClose} />
            ) : null}
            {n.link && (
              <Link href={n.link} onClick={onClose} className={buttonClass("secondary", "xs")}>
                Open
              </Link>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-1 -mt-1 grid h-7 w-7 flex-none place-items-center rounded-control text-ink-muted hover:bg-sunken hover:text-ink"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}
