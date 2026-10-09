"use client";

// "Log ‘No answer’ for Ravi Kumar?"
//
// WHY A SECOND STEP, ON A SCREEN BUILT AROUND ONE TAP
// The outcome buttons sit a thumb apart and are hit at speed, with the screen
// moving on to the next person the moment one is touched. A slip used to log
// the wrong thing AND take the caller away from the person it was about, and
// the Undo that fixed it was a toast that had already faded. So a tap now
// picks an outcome, and this asks once - with what is about to be saved
// written out, so a forgotten callback date or amount is caught here rather
// than discovered on the reminders board next week.
//
// Callers who know the screen can turn it off ("Ask before logging"), and
// the old one-tap behaviour returns.
//
// The button Enter presses carries data-confirm-primary, so the call screen
// can put focus on it when the confirm opens.
//
// TWO SHAPES, ONE COMPONENT
//   sheet   - phones and tablets: pinned to the bottom edge, over the
//             Previous / Skip bar (never under it), clear of the home
//             indicator. The page under it still scrolls, so the note and
//             the callback chips stay editable.
//   inline  - desks: a bar directly under the outcome buttons, where the
//             eye already is.

import { useEffect } from "react";
import { currency, dateTime, istDayPlus, istInputToISO, istInstant, shortDate } from "@/lib/format";
import { Button, Icon, Input } from "@/components/ui";
import { isClosingOutcome, isDonatedOutcome, type Disposition } from "@/lib/calling";
import type { CallForm } from "./outcome-panel";

/** "When will they donate?" - the days people actually say on the phone. */
const LATER_WHEN: { label: string; days: number; time: string }[] = [
  { label: "This evening", days: 0, time: "18:00" },
  { label: "Tomorrow", days: 1, time: "10:00" },
  { label: "In 3 days", days: 3, time: "10:00" },
  { label: "Next week", days: 7, time: "10:00" },
  { label: "In 2 weeks", days: 14, time: "10:00" },
  { label: "Next month", days: 30, time: "10:00" },
];

