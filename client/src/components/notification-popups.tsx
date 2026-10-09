"use client";

// New updates, popped up on screen the moment they arrive - a failed payment,
// a donation left unfinished, the morning's Sankalpam list - with a sound, so
// nobody has to open the bell to find out. Each card stays until it is closed
// or acted on (at most four at a time; the rest are in the bell).
//
// Also puts the count in the browser tab's title - "(3) DRM" - so it shows
// even when DRM is not the tab in front.

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { clockTime } from "@/lib/format";
import { callHref, formatPhone } from "@/lib/calling";
import { Badge, Button, Icon } from "@/components/ui";
import { toast } from "./toast";
import { useCallingAlerts, type DrmNotification } from "./calling-alerts";

/**
 * Call and Open on a Nearly gave notification.
 *
 * Both go through the person's lead: Call opens the call screen (so the call
 * is logged and counted), Open opens their lead page. Somebody who is not a
 * lead yet is made one first - the server does that, so the buttons work even
 * when the bell does not know their lead yet. Before, Call fell back to a
 * phone link (which does nothing on a computer) and Open went to the Nearly
 * gave list, which is no help when you are already on it.
 */
export function NearlyGaveActions({ n, onGo }: { n: DrmNotification; onGo?: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"call" | "open" | null>(null);

  async function go(what: "call" | "open") {
    setBusy(what);
    try {
      let id = n.lead_id ?? null;
      if (!id) {
        const r = await apiClient.post<{ lead_id?: string; paid?: boolean }>(`/api/notifications/${n.id}/lead`, {});
        if (r.paid) {
          toast("They have donated since - no call needed.");
          onGo?.();
          return;
        }
        id = r.lead_id ?? null;
      }
      if (!id) throw new Error("Could not find them.");
      onGo?.();
      router.push(what === "call" ? callHref(id, "/calling/pending") : `/leads/${id}`);
    } catch (e) {
      toast.error(what === "call" ? "Could not start the call." : "Could not open them.", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Button size="xs" icon="phone" loading={busy === "call"} disabled={!!busy} onClick={() => void go("call")}>
        Call {n.phone ? formatPhone(n.phone) : ""}
      </Button>
      <Button size="xs" variant="secondary" loading={busy === "open"} disabled={!!busy} onClick={() => void go("open")}>
        Open
      </Button>
    </>
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
  const router = useRouter();
  const go = (href: string) => {
    onClose();
    router.push(href);
  };
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
              <NearlyGaveActions n={n} onGo={onClose} />
            ) : n.link ? (
              <Button size="xs" variant="secondary" onClick={() => go(n.link!)}>
                Open
              </Button>
            ) : null}
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
