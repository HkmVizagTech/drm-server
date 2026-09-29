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
// THE REMINDER BOX
// "I'll give on Govardhan Puja evening" is said DURING the call. If capturing
// it means hanging up, finding the lead again and opening a separate form, it
// gets captured maybe a third of the time. So it is a box right under the
// outcome buttons, and it saves with the call in the same request.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, dueLabel, relativeDate } from "@/lib/format";
import { Badge, Card, EmptyState, PageHeader, buttonPrimary, buttonSecondary, inputClass } from "@/components/ui";
import { SendLink } from "@/components/send-link";

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
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  // 10am rather than the current time of day: a callback booked at 9pm should
  // not come due at 9pm.
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
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
function toneFor(d: Disposition): string {
  const closes = d.suggests_status === "not_interested" || d.suggests_status === "invalid" || d.suggests_status === "dnc";
  if (closes) return "border-slate-200 bg-white text-slate-600 hover:bg-slate-50";
  if (d.counts_connected) return "border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100";
  return "border-slate-200 bg-white text-slate-700 hover:bg-slate-50";
}

// Local datetime formatted for <input type="datetime-local">, which refuses an
// ISO string with a timezone on it.
function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CallingQueuePage() {
  const [queue, setQueue] = useState<Lead[]>([]);
  const [dispositions, setDispositions] = useState<Disposition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Session tally. Not vanity: a caller doing a two-hour run wants to know
  // where they are in it, and it is the only feedback the screen gives for
  // work that otherwise disappears the moment it is logged.
  const [done, setDone] = useState(0);
  const [connectedCount, setConnectedCount] = useState(0);

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

  // What was just logged, so a misclick is one keystroke away from being fixed
  // rather than a trip to the lead page.
  const [lastCall, setLastCall] = useState<{ lead: Lead; activityId: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [shortcutsOn, setShortcutsOn] = useState(true);

  const noteRef = useRef<HTMLTextAreaElement>(null);
  const lead = queue[0] ?? null;

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
      const [q, cfg] = await Promise.all([
        apiClient.get<{ leads: Lead[] }>("/api/crm/queue?limit=25"),
        apiClient.get<{ dispositions: Disposition[] }>("/api/crm/config"),
      ]);
      setQueue(q.leads);
      setDispositions(cfg.dispositions);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the queue");
    } finally {
      setLoading(false);
    }
  }, []);

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
    setCopied(false);
  };

  const logCall = useCallback(
    async (d: Disposition) => {
      if (!lead || saving) return;
      setSaving(true);
      setError(null);
      try {
        const res = await apiClient.post<{ activity: { id: string } }>(`/api/crm/leads/${lead.id}/call`, {
          disposition: d.slug,
          note: note.trim() || undefined,
          duration_seconds: duration ? Number(duration) * 60 : undefined,
          next_follow_up_at: followUp ?? (customDate ? new Date(customDate).toISOString() : undefined),
          reminder: remWhen
            ? {
                occasion: remOccasion.trim() || undefined,
                due_at: new Date(remWhen).toISOString(),
                expected_amount: remAmount ? Number(remAmount) : undefined,
                note: note.trim() || undefined,
              }
            : undefined,
        });

        setDone((n) => n + 1);
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
    [lead, saving, note, duration, followUp, customDate, remWhen, remOccasion, remAmount]
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
      setLastCall(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not undo that");
    }
  }, [lastCall]);

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
        title="Calling"
        subtitle={
          done > 0
            ? `${done} logged this session · ${connectedCount} got through · ${queue.length} waiting`
            : `${queue.length} in the queue`
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/calling/reminders" className={buttonSecondary}>
              Reminders
            </Link>
            <Link href="/leads" className={buttonSecondary}>
              All leads
            </Link>
            <button onClick={() => void load()} className={buttonSecondary}>
              Refresh queue
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {/* Undo sits above the fold, because a misclick is noticed instantly and
          the fix has to be within reach at that moment. */}
      {lastCall && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--line-soft)] bg-white px-4 py-2.5">
          <p className="text-sm text-slate-600">
            Logged <span className="font-medium text-slate-900">{lastCall.label}</span> for{" "}
            {lastCall.lead.name || lastCall.lead.phone}
          </p>
          <button onClick={() => void undoLast()} className="text-sm font-medium text-[var(--accent)] hover:underline">
            Undo <kbd className="ml-1 text-[10px] text-slate-400">U</kbd>
          </button>
        </div>
      )}

      {loading && !lead && (
        <Card>
          <div className="space-y-3">
            <div className="h-6 w-48 rounded bg-slate-100 animate-pulse" />
            <div className="h-4 w-64 rounded bg-slate-100 animate-pulse" />
            <div className="h-24 rounded bg-slate-100 animate-pulse" />
          </div>
        </Card>
      )}

      {!loading && !lead && (
        <Card padded={false}>
          <EmptyState
            title="Nothing left to call"
            message={
              done > 0
                ? `You logged ${done} call${done === 1 ? "" : "s"}. Everything assigned to you is either done or scheduled for later.`
                : "No leads are waiting for you. Add some from the leads screen, or pull a list out of your existing donors."
            }
            action={
              <Link href="/leads" className={buttonPrimary}>
                Go to leads
              </Link>
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
                  <h2 className="text-xl font-semibold text-slate-900 truncate">
                    {lead.name || "Name not known"}
                  </h2>
                  {lead.status_label && <Badge tone="info">{lead.status_label}</Badge>}
                  {lead.call_attempts > 0 && (
                    <Badge tone={lead.call_attempts >= 4 ? "warn" : "neutral"}>
                      {lead.call_attempts} attempt{lead.call_attempts === 1 ? "" : "s"}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  {[lead.city, lead.email].filter(Boolean).join(" · ") || "No other details"}
                </p>
              </div>

              {/* The number, big. On a phone it dials; at a desk it copies. */}
              <div className="flex flex-col items-end gap-1.5">
                {isTouch ? (
                  <a
                    href={`tel:+91${lead.phone}`}
                    className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-5 py-3 text-white font-semibold tabular-nums text-lg hover:opacity-90 transition-opacity"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
                    </svg>
                    {lead.phone}
                  </a>
                ) : (
                  <button
                    onClick={() => void copyNumber()}
                    title="Copy the number so you can dial it on your handset"
                    className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-5 py-3 text-white font-semibold tabular-nums text-lg hover:opacity-90 transition-opacity"
                  >
                    {copied ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="w-5 h-5">
                        <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5">
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M5 15V5a2 2 0 0 1 2-2h10" strokeLinecap="round" />
                      </svg>
                    )}
                    {lead.phone}
                  </button>
                )}
                <span className="text-[11px] text-slate-400">
                  {isTouch ? "Tap to dial" : copied ? "Copied — dial it on your handset" : "Click to copy · C"}
                </span>
              </div>
            </div>

            {/* ------------------------------- what they have donated before */}
            {history ? (
              <div className="mt-4 rounded-lg bg-[var(--accent-wash)] px-4 py-3">
                <p className="text-sm text-slate-800">
                  <span className="font-semibold">{currency(history.total)}</span> donated across{" "}
                  <span className="font-semibold">{history.count}</span> donation
                  {history.count === 1 ? "" : "s"}
                  {history.last && <> · last one {relativeDate(history.last)}</>}
                </p>
                {lead.person_id && (
                  <Link
                    href={`/people/${lead.person_id}`}
                    className="text-xs text-[var(--accent)] hover:underline mt-0.5 inline-block"
                  >
                    See their full history
                  </Link>
                )}
              </div>
            ) : (
              <p className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
                No donation on record — this is a first conversation.
                {lead.source_detail && <span className="text-slate-500"> From: {lead.source_detail}</span>}
              </p>
            )}

            {/* Why this lead is up now, and what was last said. */}
            {(lead.follow_up_note || lead.remarks || lead.next_follow_up_at) && (
              <div className="mt-3 space-y-1 text-sm">
                {lead.next_follow_up_at && (
                  <p className="text-slate-700">
                    <span className="text-slate-500">Promised callback:</span> {dueLabel(lead.next_follow_up_at)}
                    {lead.follow_up_note && <> — “{lead.follow_up_note}”</>}
                  </p>
                )}
                {lead.remarks && (
                  <p className="text-slate-700">
                    <span className="text-slate-500">Last note:</span> “{lead.remarks}”
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
            <p className="mt-2 text-[11px] text-slate-400">
              Opens WhatsApp on this computer in their chat, with the message ready. Press send there.
            </p>
          </Card>

          {/* ------------------------------------------------ log the outcome */}
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">How did it go?</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  One tap — or the number key beside it — logs the call and brings up the next person.
                </p>
              </div>
              <button
                onClick={() => setShortcutsOn((v) => !v)}
                title="Turn the keyboard shortcuts off if they get in the way"
                className="text-[11px] text-slate-400 hover:text-slate-600 whitespace-nowrap"
              >
                shortcuts {shortcutsOn ? "on" : "off"}
              </button>
            </div>

            <div className="mt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Got through</p>
              <div className="flex flex-wrap gap-2">
                {connected.map((d, i) => (
                  <button
                    key={d.slug}
                    disabled={saving}
                    onClick={() => void logCall(d)}
                    className={`rounded-lg border px-4 py-2.5 text-sm font-medium disabled:opacity-50 transition-colors ${toneFor(d)}`}
                  >
                    {d.label}
                    {shortcutsOn && i < 9 && (
                      <kbd className="ml-2 text-[10px] opacity-50 font-normal">{i + 1}</kbd>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                Didn&apos;t get through
              </p>
              <div className="flex flex-wrap gap-2">
                {unanswered.map((d, i) => {
                  const n = connected.length + i + 1;
                  return (
                    <button
                      key={d.slug}
                      disabled={saving}
                      onClick={() => void logCall(d)}
                      className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                    >
                      {d.label}
                      {shortcutsOn && n <= 9 && <kbd className="ml-2 text-[10px] opacity-50 font-normal">{n}</kbd>}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-slate-500">
                These come back round automatically — you don&apos;t need to set a date.
              </p>
            </div>

            {/* ------------------------------------------ the optional extras */}
            <div className="mt-5 border-t border-[var(--line-soft)] pt-4 space-y-3">
              <textarea
                ref={noteRef}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="What they said (optional) — press N"
                className={`${inputClass} w-full resize-y`}
              />

              <div>
                <p className="text-xs text-slate-500 mb-1.5">Call back on:</p>
                <div className="flex flex-wrap gap-1.5">
                  {WHEN_PRESETS.map((p) => {
                    const iso = atTenAm(p.days);
                    const active = followUp === iso;
                    return (
                      <button
                        key={p.label}
                        onClick={() => {
                          setFollowUp(active ? null : iso);
                          setCustomDate("");
                        }}
                        className={`rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors ${
                          active
                            ? "border-[var(--accent)] bg-[var(--accent-wash)] text-[var(--accent)]"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                  <input
                    type="date"
                    value={customDate}
                    onChange={(e) => {
                      setCustomDate(e.target.value);
                      setFollowUp(null);
                    }}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600"
                  />
                </div>
              </div>

              {/* ------------------------------------------ the reminder box */}
              {remOpen ? (
                <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-wash)]/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-800">They named a moment</p>
                    <button onClick={() => { setRemOpen(false); setRemWhen(""); }} className="text-xs text-slate-500 hover:text-slate-700">
                      Remove
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    You&apos;ll be alerted a day before, an hour before and fifteen minutes before.
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <input
                      value={remOccasion}
                      onChange={(e) => setRemOccasion(e.target.value)}
                      placeholder="Occasion — Govardhan Puja"
                      className={`${inputClass} w-full text-sm`}
                    />
                    <input
                      type="datetime-local"
                      value={remWhen}
                      onChange={(e) => setRemWhen(e.target.value)}
                      className={`${inputClass} w-full text-sm`}
                    />
                    <input
                      type="number"
                      value={remAmount}
                      onChange={(e) => setRemAmount(e.target.value)}
                      placeholder="₹ they said"
                      className={`${inputClass} w-full text-sm`}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {[
                      { label: "This evening 6pm", h: 18, d: 0 },
                      { label: "Tomorrow 10am", h: 10, d: 1 },
                      { label: "Saturday 10am", h: 10, d: (6 - new Date().getDay() + 7) % 7 || 7 },
                    ].map((p) => (
                      <button
                        key={p.label}
                        onClick={() => {
                          const d = new Date();
                          d.setDate(d.getDate() + p.d);
                          d.setHours(p.h, 0, 0, 0);
                          setRemWhen(localInput(d));
                        }}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setRemOpen(true)}
                  className="text-xs text-[var(--accent)] hover:underline underline-offset-2"
                >
                  + They said they&apos;ll donate at a particular time — remind me <kbd className="text-[10px] text-slate-400">R</kbd>
                </button>
              )}

              {showMore ? (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-500">Roughly how long, in minutes</label>
                  <input
                    type="number"
                    min={0}
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-sm tabular-nums"
                  />
                  <span className="text-xs text-slate-400">Self-reported — nothing is timing the call</span>
                </div>
              ) : (
                <button
                  onClick={() => setShowMore(true)}
                  className="block text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2"
                >
                  Add call length
                </button>
              )}
            </div>
          </Card>

          {/* -------------------------------------------------------- skip it */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                setQueue((q) => q.slice(1));
                reset();
              }}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              Skip for now <kbd className="text-[10px] text-slate-400">S</kbd> →
            </button>
            <Link href={`/leads/${lead.id}`} className="text-sm text-[var(--accent)] hover:underline">
              Open full record
            </Link>
          </div>

          {/* Who is coming up, so the caller can see the run ahead of them. */}
          {queue.length > 1 && (
            <Card>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Up next</p>
              <ul className="divide-y divide-slate-100">
                {queue.slice(1, 6).map((l) => (
                  <li key={l.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                    <span className="truncate text-slate-700">{l.name || l.phone}</span>
                    <span className="text-xs text-slate-400 whitespace-nowrap">
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
