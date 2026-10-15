"use client";

// Laptop dialer - the phone's half of "click Call on the laptop, ring from the
// phone". Opened in the DRM app and left on, beside the laptop.
//
// While this screen is open the phone keeps asking DRM "anything to dial?"
// (the server holds each question for up to 25 seconds and answers the moment
// the laptop sends a number), and keeps its screen on, because a locked phone
// cannot hear the laptop. When a number arrives it rings it from the SIM
// exactly as the phone's own Call buttons do, so the call, its talk time and
// its recording are saved the same way.
//
// When the screen is left (a call is in progress, the phone is locked, another
// app is opened) the asking stops, and the laptop sees "Phone off" within half
// a minute and calls the ordinary way. Coming back here starts it again.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { clockTime } from "@/lib/format";
import { formatPhone } from "@/lib/calling";
import { ensureLinked, keepScreenOn, placeCall, useInApp, type PhoneInfo } from "@/lib/phone-app";
import { nextDial, reportDial } from "@/lib/phone-dialer";
import { isAbort } from "@/lib/api";
import { Alert, Card, PageHeader, buttonClass } from "@/components/ui";
import { Icon } from "@/components/icons";

type Mode = "starting" | "ready" | "dialling" | "offline" | "unlinked";

interface Dialled {
  at: number;
  phone: string;
  name: string | null;
  ok: boolean;
  error?: string;
}

