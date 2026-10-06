"use client";

// The search box in the top bar: a number or a name, from any screen.
//
// A donor rings the temple back. Before this, the caller had to know whether
// that person was a lead or a donor, open the right screen, and type the
// number into that screen's own filter. Now: type what is on the phone's
// screen, in whatever format the phone shows it.
//
// Keyboard: "/" focuses it from anywhere that is not already a text field;
// arrows move through results; Enter opens one; Escape closes.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { callHref } from "@/lib/calling";
import { useAuth } from "@/lib/auth-context";
import { Icon, Spinner } from "./icons";
import { CALL_EDGE, CallStateChip, callState, type CallStateInput } from "./calling/call-state";

interface LeadHit {
  id: string;
  name: string | null;
  phone: string;
  alt_phone: string | null;
  city: string | null;
  status_label: string | null;
  do_not_call: boolean;
  assigned_to_name: string | null;
}
type LeadHitFull = LeadHit & CallStateInput;
interface PersonHit extends CallStateInput {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  total_donated: string;
  /** Set when this donor is also a lead - then the call state is the lead's. */
  lead_id: string | null;
}

type Hit =
  | { kind: "lead"; key: string; href: string; callable: boolean; lead: LeadHitFull }
  | { kind: "person"; key: string; href: string; person: PersonHit };

export function GlobalSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [leads, setLeads] = useState<LeadHitFull[]>([]);
  const { user } = useAuth();
  const [people, setPeople] = useState<PersonHit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  // "/" to search, the convention people already know from other tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => {
    const term = q.trim();
    let live = true;
    // Everything happens in the timer, so typing fast costs one request and
    // nothing is set synchronously inside the effect.
    const t = window.setTimeout(async () => {
      if (term.length < 2) {
        setLeads([]);
        setPeople([]);
        return;
      }
      setLoading(true);
      try {
        const r = await api<{ leads: LeadHitFull[]; people: PersonHit[] }>(
          `/api/crm/search?q=${encodeURIComponent(term)}`
        );
        if (!live) return;
        setLeads(r.leads);
        setPeople(r.people);
        setActive(0);
      } catch {
        if (live) {
          setLeads([]);
          setPeople([]);
        }
      } finally {
        if (live) setLoading(false);
      }
    }, term.length < 2 ? 0 : 220);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q]);

  const hits: Hit[] = useMemo(
    () => [
      ...leads.map((l) => ({
        kind: "lead" as const,
        key: `l${l.id}`,
        href: `/leads/${l.id}`,
        callable: !l.do_not_call,
        lead: l,
      })),
      ...people.map((p) => ({ kind: "person" as const, key: `p${p.id}`, href: `/people/${p.id}`, person: p })),
    ],
    [leads, people]
  );

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    input.current?.blur();
    router.push(href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      input.current?.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(hits.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      go(hits[active].href);
    }
  };

  const show = open && q.trim().length >= 2;

  return (
    <div ref={box} className="relative w-full max-w-md">
      <Icon
        name="search"
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
      />
      <input
        ref={input}
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search name or number…"
        aria-label="Search leads and donors"
        autoFocus={autoFocus}
        className="h-9 w-full rounded-control border border-line bg-sunken/60 pl-9 pr-10 text-sm text-ink placeholder:text-ink-faint outline-none transition-colors focus:border-brand-500 focus:bg-surface focus:ring-2 focus:ring-brand-500/20 [&::-webkit-search-cancel-button]:appearance-none"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-line px-1.5 text-2xs text-ink-faint sm:block">
        {loading ? <Spinner size={11} /> : "/"}
      </span>

      {show && (
        <div className="absolute left-0 right-0 top-11 z-50 max-h-[70vh] overflow-y-auto rounded-card border border-line-soft bg-surface p-1.5 shadow-dialog sm:min-w-[26rem]">
          {!loading && !hits.length && (
            <p className="px-3 py-4 text-center text-sm text-ink-muted">Nobody matches that.</p>
          )}
          {leads.length > 0 && (
            <p className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.1em] text-ink-faint">Leads</p>
          )}
          {hits.map((h, n) => {
            const isActive = n === active;
            // The colour says where the calling has got to with them - given,
            // do not call, call back due, called, or never rung - so a caller
            // can tell at a glance whether they have spoken to this person.
            const state =
              h.kind === "lead"
                ? callState(h.lead, user?.id)
                : h.person.lead_id
                ? callState(h.person, user?.id)
                : callState({}, user?.id);
            const header =
              h.kind === "person" && (n === 0 || hits[n - 1].kind !== "person") ? (
                <p
                  key={`${h.key}-h`}
                  className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.1em] text-ink-faint"
                >
                  Donors
                </p>
              ) : null;
            return (
              <div key={h.key}>
                {header}
                <div
                  onMouseEnter={() => setActive(n)}
                  className={`flex items-center gap-2 rounded-control border-l-[3px] px-3 py-2 ${CALL_EDGE[state.tone]} ${isActive ? "bg-brand-50" : ""}`}
                >
                  <button type="button" onClick={() => go(h.href)} className="min-w-0 flex-1 text-left">
                    {h.kind === "lead" ? (
                      <>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-ink">{h.lead.name || "No name"}</span>
                          <CallStateChip state={state} />
                        </span>
                        <span className="block truncate text-xs text-ink-muted tabular-nums">
                          {h.lead.phone}
                          {h.lead.assigned_to_name ? ` · ${h.lead.assigned_to_name}'s lead` : ""}
                          {h.lead.city ? ` · ${h.lead.city}` : ""}
                        </span>
                        {state.detail && (
                          <span className="block truncate text-xs text-ink-soft">Last call: {state.detail}</span>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-ink">{h.person.name}</span>
                          {h.person.lead_id && <CallStateChip state={state} />}
                        </span>
                        <span className="block truncate text-xs text-ink-muted tabular-nums">
                          {h.person.phone}
                          {Number(h.person.total_donated) > 0
                            ? ` · gave ₹${Number(h.person.total_donated).toLocaleString("en-IN")}`
                            : ""}
                        </span>
                        {state.detail && (
                          <span className="block truncate text-xs text-ink-soft">Last call: {state.detail}</span>
                        )}
                      </>
                    )}
                  </button>
                  {h.kind === "lead" && h.callable && (
                    <button
                      type="button"
                      onClick={() => go(callHref(h.lead.id))}
                      className="flex flex-none items-center gap-1 rounded-control bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
                    >
                      <Icon name="phone" size={13} />
                      Call
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
