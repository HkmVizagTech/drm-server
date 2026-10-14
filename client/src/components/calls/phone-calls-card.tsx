"use client";

// A lead's calls as the callers' phones saw them (the DRM app): calls made,
// donors who rang back, missed call-backs, with the measured talk time and the
// recording. Shows nothing until a phone has reported a call for this lead.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import type { PhoneCallRow } from "@/lib/phone-calls";
import { Card, CardHeader } from "@/components/ui";
import { PhoneCallItem } from "./phone-call-item";

export function PhoneCallsCard({ leadId }: { leadId: string }) {
  const [calls, setCalls] = useState<PhoneCallRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ calls: PhoneCallRow[] }>(`/api/app/leads/${leadId}/calls`)
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
      <CardHeader title="Calls and recordings" subtitle="From the callers' phones, with the real talk time" icon="mic" />
      <ul className="-my-1 divide-y divide-line-soft">
        {calls.map((c) => (
          <PhoneCallItem key={c.id} call={c} showDonor={false} showCaller />
        ))}
      </ul>
    </Card>
  );
}
