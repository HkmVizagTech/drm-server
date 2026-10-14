"use client";

// Phones - every caller's phone with the DRM app: is it saving calls and
// recordings, and what did it see this week. For admins.
//
// The numbers to watch:
//   - Rang back / Missed: donors who called the caller. Missed ones also put a
//     "ring them back" reminder on the caller's list.
//   - Recordings: of the calls where somebody spoke, how many recordings came.
//     A phone with calls but no recordings has auto-record off, or uses the
//     Google Phone app, which keeps recordings to itself.
//   - No outcome saved: the caller dialled from DRM but never pressed an
//     outcome. The call is still in the lead's phone calls.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { number, relativeDate } from "@/lib/format";
import { dialerHidesRecordings } from "@/lib/phone-app";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
} from "@/components/ui";
import { toast } from "@/components/toast";

interface Device {
  id: string;
  user_id: string;
  user_name: string;
  manufacturer: string | null;
  model: string | null;
  android_version: string | null;
  app_version: string | null;
  dialer: string | null;
  status: { call?: boolean; call_log?: boolean; phone_state?: boolean; audio?: boolean; all_files?: boolean; battery?: boolean };
  recordings_folder: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  revoked_at: string | null;
  outbound: number;
  answered_out: number;
  inbound: number;
  missed: number;
  talk_seconds: number;
  recorded: number;
  needs_recording: number;
  no_recording: number;
  waiting: number;
  no_outcome: number;
}

const talk = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.round(s / 60)}m`);

function problems(d: Device): string[] {
  const out: string[] = [];
  const s = d.status ?? {};
  if (d.revoked_at) return ["Signed out"];
  if (s.call_log === false || s.call === false) out.push("Calls not allowed");
  if (s.audio === false && s.all_files === false) out.push("Recordings not allowed");
  if (dialerHidesRecordings(d.dialer)) out.push("Google Phone app - no recordings");
  if (s.battery === false) out.push("May sleep in background");
  if (d.last_sync_at && Date.now() - new Date(d.last_sync_at).getTime() > 6 * 3600_000) out.push("Not heard from in 6h+");
  return out;
}

export default function PhonesPage() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [storageReady, setStorageReady] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiClient
      .get<{ devices: Device[]; storage_ready: boolean }>("/api/app/devices")
      .then((r) => {
        setDevices(r.devices);
        setStorageReady(r.storage_ready);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load phones."));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function signOut(d: Device) {
    if (!window.confirm(`Sign ${d.user_name}'s ${d.model ?? "phone"} out of DRM? It stops sending calls until they open DRM in the app again.`)) return;
    try {
      await apiClient.delete(`/api/app/devices/${d.id}`);
      toast.success("Phone signed out.");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not sign the phone out.");
    }
  }

  return (
    <>
      <PageHeader
        title="Phones"
        subtitle="Callers' phones with the DRM app: calls made, donors who rang back, and recordings, over the last 7 days."
        actions={
          <Button variant="secondary" icon="refresh" onClick={load}>
            Refresh
          </Button>
        }
      />

      {!storageReady && (
        <Alert tone="warn" title="Recording storage is not set up">
          Calls are being saved, but recordings cannot be until the R2 storage settings are added to the server.
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      {devices === null && !error ? (
        <Skeleton className="h-40" />
      ) : devices && devices.length === 0 ? (
        <Card>
          <EmptyState
            icon="phone"
            title="No phones yet"
            message="Install the DRM app on a caller's phone and sign in. It appears here as soon as it is linked."
          />
        </Card>
      ) : (
        // One card per phone: readable on the admin's own phone as well as on a
        // desk, where a nine-column table had to be scrolled sideways.
        <div className="grid gap-4 xl:grid-cols-2">
          {devices?.map((d) => {
            const issues = problems(d);
            const stats: { label: string; value: string; sub?: string; warn?: boolean; href?: string }[] = [
              {
                label: "Calls made",
                value: number(d.outbound),
                sub: `${number(d.answered_out)} answered`,
                href: `/calling/recordings?user_id=${d.user_id}&direction=outbound`,
              },
              { label: "Rang back", value: number(d.inbound), href: `/calling/recordings?user_id=${d.user_id}&direction=inbound` },
              {
                label: "Missed",
                value: number(d.missed),
                warn: d.missed > 0,
                href: `/calling/recordings?user_id=${d.user_id}&direction=missed`,
              },
              { label: "Talk time", value: talk(d.talk_seconds) },
              {
                label: "Recorded",
                value: `${number(d.recorded)} / ${number(d.needs_recording)}`,
                sub: d.waiting ? `${number(d.waiting)} on the way` : d.no_recording ? `${number(d.no_recording)} not found` : undefined,
                warn: d.no_recording > 0,
                href: `/calling/recordings?user_id=${d.user_id}&recording=${d.no_recording ? "none" : "uploaded"}`,
              },
              { label: "No outcome", value: number(d.no_outcome), warn: d.no_outcome > 0 },
            ];
            return (
              <Card key={d.id} className={d.revoked_at ? "opacity-60" : ""}>
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-[1_1_14rem]">
                    <p className="font-semibold text-ink">{d.user_name}</p>
                    <p className="text-xs text-ink-muted">
                      {[d.manufacturer, d.model].filter(Boolean).join(" ")}
                      {d.android_version ? ` · Android ${d.android_version}` : ""}
                      {d.app_version ? ` · app ${d.app_version}` : ""}
                    </p>
                    <p className="text-xs text-ink-faint">
                      Last heard {d.last_sync_at ? relativeDate(d.last_sync_at).toLowerCase() : "never"}
                      {d.recordings_folder ? ` · recordings in ${d.recordings_folder}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {issues.length === 0 ? (
                      <Badge tone="good" dot>
                        Working
                      </Badge>
                    ) : null}
                    {user?.role === "admin" && !d.revoked_at && (
                      <Button size="xs" variant="ghost" onClick={() => void signOut(d)}>
                        Sign out
                      </Button>
                    )}
                  </div>
                </div>

                {issues.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {issues.map((i) => (
                      <Badge key={i} tone="warn">
                        {i}
                      </Badge>
                    ))}
                  </div>
                )}
                {d.last_error && <p className="mt-2 text-xs text-warn">{d.last_error}</p>}

                <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
                  {stats.map((x) => {
                    const body = (
                      <>
                        <span className="block text-2xs font-medium uppercase tracking-wide text-ink-muted">{x.label}</span>
                        <span className={`mt-0.5 block text-base font-semibold tabular-nums ${x.warn ? "text-warn" : "text-ink"}`}>
                          {x.value}
                        </span>
                        {x.sub && <span className="block truncate text-2xs text-ink-muted">{x.sub}</span>}
                      </>
                    );
                    return (
                      <li key={x.label}>
                        {x.href ? (
                          <Link href={x.href} className="block rounded-control bg-sunken px-2.5 py-2 hover:bg-brand-50 hover:ring-1 hover:ring-brand-200">
                            {body}
                          </Link>
                        ) : (
                          <div className="rounded-control bg-sunken px-2.5 py-2">{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
