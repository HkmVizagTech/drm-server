"use client";

// The calling screen.
//
// A caller works through sixty of these in an hour, so this screen is designed
// around one number: how many actions it takes to finish a call and get to the
// next person. The answer is one - a single tap or a single keystroke. Every
// other control is optional and stays out of the way until wanted.
//
// WHY ONE LEAD AT A TIME, NOT A LIST
// A list makes the caller decide who to ring next, sixty times an hour, and
// they decide badly: the easy names first, the overdue promises last. The queue
// already knows the right order (overdue, then today, then never-touched), so
// this screen shows the next person and the history they need before the line
// connects.
//
// DESKTOP AND PHONE ARE DIFFERENT JOBS
// On a phone the caller taps the number and the dialler opens. On a desktop a
// tel: link usually does nothing at all - so the same button copies the number
// instead, and says so. That is the whole difference: a caller at a desk with
// a handset needs the number in their clipboard, not a dead link. DRM never
// places the call itself either way; see the note at the top of
// server/src/routes/crm.ts.
//
// MOST OF THE PEOPLE READING THIS ARE HOLDING A PHONE
// Callers work from their own handsets, so every control here is sized for a
// thumb rather than for a mouse: the dial button and the outcome buttons are
// the large size, the quick-pick chips are a finger tall, and nothing on the
// screen needs sideways scrolling at the width of a phone. A row of 12px
// buttons is fine to click and genuinely hard to tap.
//
// THE REMINDER BOX
// "I'll give on Govardhan Puja evening" is said DURING the call. If capturing
// it means hanging up, finding the lead again and opening a separate form, it
// gets captured maybe a third of the time. So it is a box right under the
// outcome buttons, and it saves with the call in the same request.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import { currency, dueLabel, istDayPlus, istInputToISO, istInstant, istWeekday, istYear, number, relativeDate } from "@/lib/format";
import {
  Alert,
  AlertPicker,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  LinkButton,
  PageHeader,
  SegmentedControl,
  Skeleton,
  buttonPrimary,
  buttonSecondary,
  textareaClass,
  type ButtonVariant,
} from "@/components/ui";
import { ALERT_OPTIONS, DEFAULT_ALERTS, cleanAlerts } from "@/lib/reminders";
import { SendLink } from "@/components/send-link";
import { SendQr } from "@/components/send-qr";
import { useCallingAlerts } from "@/components/calling-alerts";

interface Lead {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  city: string | null;
  person_id: string | null;
  status: string;
  status_label: string | null;
  tags: string[];
  remarks: string | null;
  next_follow_up_at: string | null;
  follow_up_note: string | null;
  last_contacted_at: string | null;
  last_outcome: string | null;
  call_attempts: number;
  expected_amount: string | null;
  source: string;
  source_detail: string | null;
  assigned_to_name: string | null;
  total_donated: string | null;
  donation_count: number | null;
  last_donation_at: string | null;
  preacher_code: string | null;
  preacher_name: string | null;
  donor_code: string | null;
  external_total_donated: string | null;
  external_account_count: number | null;
  external_last_donation_at: string | null;
  external_source: string | null;
}

interface Disposition {
  slug: string;
  label: string;
  counts_connected: boolean;
  suggests_status: string | null;
  wants_follow_up: boolean;
}

// Callback dates as buttons rather than a date picker. A caller saying "next
// week" should not have to open a calendar, work out the date and tap a day -
// four interactions for something they said in two words.
const WHEN_PRESETS: { label: string; days: number }[] = [
  { label: "Tomorrow", days: 1 },
  { label: "In 3 days", days: 3 },
  { label: "Next week", days: 7 },
  { label: "In 2 weeks", days: 14 },
  { label: "Next month", days: 30 },
];

function atTenAm(daysFromNow: number): string {
  // 10am rather than the current time of day: a callback booked at 9pm should
  // not come due at 9pm. 10am at the temple, counted off the temple's own
  // calendar, so a caller on a laptop set to another zone books the same hour
  // on the same day as everybody else.
  return istInstant(istDayPlus(daysFromNow), "10:00").toISOString();
}

/**
 * A quick-pick chip, on the same classes as the design system's AlertPicker.
 *
 * The chips here and the alert offsets in the reminder box are the same
 * control doing the same job - "one of these, tapped mid-call" - so they are
 * drawn from one description rather than two that drift. The padding is a
 * step larger than AlertPicker's own: these are tapped with a thumb while the
 * caller is holding a phone to their ear, and a 28px target is where mis-taps
 * start.
 */
