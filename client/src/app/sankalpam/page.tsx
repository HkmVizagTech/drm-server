"use client";

// Sankalpam: a small puja on a donor's special day, filmed and sent to them -
// every year, on the same day.
//
// THREE VIEWS
//   Today     the day's work: what to send today, what was missed, what is
//             coming tomorrow and this week. Where the caller starts.
//   Calendar  a month at a glance, for planning and for looking back.
//   Donors    everybody and their days, to add, change or switch off.
//
// A day moves To do -> Video ready -> Sent (or Skipped this year). What was
// done is kept per year, so next year the same day is To do again.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import { istToday, number } from "@/lib/format";
import {
  KIND,
  MONTHS_LONG,
  dayKind,
  dayLabel,
  dayMonth,
  isPending,
  sameName,
  type Occurrence,
  type SankalpDonor,
  type SankalpStatus,
} from "@/lib/sankalpam";
import { useCallingAlerts } from "@/components/calling-alerts";
import { toast } from "@/components/toast";
import { ExportButton } from "@/components/export-button";
import { SankalpRow } from "@/components/sankalpam/sankalp-row";
import { DonorDialog } from "@/components/sankalpam/donor-dialog";
import { UploadDialog } from "@/components/sankalpam/upload-dialog";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  PageHeader,
  SearchInput,
  Select,
  Skeleton,
  StatTile,
  Tabs,
} from "@/components/ui";

type Tab = "today" | "calendar" | "donors";
const key = (o: { date_id: string; year: number }) => `${o.date_id}:${o.year}`;

export default function SankalpamPage() {
  return (
    <Suspense fallback={null}>
      <Sankalpam />
    </Suspense>
  );
}

