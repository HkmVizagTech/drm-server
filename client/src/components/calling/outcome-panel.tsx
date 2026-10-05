"use client";

// How the call went: the buttons the whole call screen exists for, and the
// optional extras that ride along with them in one request.
//
// ONE TAP TO PICK, ONE TO CONFIRM
// A caller works through sixty of these in an hour, so an outcome is one tap
// (or one number key at a desk) - and, with "Ask before logging" on (the
// default), one more on the confirm that says exactly what is about to be
// saved. The pick is drawn as picked, so the caller can see what they hit
// before it is saved. Everything else - the note, the callback date, the
// promise, the amount - is optional and is sent WITH the outcome, never as a
// separate save after it, because separate saves are the ones that get skipped.
//
// THEY RANG ME
// A donor who did not answer at ten often rings back at four. That call is
// logged here like any other, with "They rang me" switched on, so the record
// says who rang whom - and "Donated now" with the amount is how money taken on
// that call is recorded.
//
// THE REMINDER BOX
// "I'll give on Govardhan Puja evening" is said DURING the call. If capturing it
// means hanging up, finding the lead again and opening a separate form, it gets
// captured maybe a third of the time. So it sits right under the outcomes and
// saves with the call.
//
// The form's state lives in useCallForm() rather than in the panel, so the
// call screen can read it for the keyboard shortcuts and clear it when the
// person on screen changes, without reaching into a child.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { istDayPlus, istInputToISO, istInstant, istWeekday } from "@/lib/format";
import { AlertPicker, Button, Card, Field, Icon, Input, SegmentedControl, Toggle, textareaClass, type ButtonVariant } from "@/components/ui";
import { ALERT_OPTIONS, DEFAULT_ALERTS } from "@/lib/reminders";
import { isClosingOutcome, type Disposition } from "@/lib/calling";

// Callback dates as buttons rather than a date picker. "Next week" said on the
// phone should not become four taps on a calendar.
const WHEN_PRESETS: { label: string; days: number }[] = [
  { label: "Tomorrow", days: 1 },
  { label: "In 3 days", days: 3 },
  { label: "Next week", days: 7 },
  { label: "In 2 weeks", days: 14 },
  { label: "Next month", days: 30 },
];

// 10am at the temple rather than the current time of day: a callback booked at
// 9pm should not come due at 9pm, and the day is the temple's day.
function atTenAm(daysFromNow: number): string {
  return istInstant(istDayPlus(daysFromNow), "10:00").toISOString();
}

// An IST wall-clock moment for <input type="datetime-local">, which refuses an
// ISO string with a zone on it.
function istInput(daysFromNow: number, hour: number): string {
  return `${istDayPlus(daysFromNow)}T${String(hour).padStart(2, "0")}:00`;
}

/** A quick-pick chip, a finger tall: these are tapped with a phone at the ear. */
function chipClass(on: boolean): string {
  return `inline-flex min-h-11 items-center gap-1 rounded-control border px-3 py-2 text-xs transition-colors ${
    on
      ? "border-brand-600 bg-brand-50 font-medium text-brand-800"
      : "border-line-strong bg-surface text-ink-muted hover:border-brand-400 hover:bg-sunken"
  }`;
}

// Colour by what the outcome MEANS. "Wrong number" technically got through,
// but painting it the encouraging green of "will donate" made the grid read
// wrong at a glance. Not red either: "please don't ring again" is an honest
// answer to record, not a destructive act.
const BAD_ENDINGS = ["not_interested", "invalid", "dnc"];
function variantFor(d: Disposition): ButtonVariant {
  if (BAD_ENDINGS.includes(d.suggests_status ?? "")) return "secondary";
  return d.counts_connected ? "primary" : "secondary";
}

/** The one outcome that is never undone by accident: it takes two taps. */
const NEEDS_CONFIRM = (d: Disposition) => d.slug === "do_not_call" || d.suggests_status === "dnc";

export interface CallForm {
  note: string;
  setNote: (v: string) => void;
  followUp: string | null;
  setFollowUp: (v: string | null) => void;
  customDate: string;
  setCustomDate: (v: string) => void;
  duration: string;
  setDuration: (v: string) => void;
  showMore: boolean;
  setShowMore: (v: boolean) => void;
  remOpen: boolean;
  setRemOpen: (v: boolean) => void;
  remOccasion: string;
  setRemOccasion: (v: string) => void;
  remWhen: string;
  setRemWhen: (v: string) => void;
  remAmount: string;
  setRemAmount: (v: string) => void;
  remAlerts: number[];
  setRemAlerts: (v: number[]) => void;
  donatedAmount: string;
  setDonatedAmount: (v: string) => void;
  /** Sets the temple's own default alert times, once config has loaded. */
  setDefaultAlerts: (v: number[]) => void;
  reset: () => void;
  /** Everything optional about the call, shaped for POST /leads/:id/call. */
  payload: () => Record<string, unknown>;
}

