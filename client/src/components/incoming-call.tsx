"use client";

// "Ramesh Kumar is calling" - on the laptop, while the caller's phone rings.
//
// The DRM app on the phone reports a ring from a number already in DRM (see
// CallerId.java and POST /api/app/ringing). The laptop asks every few seconds
// - only for people with a phone linked, and only while the page is in view -
// and shows a card per ring: ringing, on the call, ended ("Save what
// happened"), or missed ("Ring back"). Open takes them to the person's call
// screen with "They rang me" already on.
//
// Inside the app none of this shows: the phone has its own notification.

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useInApp } from "@/lib/phone-app";
import { useDialerStatus } from "@/lib/phone-dialer";
import { callHref, formatPhone, telHref } from "@/lib/calling";
import { clockTime } from "@/lib/format";
import { Icon } from "./icons";

interface Ring {
  id: string;
  phone: string;
  lead_id: string | null;
  state: "ringing" | "answered" | "ended";
  missed: boolean;
  started_at: string;
  name: string | null;
  note: string | null;
}

const EVERY_MS = 4000;

/** A soft two-note chime, so a ring is noticed when eyes are on a call sheet. */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.connect(g);
      g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.start(t);
      o.stop(t + 0.32);
    });
    setTimeout(() => void ctx.close().catch(() => undefined), 1000);
  } catch {
    // No sound; the card still shows.
  }
}

export function IncomingCalls() {
  const app = useInApp();
  const status = useDialerStatus(!app);
  const watching = !app && !!status?.has_phone;
  const router = useRouter();
  const pathname = usePathname();
  const [rings, setRings] = useState<Ring[]>([]);
  const heard = useRef(new Set<string>());

  useEffect(() => {
    if (!watching) return;
    let stopped = false;
    let timer: number | null = null;

    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const r = await apiClient.get<{ rings: Ring[] }>("/api/app/incoming");
          if (stopped) return;
          for (const x of r.rings) {
            if (x.state === "ringing" && !heard.current.has(x.id)) {
              heard.current.add(x.id);
              chime();
            }
          }
          setRings(r.rings);
        } catch {
          // Try again on the next tick.
        }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), EVERY_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [watching]);

  if (!watching || rings.length === 0) return null;

  const close = (id: string) => {
    setRings((rs) => rs.filter((r) => r.id !== id));
    void apiClient.post(`/api/app/incoming/${id}/dismiss`, {}).catch(() => undefined);
  };
  const open = (r: Ring) => {
    if (!r.lead_id) return;
    close(r.id);
    router.push(callHref(r.lead_id, pathname, { inbound: true }));
  };

  return (
    <div className="pointer-events-none fixed right-4 top-16 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {rings.slice(0, 2).map((r) => {
        const who = r.name ?? formatPhone(r.phone);
        const head =
          r.state === "ringing"
            ? `${who} is calling`
            : r.state === "answered"
              ? `On the call with ${who}`
              : r.missed
                ? `Missed call from ${who}`
                : `Call with ${who} ended`;
        const live = r.state === "ringing";
        return (
          <div
            key={r.id}
            role="status"
            aria-live="polite"
            className={`pointer-events-auto fade-rise rounded-panel border bg-surface p-3.5 shadow-raised ${
              live ? "border-brand-300 ring-2 ring-brand-200" : r.missed ? "border-amber-200" : "border-line-soft"
            }`}
          >
            <div className="flex items-start gap-3">
              <span
                className={`relative grid h-10 w-10 flex-none place-items-center rounded-full ${
                  live ? "bg-brand-600 text-white" : r.missed ? "bg-warn-wash text-warn" : "bg-brand-50 text-brand-700"
                }`}
              >
                {live && <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/30" aria-hidden />}
                <Icon name={r.missed ? "phoneMissed" : "phoneIncoming"} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-ink">{head}</p>
                <p className="mt-0.5 truncate text-sm text-ink-muted">
                  {r.note ? `${r.note} · ` : ""}
                  <span className="tabular-nums">{r.name ? formatPhone(r.phone) : "Not a lead yet"}</span>
                </p>
                <p className="mt-0.5 text-xs text-ink-faint">{clockTime(r.started_at)} · on your phone</p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => close(r.id)}
                className="-mr-1 -mt-1 grid h-7 w-7 flex-none place-items-center rounded-control text-ink-muted hover:bg-sunken"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            {(r.lead_id || r.missed) && (
              <div className="mt-3 flex gap-2">
                {r.lead_id && (
                  <button
                    type="button"
                    onClick={() => open(r)}
                    className={`inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-control text-sm font-medium ${
                      r.missed
                        ? "border border-line-strong bg-surface text-ink-soft hover:bg-sunken"
                        : "bg-brand-700 text-white hover:bg-brand-800"
                    }`}
                  >
                    {r.state === "ended" && !r.missed ? "Save what happened" : "Open"}
                  </button>
                )}
                {r.missed && (
                  <a
                    href={telHref(r.phone)}
                    data-lead-id={r.lead_id ?? undefined}
                    onClick={() => close(r.id)}
                    className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-control bg-brand-700 text-sm font-medium text-white hover:bg-brand-800"
                  >
                    <Icon name="phone" size={14} />
                    Ring back
                  </a>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
