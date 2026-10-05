"use client";

// "Someone rang me."
//
// A lead does not answer at eleven, rings back at four, and gives on that
// call. Until now the caller had nowhere to put that: the call screen only
// opens on somebody DRM has queued, so the callback - often the call that
// brought the money in - went unrecorded and the caller uncredited.
//
// This finds them by the number on the phone (or a name), and opens the call
// screen on them marked as a call THEY made, so the outcome, the donation and
// the credit are logged exactly as any other call. Someone not in DRM at all
// is added in the same breath - a stranger ringing the temple to give is the
// warmest lead there is.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { callHref, formatPhone } from "@/lib/calling";
import { currency } from "@/lib/format";
import { Alert, Badge, Button, Field, Icon, Input, Modal, SearchInput, Skeleton, Spinner } from "@/components/ui";
import { toast } from "@/components/toast";

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

interface PersonHit {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  total_donated: string | number | null;
}

interface CreatedLead {
  lead: { id: string; name: string | null; phone: string; assigned_to: string | null };
  created: boolean;
  duplicate: boolean;
}

/** The last ten digits of whatever was typed, if it is a whole Indian mobile. */
function mobileFrom(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

const last10 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);

/** The call screen for this lead, marked as a call that came in. */
function inboundHref(leadId: string, back: string) {
  return `${callHref(leadId, back)}&inbound=1`;
}

