// Laptop dialer: a Call click on the laptop rings from the caller's phone.
// The server half, and why it works the way it does, is in
// server/src/routes/phoneDialer.ts.
//
// The laptop side keeps one small piece of shared state - "is my phone ready?"
// - checked every 15 seconds while the page is in view, so the top bar can say
// so and every Call button knows where to send the call.

import { useSyncExternalStore } from "react";
import { api, apiClient } from "./api";

export interface DialerStatus {
  /** A phone is linked to this person at all. */
  has_phone: boolean;
  /** That phone is on the Laptop dialer screen right now. */
  ready: boolean;
  /** "Xiaomi Redmi 12". */
  phone: string | null;
  seen_at: string | null;
}

export interface DialRequest {
  id: string;
  phone: string;
  lead_id: string | null;
  name: string | null;
}

export type DialState = "waiting" | "ringing" | "placed" | "failed" | "expired" | "replaced";

/* ------------------------------------------------------------- the laptop */

let status: DialerStatus | null = null;
const listeners = new Set<() => void>();
let timer: number | null = null;
let inflight: Promise<DialerStatus | null> | null = null;

function emit() {
  for (const l of listeners) l();
}

/** Ask the server now. Shared, so ten callers at once make one request. */
export function refreshDialer(): Promise<DialerStatus | null> {
  if (inflight) return inflight;
  inflight = apiClient
    .get<DialerStatus>("/api/app/dialer")
    .then((s) => {
      status = s;
      emit();
      return s;
    })
    .catch(() => status)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function start() {
  if (timer !== null || typeof window === "undefined") return;
  void refreshDialer();
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void refreshDialer();
  }, 15_000);
  document.addEventListener("visibilitychange", onVisible);
}

function stop() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisible);
}

function onVisible() {
  if (document.visibilityState === "visible") void refreshDialer();
}

function subscribe(l: () => void) {
  listeners.add(l);
  start();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) stop();
  };
}

/** Whether the person's phone is ready to dial for this laptop. Null until known. */
export function useDialerStatus(enabled = true): DialerStatus | null {
  return useSyncExternalStore(
    enabled ? subscribe : () => () => {},
    () => (enabled ? status : null),
    () => null
  );
}

/** The last known status, without waiting. */
export function dialerStatus(): DialerStatus | null {
  return status;
}

/** Send a number to the person's phone. Rejects with `notReady` when no phone is listening. */
export function sendToPhone(phone: string, leadId?: string | null) {
  return apiClient.post<{ id: string; phone: string }>("/api/app/dial", { phone, lead_id: leadId ?? null });
}

/** Was this a "your phone is not ready" refusal from sendToPhone? */
export function phoneNotReady(e: unknown): boolean {
  return (e as { status?: number } | null)?.status === 409;
}

export function dialState(id: string) {
  return apiClient.get<{ id: string; state: DialState; error: string | null }>(`/api/app/dial/${id}`);
}

/* -------------------------------------------------------------- the phone */

/** Wait (up to `wait` seconds) for the next number the laptop sends. */
export function nextDial(deviceId: string, wait: number, signal?: AbortSignal) {
  return api<{ request: DialRequest | null }>(
    `/api/app/dial-next?device_id=${encodeURIComponent(deviceId)}&wait=${wait}`,
    { signal }
  );
}

export function reportDial(id: string, placed: boolean, error?: string) {
  return apiClient.post<{ ok: boolean }>(`/api/app/dial/${id}/result`, { placed, error });
}
