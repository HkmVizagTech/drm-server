"use client";

// The donors to ring and ask: no special day yet, or no gotram.
//
// One row per donor, in calling order - a callback that is due, then anyone
// not rung yet, then whoever was tried longest ago. Call opens the phone; the
// outcome buttons record what happened, so the list can say "3 calls, no
// answer" and bring them back on the day they asked. "Got the details" opens
// their form to type the days in, and once they have a day they leave the list.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { currency, dateTime, number, relativeDate } from "@/lib/format";
import { OUTCOME_WORDS, sameName, type CallOutcome, type SankalpDonor } from "@/lib/sankalpam";
import { toast } from "@/components/toast";
import { Alert, Button, Card, DropdownMenu, EmptyState, Icon, SegmentedControl, Skeleton } from "@/components/ui";
import { SourceChip } from "./source-chip";
import { CallBackDialog } from "./call-tools";

type Need = "days" | "gotram" | "check";
type Counts = { need_days: number; need_gotram: number; need_check?: number };

export function NeedDetailsView({
  version,
  onEdit,
  onChanged,
}: {
  version: number;
  onEdit: (id: string) => void;
  onChanged: () => void;
}) {
  const [need, setNeed] = useState<Need>("days");
  const [data, setData] = useState<{ donors: SankalpDonor[]; total: number; counts?: Counts } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [callBack, setCallBack] = useState<SankalpDonor | null>(null);
  const [reload, setReload] = useState(0);
  const [loadedAt, setLoadedAt] = useState(0);

  useEffect(() => {
    let live = true;
    apiClient
      .get<{ donors: SankalpDonor[]; total: number; counts?: Counts }>(
        `/api/sankalpam/donors?need=${need}&limit=300`
      )
      .then((d) => {
        if (!live) return;
        setData(d);
        // "Due" is judged against when the list was fetched, not re-read on every render.
        setLoadedAt(Date.now());
        setError(null);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load."));
    return () => {
      live = false;
    };
  }, [need, version, reload]);

  async function log(d: SankalpDonor, outcome: CallOutcome, extra: { note?: string; next_call_at?: string } = {}) {
    setBusy(d.id);
    try {
      await apiClient.post(`/api/sankalpam/donors/${d.id}/calls`, { outcome, ...extra });
      toast(`${OUTCOME_WORDS[outcome]} · ${d.donor_name}`);
      if (outcome === "got_details") onEdit(d.id);
      setReload((n) => n + 1);
      onChanged();
    } catch (e) {
      toast.error("Could not save. Try again.", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  const now = loadedAt;
  const rows = data?.donors ?? [];
  const due = rows.filter((d) => d.next_call_at && new Date(d.next_call_at).getTime() <= now).length;
  const never = rows.filter((d) => !d.call_count).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          value={need}
          onChange={(v) => setNeed(v as Need)}
          options={[
            { value: "days", label: `No special days${data?.counts ? ` · ${number(data.counts.need_days)}` : ""}` },
            { value: "gotram", label: `No gotram${data?.counts ? ` · ${number(data.counts.need_gotram)}` : ""}` },
            { value: "check", label: `Check details${data?.counts?.need_check != null ? ` · ${number(data.counts.need_check)}` : ""}` },
          ]}
        />
        {data && (
          <p className="text-sm text-ink-muted">
            {number(due)} callback{due === 1 ? "" : "s"} due · {number(never)} not rung yet
          </p>
        )}
      </div>
      <p className="text-sm text-ink-soft">
        {need === "days"
          ? "Ring them to ask their family's birthdays and anniversaries. Once a day is added they leave this list."
          : need === "gotram"
          ? "Ring them to ask their gotram for the sankalpam."
          : "Everyone on Sankalpam, to ring once a year and check their names, days, gotram and address. They leave this list for a year once you mark the details correct or updated."}
      </p>

      {error && <Alert tone="danger">{error}</Alert>}

      {!data ? (
        <Skeleton className="h-64" />
      ) : !rows.length ? (
        <Card padded={false}>
          <EmptyState
            icon="checkCircle"
            title="Nobody to ring"
            message={need === "days" ? "Every donor has a special day." : need === "gotram" ? "Every donor has a gotram." : "Every donor's details were checked this year."}
          />
        </Card>
      ) : (
        <Card padded={false} className="overflow-hidden">
          <ul className="divide-y divide-line-soft">
            {rows.map((d) => {
              const dueNow = d.next_call_at && new Date(d.next_call_at).getTime() <= now;
              return (
                <li key={d.id} className={`flex flex-wrap items-start gap-x-4 gap-y-2.5 px-4 py-3.5 sm:px-5 ${dueNow ? "bg-amber-50/60" : ""}`}>
                  <div className="min-w-0 flex-1 basis-60">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <button type="button" onClick={() => onEdit(d.id)} className="font-medium text-ink hover:text-brand-700 hover:underline">
                        {d.donor_name}
                      </button>
                      <SourceChip source={d.source} />
                      {Number(d.total_given) > 0 && <span className="text-xs text-ink-muted">gave {currency(Number(d.total_given))}</span>}
                    </p>
                    {!sameName(d.sevak_name, d.donor_name) && <p className="text-xs text-ink-muted">On the name of {d.sevak_name}</p>}
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {d.call_count ? (
                        <>
                          <span className="font-medium text-ink-soft">
                            {d.call_count} call{d.call_count === 1 ? "" : "s"}
                          </span>
                          {d.last_call_outcome && (
                            <>
                              {" · last: "}
                              {OUTCOME_WORDS[d.last_call_outcome]}, {relativeDate(d.last_call_at).toLowerCase()}
                              {d.last_caller_name ? ` by ${d.last_caller_name}` : ""}
                            </>
                          )}
                        </>
                      ) : (
                        "Not rung yet"
                      )}
                    </p>
                    {d.last_call_note && <p className="mt-0.5 text-xs text-ink-muted">“{d.last_call_note}”</p>}
                    {d.next_call_at && (
                      <p className={`mt-0.5 text-xs font-medium ${dueNow ? "text-warn" : "text-ink-muted"}`}>
                        {dueNow ? "Call back now" : `Call back ${dateTime(d.next_call_at)}`}
                      </p>
                    )}
                  </div>
                  {/* Phone: the number full width, the outcomes in one row under it. */}
                  <div className="grid w-full grid-cols-[1fr_1fr_1fr_auto] items-center gap-1.5 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
                    {d.phone ? (
                      <a
                        href={`tel:+91${d.phone}`}
                        className="col-span-4 inline-flex h-9 items-center justify-center gap-1.5 rounded-control bg-brand-700 px-3 text-sm font-medium text-white shadow-button hover:bg-brand-800 max-sm:h-11"
                      >
                        <Icon name="phone" size={14} />
                        {d.phone}
                      </a>
                    ) : (
                      <span className="col-span-4 text-xs text-warn sm:col-span-1">No mobile number</span>
                    )}
                    <Button variant="secondary" size="sm" className="max-sm:h-11 max-sm:px-2" loading={busy === d.id} onClick={() => void log(d, "no_answer")}>
                      No answer
                    </Button>
                    <Button variant="secondary" size="sm" className="max-sm:h-11 max-sm:px-2" disabled={busy === d.id} onClick={() => setCallBack(d)}>
                      Call back
                    </Button>
                    {need === "check" ? (
                      <Button size="sm" icon="check" className="max-sm:h-11 max-sm:px-2" disabled={busy === d.id} onClick={() => void log(d, "verified")}>
                        All correct
                      </Button>
                    ) : (
                      <Button size="sm" icon="check" className="max-sm:h-11 max-sm:px-2" disabled={busy === d.id} onClick={() => void log(d, "got_details")}>
                        Got details
                      </Button>
                    )}
                    <DropdownMenu
                      items={[
                        ...(need === "check"
                          ? [{ label: "They changed something", hint: "Opens their details to update", icon: "edit" as const, onSelect: () => void log(d, "got_details") }]
                          : []),
                        { label: "Busy", onSelect: () => void log(d, "busy") },
                        { label: "Not interested", hint: "Stops their reminders", onSelect: () => void log(d, "not_interested") },
                        { label: "Wrong number", hint: "Stops their reminders", tone: "danger", onSelect: () => void log(d, "wrong_number") },
                        { label: "Open their details", icon: "edit", onSelect: () => onEdit(d.id) },
                      ]}
                      trigger={({ open, toggle }) => (
                        <Button variant="ghost" size="sm" icon="more" className="max-sm:h-11" onClick={toggle} aria-expanded={open} aria-haspopup="menu" aria-label="More" />
                      )}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {callBack && (
        <CallBackDialog
          donor={callBack}
          onClose={() => setCallBack(null)}
          onSave={async (when, note) => {
            const d = callBack;
            setCallBack(null);
            await log(d, "call_back", { next_call_at: when, note });
          }}
        />
      )}
    </div>
  );
}
