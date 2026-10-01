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
import { currency, dueLabel, istDayPlus, istInputToISO, istInstant, number, shortDate } from "@/lib/format";
import {
  Alert,
  AlertPicker,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  LinkButton,
  Modal,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
  Textarea,
  Toolbar,
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

// 10am on the n-th day from now at the temple, counted off the IST calendar so
// that the day a caller picks is the day the office will see.
function inDays(n: number): string {
  return istInstant(istDayPlus(n), "10:00").toISOString();
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
  const activeFilters = [batch, preacher, who, search.trim(), mineOnly].filter(Boolean).length;
  const clearFilters = () => {
    setBatch("");
    setPreacher("");
    setWho("");
    setSearch("");
    setMineOnly(false);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="Follow-ups"
        subtitle="Calls the temple said it would make"
        actions={
          <>
            {/* Who the board is for, as a switch rather than a primary button.
                It used to be `mineOnly ? buttonPrimary : buttonSecondary`, so
                when it was on it looked exactly like "Start calling" beside it —
                two different things, one appearance. Greyed out rather than
                hidden when nobody is signed in, because there is then no id to
                filter on and a control that silently does nothing is worse. */}
            <SegmentedControl
              options={[
                { value: "everyone", label: "Everyone" },
                { value: "mine", label: "Just mine" },
              ]}
              value={mineOnly ? "mine" : "everyone"}
              onChange={(v) => setMineOnly(v === "mine")}
              className={me ? "" : "pointer-events-none opacity-45"}
            />
            <Button variant="secondary" icon="bell" onClick={() => setAdding(true)}>
              Someone promised to give
            </Button>
            <LinkButton href="/calling/queue" variant="primary" icon="phoneOutgoing">
              Start calling
            </LinkButton>
          </>
        }
      />

      {/* --------------------------------------------------------- narrowing */}
      {/* The sheet comes first because it is how the office thinks about its
          people — "the Janmashtami file", "last year's general donations" —
          and a board of four hundred callbacks is only workable one sheet at
          a time. */}
      <Toolbar onClear={clearFilters} activeCount={activeFilters}>
        <Field label="Sheet" className="min-w-[13rem] flex-1">
          <Select
            value={batch}
            onChange={setBatch}
            ariaLabel="Sheet"
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
        </Field>

        {!!config?.preachers.length && (
          <Field label="Preacher" className="min-w-[10rem] flex-1">
            <Select
              value={preacher}
              onChange={setPreacher}
              ariaLabel="Preacher"
              options={[
                { value: "", label: "Anyone's" },
                { value: "none", label: "No preacher" },
                ...config.preachers.map((p) => ({
                  value: p.id,
                  label: p.name ? `${p.code} — ${p.name}` : p.code,
                })),
              ]}
            />
          </Field>
        )}

        <Field label="Caller" className="min-w-[10rem] flex-1">
          <Select
            value={mineOnly ? (me ?? "") : who}
            onChange={(v) => {
              setMineOnly(false);
              setWho(v);
            }}
            ariaLabel="Caller"
            options={[
              { value: "", label: "Everyone" },
              { value: "unassigned", label: "Unassigned" },
              ...(config?.users ?? []).map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
        </Field>

        <Field label="Find" htmlFor="follow-ups-search" className="min-w-[10rem] flex-1">
          <SearchInput
            id="follow-ups-search"
            value={search}
            onChange={setSearch}
            placeholder="Name, number or town"
          />
        </Field>
      </Toolbar>

      {error && <Alert tone="danger">{error}</Alert>}

      {!loading && overdueCount === 0 && (
        <Alert tone="good" title={`Nothing is overdue${extra ? " in what you are looking at" : ""}.`}>
          Every callback that was promised has either happened or is still in the future.
        </Alert>
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
                <div className="space-y-2 px-5 pb-5">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : !rows.length ? (
                <div className="px-5 pb-5">
                  <p className="text-sm text-ink-muted">Nothing here.</p>
                </div>
              ) : (
                <ul className="divide-y divide-line-soft border-t border-line-soft">
                  {rows.map((l) => (
                    <li
                      key={l.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 transition-colors hover:bg-brand-50/60"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={`/leads/${l.id}`} className="truncate font-medium text-ink hover:text-brand-700">
                            {l.name || l.phone}
                          </Link>
                          {l.status_label && <Badge tone="info">{l.status_label}</Badge>}
                          {l.donation_count ? (
                            <span className="text-xs text-ink-muted">
                              given {currency(Number(l.total_donated ?? 0))}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 text-xs text-ink-muted">
                          <span className={b.tone === "danger" ? "font-medium text-warn" : ""}>
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
                        <LinkButton href={`tel:+91${l.phone}`} variant="primary" size="xs" icon="phone">
                          Call
                        </LinkButton>
                        <Button variant="secondary" size="xs" onClick={() => void push(l.id, 1)}>
                          Tomorrow
                        </Button>
                        <Button variant="secondary" size="xs" onClick={() => void push(l.id, 7)}>
                          Next week
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => void drop(l.id)}
                          title="Remove the callback without changing the lead"
                        >
                          Drop
                        </Button>
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
              <LinkButton href="/calling/queue" variant="primary" icon="phoneOutgoing">
                Start calling
              </LinkButton>
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
  const [when, setWhen] = useState(() => `${istDayPlus(7)}T10:00`);
  const [alerts, setAlerts] = useState<number[]>(DEFAULT_ALERTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = phone.replace(/\D/g, "").length >= 10 && !!when;

  return (
    <Modal
      title="Someone promised to give"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!ready}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await apiClient.post("/api/crm/promises", {
                  phone,
                  name: name.trim() || undefined,
                  // datetime-local has no zone on it, so the hour is read as IST
                  // explicitly rather than in the browser's own - which is the
                  // temple's zone only as long as nobody opens this abroad.
                  due_at: istInputToISO(when),
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
          >
            {busy ? "Saving…" : "Record it"}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="mb-4 text-sm text-ink-soft">
        For a donor who rang the temple and named a date. DRM finds them by number — or adds them if they are new —
        books the callback, and alerts you before the day arrives.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Their number" htmlFor="promise-phone" required>
          <Input
            id="promise-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ""))}
            placeholder="98480 12345"
            inputMode="tel"
            className="tabular-nums"
          />
        </Field>
        <Field label="Their name" htmlFor="promise-name">
          <Input
            id="promise-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Left blank if you did not catch it"
          />
        </Field>

        <Field label="When they said they would give" htmlFor="promise-when" required>
          <Input
            id="promise-when"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </Field>
        <Field label="How much they said" htmlFor="promise-amount">
          <Input
            id="promise-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            placeholder="Optional"
            inputMode="numeric"
            className="tabular-nums"
          />
        </Field>

        <Field label="The occasion they named" htmlFor="promise-occasion">
          <Input
            id="promise-occasion"
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
            placeholder="e.g. Govardhan Puja, after salary day"
          />
        </Field>
        <Field label="Who should ring them">
          <Select
            value={assignee}
            onChange={setAssignee}
            ariaLabel="Who should ring them"
            options={[{ value: "", label: "Me" }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
          />
        </Field>

        <Field label="What they said, in their words" htmlFor="promise-note" className="sm:col-span-2">
          <Textarea
            id="promise-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Read back on the call — worth the extra few seconds now."
          />
        </Field>

        {/* The alerts. More than one, because a promise made weeks out needs
            warning long before the morning it falls due — which is the whole
            reason this is a reminder and not just a date on a board. */}
        <Field label="Warn me" className="sm:col-span-2">
          <div className="mt-1.5">
            <AlertPicker value={alerts} onChange={setAlerts} options={ALERT_OPTIONS} />
          </div>
        </Field>
      </div>
    </Modal>
  );
}