export function ConfirmLog({
  outcome,
  name,
  form,
  inbound,
  canAdvance,
  advanceLabel,
  saving,
  layout,
  expectedAmount,
  onChange,
  onConfirm,
}: {
  outcome: Disposition;
  /** Who it is for, as the caller knows them. */
  name: string;
  form: CallForm;
  inbound: boolean;
  /** Offer "Log & next person" - only in a run with "move on by itself" on, and never for the QR outcome. */
  canAdvance: boolean;
  /** "Log & next person", or "Log & finish" on the last one. */
  advanceLabel: string;
  saving: boolean;
  layout: "sheet" | "inline";
  expectedAmount: string | null;
  onChange: () => void;
  onConfirm: (advance: boolean) => void;
}) {
  const closing = isClosingOutcome(outcome);
  const donated = isDonatedOutcome(outcome);
  const qr = outcome.slug === "will_pay_qr";
  // "Will donate later": they mean it, just not today. Ask when and how much
  // right here, so it becomes a promise that rings on the day.
  const later = outcome.slug === "will_donate";
  // A follow-up day already picked below the outcomes is the day they said:
  // carried into the promise, so the two never disagree.
  const pickedDay = form.followUp ?? (form.customDate ? istInstant(form.customDate, "10:00").toISOString() : null);
  useEffect(() => {
    if (later && pickedDay && !form.remWhen) {
      form.setRemWhen(new Date(new Date(pickedDay).getTime() + 5.5 * 3600_000).toISOString().slice(0, 16));
    }
    // Once, as the confirm opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What will ride along with the outcome, in words.
  const extras: string[] = [];
  if (inbound) extras.push("They called you");
  if (form.followUp) extras.push(`Call back ${shortDate(form.followUp)}`);
  else if (form.customDate) extras.push(`Call back ${shortDate(istInstant(form.customDate, "10:00").toISOString())}`);
  if (form.remWhen) {
    extras.push(
      `${later ? "Will donate" : `Promise: ${form.remOccasion.trim() || "Reminder"}`} · ${dateTime(istInputToISO(form.remWhen))}${
        form.remAmount ? ` · ${currency(Number(form.remAmount))}` : ""
      }`
    );
  }
  if (form.duration) extras.push(`About ${form.duration} min`);
  const note = form.note.trim();

  // A promise date is also the day they are rung again.
  const missingCallback = outcome.wants_follow_up && !form.followUp && !form.customDate && !form.remWhen && !closing;

  const box =
    layout === "sheet"
      ? `fixed inset-x-0 bottom-0 z-40 rounded-t-panel border-t-2 bg-surface px-4 pt-3 shadow-dialog pb-[calc(0.75rem+env(safe-area-inset-bottom))] ${
          closing ? "border-danger" : "border-brand-600"
        }`
      : `mt-4 rounded-card border-2 p-3.5 shadow-raised ${closing ? "border-danger bg-danger-wash" : "border-brand-600 bg-brand-50"}`;

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="confirm-log-title"
      aria-describedby="confirm-log-desc"
      className={`fade-rise ${box}`}
    >
      <div className={layout === "sheet" ? "mx-auto max-w-2xl" : ""}>
        {layout === "sheet" && <div className="mx-auto mb-2 h-1 w-10 rounded-pill bg-line-strong" aria-hidden />}
        <p id="confirm-log-title" className={`text-base font-semibold leading-snug ${closing ? "text-danger" : "text-ink"}`}>
          Save &ldquo;{outcome.label}&rdquo; for {name}?
        </p>
        <div id="confirm-log-desc" className="mt-1 space-y-0.5 text-xs text-ink-muted">
          {closing && (
            <p className="flex items-start gap-1.5 font-medium text-danger">
              <Icon name="alert" size={13} className="mt-px flex-none" />
              They will not be called again.
            </p>
          )}
          {qr && <p>Send the QR next.</p>}
          {extras.length > 0 && <p className="text-ink-soft">{extras.join(" · ")}</p>}
          {note && <p className="line-clamp-2 text-ink-soft">“{note}”</p>}
          {missingCallback && <p>No date picked. We&apos;ll try them again later.</p>}
        </div>

        {/* The one field worth having right here: "Donated now" with no
            amount records a conversion worth whatever they were hoping for,
            which on an incoming call is often the wrong number. */}
        {donated && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label htmlFor="confirm-donated" className="text-xs font-medium text-ink-soft">
              Amount
            </label>
            <div className="w-36">
              <Input
                id="confirm-donated"
                value={form.donatedAmount}
                onChange={(e) => form.setDonatedAmount(e.target.value.replace(/\D/g, ""))}
                placeholder={expectedAmount ? `₹${Math.round(Number(expectedAmount))}` : "₹"}
                inputMode="numeric"
                className="tabular-nums"
              />
            </div>
            {!form.donatedAmount && (
              <span className="text-2xs text-ink-muted">
                {expectedAmount ? `Blank uses ${currency(Number(expectedAmount))}` : "Optional"}
              </span>
            )}
          </div>
        )}

        {later && (
          <div className="mt-2.5 space-y-2">
            <p className="text-xs font-medium text-ink-soft">When will they donate?</p>
            <div className="flex flex-wrap gap-1.5">
              {LATER_WHEN.map((w) => {
                const v = `${istDayPlus(w.days)}T${w.time}`;
                const on = form.remWhen === v;
                return (
                  <button
                    key={w.label}
                    type="button"
                    onClick={() => form.setRemWhen(on ? "" : v)}
                    className={`inline-flex min-h-9 items-center rounded-control border px-2.5 text-xs transition-colors ${
                      on
                        ? "border-brand-600 bg-brand-100 font-medium text-brand-800"
                        : "border-line-strong bg-surface text-ink-soft hover:border-brand-400"
                    }`}
                  >
                    {w.label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-48">
                <Input
                  type="datetime-local"
                  value={form.remWhen}
                  onChange={(e) => form.setRemWhen(e.target.value)}
                  aria-label="Day they will donate"
                />
              </div>
              <div className="w-32">
                <Input
                  value={form.remAmount}
                  onChange={(e) => form.setRemAmount(e.target.value.replace(/\D/g, ""))}
                  placeholder={expectedAmount ? `₹${Math.round(Number(expectedAmount))}` : "Amount ₹"}
                  inputMode="numeric"
                  aria-label="Amount they will donate"
                  className="tabular-nums"
                />
              </div>
            </div>
            {!form.remWhen && (
              <p className="text-2xs text-ink-muted">Pick a day and DRM reminds you to ring them then. Without one they are tried again in a few days.</p>
            )}
          </div>
        )}

        <div
          className={
            layout === "sheet"
              ? "mt-3 grid grid-cols-2 gap-2"
              : "mt-3 flex flex-wrap items-center justify-end gap-2"
          }
        >
          <Button
            variant="secondary"
            size="lg"
            icon="arrowLeft"
            onClick={onChange}
            disabled={saving}
          >
            Change
          </Button>
          <Button
            data-confirm-primary={canAdvance ? undefined : ""}
            variant={canAdvance ? "secondary" : closing ? "danger" : "primary"}
            size="lg"
            icon="check"
            loading={saving}
            onClick={() => onConfirm(false)}
          >
            {canAdvance ? "Save, stay" : "Save"}
            {layout === "inline" && !canAdvance && <kbd className="ml-1 text-2xs font-normal opacity-70">Enter</kbd>}
          </Button>
          {canAdvance && (
            <Button
              data-confirm-primary=""
              variant={closing ? "danger" : "primary"}
              size="lg"
              iconRight="arrowRight"
              loading={saving}
              onClick={() => onConfirm(true)}
              className={layout === "sheet" ? "col-span-2" : ""}
            >
              {advanceLabel}
              {layout === "inline" && <kbd className="ml-1 text-2xs font-normal opacity-70">Enter</kbd>}
            </Button>
          )}
        </div>
        {layout === "sheet" && (
          <p className="mt-2 text-center text-2xs text-ink-faint">Tap another result to change.</p>
        )}
      </div>
    </div>
  );
}
