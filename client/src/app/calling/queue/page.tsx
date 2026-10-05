"use client";

// The call screen.
//
// A caller works through sixty of these in an hour, so the screen is built
// around one number: how many actions it takes to finish a call and get to the
// next person. Dial, talk, one tap for the outcome - and with "move on by
// itself" left on, that tap is also the move to the next person.
//
// THREE WAYS IN
//   ?session=<id>  a run: a list the caller chose on the start screen, in an
//                  order the SERVER keeps. Previous, Skip and Next move a
//                  position the server holds, so a refresh, a second phone or
//                  tomorrow morning all land on the same person. Nothing about
//                  the order lives in this tab any more - the old screen kept
//                  its own batch and refilled it endlessly, and every refresh
//                  quietly reshuffled who came next.
//   ?lead=<id>     one person, from a "Call" button anywhere else in DRM. The
//                  same card and the same outcome buttons, so a call made from
//                  the follow-ups board is logged exactly as one made in a run,
//                  instead of vanishing into a bare tel: link.
//   (nothing)      sends the caller to the run they were last in, or to the
//                  start screen to choose one.
//
// MOST OF THE PEOPLE READING THIS ARE HOLDING A PHONE
// Callers dial from their own handsets and come back to this tab to log the
// outcome. So the dial button is the first and biggest thing on the card, the
// outcome buttons are a thumb tall in two columns, and Previous / Next is a bar
// pinned to the bottom edge. Nothing scrolls sideways at 390px.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import { cleanAlerts } from "@/lib/reminders";
import {
  CALL_SCREEN,
  endRun,
  formatPhone,
  getRun,
  getRunItems,
  getRunSummary,
  heartbeatRun,
  moveRun,
  outcomeKeys,
  pauseRun,
  resumeRun,
  runHref,
  toCallLead,
  type CallLead,
  type Disposition,
  type RunListItem,
  type RunState,
  type RunSummary,
} from "@/lib/calling";
import {
  Alert,
  Button,
  Card,
  DropdownMenu,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  Skeleton,
  Toggle,
  buttonClass,
} from "@/components/ui";
import { toast } from "@/components/toast";
import { SendLink } from "@/components/send-link";
import { SendQr } from "@/components/send-qr";
import { LeadCard } from "@/components/calling/lead-card";
import { OutcomePanel, useCallForm } from "@/components/calling/outcome-panel";
import { UpNextList } from "@/components/calling/up-next";
import { RunSummaryCard } from "@/components/calling/run-summary";
import { ShortcutHelp } from "@/components/calling/shortcut-help";
import { CallBanners } from "@/components/calling/call-banners";
import { ContactEditor } from "@/components/calling/contact-editor";
import { NavBar, NavButton, RunHeader } from "@/components/calling/run-chrome";

/** How often the open screen tells the server the caller is still on this person. */
const HEARTBEAT_MS = 4 * 60_000;
const AUTO_ADVANCE_KEY = "drm.calling.autoAdvance";
const SHORTCUTS_KEY = "drm.calling.shortcuts";

type Move = "next" | "skip" | "prev" | "jump" | "revisit";

interface LastCall {
  activityId: string;
  label: string;
  name: string;
  leadId: string;
  /** Where they sit in the run, so Undo can take the caller back to them. */
  position: number | null;
}

/* ------------------------------------------------------------------ helpers */

/** A media query as live state - a phone turned sideways, a window resized. */
function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}

// Per-device preferences. Read once, when the screen opens; a private window
// or blocked storage simply gets the defaults.
function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writePref(key: string, on: boolean) {
  try {
    window.localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* the setting just won't survive a refresh */
  }
}

/** Only ever a path inside DRM - `back` arrives in the URL and must not send anyone off-site. */
function safeBack(raw: string | null): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

