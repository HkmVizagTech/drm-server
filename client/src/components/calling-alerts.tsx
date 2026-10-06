"use client";

// One poll, shared by everything that needs to interrupt a caller.
//
// WHY A PROVIDER AND NOT A HOOK PER COMPONENT
// Three things need the same live information: the bell in the header, the
// count beside Reminders in the nav, and the strip across the top of the
// calling screen. A hook called in three places would open three timers and
// make three requests a minute each - and worse, they would race for the same
// alerts, because fetching an alert is what marks it delivered. Whichever
// component polled first would "win" it and the other two would show nothing.
//
// So the poll lives here, once, and everything else reads from it.
//
// WHAT IT CARRIES
//   reminders   what the donor themselves asked for, at the moment they named
//   conversions a lead that has just donated - the caller who earned it needs
//               telling, or they will ring a donor who has already given
//
// Both are deliberately on the same timer: they are the same kind of
// interruption, and a caller mid-run should get them together rather than
// having two separate things pulling at their attention.

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { apiClient } from "@/lib/api";
import type { SankalpSummary } from "@/lib/sankalpam";

export interface ReminderAlert {
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

export interface ConversionAlert {
  id: string;
  name: string | null;
  phone: string;
  converted_amount: string | null;
  converted_at: string;
  converted_via: string | null;
  purpose: string | null;
  source_site: string | null;
}

interface Counts {
  missed: number;
  now: number;
  today: number;
  next_7_days: number;
}

interface Ctx {
  /** Newly-due reminder alerts, each delivered exactly once by the server. */
  alerts: ReminderAlert[];
  /** Leads that donated and whose caller has not been told yet. */
  conversions: ConversionAlert[];
  counts: Counts;
  /** Late, due now, or due today — what the badge shows. */
  dueCount: number;
  /** Sankalpam videos to send today, missed, and coming tomorrow. Null when this person has no Sankalpam. */
  sankalpam: SankalpSummary | null;
  dismissAlert: (id: string) => void;
  dismissConversions: (ids?: string[]) => Promise<void>;
  refresh: () => Promise<void>;
}

const EMPTY_COUNTS: Counts = { missed: 0, now: 0, today: 0, next_7_days: 0 };

const CallingAlertsContext = createContext<Ctx>({
  alerts: [],
  conversions: [],
  counts: EMPTY_COUNTS,
  dueCount: 0,
  sankalpam: null,
  dismissAlert: () => undefined,
  dismissConversions: async () => undefined,
  refresh: async () => undefined,
});

export const useCallingAlerts = () => useContext(CallingAlertsContext);

// A minute. Short enough that a fifteen-minutes-before alert is never more than
// a minute late; long enough that a full day at the desk is under 500 requests,
// and the query usually writes nothing at all.
const POLL_MS = 60_000;

export function CallingAlertsProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState<ReminderAlert[]>([]);
  const [conversions, setConversions] = useState<ConversionAlert[]>([]);
  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);
  const [sankalpam, setSankalpam] = useState<SankalpSummary | null>(null);
  const signedIn = useRef(true);

  const refresh = useCallback(async () => {
    // Sankalpam on its own: it is not calling, and a person who cannot see it
    // (403) must not lose the reminders above to its failure.
    void apiClient
      .get<SankalpSummary & { today_date?: string }>("/api/sankalpam/summary")
      .then((s) => {
        setSankalpam({ today: s.today, missed: s.missed, tomorrow: s.tomorrow });
        notifySankalpamOnceADay(s);
      })
      .catch(() => setSankalpam(null));
    try {
      const [a, board, conv] = await Promise.all([
        apiClient.get<{ alerts: ReminderAlert[] }>("/api/crm/reminders/alerts"),
        apiClient.get<{ counts: Counts }>("/api/crm/reminders?scope=open&mine=true"),
        apiClient.get<{ conversions: ConversionAlert[] }>("/api/crm/conversions/unseen"),
      ]);

      setCounts({ ...EMPTY_COUNTS, ...board.counts });
      setConversions(conv.conversions);

      if (a.alerts.length) {
        // Prepended, capped, and never de-duplicated here: the server hands
        // each offset over exactly once, so anything that arrives is new by
        // definition.
        setAlerts((prev) => [...a.alerts, ...prev].slice(0, 20));
        if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
          for (const al of a.alerts) {
            new Notification(al.lead_name ? `Reminder: ${al.lead_name}` : "Reminder", {
              body: al.title,
              tag: al.id,
            });
          }
        }
      }
      signedIn.current = true;
    } catch {
      // Silent. A failed poll must never put an error banner over a call in
      // progress, and the next one is a minute away.
      signedIn.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    // Catching up the moment someone returns to the tab matters more than the
    // timer: a laptop that was asleep has a backlog waiting.
    const onBack = () => void refresh();
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [refresh]);

  const dismissAlert = useCallback((id: string) => {
    setAlerts((a) => a.filter((x) => x.id !== id));
  }, []);

  const dismissConversions = useCallback(async (ids?: string[]) => {
    setConversions((c) => (ids ? c.filter((x) => !ids.includes(x.id)) : []));
    try {
      await apiClient.post("/api/crm/conversions/seen", { ids: ids ?? [] });
    } catch {
      /* it reappears on the next poll, which is the right failure */
    }
  }, []);

  const dueCount = counts.missed + counts.now + counts.today;

  return (
    <CallingAlertsContext.Provider
      value={{ alerts, conversions, counts, dueCount, sankalpam, dismissAlert, dismissConversions, refresh }}
    >
      {children}
    </CallingAlertsContext.Provider>
  );
}

/**
 * The morning nudge: once a day, the first time DRM is open, a desktop
 * notification saying how many Sankalpam videos are due. Remembered per
 * browser so it does not repeat every minute.
 */
function notifySankalpamOnceADay(s: SankalpSummary) {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
  const due = s.today + s.missed;
  if (!due && !s.tomorrow) return;
  const day = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  try {
    if (localStorage.getItem("sankalpam-notified") === day) return;
    localStorage.setItem("sankalpam-notified", day);
  } catch {
    return;
  }
  const parts = [
    s.today ? `${s.today} to send today` : null,
    s.missed ? `${s.missed} missed` : null,
    s.tomorrow ? `${s.tomorrow} tomorrow` : null,
  ].filter(Boolean);
  new Notification("Sankalpam", { body: parts.join(" · "), tag: `sankalpam-${day}` });
}
