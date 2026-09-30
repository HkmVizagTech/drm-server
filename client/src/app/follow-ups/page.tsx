"use client";

// Follow-ups - the promises the temple has made.
//
// Every row here is somebody who was told they would be rung back. That is why
// overdue comes first and is the loudest thing on the screen: a missed callback
// is not an admin tidiness problem, it is a donor who was told something that
// turned out not to be true.
//
// Three buckets, in the order they matter: overdue, today, then the week ahead.
// Each row can be acted on without leaving the page - ring it, push it, or drop
// it - because a board that forces a detour to the lead screen for every line
// stops being worked after the first twenty.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { currency, dueLabel, number, shortDate } from "@/lib/format";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Modal,
  PageHeader,
  Select,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  AlertPicker,
} from "@/components/ui";
import { ALERT_OPTIONS, DEFAULT_ALERTS } from "@/lib/reminders";

interface Lead {
  id: string;
  phone: string;
  name: string | null;
  city: string | null;
  status_label: string | null;
  next_follow_up_at: string | null;
  follow_up_note: string | null;
  remarks: string | null;
  call_attempts: number;
  expected_amount: string | null;
  assigned_to_name: string | null;
  total_donated: string | null;
  donation_count: number | null;
}

interface Bucket {
  key: string;
  title: string;
  caption: string;
  query: string;
  tone: "danger" | "warn" | "neutral";
}

const BUCKETS: Bucket[] = [
  {
    key: "overdue",
    title: "Overdue",
    caption: "Promised a call that hasn't happened",
    query: "due=overdue",
    tone: "danger",
  },
  {
    key: "today",
    title: "Due today",
    caption: "Booked for today",
    query: "due=today_only",
    tone: "warn",
  },
  {
    key: "upcoming",
    title: "Coming up",
    caption: "Booked for later — nothing to do yet",
    query: "due=upcoming",
    tone: "neutral",
  },
];

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

interface Batch {
  id: string;
  filename: string;
  sheet_name: string | null;
  label: string | null;
  leads_added: number;
}
interface Config {
  users: { id: string; name: string; role: string }[];
  batches: Batch[];
  preachers: { id: string; code: string; name: string | null }[];
}

/** What the office calls a sheet: its own label, else the tab, else the file. */
function batchName(b: Batch): string {
  const base = b.label || b.filename.replace(/\.(xlsx|xls|csv)$/i, "");
  return b.sheet_name && b.sheet_name !== base ? `${base} · ${b.sheet_name}` : base;
}


