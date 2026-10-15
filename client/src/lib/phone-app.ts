// DRM inside the Android app (mobile/ in this repo).
//
// The app is DRM's own pages in a phone shell, plus a small native part
// (DrmPhonePlugin.java) that can dial from the SIM, read the call log and send
// the phone's call recordings to DRM. Everything here is a no-op in a browser:
// inApp() is false and every page behaves exactly as it always has.

import { useSyncExternalStore } from "react";
import { apiClient } from "./api";

export interface PhonePermissions {
  call?: boolean;
  call_log?: boolean;
  phone_state?: boolean;
  audio?: boolean;
  all_files?: boolean;
  battery?: boolean;
  pending_recordings?: number;
  numbers?: number;
}

export interface PhoneInfo {
  installId: string;
  linked: boolean;
  deviceId: string | null;
  userId: string | null;
  baseUrl: string | null;
  manufacturer: string;
  model: string;
  androidVersion: string;
  appVersion: string | null;
  dialer: string | null;
  permissions: PhonePermissions;
  lastSyncAt: number;
  lastError: string | null;
  pendingRecordings: number;
  recordingsFolder: string | null;
  error?: string | null;
}

export interface FoundRecording {
  found: boolean;
  name?: string;
  folder?: string;
  modifiedAt?: number;
  size?: number;
}

interface DrmPhonePlugin {
  getInfo(): Promise<PhoneInfo>;
  link(o: { baseUrl: string; deviceId: string; deviceKey: string; userId: string }): Promise<PhoneInfo>;
  unlink(): Promise<PhoneInfo>;
  /** Added in app 1.0.1. */
  signOut?(): Promise<PhoneInfo>;
  requestPermissions(): Promise<PhoneInfo>;
  call(o: { phone: string; leadId?: string | null }): Promise<{ placed: boolean; direct: boolean }>;
  syncNow(): Promise<PhoneInfo>;
  findRecording(): Promise<FoundRecording>;
  openAllFilesSettings(): Promise<void>;
  openBatterySettings(): Promise<void>;
  openAppSettings(): Promise<void>;
  /** Added in app 1.0.4. */
  keepScreenOn?(o: { on: boolean }): Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
  registerPlugin?: (name: string) => unknown;
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor ?? null) as CapacitorGlobal | null;
}

/** True inside the DRM Android app. */
export function inApp(): boolean {
  const c = capacitor();
  return !!c?.isNativePlatform?.() && c.getPlatform?.() === "android";
}

const never = () => () => {};

/**
 * inApp() for rendering. False on the server and in the first client render,
 * so the page hydrates the same everywhere; true right after, inside the app.
 */
export function useInApp(): boolean {
  return useSyncExternalStore(never, inApp, () => false);
}

/** The phone side, or null in a browser. */
export function phone(): DrmPhonePlugin | null {
  if (!inApp()) return null;
  const c = capacitor()!;
  return ((c.Plugins?.DrmPhone as DrmPhonePlugin | undefined) ??
    (c.registerPlugin?.("DrmPhone") as DrmPhonePlugin | undefined) ??
    null) as DrmPhonePlugin | null;
}

/**
 * Link this phone to the signed-in user, once per user. The phone gets its own
 * key so it can keep sending calls after the day's login has expired.
 */
export async function ensureLinked(userId: string): Promise<PhoneInfo | null> {
  const p = phone();
  if (!p) return null;
  const info = await p.getInfo();
  if (info.linked && info.userId === userId && info.baseUrl === window.location.origin) return info;
  const r = await apiClient.post<{ device_id: string; device_key: string; user_id: string }>("/api/app/devices", {
    install_id: info.installId,
    manufacturer: info.manufacturer,
    model: info.model,
    android_version: info.androidVersion,
    app_version: info.appVersion,
    dialer: info.dialer,
  });
  return p.link({
    baseUrl: window.location.origin,
    deviceId: r.device_id,
    deviceKey: r.device_key,
    userId: r.user_id,
  });
}

/** Ring a number from the phone's SIM. False in a browser, where a tel: link does the job. */
export async function placeCall(number: string, leadId?: string | null): Promise<boolean> {
  const p = phone();
  if (!p) return false;
  await p.call({ phone: number, leadId: leadId ?? null });
  return true;
}

/** What still needs allowing for calls and recordings to be saved. */
export function missing(info: PhoneInfo | null): string[] {
  if (!info) return [];
  const p = info.permissions ?? {};
  const out: string[] = [];
  if (!p.call || !p.call_log || !p.phone_state) out.push("calls");
  if (!p.audio && !p.all_files) out.push("recordings");
  return out;
}

/**
 * Phones whose dialer keeps recordings to itself. On these the app saves the
 * call and its talk time, but never a recording.
 */
export function dialerHidesRecordings(dialer: string | null | undefined): boolean {
  return !!dialer && /com\.google\.android\.dialer/.test(dialer);
}

/**
 * Keep the phone's screen on (the Laptop dialer screen). The app does it
 * itself from 1.0.4; before that the browser's own wake lock is tried, which
 * holds only while the screen is in front. Returns a function that lets go.
 */
export async function keepScreenOn(): Promise<() => void> {
  const p = phone();
  if (p?.keepScreenOn) {
    try {
      await p.keepScreenOn({ on: true });
      return () => void p.keepScreenOn?.({ on: false }).catch(() => undefined);
    } catch {
      // Fall through to the wake lock.
    }
  }
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } };
    const lock = await nav.wakeLock?.request("screen");
    return () => void lock?.release().catch(() => undefined);
  } catch {
    return () => {};
  }
}

/** Sign this phone out of DRM (the caller signed out). Older apps only forget the key locally. */
export async function signOutPhone(): Promise<void> {
  const p = phone();
  if (!p) return;
  try {
    if (p.signOut) await p.signOut();
    else await p.unlink();
  } catch {
    // Nothing more to do; the next sign-in links the phone again.
  }
}
