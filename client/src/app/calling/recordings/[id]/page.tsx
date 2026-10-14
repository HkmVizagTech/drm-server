"use client";

// One call the DRM app saw: the recording, who called whom and when, what the
// caller logged, the donor it was with, and (for admins) who has listened.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { callHref, formatPhone, telHref } from "@/lib/calling";
import { currency, dateTime, relativeDate } from "@/lib/format";
import { DIRECTION, answered, recordingWords, talk, type PhoneCallRow } from "@/lib/phone-calls";
import { Alert, Badge, Card, CardHeader, LinkButton, Skeleton } from "@/components/ui";
import { Icon } from "@/components/icons";
import { RecordingPlayer } from "@/components/calls/recording-player";

interface Detail {
  call: PhoneCallRow & {
    recording_type: string | null;
    recording_name: string | null;
    recording_at: string | null;
    sim: string | null;
    activity_id: string | null;
    outcome_connected: boolean | null;
    outcome_at: string | null;
    lead_status_label: string | null;
    lead_alt_phone: string | null;
    converted_at: string | null;
    converted_amount: string | null;
    lead_owner_name: string | null;
  };
  listens: { listened_at: string; name: string | null }[];
  other_calls: {
    id: string;
    direction: PhoneCallRow["direction"];
    started_at: string;
    duration_seconds: number;
    recording_status: PhoneCallRow["recording_status"];
    caller_name: string | null;
  }[];
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
      <dt className="flex-none text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}

export default function CallPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const reviewer = user?.role === "admin" || user?.role === "volunteer_coordinator";
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Detail>(`/api/app/calls/${id}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the call.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const back = (
    <button
      type="button"
      onClick={() => (window.history.length > 1 ? router.back() : router.push("/calling/recordings"))}
      className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline"
    >
      <Icon name="arrowLeft" size={15} /> Calls and recordings
    </button>
  );

  if (error) {
    return (
      <div>
        {back}
        <Alert tone="danger">{error}</Alert>
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        {back}
        <Skeleton className="mb-4 h-28" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const c = data.call;
  const d = DIRECTION[c.direction];
  const spoke = answered(c);
  const who = c.lead_name || formatPhone(c.phone);

  return (
    <div className="mx-auto max-w-4xl">
      {back}

      {/* --------------------------------------------------------- the call */}
      <Card className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={d.tone} icon={d.icon}>
                {d.label}
              </Badge>
              {c.from_app && <Badge tone="neutral">Dialled from DRM</Badge>}
            </div>
            <h1 className="mt-2 truncate text-2xl font-semibold tracking-tight text-ink">{who}</h1>
            <p className="mt-1 text-sm text-ink-muted">
              {formatPhone(c.phone)} · {dateTime(c.started_at)}
              {spoke ? ` · ${talk(c.duration_seconds)}` : c.direction === "outbound" ? " · not answered" : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {c.lead_id && (
              <LinkButton href={`/leads/${c.lead_id}`} variant="secondary" icon="user">
                Open donor
              </LinkButton>
            )}
            {c.lead_id && !reviewer ? (
              <LinkButton href={callHref(c.lead_id, `/calling/recordings/${c.id}`)} icon="phone">
                Call again
              </LinkButton>
            ) : (
              <LinkButton href={telHref(c.phone)} variant={reviewer ? "secondary" : "primary"} icon="phone">
                Call
              </LinkButton>
            )}
          </div>
        </div>

        <div className="mt-5 rounded-panel bg-sunken px-4 py-4">
          {c.recording_status === "uploaded" ? (
            <RecordingPlayer url={`/api/app/calls/${c.id}/recording`} seconds={c.duration_seconds} size="lg" />
          ) : (
            <p className="flex items-center gap-2 text-sm text-ink-muted">
              <Icon name={c.recording_status === "none" ? "alert" : c.recording_status === "waiting" ? "clock" : "mic"} size={16} />
              {recordingWords(c.recording_status)}
              {c.recording_status === "none" && " - check that automatic call recording is on in the phone's dialer."}
            </p>
          )}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ---------------------------------------------------- what happened */}
        <Card>
          <CardHeader title="What happened" icon="phone" />
          <dl className="divide-y divide-line-soft">
            <Row label="Caller">{c.caller_name ?? "—"}</Row>
            <Row label="When">{dateTime(c.started_at)}</Row>
            <Row label="Talk time">{spoke ? talk(c.duration_seconds) : "Nobody spoke"}</Row>
            <Row label="Outcome logged">
              {c.disposition_label || c.disposition ? (
                <span className="inline-flex flex-col items-end gap-1">
                  <Badge tone="neutral">{c.disposition_label ?? c.disposition}</Badge>
                  {c.outcome_note && <span className="text-xs text-ink-soft">{c.outcome_note}</span>}
                </span>
              ) : c.direction === "outbound" ? (
                <Badge tone="warn">No outcome saved</Badge>
              ) : (
                <span className="text-ink-muted">—</span>
              )}
            </Row>
            <Row label="Phone">
              {[c.phone_maker, c.phone_model].filter(Boolean).join(" ") || "—"}
            </Row>
            {c.recording_status === "uploaded" && (
              <Row label="Recording">
                {c.recording_bytes ? `${Math.max(1, Math.round(c.recording_bytes / 1024))} KB` : "Stored"}
                {c.recording_at ? ` · saved ${relativeDate(c.recording_at)}` : ""}
              </Row>
            )}
          </dl>
        </Card>

        {/* ------------------------------------------------------- the donor */}
        <Card>
          <CardHeader title="The donor" icon="user" />
          <dl className="divide-y divide-line-soft">
            <Row label="Name">
              {c.lead_id ? (
                <Link href={`/leads/${c.lead_id}`} className="font-medium text-brand-700 hover:underline">
                  {who}
                </Link>
              ) : (
                who
              )}
            </Row>
            <Row label="Number">
              {formatPhone(c.lead_phone ?? c.phone)}
              {c.lead_alt_phone ? ` · ${formatPhone(c.lead_alt_phone)}` : ""}
            </Row>
            <Row label="Stage">{c.lead_status_label ?? "—"}</Row>
            <Row label="Their caller">{c.lead_owner_name ?? "Nobody yet"}</Row>
            <Row label="Donated">
              {c.converted_at ? `${c.converted_amount ? currency(Number(c.converted_amount)) : "Yes"} · ${relativeDate(c.converted_at)}` : "Not yet"}
            </Row>
          </dl>
        </Card>

        {/* ------------------------------------------------ other calls */}
        {data.other_calls.length > 0 && (
          <Card>
            <CardHeader title="Other calls with them" icon="clock" />
            <ul className="divide-y divide-line-soft">
              {data.other_calls.map((o) => {
                const od = DIRECTION[o.direction];
                return (
                  <li key={o.id}>
                    <Link
                      href={`/calling/recordings/${o.id}`}
                      className="-mx-2 flex items-center gap-3 rounded-control px-2 py-2.5 hover:bg-brand-50"
                    >
                      <Icon name={od.icon} size={15} className="text-ink-muted" />
                      <span className="min-w-0 flex-1 text-sm text-ink">
                        {od.label}
                        <span className="block text-xs text-ink-muted">
                          {dateTime(o.started_at)}
                          {o.duration_seconds > 0 && o.direction !== "missed" ? ` · ${talk(o.duration_seconds)}` : ""}
                          {reviewer && o.caller_name ? ` · ${o.caller_name}` : ""}
                        </span>
                      </span>
                      {o.recording_status === "uploaded" && <Icon name="mic" size={15} className="text-brand-600" />}
                      <Icon name="chevronRight" size={14} className="text-ink-faint" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {/* ----------------------------------------------- who listened */}
        {reviewer && (
          <Card>
            <CardHeader title="Who listened" subtitle="Every play of this recording is logged" icon="eye" />
            {data.listens.length === 0 ? (
              <p className="text-sm text-ink-muted">Nobody has listened yet.</p>
            ) : (
              <ul className="divide-y divide-line-soft text-sm">
                {data.listens.map((l, i) => (
                  <li key={i} className="flex justify-between gap-3 py-2">
                    <span className="text-ink">{l.name ?? "—"}</span>
                    <span className="text-ink-muted">{dateTime(l.listened_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

    </div>
  );
}