export function RangMeDialog({ onClose, back }: { onClose: () => void; back: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const isCaller = user?.role === "caller";

  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [result, setResult] = useState<{ q: string; leads: LeadHit[]; people: PersonHit[]; owned_by?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  // The "add them" form. Filled from what was typed - a number goes in the
  // number box, anything else in the name - and editable from there.
  const [showAdd, setShowAdd] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (debounced.length < 2) return;
    let live = true;
    apiClient
      .get<{ leads: LeadHit[]; people: PersonHit[]; owned_by?: string | null }>(`/api/crm/search?q=${encodeURIComponent(debounced)}`)
      .then(
        (r) => {
          if (!live) return;
          setResult({ q: debounced, leads: r.leads ?? [], people: r.people ?? [], owned_by: r.owned_by ?? null });
          setError(null);
        },
        (e) => live && setError(e instanceof Error ? e.message : "Could not search")
      );
    return () => {
      live = false;
    };
  }, [debounced]);

  const searching = debounced.length >= 2 && result?.q !== debounced && !error;
  const current = debounced.length >= 2 && result?.q === debounced ? result : null;
  const leads = useMemo(() => current?.leads ?? [], [current]);
  // Donors DRM knows who are not leads yet - matched by number, so somebody
  // who is both shows once, as the lead.
  const people = useMemo(() => {
    const leadPhones = new Set(leads.flatMap((l) => [last10(l.phone), last10(l.alt_phone)]).filter(Boolean));
    return (current?.people ?? []).filter((p) => p.phone && !leadPhones.has(last10(p.phone)));
  }, [current, leads]);
  const nothing = !!current && !leads.length && !people.length;

  // Seed the add form from the search box until the caller edits it.
  const typedPhone = mobileFrom(q);
  if (!touched) {
    const seedPhone = typedPhone ?? "";
    const seedName = /\d/.test(q) ? "" : q.trim();
    if (seedPhone !== phone) setPhone(seedPhone);
    if (seedName !== name) setName(seedName);
  }
  const addOpen = !result?.owned_by && (showAdd || nothing);
  const validPhone = mobileFrom(phone);

  function open(leadId: string, label: string) {
    setOpening(leadId);
    toast(`Log the call with ${label}`, { body: "Marked as a call they made to you", tone: "info" });
    router.push(inboundHref(leadId, back));
  }

  async function addAndOpen(input: { phone: string; name: string | null }, key: string) {
    setAdding(key === "new");
    setOpening(key);
    try {
      const r = await apiClient.post<CreatedLead>("/api/crm/leads", {
        phone: input.phone,
        name: input.name || undefined,
        source: "manual",
        source_detail: "Rang the temple",
        // Theirs: the person rang them. Only applies to a new lead - an
        // existing one keeps whoever it already belongs to.
        assigned_to: user?.id,
      });
      const label = r.lead.name || formatPhone(r.lead.phone);
      // The number was already a colleague's lead, hidden from this caller's
      // search. Opening it would answer "not found"; say whose it is instead.
      if (r.duplicate && isCaller && r.lead.assigned_to && r.lead.assigned_to !== user?.id) {
        toast.warn(
          `${formatPhone(r.lead.phone)} is already another caller's lead`,
          "Ask an admin to move them to you, or let that caller log it."
        );
        setOpening(null);
        return;
      }
      toast(r.created ? `${label} added — now log the call` : `${label} was already a lead — opening them`);
      router.push(inboundHref(r.lead.id, back));
    } catch (e) {
      toast.error("Could not add them", e instanceof Error ? e.message : undefined);
      setOpening(null);
    } finally {
      setAdding(false);
    }
  }

  return (
    <Modal title="Someone rang me" onClose={onClose}>
      <p className="mb-4 text-sm text-ink-muted">
        They rang back? Find them here and log what happened — including a donation taken on the call.
      </p>

      <Field label="Their number, or name" htmlFor="rang-me-search">
        <SearchInput
          id="rang-me-search"
          value={q}
          onChange={setQ}
          placeholder="98765 43210 or a name…"
          inputMode="search"
          autoComplete="off"
        />
      </Field>

      {error && (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      )}

      <div className="mt-3 space-y-2" aria-live="polite">
        {debounced.length < 2 && (
          <p className="text-xs text-ink-faint">Type at least two characters — the last few digits of the number work.</p>
        )}
        {searching && (
          <>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </>
        )}

        {leads.map((l) => (
          <button
            key={l.id}
            type="button"
            disabled={opening !== null}
            onClick={() => open(l.id, l.name || formatPhone(l.phone))}
            className="flex min-h-14 w-full items-center gap-3 rounded-control border border-line-soft bg-surface px-3 py-2.5 text-left transition-colors hover:border-brand-400 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:opacity-60"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-ink">{l.name || "Name not known"}</span>
              <span className="block truncate text-xs tabular-nums text-ink-muted">
                {formatPhone(l.phone)}
                {l.alt_phone && ` · also ${formatPhone(l.alt_phone)}`}
                {l.city && ` · ${l.city}`}
              </span>
              <span className="mt-1 flex flex-wrap gap-1">
                {l.status_label && <Badge>{l.status_label}</Badge>}
                {l.do_not_call && <Badge tone="danger">Asked not to be called</Badge>}
                {l.assigned_to_name && <Badge tone="info">{l.assigned_to_name}</Badge>}
              </span>
            </span>
            {opening === l.id ? (
              <Spinner size={16} />
            ) : (
              <Icon name="chevronRight" size={16} className="flex-none text-ink-muted" />
            )}
          </button>
        ))}

        {people.length > 0 && (
          <>
            <p className="pt-1 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
              Donors in DRM, not yet leads
            </p>
            {people.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={opening !== null}
                onClick={() => void addAndOpen({ phone: last10(p.phone), name: p.name }, p.id)}
                className="flex min-h-14 w-full items-center gap-3 rounded-control border border-dashed border-line-strong bg-surface px-3 py-2.5 text-left transition-colors hover:border-brand-400 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:opacity-60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{p.name || "Name not known"}</span>
                  <span className="block truncate text-xs tabular-nums text-ink-muted">
                    {formatPhone(p.phone)}
                    {Number(p.total_donated) > 0 && ` · has given ${currency(p.total_donated)}`}
                  </span>
                </span>
                <span className="flex-none text-xs font-medium text-brand-700">Add &amp; log</span>
              </button>
            ))}
          </>
        )}

        {result?.owned_by && (
          <p className="rounded-control bg-warn-wash px-3 py-2 text-sm text-ink-soft">
            That number is <strong className="text-ink">{result.owned_by}</strong>&apos;s lead. Let them know they rang
            back, or ask an admin to hand the lead to you.
          </p>
        )}
        {nothing && !result?.owned_by && (
          <p className="text-sm text-ink-soft">
            Nobody in DRM matches <strong className="text-ink">{debounced}</strong>.
          </p>
        )}
      </div>

      {!addOpen && current && (
        <Button variant="ghost" icon="userPlus" className="mt-3" onClick={() => setShowAdd(true)}>
          Not them? Add someone new
        </Button>
      )}

      {addOpen && (
        <form
          className="mt-4 space-y-3 rounded-card border border-line-soft bg-sunken p-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (validPhone) void addAndOpen({ phone: validPhone, name: name.trim() || null }, "new");
          }}
        >
          <p className="text-sm font-medium text-ink">Add them and log the call</p>
          <Field
            label="Number they rang from"
            htmlFor="rang-me-phone"
            error={touched && phone && !validPhone ? "A 10-digit mobile number" : undefined}
          >
            <Input
              id="rang-me-phone"
              value={phone}
              inputMode="tel"
              autoComplete="off"
              placeholder="10-digit mobile"
              onChange={(e) => {
                setTouched(true);
                setPhone(e.target.value);
              }}
            />
          </Field>
          <Field label="Name" hint="As they gave it — you can correct it on the call screen" htmlFor="rang-me-name">
            <Input
              id="rang-me-name"
              value={name}
              autoComplete="off"
              placeholder="Name"
              onChange={(e) => {
                setTouched(true);
                setName(e.target.value);
              }}
            />
          </Field>
          <Button type="submit" icon="phone" block size="lg" loading={adding} disabled={!validPhone || opening !== null}>
            Add and log the call
          </Button>
        </form>
      )}
    </Modal>
  );
}
