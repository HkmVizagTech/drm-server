"use client";

// The alert that makes reminders worth having.
//
// A reminder nobody is told about is a list, and lists get read once a week. So
// this sits in the shell on every screen, asks the server once a minute what is
// newly due for this caller, and puts it in front of them.
//
// WHAT THE SERVER GUARANTEES, AND WHY THAT MATTERS HERE
// GET /reminders/alerts returns only offsets that have not been raised before,
// and marks them raised as it returns them. So this component can be naive: it
// shows whatever arrives, and does not need to remember what it has already
// shown, de-duplicate across tabs, or worry that a refresh will replay the
// morning's alerts. All of that is settled in one SQL statement.
//
// DESKTOP NOTIFICATIONS
// Offered, never forced. The browser only grants permission in response to a
// real click, and a page that demands it on load gets refused permanently in
// most browsers - so there is a button, and the toast works regardless of the
// answer.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { apiClient } from "@/lib/api";
import { clockTime, currency, relativeDate } from "@/lib/format";
import { callHref, formatPhone } from "@/lib/calling";
import { Badge, Button, Icon, IconButton, buttonClass } from "@/components/ui";
import { toast } from "./toast";
import { useCallingAlerts, type DrmNotification } from "./calling-alerts";
import { NearlyGaveActions } from "./notification-popups";
import { setSoundOn, soundOn } from "@/lib/chime";

// The cadence - a minute - lives with the timer that uses it, in
// calling-alerts.tsx. A second POLL_MS was declared here and read by nothing,
// which is the worst kind of constant: editing it looks like it changed the
// poll and does not.