export function useCallForm(): CallForm {
  const [note, setNote] = useState("");
  const [followUp, setFollowUp] = useState<string | null>(null);
  const [customDate, setCustomDate] = useState("");
  const [duration, setDuration] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [remOpen, setRemOpen] = useState(false);
  const [remOccasion, setRemOccasion] = useState("");
  const [remWhen, setRemWhen] = useState("");
  const [remAmount, setRemAmount] = useState("");
  // The wider default until config arrives, so a caller who opens the box in
  // the first second after a refresh does not silently get something narrower.
  const defaults = useRef<number[]>(DEFAULT_ALERTS);
  const [remAlerts, setRemAlerts] = useState<number[]>(DEFAULT_ALERTS);
  // What they gave, when the outcome is that they gave. Without it a donation
  // taken on the call was recorded as a conversion worth nothing.
  const [donatedAmount, setDonatedAmount] = useState("");

  const setDefaultAlerts = useCallback((v: number[]) => {
    defaults.current = v;
    setRemAlerts(v);
  }, []);

  const reset = useCallback(() => {
    setNote("");
    setFollowUp(null);
    setCustomDate("");
    setDuration("");
    setShowMore(false);
    setRemOpen(false);
    setRemOccasion("");
    setRemWhen("");
    setRemAmount("");
    setRemAlerts(defaults.current);
    setDonatedAmount("");
  }, []);

  const payload = useCallback(
    () => ({
      note: note.trim() || undefined,
      duration_seconds: duration ? Number(duration) * 60 : undefined,
      // A bare date from the picker is read as UTC midnight by `new Date()`,
      // which landed callbacks at 05:30. 10am IST, as the chips book.
      next_follow_up_at: followUp ?? (customDate ? istInstant(customDate, "10:00").toISOString() : undefined),
      reminder: remWhen
        ? {
            occasion: remOccasion.trim() || undefined,
            due_at: istInputToISO(remWhen),
            expected_amount: remAmount ? Number(remAmount) : undefined,
            lead_times: remAlerts,
            note: note.trim() || undefined,
          }
        : undefined,
      donated_amount: donatedAmount ? Number(donatedAmount) : undefined,
    }),
    [note, duration, followUp, customDate, remWhen, remOccasion, remAmount, remAlerts, donatedAmount]
  );

  return {
    note, setNote, followUp, setFollowUp, customDate, setCustomDate, duration, setDuration,
    showMore, setShowMore, remOpen, setRemOpen, remOccasion, setRemOccasion, remWhen, setRemWhen,
    remAmount, setRemAmount, remAlerts, setRemAlerts, donatedAmount, setDonatedAmount,
    setDefaultAlerts, reset, payload,
  };
}

