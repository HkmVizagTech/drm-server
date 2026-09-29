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
import { apiClient } from "@/lib/api";
import { currency } from "@/lib/format";
import { useCallingAlerts } from "./calling-alerts";

interface Alert {
  id: string;
  lead_id: string;
  title: string;
  note: string | null;
  occasion: string | null;
  due_at: string;
  expected_amount: string | null;
  lead_name: string | null;
  lead_phone: string;
}

// A minute. Short enough that a 15-minutes-before alert is never more than a
// minute late, long enough that a day at the desk is 480 requests rather than
// thousands - and the query is an indexed lookup that usually writes nothing.
const POLL_MS = 60_000;

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
  const { alerts, conversions, dueCount, dismissAlert, dismissConversions, refresh } = useCallingAlerts();
  const [open, setOpen] = useState(false);
  const [canNotify, setCanNotify] = useState<"unsupported" | "granted" | "denied" | "default">("unsupported");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setCanNotify(Notification.permission as "granted" | "denied" | "default");
    }
  }, []);

  // Open by itself when something new arrives — the whole point of an alert is
  // that the caller does not have to go looking for it.
  const seen = useRef(0);
  useEffect(() => {
    if (alerts.length > seen.current) setOpen(true);
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
      void refresh();
    } catch {
      /* the board is the source of truth; a failed snooze just reappears */
    }
  }

  return (
    <div ref={panelRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={dueCount ? `${dueCount} reminders need attention` : "Reminders"}
        className="relative rounded-lg p-2 text-slate-600 hover:bg-white/70 hover:text-slate-900 transition-colors"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {dueCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold grid place-items-center tabular-nums">
            {dueCount > 99 ? "99+" : dueCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--line-strong)] bg-white shadow-xl z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--line-soft)]">
            <p className="text-sm font-semibold text-slate-900">Reminders</p>
            <Link href="/calling/reminders" onClick={() => setOpen(false)} className="text-xs text-[var(--accent)] hover:underline">
              See all
            </Link>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {/* A lead that has donated goes above the reminders. It is the one
                piece of news that changes what a caller does next — including
                not ringing someone who has already given. */}
            {conversions.length > 0 && (
              <ul className="divide-y divide-emerald-100 bg-emerald-50/60">
                {conversions.map((c) => (
                  <li key={c.id} className="px-4 py-3">
                    <p className="text-sm font-medium text-emerald-900">
                      {c.name || c.phone} donated {c.converted_amount ? currency(Number(c.converted_amount)) : ""}
                    </p>
                    <p className="text-xs text-emerald-800 mt-0.5">
                      {c.purpose ? `${c.purpose} · ` : ""}
                      {c.converted_via === "auto" ? "came through on the site" : "recorded by hand"}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Link
                        href={`/leads/${c.id}`}
                        onClick={() => setOpen(false)}
                        className="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white"
                      >
                        Open
                      </Link>
                      <button
                        onClick={() => void dismissConversions([c.id])}
                        className="rounded-lg border border-emerald-200 bg-white px-2.5 py-1 text-xs text-emerald-800"
                      >
                        Got it
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {!alerts.length && !conversions.length ? (
              <p className="px-4 py-6 text-sm text-slate-500 text-center">
                {dueCount > 0
                  ? `${dueCount} reminder${dueCount === 1 ? "" : "s"} need attention.`
                  : "Nothing is alerting right now."}
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {alerts.map((a) => (
                  <li key={a.id + a.due_at} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <Link
                        href={`/leads/${a.lead_id}`}
                        onClick={() => setOpen(false)}
                        className="text-sm font-medium text-slate-900 hover:text-[var(--accent)] truncate"
                      >
                        {a.lead_name || a.lead_phone}
                      </Link>
                      <span className="text-[11px] text-amber-700 font-medium whitespace-nowrap">
                        {timeUntil(a.due_at)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-slate-600">{a.title}</p>
                    {a.expected_amount && (
                      <p className="text-xs text-slate-500">Said they would give {currency(Number(a.expected_amount))}</p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <a
                        href={`tel:+91${a.lead_phone}`}
                        className="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                      >
                        Call {a.lead_phone}
                      </a>
                      <button onClick={() => void act(a.id, "snooze", 15)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                        15 min
                      </button>
                      <button onClick={() => void act(a.id, "snooze", 60)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                        1 hour
                      </button>
                      <button onClick={() => void act(a.id, "done")} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                        Done
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {canNotify === "default" && (
            <div className="border-t border-[var(--line-soft)] px-4 py-3">
              <button
                onClick={() =>
                  Notification.requestPermission().then((p) => setCanNotify(p as "granted" | "denied" | "default"))
                }
                className="text-xs text-[var(--accent)] hover:underline"
              >
                Also alert me on the desktop, even when this tab is behind something
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
