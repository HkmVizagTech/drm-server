"use client";

// Everything the devotee screens share while signed in: the server's config (map and push keys),
// the follow-ups that are due, and the reminders that announce them.
//
// A reminder reaches the devotee three ways, whichever they have:
//
//   1. The page is open      - a toast with a chime, and a system notification if the tab is hidden.
//   2. The browser is closed - Web Push from the server (services/devoteeReminders.ts) to this
//                              browser's subscription. Needs the server's push keys and a "yes"
//                              from the devotee.
//   3. The Android app       - notifications scheduled on the phone itself (Capacitor local
//                              notifications), so they ring at the time even with no network.
//
// One provider, mounted by the devotee shell. A second would alert twice.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiClient } from "./api";
import { appPlugin } from "./phone-app";
import { chime } from "./chime";
import { LEADS_CHANGED, type DevoteeConfig } from "./devotee";
import { toast } from "@/components/toast";

interface Reminder {
  id: string;
  name: string;
  phone: string;
  status: string;
  next_follow_up_at: string;
}

export type PushState = "checking" | "unsupported" | "not_configured" | "off" | "denied" | "on" | "app";

interface DevoteeContext {
  config: DevoteeConfig | null;
  /** Follow-ups whose time has come (overdue included). */
  dueCount: number;
  push: PushState;
  enablePush: () => Promise<void>;
  refresh: () => void;
}

const Ctx = createContext<DevoteeContext | null>(null);

const POLL_MS = 60_000;
/** Older than this when first seen: already on the Follow-ups screen, not worth a ping. */
const STALE_MS = 24 * 60 * 60_000;
const ALERTED_KEY = "dv-alerted";
const NATIVE_KIND = "devotee-follow-up";

/* ------------------------------------------------------------ remembered alerts */

