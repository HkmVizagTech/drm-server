"use client";

// The call screen.
//
// A caller works through sixty of these in an hour, so the screen is built
// around one number: how many actions it takes to finish a call and get to the
// next person. Dial, talk, tap the outcome, confirm - and with "move on by
// itself" left on, the confirm is also the move to the next person.
//
// WHAT IT GUARDS AGAINST
//   - a mis-tapped outcome: a tap picks, a confirm logs ("Ask before logging",
//     on unless the caller turns it off), and Undo stays for after.
//   - a call that happened and was never logged: ring somebody (or open
//     WhatsApp) and then try to move on, and the screen asks first.
//   - the donor who rang back: "They rang me" logs the call as incoming, and
//     "Already donated" says so before anybody asks for money twice.
//   - the donor who gave from another phone: "They gave from another number"
//     finds the donation and links it to them.
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
  Badge,
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
import { LEAD_HEADING_ID, LeadCard, type DialVia } from "@/components/calling/lead-card";
import { ConfirmLog } from "@/components/calling/confirm-log";
import { LinkDonationDialog } from "@/components/calling/link-donation";
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
const ASK_FIRST_KEY = "drm.calling.askFirst";
/** Who the caller last reached for the phone to ring, so a refresh mid-call still remembers. */
const DIALLED_KEY = "drm.calling.dialled";

type Move = "next" | "skip" | "prev" | "jump" | "revisit";
/** A move the "you rang them but didn't log it" question can stand in front of. */
type Leave = Exclude<Move, "revisit"> | "back";

interface Dialled {
  leadId: string;
  via: DialVia;
}

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

// The dial is remembered for this tab only: a phone often drops the tab while
// the dialler is in front, and coming back should still know a call was made.
function readDialled(): Dialled | null {
  try {
    const v = window.sessionStorage.getItem(DIALLED_KEY);
    if (!v) return null;
    const d = JSON.parse(v) as Dialled;
    return d && typeof d.leadId === "string" ? d : null;
  } catch {
    return null;
  }
}
function writeDialled(d: Dialled | null) {
  try {
    if (d) window.sessionStorage.setItem(DIALLED_KEY, JSON.stringify(d));
    else window.sessionStorage.removeItem(DIALLED_KEY);
  } catch {
    /* only the question on leaving is lost */
  }
}

