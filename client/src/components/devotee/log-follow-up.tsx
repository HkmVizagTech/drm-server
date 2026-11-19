"use client";

// Log what happened when the devotee reached (or tried to reach) a lead, and when to try next.
//
// The outcome becomes the lead's status. "Donated" asks for the gift. "Call later" needs a time.
// "Invalid number" and "Not interested" close the lead, so there is no next time to ask for.
// The next follow-up starts at a sensible time for the outcome and is one tap to change.

import { useState } from "react";
import { apiClient } from "@/lib/api";
import { istInputToISO, istToday } from "@/lib/format";
import {
  CHANNELS,
  CLOSED,
  FOLLOW_UP_PRESETS,
  OUTCOME_ORDER,
  PAYMENT_MODES,
  STATUS,
  defaultFollowUp,
  leadsChanged,
  toIstInput,
  type Channel,
  type DevoteeLead,
  type LeadActivity,
  type Outcome,
} from "@/lib/devotee";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";

const OUTCOME_STYLE: Record<Outcome, string> = {
  not_answered: "data-[on=true]:bg-sunken data-[on=true]:ring-ink-faint",
  call_later: "data-[on=true]:bg-warn-wash data-[on=true]:ring-warn",
  interested: "data-[on=true]:bg-brand-50 data-[on=true]:ring-brand-500",
  donated: "data-[on=true]:bg-good-wash data-[on=true]:ring-good",
  not_interested: "data-[on=true]:bg-sunken data-[on=true]:ring-ink-faint",
  invalid_number: "data-[on=true]:bg-danger-wash data-[on=true]:ring-danger",
};

export function LogFollowUpDialog({
  lead,
  onClose,
  onSaved,
}: {
  lead: Pick<DevoteeLead, "id" | "name" | "phone">;
  onClose: () => void;
  onSaved?: (r: { lead: DevoteeLead; activity: LeadActivity }) => void;
}) {
  const [channel, setChannel] = useState<Channel>("call");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [note, setNote] = useState("");
  const [next, setNext] = useState(""); // datetime-local value, IST
  const [preset, setPreset] = useState<string | null>(null);
  const [gift, setGift] = useState({ amount: "", donated_on: istToday(), payment_mode: "upi", purpose: "", reference: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closed = outcome !== null && CLOSED.includes(outcome);

  function pickOutcome(o: Outcome) {
    setOutcome(o);
    setError(null);
    // Suggest a time for the outcome, unless the devotee has already chosen one.
    if (!preset) setNext(toIstInput(defaultFollowUp(o)));
  }

  function pickPreset(key: string) {
    const p = FOLLOW_UP_PRESETS.find((x) => x.key === key);
    if (!p) return;
    setPreset(key);
    setNext(toIstInput(p.at().toISOString()));
  }

  async function save() {
    setError(null);
    if (!outcome && !note.trim()) return setError("Choose what happened, or write a note.");
    if (outcome === "call_later" && !next) return setError("Pick when to call them back.");
    if (outcome === "donated" && !(Number(gift.amount) > 0)) return setError("Enter the amount donated.");
    setBusy(true);
    try {
      const body: Record<string, unknown> = { outcome, channel, note: note.trim() || null };
      // With an outcome the follow-up is always decided (a time, or none). A plain note only
      // changes it if a time was picked.
      if (outcome) body.next_follow_up_at = !closed && next ? istInputToISO(next) : null;
      else if (next) body.next_follow_up_at = istInputToISO(next);
      if (outcome === "donated") body.donation = { ...gift, amount: Number(gift.amount) };
      const r = await apiClient.post<{ lead: DevoteeLead; activity: LeadActivity }>(`/api/devotee/leads/${lead.id}/activities`, body);
      toast.success(outcome ? `${lead.name}: ${STATUS[outcome].label}` : "Note saved");
      leadsChanged();
      onSaved?.(r);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Follow-up · ${lead.name}`}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} icon="check">
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {error && <Alert tone="danger">{error}</Alert>}

        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-soft">How did you reach them?</p>
          <div className="grid grid-cols-4 gap-1.5">
            {CHANNELS.map((c) => (
              <button
                key={c.value}
                type="button"
                data-on={channel === c.value}
                onClick={() => setChannel(c.value)}
                className="flex flex-col items-center gap-1 rounded-control py-2 text-xs font-medium text-ink-soft ring-1 ring-inset ring-line-soft transition-colors hover:bg-sunken data-[on=true]:bg-brand-50 data-[on=true]:text-brand-700 data-[on=true]:ring-brand-500"
              >
                <Icon name={c.icon} size={17} />
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-soft">What happened?</p>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {OUTCOME_ORDER.map((o) => (
              <button
                key={o}
                type="button"
                data-on={outcome === o}
                onClick={() => pickOutcome(o)}
                className={`flex items-center gap-2 rounded-control px-3 py-2.5 text-left text-sm font-medium text-ink ring-1 ring-inset ring-line-soft transition-colors hover:bg-sunken ${OUTCOME_STYLE[o]}`}
              >
                <Icon name={STATUS[o].icon} size={16} />
                {STATUS[o].label}
              </button>
            ))}
          </div>
          {outcome && (
            <button type="button" className="mt-1.5 text-xs text-ink-muted hover:text-ink" onClick={() => setOutcome(null)}>
              Clear - just add a note
            </button>
          )}
        </div>

        {outcome === "donated" && (
          <div className="grid gap-3 rounded-card border border-emerald-200 bg-good-wash p-3 sm:grid-cols-2">
            <Field label="Amount (₹)" required>
              <Input inputMode="decimal" value={gift.amount} onChange={(e) => setGift({ ...gift, amount: e.target.value.replace(/[^\d.]/g, "") })} placeholder="e.g. 1116" />
            </Field>
            <Field label="Date">
              <Input type="date" max={istToday()} value={gift.donated_on} onChange={(e) => setGift({ ...gift, donated_on: e.target.value })} />
            </Field>
            <Field label="Paid by">
              <Select value={gift.payment_mode} onChange={(v) => setGift({ ...gift, payment_mode: v })} options={PAYMENT_MODES} ariaLabel="Paid by" />
            </Field>
            <Field label="Receipt / UTR no." hint="Optional">
              <Input value={gift.reference} onChange={(e) => setGift({ ...gift, reference: e.target.value })} />
            </Field>
            <Field label="For" hint="Optional - e.g. Annadanam" className="sm:col-span-2">
              <Input value={gift.purpose} onChange={(e) => setGift({ ...gift, purpose: e.target.value })} />
            </Field>
          </div>
        )}

        <Field label="Note" hint={outcome ? "Optional" : undefined}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did they say?" />
        </Field>

        {!closed && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-soft">
              Next follow-up{outcome === "call_later" ? " (required)" : ""}
            </p>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {FOLLOW_UP_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  data-on={preset === p.key}
                  onClick={() => pickPreset(p.key)}
                  className="rounded-full px-2.5 py-1 text-xs font-medium text-ink-soft ring-1 ring-inset ring-line-soft hover:bg-sunken data-[on=true]:bg-brand-600 data-[on=true]:text-white data-[on=true]:ring-brand-600"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="datetime-local"
                value={next}
                min={toIstInput(new Date().toISOString())}
                onChange={(e) => {
                  setNext(e.target.value);
                  setPreset(null);
                }}
                aria-label="Next follow-up date and time"
              />
              {next && (
                <Button variant="ghost" size="sm" onClick={() => { setNext(""); setPreset(null); }}>
                  Clear
                </Button>
              )}
            </div>
            <p className="mt-1 text-xs text-ink-muted">You will get a reminder at this time.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