function chipClass(on: boolean): string {
  return `inline-flex min-h-10 items-center gap-1 rounded-control border px-3 py-2 text-xs transition-colors ${
    on
      ? "border-brand-600 bg-brand-50 font-medium text-brand-800"
      : "border-line-strong bg-surface text-ink-muted hover:border-brand-400 hover:bg-sunken"
  }`;
}

/**
 * Colour by what the outcome MEANS, not by which group it sits in.
 *
 * The two groups are the connected/unanswered split the reports depend on, so
 * they have to stay - but "wrong number" and "asked not to be called" are both
 * technically "got through", and painting them the same encouraging green as
 * "will donate" made the row read wrong at a glance. The stage a disposition
 * suggests is exactly the signal needed: one that closes a lead is not good
 * news however the call connected.
 */
// The stages that close a lead badly. `converted` closes it too, and should
// stay green - it is the best outcome there is. Anything the temple invents in
// Settings is unknown here and falls through to neutral, which is the right
// default for a stage this screen has never heard of.
const BAD_ENDINGS = ["not_interested", "invalid", "dnc"];

// Not `dangerSoft` for the bad endings: a call that ended with "please don't
// ring again" is a perfectly good thing to record, and painting the button red
// would make an honest answer look like a destructive one.
function variantFor(d: Disposition): ButtonVariant {
  if (BAD_ENDINGS.includes(d.suggests_status ?? "")) return "secondary";
  if (d.counts_connected) return "primary";
  return "secondary";
}

// An IST wall-clock moment formatted for <input type="datetime-local">, which
// refuses an ISO string with a timezone on it. The hour the quick-pick buttons
// name - "this evening 6pm" - is the hour at the temple, so the value is built
// from the IST calendar day rather than from the device's clock.
function istInput(daysFromNow: number, hour: number): string {
  return `${istDayPlus(daysFromNow)}T${String(hour).padStart(2, "0")}:00`;
}

// useSearchParams needs a Suspense boundary around it, so the screen is split:
// this wrapper reads the URL, the component below does the work.
export default function CallingQueuePage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-4xl">
          <Card>
            <Skeleton className="h-40 w-full" rounded="rounded-card" />
          </Card>
        </div>
      }
    >
      <CallingQueue />
    </Suspense>
  );
}

