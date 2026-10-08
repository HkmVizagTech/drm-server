"use client";

// Calling a Sankalpam donor: the "call back when?" dialog, and the call panel
// on a donor's form - so anyone on the list can be rung to ask, update or
// check their details, not only those on the Need details list.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { dateTime, istDayPlus, istInputToISO, relativeDate } from "@/lib/format";
import { OUTCOME_WORDS, type CallOutcome, type SankalpDonor } from "@/lib/sankalpam";
import { toast } from "@/components/toast";
import { Button, DropdownMenu, Field, Icon, Input, Modal, Textarea } from "@/components/ui";

export async function logSankalpCall(
  donorId: string,
  outcome: CallOutcome,
  extra: { note?: string; next_call_at?: string } = {}
) {
  await apiClient.post(`/api/sankalpam/donors/${donorId}/calls`, { outcome, ...extra });
}

interface CallRow {
  id: string;
  outcome: CallOutcome;
  note: string | null;
  next_call_at: string | null;
  called_at: string;
  called_by_name: string | null;
}

/**
 * On the donor's form: ring them, and say what came of it. Shows every call
 * so far, so whoever picks up the phone next knows what was said.
 */
export function SankalpCallPanel({
  donorId,
  donorName,
  phone,
  onUpdateDetails,
}: {
  donorId: string;
  donorName: string;
  phone: string | null;
  /** "They changed something": the form is right here, so just say so. */
  onUpdateDetails?: () => void;
}) {
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [callBack, setCallBack] = useState(false);
  const [all, setAll] = useState(false);

  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    apiClient
      .get<{ calls: CallRow[] }>(`/api/sankalpam/donors/${donorId}/calls`)
      .then((r) => live && setCalls(r.calls))
      .catch(() => live && setCalls([]));
    return () => {
      live = false;
    };
  }, [donorId, reload]);

  async function log(outcome: CallOutcome, extra: { note?: string; next_call_at?: string } = {}) {
    setBusy(true);
    try {
      await logSankalpCall(donorId, outcome, extra);
      toast(`${OUTCOME_WORDS[outcome]} · ${donorName}`);
      if (outcome === "got_details") onUpdateDetails?.();
      setReload((n) => n + 1);
    } catch (e) {
      toast.error("Could not save. Try again.", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  const digits = (phone ?? "").replace(/\D/g, "").slice(-10);
  const shown = all ? calls ?? [] : (calls ?? []).slice(0, 3);
  const next = calls?.[0]?.next_call_at;

  return (
    <div className="rounded-card border border-line-soft p-3 sm:p-4">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">
          Calls{calls && calls.length ? <span className="font-normal text-ink-muted"> · {calls.length}</span> : null}
        </p>
        {next && <p className="text-xs font-medium text-warn">Call back {dateTime(next)}</p>}
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:items-center">
        {digits.length === 10 ? (
          <a
            href={`tel:+91${digits}`}
            className="col-span-2 inline-flex h-9 items-center justify-center gap-1.5 rounded-control bg-brand-700 px-3 text-sm font-medium text-white shadow-button hover:bg-brand-800 max-sm:h-11"
          >
            <Icon name="phone" size={14} />
            Call {digits}
          </a>
        ) : (
          <span className="col-span-2 text-xs text-warn sm:mr-1">No mobile number</span>
        )}
        <Button variant="secondary" size="sm" className="max-sm:h-11" loading={busy} onClick={() => void log("no_answer")}>
          No answer
        </Button>
        <Button variant="secondary" size="sm" className="max-sm:h-11" disabled={busy} onClick={() => setCallBack(true)}>
          Call back
        </Button>
        <Button size="sm" icon="check" className="max-sm:h-11" disabled={busy} onClick={() => void log("verified")}>
          Details correct
        </Button>
        <DropdownMenu
          items={[
            { label: "They gave new details", hint: "Type them in above, then Save", icon: "edit", onSelect: () => void log("got_details") },
            { label: "Busy", onSelect: () => void log("busy") },
            { label: "Not interested", hint: "Stops their reminders", onSelect: () => void log("not_interested") },
            { label: "Wrong number", hint: "Stops their reminders", tone: "danger", onSelect: () => void log("wrong_number") },
          ]}
          trigger={({ open, toggle }) => (
            <Button variant="secondary" size="sm" icon="more" className="max-sm:h-11" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
              More
            </Button>
          )}
        />
      </div>
      {calls && calls.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-line-soft pt-2.5">
          {shown.map((c) => (
            <li key={c.id} className="text-xs text-ink-muted">
              <span className="font-medium text-ink-soft">{OUTCOME_WORDS[c.outcome] ?? c.outcome}</span>
              {" · "}
              {relativeDate(c.called_at)}
              {c.called_by_name ? ` by ${c.called_by_name}` : ""}
              {c.note && <span className="block text-ink-muted">“{c.note}”</span>}
            </li>
          ))}
          {calls.length > 3 && (
            <li>
              <button type="button" onClick={() => setAll((v) => !v)} className="text-xs text-brand-700 hover:underline">
                {all ? "Show fewer" : `Show all ${calls.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
      {callBack && (
        <CallBackDialog
          donor={{ donor_name: donorName }}
          onClose={() => setCallBack(false)}
          onSave={async (when, note) => {
            setCallBack(false);
            await log("call_back", { next_call_at: when, note });
          }}
        />
      )}
    </div>
  );
}

const WHEN = [
  { label: "This evening", days: 0, time: "18:00" },
  { label: "Tomorrow", days: 1, time: "10:00" },
  { label: "In 3 days", days: 3, time: "10:00" },
  { label: "Next week", days: 7, time: "10:00" },
];

export function CallBackDialog({
  donor,
  onClose,
  onSave,
}: {
  donor: Pick<SankalpDonor, "donor_name">;
  onClose: () => void;
  onSave: (whenIso: string, note?: string) => void | Promise<void>;
}) {
  const [day, setDay] = useState(istDayPlus(1));
  const [time, setTime] = useState("10:00");
  const [note, setNote] = useState("");
  return (
    <Modal
      title={`Call ${donor.donor_name} back`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void onSave(istInputToISO(`${day}T${time}`), note.trim() || undefined)}>Save</Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {WHEN.map((w) => (
          <Button
            key={w.label}
            variant="secondary"
            size="sm"
            onClick={() => {
              setDay(istDayPlus(w.days));
              setTime(w.time);
            }}
          >
            {w.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Day" htmlFor="cb-day">
          <Input id="cb-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Time" htmlFor="cb-time">
          <Input id="cb-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
        <Field label="Note (optional)" htmlFor="cb-note" className="sm:col-span-2">
          <Textarea id="cb-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Call after 6 pm, ask for her husband" />
        </Field>
      </div>
    </Modal>
  );
}
