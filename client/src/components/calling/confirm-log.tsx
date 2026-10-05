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

import { currency, dateTime, istInputToISO, istInstant, shortDate } from "@/lib/format";
import { Button, Icon, Input } from "@/components/ui";
import { isClosingOutcome, isDonatedOutcome, type Disposition } from "@/lib/calling";
import type { CallForm } from "./outcome-panel";

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

  // What will ride along with the outcome, in words.
  const extras: string[] = [];
  if (inbound) extras.push("They called you");
  if (form.followUp) extras.push(`Call back ${shortDate(form.followUp)}`);
  else if (form.customDate) extras.push(`Call back ${shortDate(istInstant(form.customDate, "10:00").toISOString())}`);
  if (form.remWhen) {
    extras.push(
      `Promise: ${form.remOccasion.trim() || "Reminder"} · ${dateTime(istInputToISO(form.remWhen))}${
        form.remAmount ? ` · ${currency(Number(form.remAmount))}` : ""
      }`
    );
  }
  if (form.duration) extras.push(`About ${form.duration} min`);
  const note = form.note.trim();

  const missingCallback = outcome.wants_follow_up && !form.followUp && !form.customDate && !closing;

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