export default function FollowUpsPage() {
  const [data, setData] = useState<Record<string, Lead[]>>({});
  const [loading, setLoading] = useState(true);
  const [mineOnly, setMineOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [adding, setAdding] = useState(false);

  // The narrowing. Empty string means "everything", so one Select can offer an
  // "all" row without a separate flag per filter.
  const [batch, setBatch] = useState("");
  const [preacher, setPreacher] = useState("");
  const [who, setWho] = useState("");
  const [search, setSearch] = useState("");

  // Who is signed in, so "just mine" can filter without asking. Comes from the
  // auth context rather than localStorage: the context is the one place that
  // knows whether the session is still valid.
  const { user } = useAuth();
  const me = user?.id ?? null;

  // "Just mine" and the assignee dropdown are the same filter, so they are
  // resolved here once rather than fighting each other in the query string.
  const assignee = mineOnly && me ? me : who;

  const extra = useMemo(() => {
    const p = new URLSearchParams();
    if (assignee) p.set("assigned_to", assignee);
    if (batch) p.set("batch", batch);
    if (preacher) p.set("preacher", preacher);
    if (search.trim()) p.set("search", search.trim());
    const s = p.toString();
    return s ? `&${s}` : "";
  }, [assignee, batch, preacher, search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const results = await Promise.all(
        BUCKETS.map((b) =>
          apiClient.get<{ leads: Lead[] }>(`/api/crm/leads?${b.query}&sort=due&limit=100${extra}`)
        )
      );
      setData(Object.fromEntries(BUCKETS.map((b, i) => [b.key, results[i].leads])));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load follow-ups");
    } finally {
      setLoading(false);
    }
  }, [extra]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    apiClient
      .get<Config>("/api/crm/config")
      .then(setConfig)
      // A failed config load costs the filters, not the board. The board is
      // what somebody came here for.
      .catch(() => undefined);
  }, []);

  async function push(id: string, days: number) {
    await apiClient.post(`/api/crm/leads/${id}/follow-up`, { at: inDays(days) });
    await load();
  }

  async function drop(id: string) {
    await apiClient.put(`/api/crm/leads/${id}`, { next_follow_up_at: null });
    await load();
  }

  const overdueCount = data.overdue?.length ?? 0;

  return (
    <div>
      <PageHeader
        title="Follow-ups"
        subtitle="Calls the temple said it would make"
        actions={
          <div className="flex gap-2">
            <button
              onClick={() => setMineOnly((v) => !v)}
              className={mineOnly ? buttonPrimary : buttonSecondary}
              disabled={!me}
            >
              {mineOnly ? "Showing just mine" : "Just mine"}
            </button>
            <button onClick={() => setAdding(true)} className={buttonSecondary}>
              Someone promised to give
            </button>
            <Link href="/calling/queue" className={buttonPrimary}>
              Start calling
            </Link>
          </div>
        }
      />

      {/* --------------------------------------------------------- narrowing */}
      {/* The sheet comes first because it is how the office thinks about its
          people — "the Janmashtami file", "last year's general donations" —
          and a board of four hundred callbacks is only workable one sheet at
          a time. */}
      <div className="mb-5 flex flex-wrap items-end gap-2">
        <label className="min-w-[13rem] flex-1 text-xs text-slate-500">
          Sheet
          <Select
            value={batch}
            onChange={setBatch}
            className="mt-1 w-full"
            options={[
              { value: "", label: "Every sheet" },
              { value: "none", label: "Not from a sheet" },
              ...(config?.batches ?? []).map((b) => ({
                value: b.id,
                label: batchName(b),
                hint: `${number(b.leads_added)} added`,
              })),
            ]}
          />
        </label>

        {!!config?.preachers.length && (
          <label className="min-w-[10rem] flex-1 text-xs text-slate-500">
            Preacher
            <Select
              value={preacher}
              onChange={setPreacher}
              className="mt-1 w-full"
              options={[
                { value: "", label: "Anyone's" },
                { value: "none", label: "No preacher" },
                ...config.preachers.map((p) => ({
                  value: p.id,
                  label: p.name ? `${p.code} — ${p.name}` : p.code,
                })),
              ]}
            />
          </label>
        )}

        <label className="min-w-[10rem] flex-1 text-xs text-slate-500">
          Caller
          <Select
            value={mineOnly ? (me ?? "") : who}
            onChange={(v) => {
              setMineOnly(false);
              setWho(v);
            }}
            className="mt-1 w-full"
            options={[
              { value: "", label: "Everyone" },
              { value: "unassigned", label: "Unassigned" },
              ...(config?.users ?? []).map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
        </label>

        <label className="min-w-[10rem] flex-1 text-xs text-slate-500">
          Find
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, number or town"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>

        {(batch || preacher || who || search || mineOnly) && (
          <button
            onClick={() => {
              setBatch("");
              setPreacher("");
              setWho("");
              setSearch("");
              setMineOnly(false);
            }}
            className="rounded-lg px-3 py-2 text-xs text-slate-500 hover:bg-slate-100"
          >
            Clear
          </button>
        )}
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {!loading && overdueCount === 0 && (
        <Card className="mb-5 border-emerald-200 bg-emerald-50/60">
          <p className="text-sm font-medium text-emerald-900">
            Nothing is overdue{extra ? " in what you are looking at" : ""}.
          </p>
          <p className="text-xs text-emerald-800 mt-0.5">Every callback that was promised has either happened or is still in the future.</p>
        </Card>
      )}

      <div className="space-y-6">
        {BUCKETS.map((b) => {
          const rows = data[b.key] ?? [];
          return (
            <Card key={b.key} padded={false}>
              <div className="px-5 pt-5">
                <CardHeader
                  title={`${b.title}${rows.length ? ` · ${number(rows.length)}` : ""}`}
                  subtitle={b.caption}
                />
              </div>

              {loading ? (
                <div className="px-5 pb-5 space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-12 rounded-lg bg-slate-100 animate-pulse" />
                  ))}
                </div>
              ) : !rows.length ? (
                <div className="px-5 pb-5">
                  <p className="text-sm text-slate-500">Nothing here.</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 border-t border-[var(--line-soft)]">
                  {rows.map((l) => (
                    <li key={l.id} className="px-5 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 hover:bg-slate-50/60">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={`/leads/${l.id}`} className="font-medium text-slate-900 hover:text-[var(--accent)] truncate">
                            {l.name || l.phone}
                          </Link>
                          {l.status_label && <Badge tone="info">{l.status_label}</Badge>}
                          {l.donation_count ? (
                            <span className="block text-xs text-slate-500 mb-1">
                              given {currency(Number(l.total_donated ?? 0))}
                            </span>
                          ) : null}
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          <span className={b.tone === "danger" ? "text-amber-700 font-medium" : ""}>
                            {l.next_follow_up_at
                              ? `${shortDate(l.next_follow_up_at)} · ${dueLabel(l.next_follow_up_at)}`
                              : ""}
                          </span>
                          {l.follow_up_note && <> — “{l.follow_up_note}”</>}
                          {!l.follow_up_note && l.remarks && <> — “{l.remarks}”</>}
                          {l.assigned_to_name && <> · {l.assigned_to_name}</>}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <a
                          href={`tel:+91${l.phone}`}
                          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                        >
                          Call
                        </a>
                        <button
                          onClick={() => void push(l.id, 1)}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                        >
                          Tomorrow
                        </button>
                        <button
                          onClick={() => void push(l.id, 7)}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                        >
                          Next week
                        </button>
                        <button
                          onClick={() => void drop(l.id)}
                          title="Remove the callback without changing the lead"
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
                        >
                          Drop
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      {!loading && !Object.values(data).some((r) => r.length) && (
        <Card padded={false} className="mt-5">
          <EmptyState
            title={extra ? "Nothing matches that" : "No callbacks booked"}
            message={
              extra
                ? "Try a wider sheet or clear the filters."
                : "Follow-ups appear here as callers book them during calls, and you can add one yourself when a donor rings the temple."
            }
            action={
              <Link href="/calling/queue" className={buttonPrimary}>
                Start calling
              </Link>
            }
          />
        </Card>
      )}

      {adding && (
        <PromiseDialog
          users={config?.users ?? []}
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Recording a promise somebody made over the phone.
 *
 * THE SITUATION
 * The temple's phone rings. A donor says "I will give ten thousand on
 * Govardhan Puja, ring me that morning". Before this, DRM had nowhere to put
 * that: the caller would have had to find or create the lead, open it, set a
 * callback, then raise a reminder - four screens for one sentence - so it went
 * on paper and was remembered by whoever picked up.
 *
 * The date and the alerts are the substance here, not the contact details. A
 * name is optional; the number is not, because the number is the identity DRM
 * matches everything else on.
 */
function PromiseDialog({
  users,
  onClose,
  onDone,
}: {
  users: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [occasion, setOccasion] = useState("");
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState("");
  // Default to a sensible hour rather than midnight: "the 12th" means the 12th
  // during the day, and a reminder timed at 00:00 fires the night before.
  const [when, setWhen] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    d.setHours(10, 0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [alerts, setAlerts] = useState<number[]>(DEFAULT_ALERTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = phone.replace(/\D/g, "").length >= 10 && !!when;

  return (
    <Modal title="Someone promised to give" onClose={onClose}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <p className="mb-4 text-sm text-slate-600">
        For a donor who rang the temple and named a date. DRM finds them by number — or adds them if they are new —
        books the callback, and alerts you before the day arrives.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-500">
          Their number <span className="text-red-600">*</span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ""))}
            placeholder="98480 12345"
            inputMode="tel"
            className={`${inputClass} mt-1 w-full tabular-nums`}
          />
        </label>
        <label className="text-xs text-slate-500">
          Their name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Left blank if you did not catch it"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>

        <label className="text-xs text-slate-500">
          When they said they would give <span className="text-red-600">*</span>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
        <label className="text-xs text-slate-500">
          How much they said
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            placeholder="Optional"
            inputMode="numeric"
            className={`${inputClass} mt-1 w-full tabular-nums`}
          />
        </label>

        <label className="text-xs text-slate-500">
          The occasion they named
          <input
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
            placeholder="e.g. Govardhan Puja, after salary day"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
        <label className="text-xs text-slate-500">
          Who should ring them
          <Select
            value={assignee}
            onChange={setAssignee}
            className="mt-1 w-full"
            options={[{ value: "", label: "Me" }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
          />
        </label>

        <label className="text-xs text-slate-500 sm:col-span-2">
          What they said, in their words
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Read back on the call — worth the extra few seconds now."
            className={`${inputClass} mt-1 w-full`}
          />
        </label>

        {/* The alerts. More than one, because a promise made weeks out needs
            warning long before the morning it falls due — which is the whole
            reason this is a reminder and not just a date on a board. */}
        <div className="text-xs text-slate-500 sm:col-span-2">
          Warn me
          <div className="mt-1.5">
            <AlertPicker value={alerts} onChange={setAlerts} options={ALERT_OPTIONS} />
          </div>
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={buttonSecondary}>
          Cancel
        </button>
        <button
          disabled={busy || !ready}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await apiClient.post("/api/crm/promises", {
                phone,
                name: name.trim() || undefined,
                // datetime-local has no zone, so it is read in the browser's
                // own — which is the temple's, and is what the caller meant.
                due_at: new Date(when).toISOString(),
                expected_amount: amount ? Number(amount) : undefined,
                occasion: occasion.trim() || undefined,
                note: note.trim() || undefined,
                assigned_to: assignee || undefined,
                lead_times: alerts,
              });
              await onDone();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not record that");
              setBusy(false);
            }
          }}
          className={buttonPrimary}
        >
          {busy ? "Saving…" : "Record it"}
        </button>
      </div>
    </Modal>
  );
}