function readAlerted(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ALERTED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function writeAlerted(s: Set<string>) {
  try {
    // The last 300 are plenty to stop a repeat; the list must not grow for ever.
    localStorage.setItem(ALERTED_KEY, JSON.stringify([...s].slice(-300)));
  } catch {
    // Storage blocked: at worst a reminder shows again after a reload.
  }
}

/* ------------------------------------------------------------ the Android app */

interface LocalNotificationsPlugin {
  checkPermissions(): Promise<{ display: string }>;
  requestPermissions(): Promise<{ display: string }>;
  schedule(o: {
    notifications: { id: number; title: string; body: string; schedule: { at: Date; allowWhileIdle: boolean }; extra: unknown; smallIcon?: string }[];
  }): Promise<unknown>;
  cancel(o: { notifications: { id: number }[] }): Promise<void>;
  getPending(): Promise<{ notifications: { id: number; extra?: { kind?: string } }[] }>;
  addListener(
    event: "localNotificationActionPerformed",
    fn: (a: { notification: { extra?: { url?: string } } }) => void
  ): Promise<{ remove: () => void }>;
}

const nativeNotifications = () => appPlugin<LocalNotificationsPlugin>("LocalNotifications");

/** A stable positive 31-bit id for a lead, so rescheduling replaces rather than duplicates. */
function notificationId(leadId: string): number {
  let h = 0;
  for (let i = 0; i < leadId.length; i++) h = (Math.imul(31, h) + leadId.charCodeAt(i)) | 0;
  return (h & 0x7fffffff) || 1;
}

/** Replace the phone's scheduled devotee reminders with the upcoming ones. */
async function scheduleOnPhone(plugin: LocalNotificationsPlugin, rows: Reminder[]) {
  const pending = await plugin.getPending();
  const ours = pending.notifications.filter((n) => n.extra?.kind === NATIVE_KIND).map((n) => ({ id: n.id }));
  if (ours.length) await plugin.cancel({ notifications: ours });
  const future = rows.filter((r) => new Date(r.next_follow_up_at).getTime() > Date.now() + 5_000).slice(0, 60);
  if (!future.length) return;
  await plugin.schedule({
    notifications: future.map((r) => ({
      id: notificationId(r.id),
      title: `Follow up: ${r.name}`,
      body: `It is time to contact ${r.name} (${r.phone}).`,
      schedule: { at: new Date(r.next_follow_up_at), allowWhileIdle: true },
      extra: { kind: NATIVE_KIND, url: `/devotee/leads/${r.id}` },
      smallIcon: "ic_stat_drm",
    })),
  });
}

/* ------------------------------------------------------------ Web Push */

const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function subscribeBrowser(key: string): Promise<void> {
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  await apiClient.post("/api/devotee/push/subscribe", sub.toJSON());
}

/* ------------------------------------------------------------ provider */

export function DevoteeProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<DevoteeConfig | null>(null);
  const [rows, setRows] = useState<Reminder[]>([]);
  const [push, setPush] = useState<PushState>("checking");
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const first = useRef(true);

  useEffect(() => {
    apiClient
      .get<DevoteeConfig>("/api/devotee/config")
      .then(setConfig)
      .catch(() => setConfig({ maps_key: null, map_id: null, push_key: null }));
  }, []);

  // Which reminder channel this device has, and whether it is on.
  useEffect(() => {
    if (!config) return;
    let live = true;
    (async () => {
      const native = nativeNotifications();
      if (native) {
        const p = await native.checkPermissions().catch(() => ({ display: "denied" }));
        if (live) setPush(p.display === "granted" ? "app" : p.display === "denied" ? "denied" : "off");
        return;
      }
      if (!pushSupported()) return live && setPush("unsupported");
      if (!config.push_key) return live && setPush("not_configured");
      if (Notification.permission === "denied") return live && setPush("denied");
      if (Notification.permission !== "granted") return live && setPush("off");
      // Already allowed: renew the subscription quietly, so a browser that rotated it keeps working.
      try {
        await subscribeBrowser(config.push_key);
        if (live) setPush("on");
      } catch {
        if (live) setPush("off");
      }
    })();
    return () => {
      live = false;
    };
  }, [config]);

  const enablePush = useCallback(async () => {
    const native = nativeNotifications();
    if (native) {
      const p = await native.requestPermissions();
      setPush(p.display === "granted" ? "app" : "denied");
      if (p.display === "granted") refresh();
      return;
    }
    if (!pushSupported()) return setPush("unsupported");
    if (!config?.push_key) return setPush("not_configured");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return setPush(perm === "denied" ? "denied" : "off");
    try {
      await subscribeBrowser(config.push_key);
      setPush("on");
      toast.success("Reminders are on", "You will be notified on this device when a follow-up is due.");
    } catch (e) {
      toast.error("Could not turn on reminders", e instanceof Error ? e.message : undefined);
    }
  }, [config, refresh]);

  // Load the follow-ups: now, every minute while the page is in view, on return to it, after a save.
  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      apiClient
        .get<{ rows: Reminder[] }>("/api/devotee/reminders")
        .then((r) => live && setRows(r.rows))
        .catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    window.addEventListener(LEADS_CHANGED, load);
    return () => {
      live = false;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener(LEADS_CHANGED, load);
    };
  }, [tick]);

  // A clock, so a follow-up that comes due while the page sits open is noticed without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(t);
  }, []);

  const due = useMemo(() => rows.filter((r) => new Date(r.next_follow_up_at).getTime() <= now), [rows, now]);

  // Announce each follow-up once, as it comes due.
  useEffect(() => {
    const alerted = readAlerted();
    const fresh = due.filter((r) => !alerted.has(`${r.id}@${r.next_follow_up_at}`));
    if (!fresh.length) return;
    for (const r of fresh) alerted.add(`${r.id}@${r.next_follow_up_at}`);
    writeAlerted(alerted);
    // On the first load, anything already a day late is on the screen already; just remember it.
    const announce = fresh.filter((r) => !first.current || now - new Date(r.next_follow_up_at).getTime() < STALE_MS);
    first.current = false;
    if (!announce.length) return;

    chime("info");
    const open = (id?: string) => window.location.assign(id ? `/devotee/leads/${id}` : "/devotee/follow-ups");
    if (announce.length > 2) {
      toast(`${announce.length} follow-ups are due`, { tone: "info", action: { label: "View", onClick: () => open() }, ms: 10_000 });
    } else {
      for (const r of announce) {
        toast(`Follow up: ${r.name}`, { tone: "info", body: `Time to contact ${r.name}.`, action: { label: "Open", onClick: () => open(r.id) }, ms: 10_000 });
      }
    }
    // A hidden tab: a system notification too. (With Web Push on, the server sends one as well;
    // the shared tag makes the second replace the first instead of stacking.)
    if (document.visibilityState === "hidden" && pushSupported() && Notification.permission === "granted") {
      for (const r of announce.slice(0, 3)) {
        navigator.serviceWorker.getRegistration().then((reg) =>
          reg?.showNotification(`Follow up: ${r.name}`, {
            body: `It is time to contact ${r.name} (${r.phone}).`,
            tag: `devotee-lead-${r.id}`,
            data: { url: `/devotee/leads/${r.id}` },
          })
        );
      }
    }
  }, [due, now]);

  // Inside the app: keep the phone's own schedule in step with the list.
  useEffect(() => {
    if (push !== "app") return;
    const plugin = nativeNotifications();
    if (plugin) void scheduleOnPhone(plugin, rows).catch(() => undefined);
  }, [rows, push]);

  // Inside the app: tapping a reminder opens the lead.
  useEffect(() => {
    const plugin = nativeNotifications();
    if (!plugin) return;
    let handle: { remove: () => void } | null = null;
    void plugin
      .addListener("localNotificationActionPerformed", (a) => {
        const url = a.notification.extra?.url;
        if (url) window.location.assign(url);
      })
      .then((h) => (handle = h))
      .catch(() => undefined);
    return () => handle?.remove();
  }, []);

  const value = useMemo(
    () => ({ config, dueCount: due.length, push, enablePush, refresh }),
    [config, due.length, push, enablePush, refresh]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDevotee() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDevotee must be used inside DevoteeProvider");
  return c;
}
