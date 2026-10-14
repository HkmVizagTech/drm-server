"use client";

// A lead's calls as the callers' phones saw them (the DRM app): calls made,
// donors who rang back, missed call-backs, with the measured talk time and the
// recording. Shows nothing until a phone has reported a call for this lead.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { Badge, Card, CardHeader } from "@/components/ui";
import { RecordingPlayer } from "./recording-player";

interface PhoneCall {
  id: string;
  direction: "outbound" | "inbound" | "missed";
  started_at: string;
  duration_seconds: number;
  from_app: boolean;
  recording_status: "waiting" | "uploaded" | "none" | "not_needed";
  activity_id: string | null;
  user_name: string | null;
  phone_model: string | null;
  can_listen: boolean;
}

const talk = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

const WHAT: Record<PhoneCall["direction"], { label: string; tone: "neutral" | "info" | "warn" }> = {
  outbound: { label: "Rang them", tone: "neutral" },
  inbound: { label: "They rang back", tone: "info" },
  missed: { label: "Missed their call", tone: "warn" },
};

export function PhoneCallsCard({ leadId }: { leadId: string }) {
  const [calls, setCalls] = useState<PhoneCall[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ calls: PhoneCall[] }>(`/api/app/leads/${leadId}/calls`)
      .then((r) => {
        if (!cancelled) setCalls(r.calls);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  if (!calls.length) return null;

  return (
    <Card>
      <CardHeader
        title="Calls from the phone"
        subtitle="Saved by the DRM app on the caller's phone, with the real talk time."
        icon="phone"
      />
      <ul className="divide-y divide-line-soft">
        {calls.map((c) => {
          const w = WHAT[c.direction];
          const answered = c.direction === "outbound" ? c.duration_seconds > 0 : c.direction === "inbound";
          return (
            <li key={c.id} className="py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <Badge tone={w.tone}>{w.label}</Badge>
                <span className="text-ink">{dateTime(c.started_at)}</span>
                <span className="text-ink-muted">
                  · {answered ? talk(c.duration_seconds) : c.direction === "outbound" ? "not answered" : "nobody answered"}
                </span>
                {c.user_name && <span className="text-xs text-ink-faint">· {c.user_name}</span>}
                {c.direction === "outbound" && !c.activity_id && (
                  <span className="text-xs text-warn">· no outcome saved</span>
                )}
              </div>
              {c.recording_status === "uploaded" && c.can_listen && (
                <div className="mt-1.5">
                  <RecordingPlayer url={`/api/app/calls/${c.id}/recording`} />
                </div>
              )}
              {c.recording_status === "uploaded" && !c.can_listen && (
                <p className="mt-1 text-xs text-ink-faint">Recorded. Only the caller and admins can listen.</p>
              )}
              {c.recording_status === "waiting" && <p className="mt-1 text-xs text-ink-faint">Recording on its way from the phone.</p>}
              {c.recording_status === "none" && <p className="mt-1 text-xs text-ink-faint">No recording was found on the phone.</p>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