const errText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** "Stepped past Ravi — Rung by Arjun", so nobody wonders where Ravi went. */
function announcePassed(passed: RunState["passed"]) {
  if (!passed?.length) return;
  if (passed.length <= 2) {
    for (const p of passed) toast.info(`Stepped past ${p.name || "someone"} — ${p.reason}`);
  } else {
    toast.info(
      `Stepped past ${passed.length} people a colleague has`,
      passed
        .slice(0, 3)
        .map((p) => `${p.name || "someone"}: ${p.reason}`)
        .join(" · ")
    );
  }
}

/* --------------------------------------------------------------------- page */

// useSearchParams needs a Suspense boundary in this version of Next, so the
// screen is split: this wrapper is what prerenders, the rest reads the URL.
export default function CallScreenPage() {
  return (
    <Suspense fallback={<CallSkeleton />}>
      <CallScreenRouter />
    </Suspense>
  );
}

function CallSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-2 w-full" rounded="rounded-pill" />
      <Card>
        <Skeleton className="h-13 w-full" />
        <Skeleton className="mt-3 h-5 w-56" />
        <Skeleton className="mt-3 h-24 w-full" rounded="rounded-card" />
      </Card>
      <Card>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </Card>
    </div>
  );
}

function CallScreenRouter() {
  const params = useSearchParams();
  const sessionId = params.get("session");
  const leadId = params.get("lead");
  const back = safeBack(params.get("back"));

  // Keyed, so moving from one run (or one person) to another starts from a
  // clean screen rather than carrying a half-typed note across.
  if (sessionId) return <CallScreen key={`s:${sessionId}`} sessionId={sessionId} leadId={null} back={null} />;
  if (leadId) return <CallScreen key={`l:${leadId}`} sessionId={null} leadId={leadId} back={back} />;
  return <FindRun />;
}

/** No run named: the one they were last in, or the start screen. */
function FindRun() {
  const router = useRouter();
  useEffect(() => {
    apiClient
      .get<{ session: { id: string } | null }>("/api/crm/sessions/current")
      .then((r) => router.replace(r.session ? runHref(r.session.id) : "/calling/start"))
      .catch(() => router.replace("/calling/start"));
  }, [router]);
  return <CallSkeleton />;
}

/* ------------------------------------------------------------- the screen */