export default function LaptopDialerPage() {
  const app = useInApp();
  const { user } = useAuth();
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [mode, setMode] = useState<Mode>("starting");
  const [now, setNow] = useState<{ phone: string; name: string | null } | null>(null);
  const [log, setLog] = useState<Dialled[]>([]);
  const [visible, setVisible] = useState(true);
  const deviceRef = useRef<string | null>(null);

  // Which phone this is, linking it first if this person has not yet.
  useEffect(() => {
    if (!app || !user?.id) return;
    let cancelled = false;
    ensureLinked(user.id)
      .then((i) => {
        if (cancelled) return;
        setInfo(i);
        deviceRef.current = i?.deviceId ?? null;
        if (!i?.deviceId) setMode("unlinked");
      })
      .catch(() => {
        if (!cancelled) setMode("unlinked");
      });
    return () => {
      cancelled = true;
    };
  }, [app, user?.id]);

  // Only listen while the screen is in front.
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // The screen stays on while this is open.
  useEffect(() => {
    if (!app || !visible) return;
    let release: (() => void) | null = null;
    let gone = false;
    void keepScreenOn().then((r) => {
      if (gone) r();
      else release = r;
    });
    return () => {
      gone = true;
      release?.();
    };
  }, [app, visible]);

  // The loop: ask, dial, report, ask again.
  useEffect(() => {
    if (!app || !visible || !info?.deviceId) return;
    const deviceId = info.deviceId;
    const ctl = new AbortController();
    let stopped = false;

    (async () => {
      let failures = 0;
      // The first ask returns at once, so the screen says "Ready" straight
      // away; after that each ask waits up to 25 seconds for the laptop.
      let first = true;
      while (!stopped) {
        try {
          const { request } = await nextDial(deviceId, first ? 0 : 25, ctl.signal);
          first = false;
          failures = 0;
          setMode("ready");
          if (!request || stopped) continue;

          setNow({ phone: request.phone, name: request.name });
          setMode("dialling");
          let ok = false;
          let error: string | undefined;
          try {
            ok = await placeCall(request.phone, request.lead_id);
            if (!ok) error = "This phone could not start the call.";
          } catch (e) {
            error = e instanceof Error ? e.message : "This phone could not start the call.";
          }
          await reportDial(request.id, ok, error).catch(() => undefined);
          setLog((l) => [{ at: Date.now(), phone: request.phone, name: request.name, ok, error }, ...l].slice(0, 8));
          // Give the phone a moment to open its call screen before asking again.
          await new Promise((r) => setTimeout(r, 1500));
          setNow(null);
          setMode("ready");
        } catch (e) {
          if (stopped || isAbort(e)) return;
          failures++;
          first = true;
          setMode("offline");
          // Back off a little on a bad connection, but never long.
          await new Promise((r) => setTimeout(r, Math.min(10_000, 1500 * failures)));
        }
      }
    })();

    return () => {
      stopped = true;
      ctl.abort();
    };
  }, [app, visible, info?.deviceId]);

  if (!app) {
    return (
      <div>
        <PageHeader eyebrow="Calling" title="Laptop dialer" subtitle="Call from the laptop, ring from your phone." />
        <Card>
          <p className="text-sm text-ink-soft">
            Open this screen in the DRM app on your phone and leave it open beside the laptop. Then every Call button
            on the laptop rings from your phone, and the call and its recording are saved as usual.
          </p>
        </Card>
      </div>
    );
  }

  const cannotCall = info && info.permissions && info.permissions.call === false;
  const phoneName = info ? [info.manufacturer, info.model].filter(Boolean).join(" ") : "";

  return (
    <div className="mx-auto max-w-md">
      <PageHeader eyebrow="Calling" title="Laptop dialer" subtitle="Leave this open. Click Call on the laptop." />

      {cannotCall && (
        <Alert
          tone="warn"
          action={
            <Link href="/calling/phone" className={buttonClass("secondary", "sm")}>
              Set up
            </Link>
          }
        >
          This phone is not allowed to make calls yet.
        </Alert>
      )}

      <Card className="text-center">
        <div
          className={`mx-auto mb-4 grid h-28 w-28 place-items-center rounded-full ${
            mode === "dialling"
              ? "bg-brand-600 text-white"
              : mode === "ready"
                ? "bg-good-wash text-good"
                : mode === "offline" || mode === "unlinked"
                  ? "bg-warn-wash text-warn"
                  : "bg-sunken text-ink-muted"
          }`}
        >
          <span className="relative">
            {mode === "ready" && (
              <span className="absolute -inset-5 animate-ping rounded-full bg-good/15" aria-hidden />
            )}
            <Icon name={mode === "dialling" ? "phoneOutgoing" : mode === "ready" ? "phone" : "alert"} size={40} />
          </span>
        </div>

        {mode === "dialling" && now ? (
          <>
            <p className="text-lg font-semibold text-ink">Calling {now.name ?? formatPhone(now.phone)}</p>
            {now.name && <p className="mt-0.5 tabular-nums text-ink-muted">{formatPhone(now.phone)}</p>}
          </>
        ) : mode === "ready" ? (
          <>
            <p className="text-lg font-semibold text-ink">Ready</p>
            <p className="mt-1 text-sm text-ink-muted">Click Call on the laptop. This phone rings the number.</p>
          </>
        ) : mode === "offline" ? (
          <>
            <p className="text-lg font-semibold text-ink">Reconnecting…</p>
            <p className="mt-1 text-sm text-ink-muted">Check the internet on this phone.</p>
          </>
        ) : mode === "unlinked" ? (
          <>
            <p className="text-lg font-semibold text-ink">This phone is not linked</p>
            <p className="mt-1 text-sm text-ink-muted">Sign out and sign in again in the app.</p>
          </>
        ) : (
          <p className="text-lg font-semibold text-ink">Starting…</p>
        )}

        <p className="mt-4 text-xs text-ink-faint">
          {phoneName ? `${phoneName} · ` : ""}The screen stays on while this is open.
        </p>
      </Card>

      {log.length > 0 && (
        <Card className="mt-4" padded={false}>
          <p className="border-b border-line-soft px-4 py-2.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
            From the laptop
          </p>
          <ul>
            {log.map((d) => (
              <li key={d.at} className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
                <Icon
                  name={d.ok ? "phoneOutgoing" : "alert"}
                  size={15}
                  className={d.ok ? "flex-none text-brand-700" : "flex-none text-danger"}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{d.name ?? formatPhone(d.phone)}</span>
                  {!d.ok && <span className="block text-xs text-danger">{d.error}</span>}
                </span>
                <span className="flex-none text-xs tabular-nums text-ink-muted">{clockTime(new Date(d.at).toISOString())}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="mt-4 px-1 text-xs text-ink-muted">
        After each call, save what happened on the laptop as usual. The recording is added from this phone.
      </p>
    </div>
  );
}