function CallingQueue() {
  const router = useRouter();
  const params = useSearchParams();
  // Which list this run is against, and which run it is. Both come from the
  // URL rather than from component state, so a refresh, a back button or a
  // bookmarked link all land in the same shift instead of silently dropping
  // the caller back into the global queue.
  const listId = params.get("list");
  const sessionId = params.get("session");

  const [queue, setQueue] = useState<Lead[]>([]);
  const [dispositions, setDispositions] = useState<Disposition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Session tally. Not vanity: a caller doing a two-hour run wants to know
  // where they are in it, and it is the only feedback the screen gives for
  // work that otherwise disappears the moment it is logged.
  //
  // Seeded from the server on load rather than starting at zero, which is what
  // makes "stop today, continue tomorrow" real: the count that comes back is
  // the whole run, not what has happened since this tab was opened.
  const [done, setDone] = useState(0);
  const [connectedCount, setConnectedCount] = useState(0);
  // How many of this list are still waiting, counted by the database through
  // the same filter the queue uses - so it cannot drift from what is about to
  // be handed over.
  const [toCall, setToCall] = useState(0);
  const [listName, setListName] = useState<string | null>(null);

  // Per-call inputs, cleared between leads.
  const [note, setNote] = useState("");
  const [followUp, setFollowUp] = useState<string | null>(null);
  const [customDate, setCustomDate] = useState("");
  const [duration, setDuration] = useState("");
  const [showMore, setShowMore] = useState(false);

  // The reminder the donor asked for, if they named a moment.
  const [remOpen, setRemOpen] = useState(false);
  const [remOccasion, setRemOccasion] = useState("");
  const [remWhen, setRemWhen] = useState("");
  const [remAmount, setRemAmount] = useState("");
  // When to be warned. Defaults to the temple's own setting once config loads;
  // until then, the wider default, so a caller who opens the reminder box in
  // the first second after a refresh does not silently get something narrower.
  const [remAlerts, setRemAlerts] = useState<number[]>(DEFAULT_ALERTS);
  // What they gave, when the outcome is that they gave. Without this the
  // conversion was recorded with no figure at all, and every report showed a
  // donation taken on the call as a conversion worth nothing.
  const [donatedAmount, setDonatedAmount] = useState("");

  // What was just logged, so a misclick is one keystroke away from being fixed
  // rather than a trip to the lead page.
  const [lastCall, setLastCall] = useState<{ lead: Lead; activityId: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [shortcutsOn, setShortcutsOn] = useState(true);

  const noteRef = useRef<HTMLTextAreaElement>(null);
  const lead = queue[0] ?? null;

  // Reminders and conversions, from the one shared poll. On this screen they
  // cannot live in a bell in the corner: a caller mid-run is looking at the
  // outcome buttons, not the header, and a reminder they scroll past is a
  // promise broken.
  const { alerts, conversions, dueCount, dismissAlert, dismissConversions } = useCallingAlerts();

  // Phone or desk? A tel: link opens the dialler on a touch device and usually
  // does nothing on a desktop, so the primary button changes accordingly
  // instead of both being offered and one of them quietly failing.
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    setIsTouch(typeof window !== "undefined" && window.matchMedia("(hover: none) and (pointer: coarse)").matches);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: "25" });
      if (listId) qs.set("list_id", listId);

      const [q, cfg, sess] = await Promise.all([
        apiClient.get<{ leads: Lead[]; to_call: number; list: { id: string; name: string } | null }>(
          `/api/crm/queue?${qs}`
        ),
        apiClient.get<{ dispositions: Disposition[]; settings?: Record<string, unknown> }>("/api/crm/config"),
        // The run's own tally, so reopening the page mid-shift shows the real
        // total rather than restarting the count at zero.
        apiClient
          .get<{ session: { id: string; calls_logged: number; connected: number } | null }>(
            "/api/crm/sessions/current"
          )
          .catch(() => ({ session: null })),
      ]);

      setQueue(q.leads);
      setToCall(q.to_call);
      setListName(q.list?.name ?? null);
      setDispositions(cfg.dispositions);
      // The temple's default alert times, so a promise taken mid-call warns
      // whoever set it up expects - not a default baked into this screen.
      const fromSettings = cfg.settings?.reminder_lead_times;
      if (Array.isArray(fromSettings) && fromSettings.length) {
        setRemAlerts(cleanAlerts(fromSettings.map(Number)));
      }
      if (sess.session && sess.session.id === sessionId) {
        setDone(sess.session.calls_logged);
        setConnectedCount(sess.session.connected);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the queue");
    } finally {
      setLoading(false);
    }
  }, [listId, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const reset = () => {
    setNote("");
    setFollowUp(null);
    setCustomDate("");
    setDuration("");
    setShowMore(false);
    setRemOpen(false);
    setRemOccasion("");
    setRemWhen("");
    setRemAmount("");
    setDonatedAmount("");
    setCopied(false);
  };

  const logCall = useCallback(
    async (d: Disposition) => {
      if (!lead || saving) return;
      setSaving(true);
      setError(null);
      try {
        const res = await apiClient.post<{ activity: { id: string } }>(`/api/crm/leads/${lead.id}/call`, {
          session_id: sessionId ?? undefined,
          disposition: d.slug,
          note: note.trim() || undefined,
          duration_seconds: duration ? Number(duration) * 60 : undefined,
          // The picker gives a bare `YYYY-MM-DD`, which `new Date()` reads as
          // UTC midnight - so the callback was landing at 05:30 on the chosen
          // morning. 10am IST, the same hour the quick-pick buttons book,
          // because a callback is a time to ring somebody.
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
        });

        setDone((n) => n + 1);
        setToCall((n) => Math.max(0, n - 1));
        if (d.counts_connected) setConnectedCount((n) => n + 1);
        setLastCall({ lead, activityId: res.activity.id, label: d.label });

        // Drop this lead and move on. The rest of the queue is already loaded,
        // so the next person appears with no wait - the whole reason for
        // fetching 25 at a time rather than one.
        setQueue((q) => q.slice(1));
        reset();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not log that call");
      } finally {
        setSaving(false);
      }
    },
    [lead, saving, sessionId, note, duration, followUp, customDate, remWhen, remOccasion, remAmount, remAlerts, donatedAmount]
  );

  // Refill when the loaded batch runs low, so the caller never hits a spinner
  // mid-run.
  useEffect(() => {
    if (!loading && queue.length > 0 && queue.length <= 2) void load();
  }, [queue.length, loading, load]);

  /**
   * Undo the last logged call.
   *
   * Not cosmetic: the outcome buttons sit close together and are hit at speed,
   * so a misclick happens several times a shift. Without this the caller has to
   * remember the name, find the lead, correct the stage and delete the activity
   * - four steps for a slip - so in practice they leave it wrong, and the
   * reports quietly fill with calls that did not go the way they say.
   */
  const undoLast = useCallback(async () => {
    if (!lastCall) return;
    try {
      await apiClient.delete(`/api/crm/activities/${lastCall.activityId}`);
      setQueue((q) => [lastCall.lead, ...q]);
      setDone((n) => Math.max(0, n - 1));
      // Put it back on the remaining count too — an undone call is a call that
      // still has to be made, and leaving the number down by one would have the
      // list quietly shrink every time somebody corrected a mis-tap.
      setToCall((n) => n + 1);
      setLastCall(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not undo that");
    }
  }, [lastCall]);

  // STOPPING AND PAUSING ARE DIFFERENT THINGS
  //
  // Ending a run is what makes tomorrow's screen offer a fresh start rather
  // than the list somebody was halfway through. So a caller going to lunch
  // must not end anything - the run stays open, marked as stepped-away, and
  // "where you left off" still finds it.
  //
  // Both leave the screen, because in both cases the caller is going. The
  // difference is only in what they come back to.
  async function leave(how: "pause" | "end", note?: string) {
    if (!sessionId) return router.push("/calling/start");
    try {
      await apiClient.post(`/api/crm/sessions/${sessionId}/${how}`, note ? { note } : {});
    } catch {
      // Already settled elsewhere, most likely in another tab. Either way the
      // caller asked to leave, so leaving is the right thing to do.
    }
    router.push("/calling/start");
  }


  async function copyNumber() {
    if (!lead) return;
    try {
      await navigator.clipboard.writeText(lead.phone);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked outside a secure context; selecting the number by
      // hand still works, and the caller can see it.
    }
  }

  const connected = useMemo(() => dispositions.filter((d) => d.counts_connected), [dispositions]);
  const unanswered = useMemo(() => dispositions.filter((d) => !d.counts_connected), [dispositions]);
  // Numbered in the order shown, so the label on a button matches the key.
  const numbered = useMemo(() => [...connected, ...unanswered], [connected, unanswered]);

  /**
   * Keyboard shortcuts.
   *
   * The difference between a good hour and a tiring one. A caller with the
   * phone in one hand has one hand for the computer, and reaching for a mouse
   * sixty times an hour is most of the fatigue in this job. Number keys pick an
   * outcome, N jumps to the note, C copies the number, S skips, U undoes.
   *
   * Suppressed whenever focus is in a text field, or the first letter of a
   * donor's name would trigger an outcome mid-sentence.
   */
  useEffect(() => {
    if (!shortcutsOn) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) {
        if (e.key === "Escape") el?.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key >= "1" && e.key <= "9") {
        const d = numbered[Number(e.key) - 1];
        if (d) { e.preventDefault(); void logCall(d); }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "n") { e.preventDefault(); noteRef.current?.focus(); }
      else if (k === "c") { e.preventDefault(); void copyNumber(); }
      else if (k === "s") { e.preventDefault(); setQueue((q) => q.slice(1)); reset(); }
      else if (k === "u") { e.preventDefault(); void undoLast(); }
      else if (k === "r") { e.preventDefault(); setRemOpen(true); }
      else if (k === "w") {
        // The send button is a real button in the DOM, so clicking it keeps
        // one code path rather than duplicating the send logic for the
        // keyboard - and it cannot drift out of step with the mouse.
        e.preventDefault();
        (document.querySelector('[data-send-whatsapp]') as HTMLButtonElement | null)?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutsOn, numbered, logCall, undoLast]);

  const history = useMemo(() => {
    if (!lead) return null;
    const count = lead.donation_count ?? 0;
    if (!lead.person_id || !count) return null;
    return { count, total: Number(lead.total_donated ?? 0), last: lead.last_donation_at };
  }, [lead]);

  return (
    <div className="max-w-4xl">
      <PageHeader
        eyebrow="Calling"
        title={listName ?? "Calling"}
        subtitle={
          done > 0
            ? `${done} logged · ${connectedCount} got through · ${number(toCall)} still to call`
            : `${number(toCall)} to call`
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {/* Finishing is a real action, not just closing the tab: it ends
                the run so tomorrow's screen offers a fresh start rather than
                a stale "where you left off" from three weeks ago. */}
            {sessionId && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => void leave("pause")}
                  title="Keep your place. This list will be waiting when you come back, today or tomorrow."
                >
                  Pause
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void leave("end")}
                  title="Done with this list for today. Tomorrow you start fresh."
                >
                  Stop for today
                </Button>
              </>
            )}
            <Link href="/calling/start" className={buttonSecondary}>
              Switch list
            </Link>
            <Link href="/calling/reminders" className={buttonSecondary}>
              Reminders
            </Link>
            <Button variant="secondary" icon="refresh" onClick={() => void load()}>
              Refresh queue
            </Button>
          </div>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {/* ------------------------------------------- a lead has just donated */}
      {conversions.map((c) => (
        <Alert key={c.id} tone="good">
          <p>
            <span className="font-semibold">{c.name || c.phone}</span> donated
            {c.converted_amount ? <> {currency(Number(c.converted_amount))}</> : null}
            {c.purpose ? <span> — {c.purpose}</span> : null}
            <span className="opacity-80">
              {" "}
              · {c.converted_via === "auto" ? "arrived on the site" : "recorded by hand"}
            </span>
          </p>
          {/* The buttons sit under the sentence rather than beside it: at the
              width of a phone a row of actions next to two lines of text has
              nowhere to go but off the side of the screen. */}
          <div className="mt-2 flex flex-wrap gap-2">
            <Link href={`/leads/${c.id}`} className={buttonPrimary}>
              Open
            </Link>
            <Button variant="secondary" onClick={() => void dismissConversions([c.id])}>
              Got it
            </Button>
          </div>
        </Alert>
      ))}

      {/* -------------------------------------------- a reminder has come due */}
      {alerts.map((a) => (
        <Alert
          key={a.id + a.due_at}
          tone="warn"
          title={a.occasion ? `${a.lead_name || a.lead_phone} · ${a.occasion}` : a.lead_name || a.lead_phone}
        >
          <p>{a.title}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <LinkButton href={`tel:+91${a.lead_phone}`} variant="primary" icon="phone" className="tabular-nums">
              Call {a.lead_phone}
            </LinkButton>
            <Button
              variant="secondary"
              onClick={() => void apiClient.put(`/api/crm/reminders/${a.id}`, { action: "snooze", minutes: 60 }).then(() => dismissAlert(a.id))}
            >
              In an hour
            </Button>
            <Button
              variant="secondary"
              icon="check"
              onClick={() => void apiClient.put(`/api/crm/reminders/${a.id}`, { action: "done" }).then(() => dismissAlert(a.id))}
            >
              Done
            </Button>
          </div>
        </Alert>
      ))}

      {/* Nothing has fired yet, but something is owed today. Quieter than an
          alert, because it is not interrupting - just refusing to let a caller
          finish a run unaware that a promise falls due. */}
      {!alerts.length && dueCount > 0 && (
        <Alert tone="info">
          {/* The link fills the banner rather than sitting at the end of the
              sentence, so the whole strip is the tap target on a phone. */}
          <Link href="/calling/reminders" className="flex items-center justify-between gap-3">
            <span>
              {dueCount} reminder{dueCount === 1 ? "" : "s"} due today or overdue
            </span>
            <span className="inline-flex flex-none items-center gap-1 font-medium">
              See them
              <Icon name="arrowRight" size={13} />
            </span>
          </Link>
        </Alert>
      )}

      {/* Undo sits above the fold, because a misclick is noticed instantly and
          the fix has to be within reach at that moment. */}
      {lastCall && (
        <Alert
          tone="info"
          action={
            <Button variant="secondary" icon="refresh" onClick={() => void undoLast()}>
              Undo
              <kbd className="ml-1 text-2xs opacity-60">U</kbd>
            </Button>
          }
        >
          Logged <span className="font-medium">{lastCall.label}</span> for{" "}
          {lastCall.lead.name || lastCall.lead.phone}
        </Alert>
      )}

      {loading && !lead && (
        <Card>
          <div className="space-y-3">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-24 w-full" rounded="rounded-card" />
          </div>
        </Card>
      )}

      {!loading && !lead && (
        <Card padded={false}>
          <EmptyState
            icon="checkCircle"
            title="Nothing left to call"
            message={
              done > 0
                ? `You logged ${done} call${done === 1 ? "" : "s"}${listName ? ` on ${listName}` : ""}. Everything here is either done or scheduled for later.`
                : listName
                ? `Nothing in ${listName} is due right now. Another list may have work waiting.`
                : "No leads are waiting for you. Add some from the leads screen, or pull a list out of your existing donors."
            }
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {sessionId && (
                  <Button size="lg" onClick={() => void leave("end")}>
                    Finish and pick another list
                  </Button>
                )}
                <Link href="/leads" className={buttonSecondary}>
                  Go to leads
                </Link>
              </div>
            }
          />
        </Card>
      )}

      {lead && (
        <div className="space-y-4">
          {/* -------------------------------------------------- who to call */}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-xl font-semibold text-ink">
                    {lead.name || "Name not known"}
                  </h2>
                  {lead.status_label && <Badge tone="info">{lead.status_label}</Badge>}
                  {lead.call_attempts > 0 && (
                    <Badge tone={lead.call_attempts >= 4 ? "warn" : "neutral"}>
                      {lead.call_attempts} attempt{lead.call_attempts === 1 ? "" : "s"}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-ink-muted">
                  {[lead.city, lead.email].filter(Boolean).join(" · ") || "No other details"}
                </p>
                {/* The preacher who brought this donor in. A caller who can
                    open with "Jagat Tarini Mataji gave us your name" is not
                    making a cold call, which is why this sits with the name
                    rather than buried in the record. */}
                {lead.preacher_code && (
                  <p className="mt-1 text-sm text-ink-soft">
                    <span className="text-ink-muted">Known to:</span>{" "}
                    <span className="font-medium">{lead.preacher_name || lead.preacher_code}</span>
                  </p>
                )}
              </div>

              {/* The number, big. On a phone it dials; at a desk it copies.
                  Full width below the name at phone size, because this is the
                  one control on the screen that must never be missed or
                  mis-tapped. */}
              <div className="flex w-full flex-col items-stretch gap-1.5 sm:w-auto sm:items-end">
                {isTouch ? (
                  <LinkButton
                    href={`tel:+91${lead.phone}`}
                    variant="primary"
                    size="lg"
                    icon="phone"
                    className="tabular-nums text-lg"
                  >
                    {lead.phone}
                  </LinkButton>
                ) : (
                  <Button
                    size="lg"
                    icon={copied ? "check" : "copy"}
                    onClick={() => void copyNumber()}
                    title="Copy the number so you can dial it on your handset"
                    className="tabular-nums text-lg"
                  >
                    {lead.phone}
                  </Button>
                )}
                <span className="text-2xs text-ink-faint sm:text-right">
                  {isTouch ? "Tap to dial" : copied ? "Copied — dial it on your handset" : "Click to copy · C"}
                </span>
              </div>
            </div>

            {/* ------------------------------- what they have donated before */}
            {history ? (
              <div className="mt-4 rounded-card bg-brand-50 px-4 py-3">
                <p className="text-sm text-ink-soft">
                  <span className="font-semibold">{currency(history.total)}</span> donated across{" "}
                  <span className="font-semibold">{history.count}</span> donation
                  {history.count === 1 ? "" : "s"}
                  {history.last && <> · last one {relativeDate(history.last)}</>}
                </p>
                {lead.person_id && (
                  <Link
                    href={`/people/${lead.person_id}`}
                    className="mt-0.5 inline-block text-xs font-medium text-brand-700 hover:underline"
                  >
                    See their full history
                  </Link>
                )}
              </div>
            ) : lead.external_total_donated ? (
              // From the office's own sheets, not from DRM. Shown because a
              // caller ringing someone who has given three lakhs needs to know
              // that; kept out of every DRM total because it is not money the
              // calling raised.
              <div className="mt-4 rounded-card bg-brand-50 px-4 py-3">
                <p className="text-sm text-ink-soft">
                  <span className="font-semibold">{currency(Number(lead.external_total_donated))}</span> on record in
                  the temple accounts
                  {Number(lead.external_account_count) > 1 && (
                    <span className="text-ink-muted"> across {lead.external_account_count} accounts</span>
                  )}
                  {lead.external_last_donation_at && <> · last in {istYear(lead.external_last_donation_at)}</>}
                </p>
                <p className="mt-0.5 text-2xs text-ink-muted">
                  From {lead.external_source || "an uploaded sheet"} — not counted in DRM&apos;s own totals.
                </p>
              </div>
            ) : (
              <p className="mt-4 rounded-card bg-sunken px-4 py-3 text-sm text-ink-soft">
                No donation on record — this is a first conversation.
                {lead.source_detail && <span className="text-ink-muted"> From: {lead.source_detail}</span>}
              </p>
            )}

            {/* Why this lead is up now, and what was last said. */}
            {(lead.follow_up_note || lead.remarks || lead.next_follow_up_at) && (
              <div className="mt-3 space-y-1 text-sm">
                {lead.next_follow_up_at && (
                  <p className="text-ink-soft">
                    <span className="text-ink-muted">Promised callback:</span> {dueLabel(lead.next_follow_up_at)}
                    {lead.follow_up_note && <> — “{lead.follow_up_note}”</>}
                  </p>
                )}
                {lead.remarks && (
                  <p className="text-ink-soft">
                    <span className="text-ink-muted">Last note:</span> “{lead.remarks}”
                  </p>
                )}
              </div>
            )}

            {lead.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {lead.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            )}
          </Card>

          {/* --------------------------------------------- send them the link
              Sits between who-to-call and the outcome buttons on purpose: the
              link is sent DURING the conversation, while the donor is still on
              the line, not after the call has been written up. */}
          <Card>
            <SendLink
              leadId={lead.id}
              leadName={lead.name}
              expectedAmount={lead.expected_amount}
              compact
            />
            <p className="mt-2 text-2xs text-ink-faint">
              Opens WhatsApp on this computer in their chat, with the message ready. Press send there.
            </p>

            {/* The QR sits with the link rather than in its own card: from the
                caller's side "send them something" is one decision, and a
                donor who asks for a QR has usually just been offered a link. */}
            <div className="mt-3 border-t border-line-soft pt-3">
              <SendQr
                leadId={lead.id}
                leadName={lead.name}
                expectedAmount={lead.expected_amount}
                sessionId={sessionId}
              />
            </div>
          </Card>

          {/* ------------------------------------------------ log the outcome */}
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink">How did it go?</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  One tap — or the number key beside it — logs the call and brings up the next person.
                </p>
              </div>
              {/* On/off rather than a link that says its own state: "shortcuts
                  on" as a button left it ambiguous whether the words described
                  the setting or what pressing it would do. */}
              <div className="flex flex-none items-center gap-2">
                <span className="hidden text-2xs text-ink-muted sm:inline">Shortcuts</span>
                <SegmentedControl
                  size="sm"
                  options={[
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                  ]}
                  value={shortcutsOn ? "on" : "off"}
                  onChange={(v) => setShortcutsOn(v === "on")}
                />
              </div>
            </div>

            {/* How much, when the outcome is that they gave.
                Optional and inline rather than a dialog: a caller has somebody
                on the line. Left blank it falls back to whatever the lead was
                expected to give, and the conversion is still recorded - a
                donation with no figure beats a donation DRM denies happened,
                which is what used to occur. */}
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <Field label="If they gave on this call, how much?" htmlFor="donated-amount">
                {/* The box is narrow, the label is not: sizing the Field
                    itself would wrap "how much?" onto a third line at phone
                    width, so the width goes on the input's own box. */}
                <div className="w-40">
                  <Input
                    id="donated-amount"
                    value={donatedAmount}
                    onChange={(e) => setDonatedAmount(e.target.value.replace(/\D/g, ""))}
                    placeholder="₹ optional"
                    inputMode="numeric"
                    className="tabular-nums"
                  />
                </div>
              </Field>
              {!!donatedAmount && (
                <span className="pb-2.5 text-2xs text-good">
                  recorded when you pick an outcome that means they donated
                </span>
              )}
            </div>

            <div className="mt-4">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">Got through</p>
              {/* The large size, deliberately: these are the buttons the whole
                  screen exists for, and they are pressed with a thumb while
                  the caller is still holding the phone. */}
              <div className="flex flex-wrap gap-2">
                {connected.map((d, i) => (
                  <Button
                    key={d.slug}
                    size="lg"
                    variant={variantFor(d)}
                    disabled={saving}
                    onClick={() => void logCall(d)}
                  >
                    {d.label}
                    {shortcutsOn && i < 9 && (
                      <kbd className="ml-2 text-2xs font-normal opacity-60">{i + 1}</kbd>
                    )}
                  </Button>
                ))}
              </div>
            </div>

            <div className="mt-4">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
                Didn&apos;t get through
              </p>
              <div className="flex flex-wrap gap-2">
                {unanswered.map((d, i) => {
                  const n = connected.length + i + 1;
                  return (
                    <Button
                      key={d.slug}
                      size="lg"
                      variant="secondary"
                      disabled={saving}
                      onClick={() => void logCall(d)}
                    >
                      {d.label}
                      {shortcutsOn && n <= 9 && <kbd className="ml-2 text-2xs font-normal opacity-60">{n}</kbd>}
                    </Button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-ink-muted">
                These come back round automatically — you don&apos;t need to set a date.
              </p>
            </div>

            {/* ------------------------------------------ the optional extras */}
            <div className="mt-5 space-y-3 border-t border-line-soft pt-4">
              {/* The raw element and the shared class string rather than
                  <Textarea>, because the N shortcut focuses this box through a
                  ref and the component does not take one. Same styling either
                  way - textareaClass is what <Textarea> is built from. */}
              <textarea
                ref={noteRef}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="What they said (optional) — press N"
                className={`${textareaClass} resize-y`}
              />

              <div>
                <p className="mb-1.5 text-xs text-ink-muted">Call back on:</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {WHEN_PRESETS.map((p) => {
                    const iso = atTenAm(p.days);
                    const active = followUp === iso;
                    return (
                      <button
                        key={p.label}
                        type="button"
                        aria-pressed={active}
                        onClick={() => {
                          setFollowUp(active ? null : iso);
                          setCustomDate("");
                        }}
                        className={chipClass(active)}
                      >
                        {active && <Icon name="check" size={11} />}
                        {p.label}
                      </button>
                    );
                  })}
                  {/* Boxed rather than given a width class: the shared input
                      style is w-full, and a second width utility beside it is
                      a coin-toss over which one CSS applies. */}
                  <div className="w-44">
                    <Input
                      type="date"
                      value={customDate}
                      onChange={(e) => {
                        setCustomDate(e.target.value);
                        setFollowUp(null);
                      }}
                      aria-label="Call back on another date"
                    />
                  </div>
                </div>
              </div>

              {/* ------------------------------------------ the reminder box */}
              {remOpen ? (
                <div className="rounded-card border border-brand-200 bg-brand-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-ink-soft">They named a moment</p>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="x"
                      onClick={() => { setRemOpen(false); setRemWhen(""); }}
                    >
                      Remove
                    </Button>
                  </div>
                  <p className="mt-0.5 text-2xs text-ink-muted">
                    A promise the donor made at a moment they chose. Pick when it should reach you.
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <Input
                      value={remOccasion}
                      onChange={(e) => setRemOccasion(e.target.value)}
                      placeholder="Occasion — Govardhan Puja"
                      aria-label="Occasion"
                    />
                    <Input
                      type="datetime-local"
                      value={remWhen}
                      onChange={(e) => setRemWhen(e.target.value)}
                      aria-label="When to remind you"
                    />
                    <Input
                      type="number"
                      value={remAmount}
                      onChange={(e) => setRemAmount(e.target.value)}
                      placeholder="₹ they said"
                      aria-label="Amount they said"
                      className="tabular-nums"
                    />
                  </div>
                  <div className="mt-2">
                    <AlertPicker
                      value={remAlerts}
                      onChange={setRemAlerts}
                      options={ALERT_OPTIONS}
                      emptyWarning="Nothing ticked means nothing will alert you — it will only sit on the reminders board."
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
                        onClick={() => setRemWhen(istInput(p.d, p.h))}
                        className={chipClass(remWhen === istInput(p.d, p.h))}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                /* A plain button rather than <Button>: every button in the
                   system is whitespace-nowrap so a row of them stays aligned,
                   and this label is a sentence - at the width of a phone it
                   has to be allowed to wrap rather than push the card
                   sideways. */
                <button
                  type="button"
                  onClick={() => setRemOpen(true)}
                  className="inline-flex items-start gap-1.5 text-left text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  <Icon name="bell" size={13} className="mt-0.5" />
                  <span>
                    They said they&apos;ll donate at a particular time — remind me
                    <kbd className="ml-1 text-2xs text-ink-faint">R</kbd>
                  </span>
                </button>
              )}

              {showMore ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Roughly how long, in minutes" htmlFor="call-minutes">
                    <div className="w-28">
                      <Input
                        id="call-minutes"
                        type="number"
                        min={0}
                        value={duration}
                        onChange={(e) => setDuration(e.target.value)}
                        className="tabular-nums"
                      />
                    </div>
                  </Field>
                  <span className="pb-2.5 text-xs text-ink-faint">Self-reported — nothing is timing the call</span>
                </div>
              ) : (
                <Button size="sm" variant="ghost" icon="clock" onClick={() => setShowMore(true)}>
                  Add call length
                </Button>
              )}
            </div>
          </Card>

          {/* -------------------------------------------------------- skip it */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="secondary"
              iconRight="arrowRight"
              onClick={() => {
                setQueue((q) => q.slice(1));
                reset();
              }}
            >
              Skip for now
              <kbd className="ml-1 text-2xs opacity-60">S</kbd>
            </Button>
            <Link href={`/leads/${lead.id}`} className={buttonSecondary}>
              Open full record
            </Link>
          </div>

          {/* Who is coming up, so the caller can see the run ahead of them. */}
          {queue.length > 1 && (
            <Card>
              <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">Up next</p>
              <ul className="divide-y divide-line-soft">
                {queue.slice(1, 6).map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="truncate text-ink-soft">{l.name || l.phone}</span>
                    <span className="whitespace-nowrap text-xs text-ink-faint">
                      {l.next_follow_up_at ? dueLabel(l.next_follow_up_at) : "never called"}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
