"use client";

// Unmatched calls - calls from a number DRM did not know, added from their recording.
//
// The phone app reports only calls to and from numbers DRM has. A donor who
// rings from another phone is therefore invisible: no call, no talk time. A
// caller adds the call here from its recording; the talk time is the
// recording's length and the call counts everywhere calls are counted. An
// admin sees every caller's, and can play any of them.

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { istDateKey, istDayPlus, istToday, number } from "@/lib/format";
import { dayHeading, talk, type PhoneCallRow } from "@/lib/phone-calls";
import { Alert, Button, Card, EmptyState, PageHeader, Pagination, Skeleton, StatTile } from "@/components/ui";
import { PhoneCallItem } from "@/components/calls/phone-call-item";
import { AddCallDialog } from "@/components/calls/add-call-dialog";

interface Listing {
  calls: PhoneCallRow[];
  totals: { calls: number; talk_seconds: number };
  page: number;
  limit: number;
}

const LIMIT = 50;

export default function UnmatchedCallsPage() {
  const { user } = useAuth();
  const canAdd = user?.role === "caller" || user?.role === "admin";
  const reviewer = user?.role === "admin" || user?.role === "volunteer_coordinator";
  const [data, setData] = useState<Listing | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<Listing>(`/api/unmatched-calls?page=${page}&limit=${LIMIT}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
    }
  }, [page]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(t);
  }, [load]);

  const days = useMemo(() => {
    const out: { key: string; rows: PhoneCallRow[] }[] = [];
    for (const r of data?.calls ?? []) {
      const k = istDateKey(r.started_at);
      const last = out[out.length - 1];
      if (last && last.key === k) last.rows.push(r);
      else out.push({ key: k, rows: [r] });
    }
    return out;
  }, [data]);
  const today = istToday();
  const yesterday = istDayPlus(-1);

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="Unmatched calls"
        subtitle={
          reviewer
            ? "Calls from numbers DRM did not know, added by callers from their recordings. Talk time is the recording's length."
            : "A donor rang from a number DRM does not know? Add the call from its recording. Its talk time is taken from the recording and counted for you."
        }
        actions={
          canAdd ? (
            <Button icon="plus" onClick={() => setAdding(true)}>
              Add a call
            </Button>
          ) : undefined
        }
      />

      {notice && (
        <Alert tone="good" className="mb-4" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-md">
        <StatTile label="Calls added" value={data ? number(data.totals.calls) : "-"} />
        <StatTile label="Talk time" value={data ? talk(data.totals.talk_seconds) : "-"} />
      </div>

      <Card>
        {!data ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : !data.calls.length ? (
          <EmptyState
            title="No calls added yet"
            message="When a donor rings from a number DRM does not know, add the call here with its recording."
          />
        ) : (
          <div className="px-4">
            {days.map((d) => (
              <section key={d.key}>
                <h3 className="pt-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  {dayHeading(d.key, today, yesterday)}
                </h3>
                <ul className="divide-y divide-line-soft">
                  {d.rows.map((c) => (
                    <PhoneCallItem key={c.id} call={c} showDonor showCaller={reviewer} timeOnly />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      {data && data.totals.calls > LIMIT && (
        <Pagination page={page} limit={LIMIT} total={data.totals.calls} totalPages={Math.ceil(data.totals.calls / LIMIT)} onPage={setPage} unit="calls" />
      )}

      {adding && (
        <AddCallDialog
          onClose={() => setAdding(false)}
          onAdded={(message) => {
            setAdding(false);
            setNotice(message);
            setPage(1);
            void load();
          }}
        />
      )}
    </div>
  );
}