function Sankalpam() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = (["today", "calendar", "donors"].includes(params.get("tab") ?? "") ? params.get("tab") : "today") as Tab;
  const setTab = (t: string) => router.replace(t === "today" ? pathname : `${pathname}?tab=${t}`, { scroll: false });

  const { sankalpam: summary, refresh: refreshAlerts } = useCallingAlerts();
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [uploading, setUploading] = useState(false);
  // Bumped after any change, so whichever view is open reloads.
  const [version, setVersion] = useState(0);
  const changed = useCallback(async () => {
    setVersion((v) => v + 1);
    await refreshAlerts();
  }, [refreshAlerts]);

  const due = summary ? summary.today + summary.missed : undefined;

  return (
    <div>
      <PageHeader
        eyebrow="Seva"
        title="Sankalpam"
        subtitle="Puja videos for donors' special days. Every day repeats each year."
        actions={
          <>
            <ExportButton path="/api/sankalpam/export" filename="sankalpam" />
            <Button variant="secondary" icon="upload" onClick={() => setUploading(true)}>
              Upload sheet
            </Button>
            <Button icon="plus" onClick={() => setEditing(null)}>
              Add sankalp
            </Button>
          </>
        }
      />

      <Tabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        items={[
          { key: "today", label: "Today", icon: "bell", count: due || undefined },
          { key: "calendar", label: "Calendar", icon: "calendar" },
          { key: "donors", label: "Donors", icon: "users" },
        ]}
      />

      {tab === "today" && <TodayView version={version} onEdit={setEditing} onChanged={changed} onAdd={() => setEditing(null)} onUpload={() => setUploading(true)} />}
      {tab === "calendar" && <CalendarView version={version} onEdit={setEditing} onChanged={changed} />}
      {tab === "donors" && <DonorsView version={version} onEdit={setEditing} />}

      {editing !== undefined && (
        <DonorDialog
          donorId={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined);
            await changed();
          }}
        />
      )}
      {uploading && (
        <UploadDialog
          onClose={() => setUploading(false)}
          onDone={async () => {
            setUploading(false);
            await changed();
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- status */

/** Changing a day's status, with the list updated at once and put back if the save fails. */
function useStatus(items: Occurrence[], setItems: (f: (x: Occurrence[]) => Occurrence[]) => void, onChanged: () => void) {
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const apply = useCallback(
    async (targets: Occurrence[], status: SankalpStatus) => {
      if (!targets.length) return;
      const keys = new Set(targets.map(key));
      const before = new Map(items.filter((o) => keys.has(key(o))).map((o) => [key(o), o]));
      setBusy((b) => new Set([...b, ...keys]));
      setItems((xs) =>
        xs.map((o) =>
          keys.has(key(o))
            ? { ...o, status, done_at: status === "todo" ? null : new Date().toISOString(), done_by_name: status === "todo" ? null : "You" }
            : o
        )
      );
      try {
        if (targets.length === 1) {
          await apiClient.put(`/api/sankalpam/dates/${targets[0].date_id}/${targets[0].year}`, { status });
        } else {
          await apiClient.post(`/api/sankalpam/dates/status`, {
            items: targets.map((o) => ({ date_id: o.date_id, year: o.year })),
            status,
          });
        }
        const words: Record<SankalpStatus, string> = { todo: "Back to to do", ready: "Video ready", sent: "Sent", skipped: "Skipped this year" };
        toast(targets.length === 1 ? `${words[status]} · ${targets[0].donor_name}` : `${words[status]} · ${targets.length} days`);
        onChanged();
      } catch (e) {
        setItems((xs) => xs.map((o) => before.get(key(o)) ?? o));
        toast.error("Could not save. Try again.", e instanceof Error ? e.message : undefined);
      } finally {
        setBusy((b) => new Set([...b].filter((k) => !keys.has(k))));
      }
    },
    [items, setItems, onChanged]
  );
  return { apply, busy };
}

/* ---------------------------------------------------------------- today */

function TodayView({
  version,
  onEdit,
  onChanged,
  onAdd,
  onUpload,
}: {
  version: number;
  onEdit: (id: string) => void;
  onChanged: () => void;
  onAdd: () => void;
  onUpload: () => void;
}) {
  const [data, setData] = useState<{ today: string; tomorrow: string; items: Occurrence[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const items = data?.items ?? [];
  const setItems = useCallback(
    (f: (x: Occurrence[]) => Occurrence[]) => setData((d) => (d ? { ...d, items: f(d.items) } : d)),
    []
  );
  const { apply, busy } = useStatus(items, setItems, onChanged);

  useEffect(() => {
    let live = true;
    apiClient
      .get<{ today: string; tomorrow: string; items: Occurrence[] }>("/api/sankalpam/board?days=7")
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load."));
    return () => {
      live = false;
    };
  }, [version]);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <StatTile key={i} label="" value="" loading />
          ))}
        </div>
        <Skeleton className="h-40" />
      </div>
    );
  }

  const { today, tomorrow } = data;
  const missed = items.filter((o) => o.due_on < today && isPending(o));
  const todays = items.filter((o) => o.due_on === today).sort((a, b) => Number(!isPending(a)) - Number(!isPending(b)));
  const tomorrows = items.filter((o) => o.due_on === tomorrow);
  const later = items.filter((o) => o.due_on > tomorrow);
  const todaySent = todays.filter((o) => o.status === "sent").length;
  const todayLeft = todays.filter(isPending).length;

  if (!items.length) {
    return (
      <Card padded={false}>
        <EmptyState
          icon="sparkle"
          title="Nothing due this week"
          message="Add donors and their special days, or upload the office's sheet."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="secondary" icon="upload" onClick={onUpload}>
                Upload sheet
              </Button>
              <Button icon="plus" onClick={onAdd}>
                Add sankalp
              </Button>
            </div>
          }
        />
      </Card>
    );
  }

  const selectedItems = items.filter((o) => selected.has(key(o)) && isPending(o));
  const toggle = (o: Occurrence, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(key(o));
      else n.delete(key(o));
      return n;
    });
  const bulk = async (status: SankalpStatus) => {
    await apply(selectedItems, status);
    setSelected(new Set());
  };

  const late = (o: Occurrence) => {
    const days = Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${o.due_on}T00:00:00Z`).getTime()) / 86400000);
    return days === 1 ? "1 day late" : `${days} days late`;
  };

  const row = (o: Occurrence, extra?: { lateBy?: string }) => (
    <SankalpRow
      key={key(o)}
      o={o}
      busy={busy.has(key(o))}
      selected={selected.has(key(o))}
      onSelect={(on) => toggle(o, on)}
      onStatus={(x, st) => void apply([x], st)}
      onEdit={onEdit}
      lateBy={extra?.lateBy}
    />
  );

  // Coming up, a heading per day.
  const laterDays = [...new Set(later.map((o) => o.due_on))];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="To send today"
          value={number(todayLeft)}
          sub={todays.length ? `${todaySent} of ${todays.length} sent` : "Nothing today"}
          icon="sparkle"
          accent={todayLeft ? "warn" : "good"}
        />
        <StatTile label="Missed" value={number(missed.length)} sub="Last 2 weeks" icon="alert" accent={missed.length ? "danger" : "default"} />
        <StatTile label="Tomorrow" value={number(tomorrows.length)} sub={dayLabel(tomorrow)} icon="calendar" accent="brand" />
        <StatTile label="Next 7 days" value={number(later.length)} sub="After tomorrow" icon="clock" />
      </div>

      {missed.length > 0 && (
        <Section title="Missed" subtitle="Still worth sending - a few days late is better than never." tone="danger" count={missed.length}>
          {missed.map((o) => row(o, { lateBy: late(o) }))}
        </Section>
      )}

      <Section
        title={`Today · ${dayLabel(today, true)}`}
        subtitle={todays.length ? (todayLeft ? `${todayLeft} to send` : "All done for today") : "No special days today"}
        tone={todayLeft ? "warn" : "good"}
        count={todays.length}
      >
        {todays.length ? todays.map((o) => row(o)) : <li className="px-5 py-6 text-center text-sm text-ink-muted">Nothing due today.</li>}
      </Section>

      <Section title={`Tomorrow · ${dayLabel(tomorrow, true)}`} subtitle="Get these videos ready." count={tomorrows.length}>
        {tomorrows.length ? tomorrows.map((o) => row(o)) : <li className="px-5 py-6 text-center text-sm text-ink-muted">Nothing tomorrow.</li>}
      </Section>

      {laterDays.length > 0 && (
        <Section title="Coming this week" count={later.length}>
          {laterDays.map((d) => (
            <li key={d} className="list-none">
              <p className="sticky top-0 z-[1] border-y border-line-soft bg-sunken/80 px-5 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted backdrop-blur">
                {dayLabel(d, true)}
              </p>
              <ul className="divide-y divide-line-soft">{later.filter((o) => o.due_on === d).map((o) => row(o))}</ul>
            </li>
          ))}
        </Section>
      )}

      {selectedItems.length > 0 && (
        // Several at once - the morning's videos are often all sent together.
        <div className="sticky bottom-4 z-10 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-card border border-line bg-surface px-4 py-2.5 shadow-lg">
          <span className="text-sm font-medium text-ink">{selectedItems.length} selected</span>
          <Button size="sm" variant="secondary" onClick={() => void bulk("ready")}>
            Video ready
          </Button>
          <Button size="sm" icon="check" onClick={() => void bulk("sent")}>
            Sent
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void bulk("skipped")}>
            Skip
          </Button>
          <Button size="sm" variant="ghost" icon="x" aria-label="Clear selection" onClick={() => setSelected(new Set())} />
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  tone,
  count,
  children,
}: {
  title: string;
  subtitle?: string;
  tone?: "danger" | "warn" | "good";
  count?: number;
  children: React.ReactNode;
}) {
  const border = tone === "danger" ? "border-red-200" : tone === "warn" ? "border-amber-200" : "border-line-soft";
  const dot = tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : tone === "good" ? "bg-good" : "bg-brand-500";
  return (
    <Card padded={false} className={`overflow-hidden ${border}`}>
      <div className="flex items-center gap-2.5 px-4 py-3.5 sm:px-5">
        <span className={`h-2.5 w-2.5 flex-none rounded-full ${dot}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">
            {title}
            {count ? <span className="ml-1.5 font-normal text-ink-muted">· {number(count)}</span> : null}
          </h2>
          {subtitle && <p className="text-xs text-ink-muted">{subtitle}</p>}
        </div>
      </div>
      <ul className="divide-y divide-line-soft border-t border-line-soft">{children}</ul>
    </Card>
  );
}