/** Back to the top of the page for a new person - the scroller is <main>, not the window. */
function scrollToTop(behavior: ScrollBehavior) {
  document.querySelector("main")?.scrollTo({ top: 0, behavior });
  window.scrollTo({ top: 0, behavior });
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
    for (const p of passed) toast.info(`Skipped ${p.name || "someone"}: ${p.reason}`);
  } else {
    toast.info(
      `Skipped ${passed.length} people`,
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
  // "They rang me" from a lead's page: the call being logged is one they made.
  const inbound = params.get("inbound") === "1";

  // Keyed, so moving from one run (or one person) to another starts from a
  // clean screen rather than carrying a half-typed note across.
  if (sessionId) return <CallScreen key={`s:${sessionId}`} sessionId={sessionId} leadId={null} back={null} inbound={false} />;
  if (leadId)
    return (
      <CallScreen key={`l:${leadId}:${inbound ? 1 : 0}`} sessionId={null} leadId={leadId} back={back} inbound={inbound} />
    );
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
  inbound: startInbound,
}: {
  sessionId: string | null;
  leadId: string | null;
  back: string | null;
  /** Opened as "They rang me". */
  inbound: boolean;
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
  const [askFirst, setAskFirst] = useState(() => readPref(ASK_FIRST_KEY, true));

  // Per-person state is keyed by the lead it belongs to rather than reset on
  // every move: whatever is not about the person on screen simply does not
  // apply, and nothing has to remember to clear it.
  /** The outcome tapped and waiting on the confirm. */
  const [picked, setPicked] = useState<{ slug: string; leadId: string } | null>(null);
  /** The caller tapped Call / WhatsApp / Copy for this person. */
  const [dialled, setDialled] = useState<Dialled | null>(() => readDialled());
  /** "They rang me" is on for this person. */
  const [inboundFor, setInboundFor] = useState<string | null>(startInbound ? leadId : null);
  /** "You rang them but didn't log it" - the move waiting on the answer. */
  const [guard, setGuard] = useState<{ action: Leave; position?: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  /** A donation was just linked to this person - offer to move on. */
  const [linkedFor, setLinkedFor] = useState<string | null>(null);
  /** activity id -> direction, for a run's history (which comes without it). */
  const [callDirs, setCallDirs] = useState<{ leadId: string; map: Record<string, string> } | null>(null);

  const form = useCallForm();
  // The two parts of the form that never change identity, pulled out so the
  // callbacks below do not have to be rebuilt on every keystroke in the note.
  const { reset: resetForm, setDefaultAlerts } = form;
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLDivElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
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

  const pickedHere =
    lead && picked?.leadId === lead.id ? (dispositions.find((d) => d.slug === picked.slug) ?? null) : null;
  const inbound = !!lead && inboundFor === lead.id;
  const dialledHere = lead && dialled?.leadId === lead.id ? dialled : null;
  const leadName = lead ? lead.name || formatPhone(lead.phone) : "";

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
    first.catch((e) => setLoadError(errText(e, inRun ? "Could not open this list" : "Could not open this lead")));
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
      .catch((e) => toast.error("Could not load call results", errText(e, "Refresh to try again.")));
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

  // Which calls they made to us. A run's history comes without direction,
  // so it is filled in from the call log - refreshed when a call is added.
  const histLead = inRun ? (lead?.id ?? null) : null;
  const histTop = lead?.recent_activities[0]?.id ?? null;
  useEffect(() => {
    if (!histLead) return;
    let live = true;
    apiClient
      .get<{ calls: { id: string; direction: string }[] }>(`/api/crm/calls?lead_id=${histLead}&user_id=all&limit=20`)
      .then((r) => {
        if (live) setCallDirs({ leadId: histLead, map: Object.fromEntries(r.calls.map((c) => [c.id, c.direction])) });
      })
      .catch(() => undefined); // without it a call simply shows no direction
    return () => {
      live = false;
    };
  }, [histLead, histTop]);

  // A new person on screen starts at the top of the page, with the screen
  // reader told who it is. Without this, auto-advance left the caller looking
  // at the middle of the new person's outcome buttons, with the name, the
  // number and "nearly gave" all scrolled away above.
  const personKey = inRun
    ? run
      ? `${run.session?.position ?? ""}:${run.lead?.id ?? ""}:${run.finished ? 1 : 0}`
      : null
    : (single?.id ?? null);
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    if (!personKey || shownKey.current === personKey) return;
    const first = shownKey.current === null;
    shownKey.current = personKey;
    scrollToTop(first ? "auto" : "smooth");
    const raf = requestAnimationFrame(() => document.getElementById(LEAD_HEADING_ID)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [personKey]);

  const markDialled = useCallback(
    (via: DialVia) => {
      if (!lead) return;
      const d = { leadId: lead.id, via };
      setDialled(d);
      writeDialled(d);
    },
    [lead]
  );
  const clearDialled = useCallback(() => {
    setDialled(null);
    writeDialled(null);
  }, []);

  /* ------------------------------------------------------------- moving */

  const move = useCallback(
    async (action: Move, position?: number, opts: { quiet?: boolean } = {}) => {
      if (!sessionId || moving) return;
      setMoving(action);
      if (action === "jump" && position !== undefined) setJumping(position);
      const leaving = runRef.current?.lead;
      const wasPending = runRef.current?.item?.state === "pending";
      try {
        const s = await moveRun(sessionId, action, position);
        applyRun(s);
        if (opts.quiet) {
          if (!s.finished) toast.info("Next person");
        } else if (action === "skip" || (action === "next" && wasPending)) {
          toast.info(`Skipped ${leaving?.name || formatPhone(leaving?.phone) || "them"}`);
        }
        if (action === "revisit" && !s.message) toast("Back to skipped people");
        if (action === "jump") setSheetOpen(false);
      } catch (e) {
        toast.error(action === "jump" ? "Could not open them. Try again." : "Could not move on. Try again.", errText(e, ""));
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
        toast(`Undone: ${lc.label} for ${lc.name}`);
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
        toast.error("Could not undo. Try again.", errText(e, ""));
      }
    },
    [sessionId, applyRun, reloadRun, reloadSingle]
  );

  /**
   * Save the call. `advance` is the confirm's choice between "Log it" and
   * "Log & next person"; left out (no confirm), "move on by itself" decides.
   */
  const logCall = useCallback(
    async (d: Disposition, advance?: boolean) => {
      if (!lead || saving) return;
      setSaving(d.slug);
      try {
        const res = await apiClient.post<{ activity: { id: string } }>(`/api/crm/leads/${lead.id}/call`, {
          ...form.payload(),
          disposition: d.slug,
          // They rang us. Left out for an ordinary call, which the server
          // records as outbound.
          direction: inbound ? "inbound" : undefined,
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
        toast(`Saved: ${d.label}`, {
          body: inbound ? `${lc.name} · they called you` : lc.name,
          action: { label: "Undo", onClick: () => void undo(lc) },
        });
        resetForm();
        setPicked(null);
        clearDialled();

        // "Will pay by QR" is only half done when the button is pressed: the
        // QR still has to go. Moving on by itself there would bury the very
        // thing the caller has to do next.
        const qrNext = d.slug === "will_pay_qr";
        if (!sessionId) setSingleLogged(d.label);
        if (qrNext) {
          toast.info("Now send the QR", "It is just below.");
          sendRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        // The call is saved by now. A failure past this point is about
        // showing what comes next, and must not read as the call being lost.
        try {
          if (sessionId) {
            if ((advance ?? autoAdvance) && !qrNext) applyRun(await moveRun(sessionId, "next"));
            else await reloadRun();
          } else {
            await reloadSingle();
          }
        } catch (e) {
          toast.warn("Saved. Screen did not refresh.", errText(e, "Tap Next person."));
        }
      } catch (e) {
        toast.error("Could not save. Try again.", errText(e, ""));
      } finally {
        setSaving(null);
      }
    },
    [lead, saving, form, resetForm, sessionId, autoAdvance, inbound, undo, applyRun, reloadRun, reloadSingle, clearDialled]
  );

  /** A tap or a number key on an outcome: logs at once, or picks it for the confirm. */
  const pick = useCallback(
    (d: Disposition) => {
      if (!lead || saving) return;
      if (!askFirst) {
        void logCall(d);
        return;
      }
      setPicked({ slug: d.slug, leadId: lead.id });
    },
    [lead, saving, askFirst, logCall]
  );

  const cancelPick = useCallback(() => {
    const slug = picked?.slug;
    setPicked(null);
    // Back to the button that was picked, for a keyboard user choosing again.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-outcome="${slug}"]`)?.focus({ preventScroll: true })
    );
  }, [picked]);

  // The confirm takes focus as it opens, so Enter logs and a screen reader
  // reads the question. On a desk it is also brought into view: it sits under
  // the buttons, which may be at the bottom edge.
  const pickedSlug = pickedHere?.slug ?? null;
  useEffect(() => {
    if (!pickedSlug) return;
    const raf = requestAnimationFrame(() => {
      const btn = document.querySelector<HTMLButtonElement>("[data-confirm-primary]");
      btn?.focus({ preventScroll: true });
      if (isDesktop) btn?.closest('[role="alertdialog"]')?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [pickedSlug, isDesktop]);

  // Enter logs, Escape changes - whether or not the other shortcuts are on,
  // and on a phone with a keyboard too. Enter inside a note is a new line, and
  // on a focused button it is that button's own press.
  useEffect(() => {
    if (!pickedSlug) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancelPick();
        return;
      }
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && ["TEXTAREA", "BUTTON", "A", "SELECT"].includes(el.tagName)) return;
      e.preventDefault();
      document.querySelector<HTMLButtonElement>("[data-confirm-primary]")?.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickedSlug, cancelPick]);

  /* --------------------------------------------- leaving without logging */

  const leave = useCallback(() => (back ? router.push(back) : router.back()), [back, router]);

  /** Moves on, unless they were rung (or an outcome picked) and nothing logged - then asks first. */
  function go(action: Leave, position?: number) {
    const unlogged = inRun ? run?.item?.state === "pending" : !singleLogged;
    if (lead && unlogged && (dialledHere || pickedHere)) {
      if (action === "jump") setSheetOpen(false);
      setGuard({ action, position });
      return;
    }
    if (action === "back") leave();
    else void move(action, position);
  }

  function leaveAnyway() {
    const g = guard;
    setGuard(null);
    setPicked(null);
    clearDialled();
    if (!g) return;
    if (g.action === "back") leave();
    else void move(g.action, g.position);
  }

  function toOutcomes() {
    setGuard(null);
    outcomeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(pickedHere ? "[data-confirm-primary]" : "[data-outcome]")
        ?.focus({ preventScroll: true })
    );
  }

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
      toast.success("Paused. Your place is kept.");
    } catch (e) {
      toast.error("Could not pause. Try again.", errText(e, ""));
    } finally {
      setMoving(null);
    }
  }

  async function resume() {
    if (!sessionId) return;
    setMoving("resume");
    try {
      applyRun(await resumeRun(sessionId));
      toast("Resumed");
    } catch (e) {
      toast.error("Could not resume. Try again.", errText(e, ""));
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
        "Finished",
        `${r.summary.calls} call${r.summary.calls === 1 ? "" : "s"} · ${r.summary.connected} answered`
      );
      router.push("/calling/start");
    } catch (e) {
      toast.error("Could not finish. Try again.", errText(e, ""));
      setMoving(null);
    }
  }

  async function copyNumber() {
    if (!lead) return;
    try {
      await navigator.clipboard.writeText(lead.phone);
      markDialled("copy");
      toast.info(`Copied ${formatPhone(lead.phone)}`, "Dial it on your phone.");
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
        go("prev");
        return;
      }
      if (!lead) return;

      if (/^[1-9]$/.test(e.key)) {
        const slug = byKey.get(Number(e.key));
        const d = slug ? dispositions.find((x) => x.slug === slug) : undefined;
        if (d) {
          e.preventDefault();
          pick(d);
        }
        return;
      }
      if (inRun && e.key === "ArrowRight" && !finished) {
        e.preventDefault();
        go(run?.item?.state === "pending" ? "skip" : "next");
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "s" && inRun && run?.item?.state === "pending") {
        e.preventDefault();
        go("skip");
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
            title={inRun ? "Could not open this list" : "Could not open this lead"}
            message={loadError}
            action={
              <Link href="/calling/start" className={buttonClass("primary", "lg")}>
                Pick who to call
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
        {ahead > 0 ? "Next person" : "Finish"}
      </Button>
    ) : !inRun && singleLogged ? (
      <Button
        size="lg"
        block
        icon="arrowLeft"
        onClick={leave}
      >
        Done
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
        badge={
          inbound && !finished ? (
            <Badge tone="info" icon="phone">
              Incoming call
            </Badge>
          ) : null
        }
        actions={
          <>
            {!finished && !ended && (
              <Button variant="secondary" icon="list" className="lg:hidden" onClick={() => setSheetOpen(true)}>
                <span className="tabular-nums">{ahead}</span>
                <span className="sr-only"> left. See list</span>
              </Button>
            )}
            {helpButton}
            {!ended && (
              <DropdownMenu
                items={[
                  ...(!paused && !finished
                    ? [{ label: "Pause", icon: "clock" as const, hint: "Keep your place", onSelect: () => setPauseOpen(true) }]
                    : []),
                  { label: "Finish", icon: "check" as const, hint: "Stop calling this list", onSelect: () => void finish() },
                  { label: "Pick another list", icon: "list" as const, onSelect: () => router.push("/calling/start") },
                  { label: "Reminders", icon: "bell" as const, onSelect: () => router.push("/calling/reminders") },
                ]}
                trigger={({ open, toggle }) => (
                  <IconButton
                    name="more"
                    variant="secondary"
                    label="More"
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
          <IconButton name="arrowLeft" variant="secondary" label="Back" onClick={() => go("back")} />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-2xs font-semibold uppercase tracking-[0.08em] text-brand-600">
              {inbound ? "They called you" : "Call"}
              {inbound && (
                <Badge tone="info" icon="phone">
                  Incoming call
                </Badge>
              )}
            </p>
            <h1 className="truncate text-lg font-semibold tracking-tight text-ink sm:text-2xl">
              {single?.name || formatPhone(single?.phone) || "Call"}
            </h1>
          </div>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          {helpButton}
          <Link href="/calling/start" className={buttonClass("secondary", "md")}>
            Start calling
          </Link>
        </div>
      </div>
    );

  /* ---------------------------------------------------------- body */

  // The confirm, in whichever shape this screen wants: a sheet over the
  // bottom edge on a phone, a bar under the buttons on a desk.
  const confirmOn = !!pickedHere && !!lead && !paused && !ended && !(finished && inRun);
  const confirmEl =
    confirmOn && pickedHere && lead ? (
      <ConfirmLog
        outcome={pickedHere}
        name={leadName}
        form={form}
        inbound={inbound}
        canAdvance={inRun && autoAdvance && pickedHere.slug !== "will_pay_qr"}
        advanceLabel={ahead > 0 ? "Save & next" : "Save & finish"}
        saving={saving === pickedHere.slug}
        layout={isDesktop ? "inline" : "sheet"}
        expectedAmount={lead.expected_amount}
        onChange={cancelPick}
        onConfirm={(advance) => void logCall(pickedHere, advance)}
      />
    ) : null;

  let body: ReactNode;
  if (ended) {
    body = (
      <Card padded={false}>
        <EmptyState
          icon="checkCircle"
          title="This list is finished"
          message="Pick another list to call."
          action={
            <Link href="/calling/start" className={buttonClass("primary", "lg")}>
              Pick who to call
            </Link>
          }
        />
      </Card>
    );
  } else if (paused) {
    body = (
      <Card tone="warn" padded={false} className="p-4 sm:p-6">
        <p className="text-lg font-semibold text-ink">Paused</p>
        <p className="mt-1 text-sm text-ink-soft">Your place is kept.</p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button size="lg" icon="phoneOutgoing" loading={moving === "resume"} onClick={() => void resume()}>
            Resume
          </Button>
          <Link href="/calling/start" className={buttonClass("secondary", "lg")}>
            Back to start
          </Link>
        </div>
      </Card>
    );
  } else if (finished && sessionId) {
    body = (
      <RunSummaryCard
        label={run?.session?.label ?? "this list"}
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
        {/* Just linked a donation from another number: they are done with,
            unless the caller spoke to them and wants the call on record. */}
        {linkedFor === lead.id && lead.converted_at && (
          <Alert tone="good" title={`Linked. ${leadName} has donated.`} onDismiss={() => setLinkedFor(null)} className="mb-0">
            <div className="mt-2 flex flex-wrap gap-2">
              {inRun ? (
                <Button
                  iconRight="arrowRight"
                  loading={moving === "next"}
                  disabled={!!moving}
                  onClick={() => {
                    setLinkedFor(null);
                    clearDialled();
                    void move("next", undefined, { quiet: true });
                  }}
                >
                  {ahead > 0 ? "Next person" : "See summary"}
                </Button>
              ) : (
                <Button icon="arrowLeft" onClick={leave}>
                  Done
                </Button>
              )}
              <Button variant="secondary" onClick={toOutcomes}>
                Save the call
              </Button>
            </div>
          </Alert>
        )}

        <LeadCard
          lead={lead}
          outcomeLabel={outcomeLabel}
          onEdit={() => setEditing(true)}
          isTouch={isTouch}
          onDial={markDialled}
          onLinkOther={() => setLinkOpen(true)}
          directions={callDirs?.leadId === lead.id ? callDirs.map : undefined}
        />

        {/* The outcome buttons before the send panel: on a phone, after the
            call, the next thing is the outcome, and sixty scrolls an hour past
            a panel used on a few calls is real fatigue. */}
        <div ref={outcomeRef} className="scroll-mt-28">
          <OutcomePanel
            form={form}
            dispositions={dispositions}
            keys={keys}
            saving={saving}
            onPick={pick}
            askFirst={askFirst}
            selected={pickedHere?.slug ?? null}
            confirm={isDesktop ? confirmEl : null}
            inbound={inbound}
            onInboundChange={(on) => setInboundFor(on ? lead.id : null)}
            onLinkOther={() => setLinkOpen(true)}
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
        </div>

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
              onSent={() => toast.success("WhatsApp opened", "Press send there.")}
            />
            <div className="mt-3 border-t border-line-soft pt-3">
              <SendQr
                leadId={lead.id}
                leadName={lead.name}
                expectedAmount={lead.expected_amount}
                sessionId={sessionId}
                onShared={() => toast.success("QR shared", "Press send in WhatsApp.")}
              />
            </div>
          </Card>
        </div>

        {/* This device's own habits. */}
        <div className="divide-y divide-line-soft rounded-card border border-line-soft bg-surface">
          <label className="flex min-h-12 items-center justify-between gap-3 px-4 py-2 text-sm text-ink-soft">
            <span>Ask before saving</span>
            <Toggle
              on={askFirst}
              label="Ask before saving"
              onChange={(on) => {
                setAskFirst(on);
                writePref(ASK_FIRST_KEY, on);
                if (!on) setPicked(null);
                toast.info(on ? "Will ask before saving" : "One tap saves the call");
              }}
            />
          </label>
          {inRun && (
            <label className="flex min-h-12 items-center justify-between gap-3 px-4 py-2 text-sm text-ink-soft">
              <span>Go to next person after saving</span>
              <Toggle
                on={autoAdvance}
                label="Go to next person after saving"
                onChange={(on) => {
                  setAutoAdvance(on);
                  writePref(AUTO_ADVANCE_KEY, on);
                  toast.info(on ? "Will go to next person" : "Will stay on this person");
                }}
              />
            </label>
          )}
        </div>
      </div>
    );
  } else {
    body = (
      <Card padded={false}>
        <EmptyState icon="inbox" title="No one here" message="Pick a list to call." />
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
      onClick={() => go("prev")}
    >
      Previous
    </NavButton>
  ) : (
    <NavButton variant="secondary" icon="arrowLeft" onClick={() => go("back")}>
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
        {ahead > 0 ? "Next person" : "See summary"}
      </NavButton>
    ) : (
      <NavButton
        variant="secondary"
        iconRight="arrowRight"
        disabled={!!moving || !!saving}
        loading={moving === "skip"}
        onClick={() => go("skip")}
      >
        Skip
      </NavButton>
    )
  ) : lead ? (
    <Link href={`/leads/${lead.id}`} className={buttonClass("secondary", "lg", "flex-1 sm:flex-none")}>
      Open lead
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
          Saved <span className="font-medium">{lastCall.label}</span> for {lastCall.name}
        </Alert>
      )}

      <div className={inRun ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" : ""}>
        <div className="min-w-0">{body}</div>

        {inRun && isDesktop && (
          <aside className="min-w-0">
            <Card padded={false} className="sticky top-20 p-4">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">Up next</p>
                <span className="text-xs tabular-nums text-ink-muted">{ahead} left</span>
              </div>
              <div className="scroll-slim max-h-[calc(100vh-12rem)] overflow-y-auto">
                <UpNextList
                  items={items}
                  position={run?.session?.position ?? 0}
                  loading={!items}
                  jumping={jumping}
                  onJump={(p) => go("jump", p)}
                />
              </div>
            </Card>
          </aside>
        )}
      </div>

      {/* Room to scroll the note and callback chips clear of the confirm
          sheet, which sits over the bottom of the page. */}
      {!isDesktop && confirmOn && <div aria-hidden className="h-72" />}

      <NavBar left={navLeft} right={navRight} />

      {!isDesktop && confirmEl}

      {/* ------------------------------------------------------- dialogs */}
      {sheetOpen && inRun && (
        <Modal title={`${run?.session?.label ?? "This list"} · ${ahead} left`} onClose={() => setSheetOpen(false)}>
          <UpNextList
            items={items}
            position={run?.session?.position ?? 0}
            loading={!items}
            jumping={jumping}
            onJump={(p) => go("jump", p)}
          />
        </Modal>
      )}

      {pauseOpen && (
        <Modal
          title="Pause calling?"
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
          <Field label="Note (optional)" htmlFor="pause-note">
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

      {guard && lead && (
        <Modal
          title={
            pickedHere
              ? `“${pickedHere.label}” is not saved`
              : dialledHere?.via === "whatsapp"
              ? `Save your message to ${leadName}?`
              : `Save your call to ${leadName}?`
          }
          onClose={() => setGuard(null)}
        >
          <p className="text-sm text-ink-soft">
            {pickedHere ? "Confirm to save it." : "Pick a call result, even “No answer”."}
          </p>
          {/* In the body, Log first: the dialog focuses its first control, and
              Enter should keep the call, not throw it away. */}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Button size="lg" icon="check" onClick={toOutcomes}>
              Pick result
            </Button>
            <Button size="lg" variant="secondary" onClick={leaveAnyway}>
              {guard.action === "skip" || guard.action === "next" ? "Skip anyway" : "Leave anyway"}
            </Button>
          </div>
        </Modal>
      )}

      {linkOpen && lead && (
        <LinkDonationDialog
          leadId={lead.id}
          leadName={lead.name}
          onClose={() => setLinkOpen(false)}
          onLinked={() => {
            setLinkedFor(lead.id);
            (inRun ? reloadRun() : reloadSingle()).catch(() => undefined);
          }}
        />
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