function CallScreen({
  sessionId,
  leadId,
  back,
}: {
  sessionId: string | null;
  leadId: string | null;
  back: string | null;
}) {
  const router = useRouter();
  const inRun = !!sessionId;
  const isTouch = useMedia("(hover: none) and (pointer: coarse)");
  const isDesktop = useMedia("(min-width: 1024px)");

  const [run, setRun] = useState<RunState | null>(null);
  const [single, setSingle] = useState<CallLead | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dispositions, setDispositions] = useState<Disposition[]>([]);

  const [saving, setSaving] = useState<string | null>(null);
  const [moving, setMoving] = useState<Move | "pause" | "resume" | "finish" | null>(null);
  const [jumping, setJumping] = useState<number | null>(null);
  const [lastCall, setLastCall] = useState<LastCall | null>(null);
  // One-person mode has no run item to remember the outcome on.
  const [singleLogged, setSingleLogged] = useState<string | null>(null);

  const [items, setItems] = useState<RunListItem[] | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [editing, setEditing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseNote, setPauseNote] = useState("");

  // Read in the initialiser. Nothing these drive is drawn until the run has
  // loaded - the first render is the skeleton everywhere - so a stored choice
  // cannot make a server render and the browser's first render disagree.
  const [autoAdvance, setAutoAdvance] = useState(() => readPref(AUTO_ADVANCE_KEY, true));
  const [shortcutsOn, setShortcutsOn] = useState(() => readPref(SHORTCUTS_KEY, true));

  const form = useCallForm();
  // The two parts of the form that never change identity, pulled out so the
  // callbacks below do not have to be rebuilt on every keystroke in the note.
  const { reset: resetForm, setDefaultAlerts } = form;
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLDivElement>(null);
  // The run as of the last answer from the server, for handlers that outlive
  // the render they were made in (an Undo pressed on a toast, say).
  const runRef = useRef<RunState | null>(null);

  const lead: CallLead | null = inRun ? (run?.lead ?? null) : single;
  const paused = !!run?.session?.paused_at;
  const finished = !!run?.finished;
  const ended = !!run?.session?.ended_at;

  const outcomeLabel = useCallback(
    (slug: string) => dispositions.find((d) => d.slug === slug)?.label ?? slug.replace(/_/g, " "),
    [dispositions]
  );
  const keys = useMemo(() => outcomeKeys(dispositions), [dispositions]);
  const byKey = useMemo(() => new Map([...keys.entries()].map(([slug, n]) => [n, slug])), [keys]);

  /* ---------------------------------------------------------- loading */

  /** Every answer about the run comes through here. */
  const applyRun = useCallback(
    (s: RunState) => {
      const before = runRef.current?.item?.position ?? null;
      runRef.current = s;
      setRun(s);
      // A new person on screen is a new conversation: the last donor's note
      // and amount must not ride along to this one.
      if ((s.item?.position ?? null) !== before) resetForm();
      if (!s.finished) setSummary(null);
      if (s.message) toast.info(s.message);
      announcePassed(s.passed);
    },
    [resetForm]
  );

  const reloadRun = useCallback(async () => {
    if (!sessionId) return;
    applyRun(await getRun(sessionId));
  }, [sessionId, applyRun]);

  const reloadSingle = useCallback(async () => {
    if (!leadId) return;
    const d = await apiClient.get<Parameters<typeof toCallLead>[0]>(`/api/crm/leads/${leadId}`);
    setSingle(toCallLead(d));
  }, [leadId]);

  useEffect(() => {
    // The fetch is started here and its answer applied in the callback, so
    // nothing sets state synchronously inside the effect itself.
    const first = sessionId
      ? getRun(sessionId).then(applyRun)
      : leadId
      ? apiClient.get<Parameters<typeof toCallLead>[0]>(`/api/crm/leads/${leadId}`).then((d) => setSingle(toCallLead(d)))
      : Promise.resolve();
    first.catch((e) => setLoadError(errText(e, inRun ? "Could not open that run" : "Could not open that person")));
    // applyRun is stable for the life of this screen; re-running on it would
    // re-fetch for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, leadId]);

  useEffect(() => {
    apiClient
      .get<{ dispositions: Disposition[]; settings?: Record<string, unknown> }>("/api/crm/config")
      .then((cfg) => {
        setDispositions(cfg.dispositions);
        // The temple's own alert times, so a promise taken mid-call warns the
        // way whoever set DRM up expects.
        const fromSettings = cfg.settings?.reminder_lead_times;
        if (Array.isArray(fromSettings) && fromSettings.length) setDefaultAlerts(cleanAlerts(fromSettings.map(Number)));
      })
      .catch((e) => toast.error("Could not load the outcomes", errText(e, "Refresh to try again")));
  }, [setDefaultAlerts]);

  // The Up next list: refreshed when the place in the run or its tally moves,
  // and only while it can be seen - on a phone it is behind a button.
  const listVisible = inRun && (isDesktop || sheetOpen);
  const runPos = run?.session?.position;
  const runDone = run?.counts.done;
  const runSkipped = run?.counts.skipped;
  useEffect(() => {
    if (!sessionId || !listVisible) return;
    getRunItems(sessionId)
      .then((r) => setItems(r.items))
      .catch(() => undefined); // the panel is a convenience; the run still works without it
  }, [sessionId, listVisible, runPos, runDone, runSkipped]);

  // The end-of-run tally, fetched once the run says it is through.
  useEffect(() => {
    if (!sessionId || !finished || ended) return;
    getRunSummary(sessionId)
      .then((r) => setSummary(r.summary))
      .catch(() => undefined);
  }, [sessionId, finished, ended, runDone]);

  // Heartbeat: while the screen is open and looked at, the person on it stays
  // held so a colleague's run steps past them. Also sent the moment the tab
  // comes back into view - which, on a phone, is the caller returning from
  // the dialler, possibly after a long call.
  useEffect(() => {
    if (!sessionId || paused || finished || ended) return;
    const beat = () => {
      if (document.visibilityState === "visible") void heartbeatRun(sessionId).catch(() => undefined);
    };
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", beat);
    };
  }, [sessionId, paused, finished, ended]);

  /* ------------------------------------------------------------- moving */

  const move = useCallback(
    async (action: Move, position?: number) => {
      if (!sessionId || moving) return;
      setMoving(action);
      if (action === "jump" && position !== undefined) setJumping(position);
      const leaving = runRef.current?.lead;
      const wasPending = runRef.current?.item?.state === "pending";
      try {
        const s = await moveRun(sessionId, action, position);
        applyRun(s);
        if (action === "skip" || (action === "next" && wasPending)) {
          toast.info(`Skipped ${leaving?.name || formatPhone(leaving?.phone) || "them"}`, "They come back when you revisit the skipped.");
        }
        if (action === "revisit" && !s.message) toast("Back to the people you skipped");
        if (action === "jump") setSheetOpen(false);
      } catch (e) {
        toast.error(action === "jump" ? "Can't go to them right now" : "Could not move on", errText(e, ""));
      } finally {
        setMoving(null);
        setJumping(null);
      }
    },
    [sessionId, moving, applyRun]
  );

  /* ------------------------------------------------------------ logging */

  /**
   * Undo a logged call, and go back to the person it was for.
   *
   * Not cosmetic: outcome buttons sit close together and are hit at speed, so
   * a mis-tap happens several times a shift. In a run the server puts the
   * person back to "to call", and the screen returns to them - one step back
   * when they were the last person (the usual case: the slip is noticed at
   * once), a jump otherwise.
   */
  const undo = useCallback(
    async (lc: LastCall) => {
      try {
        await apiClient.delete(`/api/crm/activities/${lc.activityId}`);
        setLastCall((cur) => (cur?.activityId === lc.activityId ? null : cur));
        setSingleLogged(null);
        toast(`Undone — ${lc.label} for ${lc.name} is gone`);
        if (sessionId) {
          const cur = runRef.current;
          if (lc.position !== null && cur?.item?.position !== lc.position) {
            let s = await moveRun(sessionId, "prev");
            if (s.item?.position !== lc.position) s = await moveRun(sessionId, "jump", lc.position);
            applyRun(s);
          } else {
            await reloadRun();
          }
        } else {
          await reloadSingle();
        }
      } catch (e) {
        toast.error("Could not undo that", errText(e, ""));
      }
    },
    [sessionId, applyRun, reloadRun, reloadSingle]
  );

  const logCall = useCallback(
    async (d: Disposition) => {
      if (!lead || saving) return;
      setSaving(d.slug);
      try {
        const res = await apiClient.post<{ activity: { id: string } }>(`/api/crm/leads/${lead.id}/call`, {
          ...form.payload(),
          disposition: d.slug,
          // Marks the person done in the run. Left out for a single call.
          session_id: sessionId ?? undefined,
        });
        const lc: LastCall = {
          activityId: res.activity.id,
          label: d.label,
          name: lead.name || formatPhone(lead.phone),
          leadId: lead.id,
          position: runRef.current?.item?.position ?? null,
        };
        setLastCall(lc);
        toast(`Logged — ${d.label}`, { body: lc.name, action: { label: "Undo", onClick: () => void undo(lc) } });
        resetForm();

        // "Will pay by QR" is only half done when the button is pressed: the
        // QR still has to go. Moving on by itself there would bury the very
        // thing the caller has to do next.
        const qrNext = d.slug === "will_pay_qr";
        if (!sessionId) setSingleLogged(d.label);
        if (qrNext) {
          toast.info("Now send them the QR", "It is just below. Then move on.");
          sendRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        // The call is saved by now. A failure past this point is about
        // showing what comes next, and must not read as the call being lost.
        try {
          if (sessionId) {
            if (autoAdvance && !qrNext) applyRun(await moveRun(sessionId, "next"));
            else await reloadRun();
          } else {
            await reloadSingle();
          }
        } catch (e) {
          toast.warn("Logged, but the screen could not catch up", errText(e, "Tap Next person to carry on."));
        }
      } catch (e) {
        toast.error("Could not log that call", errText(e, ""));
      } finally {
        setSaving(null);
      }
    },
    [lead, saving, form, resetForm, sessionId, autoAdvance, undo, applyRun, reloadRun, reloadSingle]
  );

  /* ------------------------------------------------ pausing and finishing */

  async function pause() {
    if (!sessionId) return;
    setMoving("pause");
    try {
      const r = await pauseRun(sessionId, pauseNote.trim() || undefined);
      // Patched rather than re-read: reading the run re-claims the person on
      // screen, which pausing has just released for colleagues.
      const cur = runRef.current;
      if (cur?.session) {
        const s = { ...cur, session: { ...cur.session, paused_at: r.session.paused_at ?? new Date().toISOString() } };
        runRef.current = s;
        setRun(s);
      }
      setPauseOpen(false);
      setPauseNote("");
      toast.success("Paused — your place is kept", "Colleagues can ring the person on screen meanwhile.");
    } catch (e) {
      toast.error("Could not pause", errText(e, ""));
    } finally {
      setMoving(null);
    }
  }

  async function resume() {
    if (!sessionId) return;
    setMoving("resume");
    try {
      applyRun(await resumeRun(sessionId));
      toast("Back on — carrying on where you were");
    } catch (e) {
      toast.error("Could not resume", errText(e, ""));
    } finally {
      setMoving(null);
    }
  }

  async function finish() {
    if (!sessionId) return;
    setMoving("finish");
    try {
      const r = await endRun(sessionId);
      toast.success(
        "Run finished",
        `${r.summary.calls} call${r.summary.calls === 1 ? "" : "s"} logged · ${r.summary.connected} got through`
      );
      router.push("/calling/start");
    } catch (e) {
      toast.error("Could not finish the run", errText(e, ""));
      setMoving(null);
    }
  }

  async function copyNumber() {
    if (!lead) return;
    try {
      await navigator.clipboard.writeText(lead.phone);
      toast.info(`Copied ${formatPhone(lead.phone)}`, "Dial it on your handset.");
    } catch {
      /* not in a secure context; the number is on screen */
    }
  }

  /* ----------------------------------------------------------- keyboard */

  /**
   * Keyboard shortcuts, for a caller at a desk with one hand on the handset.
   * Number keys log an outcome (see outcomeKeys for which, and why "do not
   * call" has none), arrows move, S skips, U undoes, N jumps to the note.
   * Suppressed while typing, or the first letter of a donor's name would log
   * an outcome mid-sentence; and while a dialog is open.
   */
  useEffect(() => {
    if (!shortcutsOn || isTouch) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (typing) {
        if (e.key === "Escape") el?.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (paused || ended) return;
      // Back works from the end-of-run summary too, where nobody is on screen.
      if (inRun && e.key === "ArrowLeft" && run?.has_prev) {
        e.preventDefault();
        void move("prev");
        return;
      }
      if (!lead) return;

      if (/^[1-9]$/.test(e.key)) {
        const slug = byKey.get(Number(e.key));
        const d = slug ? dispositions.find((x) => x.slug === slug) : undefined;
        if (d) {
          e.preventDefault();
          void logCall(d);
        }
        return;
      }
      if (inRun && e.key === "ArrowRight" && !finished) {
        e.preventDefault();
        void move(run?.item?.state === "pending" ? "skip" : "next");
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "s" && inRun && run?.item?.state === "pending") {
        e.preventDefault();
        void move("skip");
      } else if (k === "u" && lastCall) {
        e.preventDefault();
        void undo(lastCall);
      } else if (k === "n") {
        e.preventDefault();
        noteRef.current?.focus();
      } else if (k === "c") {
        e.preventDefault();
        void copyNumber();
      } else if (k === "r") {
        e.preventDefault();
        form.setRemOpen(true);
      } else if (k === "w") {
        // The real button, so the keyboard and the mouse share one code path.
        e.preventDefault();
        (document.querySelector("[data-send-whatsapp]") as HTMLButtonElement | null)?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ------------------------------------------------------------- render */

  const here = sessionId ? runHref(sessionId) : `${CALL_SCREEN}?lead=${leadId}${back ? `&back=${encodeURIComponent(back)}` : ""}`;

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card padded={false}>
          <EmptyState
            icon="alert"
            title={inRun ? "That run can't be opened" : "That person can't be opened"}
            message={loadError}
            action={
              <Link href="/calling/start" className={buttonClass("primary", "lg")}>
                Choose who to call
              </Link>
            }
          />
        </Card>
      </div>
    );
  }
  if ((inRun && !run) || (!inRun && !single)) return <CallSkeleton />;

  const itemDone = inRun && run?.item?.state === "done";
  const loggedLabel = inRun ? (itemDone && run?.item?.outcome ? outcomeLabel(run.item.outcome) : null) : singleLogged;
  const ahead = run?.counts.ahead ?? 0;

  const nextPersonButton =
    inRun && itemDone ? (
      <Button size="lg" block iconRight="arrowRight" loading={moving === "next"} disabled={!!moving} onClick={() => void move("next")}>
        {ahead > 0 ? "Next person" : "Finish this run"}
      </Button>
    ) : !inRun && singleLogged ? (
      <Button
        size="lg"
        block
        icon="arrowLeft"
        onClick={() => (back ? router.push(back) : router.back())}
      >
        Done — go back
      </Button>
    ) : null;

  /* ---------------------------------------------------------- header */

  const helpButton = !isTouch && (
    <div className="relative hidden sm:block">
      <IconButton name="help" variant="secondary" label="Keyboard shortcuts (?)" onClick={() => setHelpOpen((v) => !v)} />
      {helpOpen && (
        <ShortcutHelp dispositions={dispositions} keys={keys} inRun={inRun} onClose={() => setHelpOpen(false)} />
      )}
    </div>
  );

  const header =
    inRun && run?.session ? (
      <RunHeader
        label={run.session.label}
        counts={run.counts}
        finished={finished}
        paused={paused}
        actions={
          <>
            {!finished && !ended && (
              <Button variant="secondary" icon="list" className="lg:hidden" onClick={() => setSheetOpen(true)}>
                <span className="tabular-nums">{ahead}</span>
                <span className="sr-only"> still ahead — see the run</span>
              </Button>
            )}
            {helpButton}
            {!ended && (
              <DropdownMenu
                items={[
                  ...(!paused && !finished
                    ? [{ label: "Pause", icon: "clock" as const, hint: "Keep your place, let go of this person", onSelect: () => setPauseOpen(true) }]
                    : []),
                  { label: "End this run", icon: "check" as const, hint: "Done with it — start fresh next time", onSelect: () => void finish() },
                  { label: "Choose another list", icon: "list" as const, onSelect: () => router.push("/calling/start") },
                  { label: "Promises due", icon: "bell" as const, onSelect: () => router.push("/calling/reminders") },
                ]}
                trigger={({ open, toggle }) => (
                  <IconButton
                    name="more"
                    variant="secondary"
                    label="Pause, end or switch run"
                    onClick={toggle}
                    aria-expanded={open}
                    aria-haspopup="menu"
                    loading={moving === "finish" || moving === "pause"}
                  />
                )}
              />
            )}
          </>
        }
      />
    ) : (
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-line-soft pb-4">
        <div className="flex min-w-0 items-center gap-2">
          <IconButton
            name="arrowLeft"
            variant="secondary"
            label="Back"
            onClick={() => (back ? router.push(back) : router.back())}
          />
          <div className="min-w-0">
            <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-brand-600">Calling one person</p>
            <h1 className="truncate text-lg font-semibold tracking-tight text-ink sm:text-2xl">
              {single?.name || formatPhone(single?.phone) || "Call"}
            </h1>
          </div>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          {helpButton}
          <Link href="/calling/start" className={buttonClass("secondary", "md")}>
            Start a run
          </Link>
        </div>
      </div>
    );

  /* ---------------------------------------------------------- body */

  let body: ReactNode;
  if (ended) {
    body = (
      <Card padded={false}>
        <EmptyState
          icon="checkCircle"
          title="This run is finished"
          message="It was ended, here or on another device. Pick up a list from the start screen."
          action={
            <Link href="/calling/start" className={buttonClass("primary", "lg")}>
              Choose who to call
            </Link>
          }
        />
      </Card>
    );
  } else if (paused) {
    body = (
      <Card tone="warn" padded={false} className="p-4 sm:p-6">
        <p className="text-lg font-semibold text-ink">Paused</p>
        <p className="mt-1 text-sm text-ink-soft">
          Your place is kept. While you were away, colleagues could ring the person you were on — if one did, you
          move straight past them when you carry on.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button size="lg" icon="phoneOutgoing" loading={moving === "resume"} onClick={() => void resume()}>
            Resume
          </Button>
          <Link href="/calling/start" className={buttonClass("secondary", "lg")}>
            Back to the start screen
          </Link>
        </div>
      </Card>
    );
  } else if (finished && sessionId) {
    body = (
      <RunSummaryCard
        label={run?.session?.label ?? "this run"}
        summary={summary}
        skipped={run?.counts.skipped ?? 0}
        busy={moving === "revisit" ? "revisit" : moving === "finish" ? "finish" : null}
        onRevisit={() => void move("revisit")}
        onFinish={() => void finish()}
        onChooseAnother={() => router.push("/calling/start")}
      />
    );
  } else if (lead) {
    body = (
      <div className="space-y-4">
        <LeadCard lead={lead} outcomeLabel={outcomeLabel} onEdit={() => setEditing(true)} isTouch={isTouch} />

        {/* The outcome buttons before the send panel: on a phone, after the
            call, the next thing is the outcome, and sixty scrolls an hour past
            a panel used on a few calls is real fatigue. */}
        <OutcomePanel
          form={form}
          dispositions={dispositions}
          keys={keys}
          saving={saving}
          onLog={(d) => void logCall(d)}
          shortcutsOn={shortcutsOn}
          onShortcutsChange={(on) => {
            setShortcutsOn(on);
            writePref(SHORTCUTS_KEY, on);
          }}
          showKeys={!isTouch}
          noteRef={noteRef}
          logged={loggedLabel}
          after={nextPersonButton}
        />

        {/* Sent DURING the conversation, while the donor is on the line. The
            QR sits with the link because, from the caller's side, "send them
            something" is one decision. */}
        <div ref={sendRef}>
          <Card padded={false} className="p-4 sm:p-5">
            <SendLink
              leadId={lead.id}
              leadName={lead.name}
              expectedAmount={lead.expected_amount}
              compact
              onSent={() => toast.success("WhatsApp opened with the link", "Press send there.")}
            />
            <div className="mt-3 border-t border-line-soft pt-3">
              <SendQr
                leadId={lead.id}
                leadName={lead.name}
                expectedAmount={lead.expected_amount}
                sessionId={sessionId}
                onShared={() => toast.success("QR shared", "Press send in WhatsApp. A payment to it is matched to them.")}
              />
            </div>
          </Card>
        </div>

        {inRun && (
          <label className="flex min-h-11 items-center justify-between gap-3 rounded-card border border-line-soft bg-surface px-4 py-2 text-sm text-ink-soft">
            <span>
              Move on by itself after I log a call
              <span className="block text-xs text-ink-muted">Except &ldquo;Will pay by QR&rdquo; — the QR comes first.</span>
            </span>
            <Toggle
              on={autoAdvance}
              label="Move on by itself after logging"
              onChange={(on) => {
                setAutoAdvance(on);
                writePref(AUTO_ADVANCE_KEY, on);
                toast.info(on ? "Will move on after each call" : "Will stay on the person after logging");
              }}
            />
          </label>
        )}
      </div>
    );
  } else {
    body = (
      <Card padded={false}>
        <EmptyState icon="inbox" title="Nobody on screen" message="Move on, or pick a list from the start screen." />
      </Card>
    );
  }

  /* ---------------------------------------------------------- nav bar */

  const navLeft = inRun ? (
    <NavButton
      variant="secondary"
      icon="arrowLeft"
      disabled={!run?.has_prev || !!moving || !!saving || paused || ended}
      loading={moving === "prev"}
      onClick={() => void move("prev")}
    >
      Previous
    </NavButton>
  ) : (
    <NavButton variant="secondary" icon="arrowLeft" onClick={() => (back ? router.push(back) : router.back())}>
      Back
    </NavButton>
  );

  const navRight = inRun ? (
    finished || paused || ended ? null : itemDone ? (
      <NavButton
        iconRight="arrowRight"
        disabled={!!moving}
        loading={moving === "next"}
        onClick={() => void move("next")}
      >
        {ahead > 0 ? "Next person" : "To the summary"}
      </NavButton>
    ) : (
      <NavButton
        variant="secondary"
        iconRight="arrowRight"
        disabled={!!moving || !!saving}
        loading={moving === "skip"}
        onClick={() => void move("skip")}
      >
        Skip for now
      </NavButton>
    )
  ) : lead ? (
    <Link href={`/leads/${lead.id}`} className={buttonClass("secondary", "lg", "flex-1 sm:flex-none")}>
      Full record
    </Link>
  ) : null;

  return (
    <div className="mx-auto max-w-6xl">
      {header}

      <CallBanners back={here} />

      {/* Undo sits above the fold too: the toast that offers it fades, and a
          slip noticed a minute later still needs a way back. */}
      {lastCall && (
        <Alert
          tone="info"
          onDismiss={() => setLastCall(null)}
          action={
            <Button size="sm" variant="secondary" icon="refresh" onClick={() => void undo(lastCall)}>
              Undo
              {!isTouch && <kbd className="ml-1 text-2xs opacity-60">U</kbd>}
            </Button>
          }
        >
          Logged <span className="font-medium">{lastCall.label}</span> for {lastCall.name}
        </Alert>
      )}

      <div className={inRun ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" : ""}>
        <div className="min-w-0">{body}</div>

        {inRun && isDesktop && (
          <aside className="min-w-0">
            <Card padded={false} className="sticky top-20 p-4">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">This run</p>
                <span className="text-xs tabular-nums text-ink-muted">{ahead} ahead</span>
              </div>
              <div className="scroll-slim max-h-[calc(100vh-12rem)] overflow-y-auto">
                <UpNextList
                  items={items}
                  position={run?.session?.position ?? 0}
                  loading={!items}
                  jumping={jumping}
                  onJump={(p) => void move("jump", p)}
                />
              </div>
            </Card>
          </aside>
        )}
      </div>

      <NavBar left={navLeft} right={navRight} />

      {/* ------------------------------------------------------- dialogs */}
      {sheetOpen && inRun && (
        <Modal title={`${run?.session?.label ?? "This run"} · ${ahead} ahead`} onClose={() => setSheetOpen(false)}>
          <UpNextList
            items={items}
            position={run?.session?.position ?? 0}
            loading={!items}
            jumping={jumping}
            onJump={(p) => void move("jump", p)}
          />
        </Modal>
      )}

      {pauseOpen && (
        <Modal
          title="Pause this run"
          onClose={() => setPauseOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setPauseOpen(false)}>
                Keep calling
              </Button>
              <Button loading={moving === "pause"} onClick={() => void pause()}>
                Pause
              </Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-ink-soft">
            Your place is kept for today or tomorrow. The person on screen is let go, so a colleague can ring them
            meanwhile.
          </p>
          <Field label="A note for yourself" htmlFor="pause-note" hint="Optional — “lunch”, “back after aarti”">
            <Input
              id="pause-note"
              value={pauseNote}
              onChange={(e) => setPauseNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void pause()}
              maxLength={200}
            />
          </Field>
        </Modal>
      )}

      {editing && lead && (
        <ContactEditor
          lead={lead}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            try {
              if (inRun) await reloadRun();
              else await reloadSingle();
            } catch {
              /* saved; the screen catches up on the next move */
            }
          }}
        />
      )}
    </div>
  );
}