/* ---------------------------------------------------------------- calendar */

function CalendarView({ version, onEdit, onChanged }: { version: number; onEdit: (id: string) => void; onChanged: () => void }) {
  const [thisMonth] = useState(() => istToday().slice(0, 7));
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<{ today: string; items: Occurrence[] } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = useMemo(() => data?.items ?? [], [data]);
  const setItems = useCallback(
    (f: (x: Occurrence[]) => Occurrence[]) => setData((d) => (d ? { ...d, items: f(d.items) } : d)),
    []
  );
  const { apply, busy } = useStatus(items, setItems, onChanged);

  const ym = month ?? thisMonth;
  const [y, m] = ym.split("-").map(Number);
  const first = `${ym}-01`;
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${ym}-${String(daysIn).padStart(2, "0")}`;

  useEffect(() => {
    let live = true;
    apiClient
      .get<{ today: string; items: Occurrence[] }>(`/api/sankalpam/occurrences?from=${first}&to=${last}`)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load."));
    return () => {
      live = false;
    };
  }, [first, last, version]);

  const today = data?.today ?? "";
  const byDay = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    for (const o of items) map.set(o.due_on, [...(map.get(o.due_on) ?? []), o]);
    return map;
  }, [items]);
  const shown = picked && picked.startsWith(ym) ? picked : today.startsWith(ym) ? today : null;
  const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday first
  const move = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
    setPicked(null);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Card>
        <div className="mb-4 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" icon="chevronLeft" aria-label="Previous month" onClick={() => move(-1)} />
          <div className="text-center">
            <p className="text-base font-semibold text-ink">
              {MONTHS_LONG[m - 1]} {y}
            </p>
            <p className="text-xs text-ink-muted">{data ? `${number(items.length)} special days` : " "}</p>
          </div>
          <div className="flex items-center gap-1">
            {month && (
              <Button variant="ghost" size="sm" onClick={() => {
                  setMonth(null);
                  setPicked(null);
                }}>
                Today
              </Button>
            )}
            <Button variant="ghost" size="sm" icon="chevronRight" aria-label="Next month" onClick={() => move(1)} />
          </div>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid grid-cols-7 gap-1 text-center text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <span key={d} className="py-1">
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: lead }, (_, i) => (
            <span key={`b${i}`} />
          ))}
          {Array.from({ length: daysIn }, (_, i) => {
            const d = `${ym}-${String(i + 1).padStart(2, "0")}`;
            const list = byDay.get(d) ?? [];
            const left = list.filter(isPending).length;
            const missed = list.some((o) => isPending(o) && o.due_on >= o.added_on);
            const isToday = d === today;
            const past = today && d < today;
            const on = d === shown;
            const tone = !list.length
              ? ""
              : left === 0
              ? "bg-good-wash text-good"
              : past
              ? missed
                ? "bg-danger-wash text-danger"
                : "bg-sunken text-ink-muted"
              : "bg-amber-100 text-amber-800";
            return (
              <button
                key={d}
                type="button"
                onClick={() => setPicked(d)}
                aria-label={`${dayLabel(d, true)}: ${list.length} special days`}
                className={`flex h-14 flex-col items-center justify-start gap-1 rounded-control pt-1.5 text-sm transition-colors sm:h-16 ${
                  on ? "bg-brand-700 text-white" : "hover:bg-sunken"
                } ${isToday && !on ? "ring-2 ring-brand-500 ring-inset" : ""}`}
              >
                <span className={`tabular-nums ${on ? "font-semibold" : past ? "text-ink-muted" : "text-ink"}`}>{i + 1}</span>
                {list.length > 0 && (
                  <span className={`min-w-6 rounded-full px-1.5 text-2xs font-semibold tabular-nums ${on ? "bg-white/25 text-white" : tone}`}>
                    {left === 0 ? <Icon name="check" size={10} className="inline" /> : left}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300" /> To send
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-good" /> All sent
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-danger" /> Missed
          </span>
        </div>
      </Card>

      <div>
        {shown ? (
          <Section
            title={dayLabel(shown, true)}
            subtitle={(byDay.get(shown) ?? []).length ? undefined : "No special days"}
            count={(byDay.get(shown) ?? []).length}
          >
            {(byDay.get(shown) ?? []).map((o) => (
              <SankalpRow key={key(o)} o={o} busy={busy.has(key(o))} onStatus={(x, st) => void apply([x], st)} onEdit={onEdit} />
            ))}
          </Section>
        ) : (
          <Card>
            <p className="text-sm text-ink-muted">Pick a day to see its sankalps.</p>
          </Card>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- donors */

function DonorsView({ version, onEdit }: { version: number; onEdit: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [preacher, setPreacher] = useState("");
  const [month, setMonth] = useState("");
  const [noDays, setNoDays] = useState(false);
  const [data, setData] = useState<{ donors: SankalpDonor[]; total: number; dates: number; preachers: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let live = true;
    const p = new URLSearchParams({ limit: "500" });
    if (q) p.set("search", q);
    if (preacher) p.set("preacher", preacher);
    if (month) p.set("month", month);
    apiClient
      .get<{ donors: SankalpDonor[]; total: number; dates: number; preachers: string[] }>(`/api/sankalpam/donors?${p}`)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load."));
    return () => {
      live = false;
    };
  }, [q, preacher, month, version]);

  const withoutDays = (data?.donors ?? []).filter((d) => !d.dates.length).length;
  const list = (data?.donors ?? []).filter((d) => !noDays || !d.dates.length);
  const m = Number(month);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Name, number, patron no. or occasion" className="min-w-0 flex-1 basis-64" />
        <Select
          value={month}
          onChange={setMonth}
          ariaLabel="Month"
          className="w-36"
          options={[{ value: "", label: "Any month" }, ...MONTHS_LONG.map((x, i) => ({ value: String(i + 1), label: x }))]}
        />
        <Select
          value={preacher}
          onChange={setPreacher}
          ariaLabel="Preacher"
          className="w-36"
          options={[{ value: "", label: "Any preacher" }, ...(data?.preachers ?? []).map((p) => ({ value: p, label: p }))]}
        />
      </div>

      {data && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          <span>
            {number(data.total)} donor{data.total === 1 ? "" : "s"} · {number(data.dates)} special day{data.dates === 1 ? "" : "s"}
          </span>
          {withoutDays > 0 && (
            <button
              type="button"
              onClick={() => setNoDays((v) => !v)}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
                noDays ? "bg-brand-700 text-white ring-brand-700" : "bg-warn-wash text-warn ring-amber-200"
              }`}
            >
              {number(withoutDays)} with no days yet
            </button>
          )}
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {!data ? (
        <Skeleton className="h-64" />
      ) : !list.length ? (
        <Card padded={false}>
          <EmptyState icon="users" title="No donors found" message={q || preacher || month ? "Try another search." : "Add a sankalp or upload the sheet."} />
        </Card>
      ) : (
        <Card padded={false} className="overflow-hidden">
          <ul className="divide-y divide-line-soft">
            {list.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => onEdit(d.id)}
                  className="flex w-full flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5 text-left transition-colors hover:bg-brand-50/50 sm:px-5"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="font-medium text-ink">
                      {d.donor_name}
                      {!d.active && (
                        <span className="ml-2">
                          <Badge tone="neutral">Switched off</Badge>
                        </span>
                      )}
                    </p>
                    {!sameName(d.sevak_name, d.donor_name) && <p className="text-xs text-ink-muted">On the name of {d.sevak_name}</p>}
                    <p className="mt-0.5 flex flex-wrap gap-x-2.5 text-xs text-ink-muted">
                      {d.phone ? <span className="tabular-nums">{d.phone}</span> : <span className="text-warn">No mobile number</span>}
                      {d.preacher && <span>{d.preacher}</span>}
                      {d.patron_number && <span className="tabular-nums">{d.patron_number}</span>}
                      {d.gotram && <span>Gotram: {d.gotram}</span>}
                    </p>
                  </div>
                  <div className="flex min-w-0 flex-1 basis-64 flex-wrap gap-1.5 sm:justify-end">
                    {d.dates.length ? (
                      d.dates.map((x) => {
                        const kind = dayKind(x.occasion);
                        const hit = m && x.month === m;
                        return (
                          <span
                            key={x.id}
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ring-1 ring-inset ${KIND[kind].chip} ${
                              x.active === false ? "opacity-50" : ""
                            } ${hit ? "font-semibold" : ""}`}
                          >
                            <span className="tabular-nums">{dayMonth(x.day, x.month)}</span>
                            <span className="text-current/70">·</span>
                            <span className="max-w-40 truncate">{x.occasion}</span>
                          </span>
                        );
                      })
                    ) : (
                      <span className="text-xs text-warn">No days yet - add them</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {data && data.total > list.length && !noDays && (
        <p className="text-center text-xs text-ink-muted">Showing the first {number(list.length)}. Search to find others.</p>
      )}
    </div>
  );
}