export function OutcomePanel({
  form,
  dispositions,
  keys,
  saving,
  onPick,
  askFirst,
  selected,
  confirm,
  inbound,
  onInboundChange,
  onLinkOther,
  shortcutsOn,
  onShortcutsChange,
  showKeys,
  noteRef,
  logged,
  after,
}: {
  form: CallForm;
  dispositions: Disposition[];
  /** slug -> number key. */
  keys: Map<string, number>;
  /** The slug being saved, so only that button spins. */
  saving: string | null;
  /** A tap (or key) on an outcome. The call screen decides whether that logs or asks first. */
  onPick: (d: Disposition) => void;
  /** "Ask before logging" is on: a tap picks, the confirm logs. */
  askFirst: boolean;
  /** The outcome picked and waiting on the confirm. */
  selected: string | null;
  /** The confirm bar, drawn right under the buttons (desk layout). */
  confirm?: ReactNode;
  /** "They rang me" - the call is logged as incoming. */
  inbound: boolean;
  onInboundChange: (on: boolean) => void;
  /** Opens "They gave from another number". */
  onLinkOther?: () => void;
  shortcutsOn: boolean;
  onShortcutsChange: (on: boolean) => void;
  /** Desk only: on a phone there is no keyboard to label. */
  showKeys: boolean;
  noteRef: RefObject<HTMLTextAreaElement | null>;
  /** What was already logged for this person in this run (reached via Previous). */
  logged: string | null;
  /** The "Next person" button, when there is a next person. */
  after?: ReactNode;
}) {
  const connected = useMemo(() => dispositions.filter((d) => d.counts_connected), [dispositions]);
  const unanswered = useMemo(() => dispositions.filter((d) => !d.counts_connected), [dispositions]);

  // Two taps for "never call again", the second within a few seconds of the first.
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(null), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  const tap = (d: Disposition) => {
    // With the confirm on, the confirm is the second tap - it already draws
    // "never call them" in red - so the old double-tap would be a third.
    if (!askFirst && NEEDS_CONFIRM(d) && armed !== d.slug) return setArmed(d.slug);
    setArmed(null);
    onPick(d);
  };

  const button = (d: Disposition, variant: ButtonVariant) => {
    const key = keys.get(d.slug);
    const confirming = armed === d.slug;
    const picked = selected === d.slug;
    const closing = isClosingOutcome(d);
    return (
      <Button
        key={d.slug}
        size="lg"
        variant={confirming || (picked && closing) ? "danger" : picked ? "primary" : variant}
        disabled={saving !== null}
        loading={saving === d.slug}
        onClick={() => tap(d)}
        aria-pressed={askFirst ? picked : undefined}
        data-outcome={d.slug}
        // Wrapping allowed: "Asked not to be called" in half a phone's width
        // would otherwise run out of its own button.
        className={`h-auto! min-h-12 whitespace-normal! py-2 text-sm! leading-tight ${
          picked ? `ring-4 ring-offset-1 ring-offset-surface ${closing ? "ring-red-300" : "ring-brand-300"}` : ""
        } ${selected && !picked ? "opacity-70" : ""}`}
      >
        {picked && <Icon name="check" size={16} className="flex-none" />}
        {confirming ? "Tap again — never call them" : d.label}
        {showKeys && shortcutsOn && key && (
          <kbd className="ml-1 text-2xs font-normal opacity-60">{key}</kbd>
        )}
      </Button>
    );
  };

  return (
    <Card padded={false} className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">How did it go?</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {logged ? (
              <>
                You logged <span className="font-semibold text-ink">{logged}</span>. Tap another to log again.
              </>
            ) : askFirst ? (
              "Tap how it went, then confirm. Everything below the buttons is optional."
            ) : (
              "One tap logs the call. Everything below the buttons is optional."
            )}
          </p>
        </div>
        {showKeys && (
          <div className="flex flex-none items-center gap-2">
            <span className="text-2xs text-ink-muted">Keys</span>
            <SegmentedControl
              size="sm"
              options={[
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
              value={shortcutsOn ? "on" : "off"}
              onChange={(v) => onShortcutsChange(v === "on")}
            />
          </div>
        )}
      </div>

      {after && <div className="mt-3">{after}</div>}

      {/* Who rang whom. Off for an ordinary call; on when the donor rang
          back - set already when the screen was opened with "They rang me". */}
      <label
        className={`mt-3 flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-card border px-3.5 py-2 text-sm transition-colors ${
          inbound ? "border-info bg-info-wash text-sky-900" : "border-line-soft bg-sunken text-ink-soft"
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon name="phone" size={15} className={`flex-none ${inbound ? "text-info" : "text-ink-muted"}`} />
          <span className="min-w-0">
            <span className="font-medium">They rang me</span>
            <span className="block text-xs opacity-80">
              {inbound ? "Logged as an incoming call" : "Switch on if they called you back"}
            </span>
          </span>
        </span>
        <Toggle on={inbound} onChange={onInboundChange} label="They rang me — log as an incoming call" />
      </label>

      {/* How much, when they gave on this call. Inline, not a dialog: somebody
          is on the line. Blank falls back to what the lead was expected to
          give, and the donation is still recorded. */}
      <div className="mt-4 flex flex-wrap items-end gap-x-3 gap-y-1">
        <Field label="If they gave on this call, how much?" htmlFor="donated-amount">
          <div className="w-40">
            <Input
              id="donated-amount"
              value={form.donatedAmount}
              onChange={(e) => form.setDonatedAmount(e.target.value.replace(/\D/g, ""))}
              placeholder="₹ optional"
              inputMode="numeric"
              className="tabular-nums"
            />
          </div>
        </Field>
        {!!form.donatedAmount && (
          <span className="pb-2.5 text-2xs text-good">recorded with an outcome that means they donated</span>
        )}
      </div>
      {onLinkOther && (
        // A plain button: the label wraps at phone width.
        <button
          type="button"
          onClick={onLinkOther}
          className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-left text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
        >
          <Icon name="link" size={14} className="flex-none" />
          <span>Already gave — from another number or name? Find it</span>
        </button>
      )}

      <div className="mt-4">
        <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">Got through</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {connected.map((d) => button(d, variantFor(d)))}
        </div>
      </div>

      <div className="mt-4">
        <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
          Didn&apos;t get through
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{unanswered.map((d) => button(d, "secondary"))}</div>
        <p className="mt-2 text-xs text-ink-muted">These come back round by themselves — no date needed.</p>
      </div>

      {confirm}

      {/* ------------------------------------------------- the optional extras */}
      <div className="mt-5 space-y-3 border-t border-line-soft pt-4">
        {/* The raw element: the N shortcut focuses this through a ref and the
            Textarea component does not take one. Same classes either way. */}
        <textarea
          ref={noteRef}
          value={form.note}
          onChange={(e) => form.setNote(e.target.value)}
          rows={2}
          placeholder={showKeys ? "What they said (optional) — press N" : "What they said (optional)"}
          className={`${textareaClass} resize-y`}
        />

        <div>
          <p className="mb-1.5 text-xs text-ink-muted">Call back on:</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {WHEN_PRESETS.map((p) => {
              const iso = atTenAm(p.days);
              const active = form.followUp === iso;
              return (
                <button
                  key={p.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    form.setFollowUp(active ? null : iso);
                    form.setCustomDate("");
                  }}
                  className={chipClass(active)}
                >
                  {active && <Icon name="check" size={11} />}
                  {p.label}
                </button>
              );
            })}
            <div className="w-44">
              <Input
                type="date"
                value={form.customDate}
                onChange={(e) => {
                  form.setCustomDate(e.target.value);
                  form.setFollowUp(null);
                }}
                aria-label="Call back on another date"
                className="h-11"
              />
            </div>
          </div>
        </div>

        {form.remOpen ? (
          <div className="rounded-card border border-brand-200 bg-brand-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-ink-soft">They named a moment</p>
              <Button
                size="sm"
                variant="ghost"
                icon="x"
                onClick={() => {
                  form.setRemOpen(false);
                  form.setRemWhen("");
                }}
              >
                Remove
              </Button>
            </div>
            <p className="mt-0.5 text-2xs text-ink-muted">
              A promise the donor made at a moment they chose. Pick when it should reach you.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <Input
                value={form.remOccasion}
                onChange={(e) => form.setRemOccasion(e.target.value)}
                placeholder="Occasion — Govardhan Puja"
                aria-label="Occasion"
              />
              <Input
                type="datetime-local"
                value={form.remWhen}
                onChange={(e) => form.setRemWhen(e.target.value)}
                aria-label="When to remind you"
              />
              <Input
                value={form.remAmount}
                onChange={(e) => form.setRemAmount(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                placeholder="₹ they said"
                aria-label="Amount they said"
                className="tabular-nums"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[
                { label: "This evening 6pm", h: 18, d: 0 },
                { label: "Tomorrow 10am", h: 10, d: 1 },
                { label: "Saturday 10am", h: 10, d: (6 - istWeekday() + 7) % 7 || 7 },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => form.setRemWhen(istInput(p.d, p.h))}
                  className={chipClass(form.remWhen === istInput(p.d, p.h))}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="mt-2">
              <AlertPicker
                value={form.remAlerts}
                onChange={form.setRemAlerts}
                options={ALERT_OPTIONS}
                emptyWarning="Nothing ticked means nothing will alert you — it will only sit on the reminders board."
              />
            </div>
          </div>
        ) : (
          // A plain button: the label is a sentence and has to wrap at phone
          // width, which every <Button> (whitespace-nowrap) refuses to do.
          <button
            type="button"
            onClick={() => form.setRemOpen(true)}
            className="inline-flex min-h-11 items-center gap-1.5 text-left text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            <Icon name="bell" size={14} className="flex-none" />
            <span>
              They promised to give at a particular time — remind me
              {showKeys && <kbd className="ml-1 text-2xs text-ink-faint">R</kbd>}
            </span>
          </button>
        )}

        {form.showMore ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Roughly how long, in minutes" htmlFor="call-minutes">
              <div className="w-28">
                <Input
                  id="call-minutes"
                  inputMode="numeric"
                  value={form.duration}
                  onChange={(e) => form.setDuration(e.target.value.replace(/\D/g, ""))}
                  className="tabular-nums"
                />
              </div>
            </Field>
            <span className="pb-2.5 text-xs text-ink-faint">Self-reported — nothing is timing the call</span>
          </div>
        ) : (
          <Button size="sm" variant="ghost" icon="clock" onClick={() => form.setShowMore(true)}>
            Add call length
          </Button>
        )}
      </div>
    </Card>
  );
}