function timeUntil(iso: string): string {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (mins < -1) return `${Math.abs(mins)} minutes ago`;
  if (mins <= 1) return "now";
  if (mins < 60) return `in ${mins} minutes`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs} hour${hrs === 1 ? "" : "s"}`;
  const days = Math.round(hrs / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

export function ReminderBell() {
  // The poll lives in CallingAlertsProvider, once for the whole app. Three
  // components need this information and three timers would race each other for
  // the same alerts, since fetching one is what marks it delivered.
  const { alerts, conversions, dueCount, dismissAlert, dismissConversions, refresh, notifications, unread, markNotificationsSeen } =
    useCallingAlerts();
  const [open, setOpen] = useState(false);
  // Two lists behind one bell: what just happened (nearly gave, Sankalpam)
  // and the donors' own promises (reminders). Opens on whichever has news.
  const [pane, setPane] = useState<"updates" | "reminders">("updates");
  const badge = dueCount + unread;
  // Read once, lazily. Only ever drawn inside the open panel, which is never
  // part of the server's HTML, so reading the browser here cannot make the
  // first render disagree with it.
  const [canNotify, setCanNotify] = useState<"unsupported" | "granted" | "denied" | "default">(() =>
    typeof window !== "undefined" && "Notification" in window
      ? (Notification.permission as "granted" | "denied" | "default")
      : "unsupported"
  );
  const panelRef = useRef<HTMLDivElement>(null);
  // Only read inside the open panel, never in the server's HTML.
  const [sound, setSound] = useState(soundOn);
  // Where a "Call" from here should come back to once the outcome is logged.
  const pathname = usePathname();

  // Open by itself when something new arrives — the whole point of an alert is
  // that the caller does not have to go looking for it.
  const seen = useRef(0);
  useEffect(() => {
    if (alerts.length > seen.current) {
      setOpen(true);
      setPane("reminders");
    }
    seen.current = alerts.length;
  }, [alerts.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  async function act(id: string, action: string, minutes?: number) {
    dismissAlert(id);
    try {
      await apiClient.put(`/api/crm/reminders/${id}`, { action, minutes });
      toast(action === "done" ? "Reminder done" : `Snoozed for ${minutes === 60 ? "an hour" : `${minutes} minutes`}`);
      void refresh();
    } catch (e) {
      // The board is the source of truth; a failed snooze just reappears.
      toast.error("Could not update. Try again.", e instanceof Error ? e.message : undefined);
    }
  }

  return (
    <div ref={panelRef} className="relative">
      {/* The count rides on top of the shared IconButton rather than being
          baked into it: a badge is the only thing this bell needs that a
          standard icon button does not have, and a wrapper is cheaper than a
          variant nothing else would use. */}
      <span className="relative block">
        <IconButton
          name="bell"
          label={badge ? `Notifications, ${badge} new` : "Notifications"}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) setPane(unread || !(alerts.length || conversions.length) ? "updates" : "reminders");
          }}
          aria-expanded={open}
          aria-haspopup="true"
        />
        {badge > 0 && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 grid h-[1.1rem] min-w-[1.1rem] place-items-center rounded-pill bg-danger px-1 text-2xs font-semibold tabular-nums text-white ring-2 ring-surface">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>

      {open && (
        <div
          aria-label="Reminders"
          className="fade-rise absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] rounded-control border border-line-strong bg-surface shadow-float"
        >
          <div className="flex items-center gap-1 border-b border-line-soft px-2 py-2">
            {(
              [
                { key: "updates", label: "Updates", n: unread },
                { key: "reminders", label: "Reminders", n: dueCount },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setPane(t.key)}
                className={`inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-sm font-medium ${
                  pane === t.key ? "bg-brand-50 text-brand-800" : "text-ink-muted hover:bg-sunken"
                }`}
              >
                {t.label}
                {t.n > 0 && (
                  <span className="rounded-pill bg-danger px-1.5 text-2xs font-semibold tabular-nums text-white">{t.n > 99 ? "99+" : t.n}</span>
                )}
              </button>
            ))}
            <Link
              href={pane === "updates" ? "/calling/pending" : "/calling/reminders"}
              onClick={() => setOpen(false)}
              className="ml-auto px-2 text-xs text-brand-700 hover:underline"
            >
              {pane === "updates" ? "Nearly gave" : "See all"}
            </Link>
          </div>

          {pane === "updates" && (
            <Updates
              items={notifications}
              unread={unread}
              onSeen={markNotificationsSeen}
              onGo={() => setOpen(false)}
            />
          )}

          <div className={`scroll-slim max-h-96 overflow-y-auto ${pane === "updates" ? "hidden" : ""}`}>
            {/* A lead that has donated goes above the reminders. It is the one
                piece of news that changes what a caller does next — including
                not ringing someone who has already given. */}
            {conversions.length > 0 && (
              <ul className="divide-y divide-line-soft bg-good-wash">
                {conversions.map((c) => (
                  <li key={c.id} className="px-4 py-3">
                    <div className="mb-1">
                      <Badge tone="good" dot>
                        Donated
                      </Badge>
                    </div>
                    <p className="text-sm font-medium text-ink">
                      {c.name || c.phone} donated {c.converted_amount ? currency(Number(c.converted_amount)) : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {c.purpose ? `${c.purpose} · ` : ""}
                      {c.converted_via === "auto" ? "Paid on the site" : "Added by hand"}
                    </p>
                    <div className="mt-2 flex gap-2">
                      {/* Still a next/link, not the shared LinkButton: that one
                          renders a plain anchor, and swapping it in here would
                          turn a client-side hop into a full page reload in the
                          middle of a call. The class string is the same one the
                          component builds from. */}
                      <Link
                        href={`/leads/${c.id}`}
                        onClick={() => setOpen(false)}
                        className={buttonClass("primary", "xs")}
                      >
                        Open
                      </Link>
                      <Button size="xs" variant="secondary" onClick={() => void dismissConversions([c.id])}>
                        Got it
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {!alerts.length && !conversions.length ? (
              <p className="px-4 py-6 text-center text-sm text-ink-muted">
                {dueCount > 0
                  ? `${dueCount} reminder${dueCount === 1 ? "" : "s"} due.`
                  : "No reminders right now."}
              </p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {alerts.map((a) => (
                  <li key={a.id + a.due_at} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <Link
                        href={`/leads/${a.lead_id}`}
                        onClick={() => setOpen(false)}
                        className="truncate text-sm font-medium text-ink hover:text-brand-700"
                      >
                        {a.lead_name || a.lead_phone}
                      </Link>
                      {/* The timing is the reason this row is in front of
                          someone, so it wears a badge rather than a line of
                          coloured text that reads as a caption. */}
                      <Badge tone="warn">{timeUntil(a.due_at)}</Badge>
                    </div>
                    <p className="mt-0.5 text-sm text-ink-soft">{a.title}</p>
                    {a.expected_amount && (
                      <p className="text-xs text-ink-muted">
                        Promised {currency(Number(a.expected_amount))}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {/* Through the call screen rather than a bare tel:
                          link, so the outcome of the call is recorded. */}
                      <Link
                        href={callHref(a.lead_id, pathname || undefined)}
                        onClick={() => setOpen(false)}
                        className={buttonClass("primary", "xs")}
                      >
                        <Icon name="phone" size={13} />
                        Call {formatPhone(a.lead_phone)}
                      </Link>
                      <Button size="xs" variant="secondary" onClick={() => void act(a.id, "snooze", 15)}>
                        15 min
                      </Button>
                      <Button size="xs" variant="secondary" onClick={() => void act(a.id, "snooze", 60)}>
                        1 hour
                      </Button>
                      <Button size="xs" variant="secondary" icon="check" onClick={() => void act(a.id, "done")}>
                        Done
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line-soft px-4 py-2.5">
            {canNotify === "default" ? (
              <button
                onClick={() =>
                  Notification.requestPermission().then((p) => setCanNotify(p as "granted" | "denied" | "default"))
                }
                className="text-left text-xs text-brand-700 hover:underline"
              >
                Turn on desktop alerts
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => {
                setSoundOn(!sound);
                setSound(!sound);
              }}
              className="inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink"
            >
              <Icon name="bell" size={13} />
              Sound {sound ? "on" : "off"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What just happened: a payment that failed, a donation left unfinished, the
 * morning's Sankalpam list, a special day a donor gave on a site's form. Marked
 * read when shown; new ones are tinted until then.
 */
function Updates({
  items,
  unread,
  onSeen,
  onGo,
}: {
  items: DrmNotification[];
  unread: number;
  onSeen: () => Promise<void>;
  onGo: () => void;
}) {
  // Which were new when the panel opened - kept so they stay tinted while
  // being read, even though opening the panel marks them seen.
  const [fresh] = useState(() => new Set(items.slice(0, unread).map((n) => n.id)));
  useEffect(() => {
    if (unread > 0) void onSeen();
  }, [unread, onSeen]);

  if (!items.length) {
    return <p className="px-4 py-6 text-center text-sm text-ink-muted">Nothing new. Failed payments and Sankalpam days show here.</p>;
  }
  return (
    <ul className="scroll-slim max-h-96 divide-y divide-line-soft overflow-y-auto">
      {items.map((n) => {
        const ng = n.kind === "nearly_gave";
        return (
          <li key={n.id} className={`px-4 py-3 ${fresh.has(n.id) ? "bg-brand-50/70" : ""}`}>
            <div className="flex items-start gap-2.5">
              <span
                className={`mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-control ${
                  ng ? "bg-warn-wash text-warn" : "bg-amber-100 text-amber-800"
                }`}
              >
                <Icon name={ng ? "inbox" : "sparkle"} size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{n.title}</p>
                {n.body && <p className="mt-0.5 text-xs text-ink-muted">{n.body}</p>}
                <p className="mt-0.5 text-2xs text-ink-faint">{relativeDate(n.created_at)} · {clockTime(n.created_at)}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {ng && n.paid_since ? (
                    <Badge tone="good" dot>
                      Donated since
                    </Badge>
                  ) : ng ? (
                    <NearlyGaveActions n={n} onGo={onGo} />
                  ) : null}
                  {!ng && n.link && (
                    <Link href={n.link} onClick={onGo} className={buttonClass("secondary", "xs")}>
                      Open
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
