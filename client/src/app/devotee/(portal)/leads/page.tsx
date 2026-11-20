"use client";

// All of the devotee's leads: search, filter by where each stands and when it is due, and act on
// one without opening it (call, WhatsApp, directions, log a follow-up).

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { apiClient, isAbort } from "@/lib/api";
import { useSessionState } from "@/lib/session-state";
import { LEADS_CHANGED, STATUS, STATUS_ORDER, type DevoteeLead, type LeadStatus } from "@/lib/devotee";
import { Alert, Button, Card, EmptyState, LinkButton, Pagination, SearchInput, Select, Skeleton } from "@/components/ui";
import { Icon } from "@/components/icons";
import { LeadRow } from "@/components/devotee/lead-bits";
import { LogFollowUpDialog } from "@/components/devotee/log-follow-up";
import { LeadUploadDialog } from "@/components/devotee/lead-upload";

interface ListResult {
  rows: DevoteeLead[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  counts: Partial<Record<LeadStatus, number>>;
}

const DUE_OPTIONS = [
  { value: "", label: "Any follow-up" },
  { value: "due", label: "Due today or late" },
  { value: "overdue", label: "Overdue" },
  { value: "upcoming", label: "Later" },
  { value: "none", label: "No follow-up set" },
];
const SORT_OPTIONS = [
  { value: "due", label: "Follow-up time" },
  { value: "recent", label: "Recently updated" },
  { value: "created", label: "Newest first" },
  { value: "name", label: "Name A-Z" },
  { value: "donated", label: "Most donated" },
];

function LeadsScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useSessionState("dv-leads:q", "");
  const [debounced, setDebounced] = useState(q);
  const [status, setStatus] = useState<string>(() => params.get("status") ?? "");
  const [due, setDue] = useSessionState("dv-leads:due", "");
  const [sort, setSort] = useSessionState("dv-leads:sort", "due");
  const [page, setPage] = useState(1);
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ key: string; data: ListResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState<DevoteeLead | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebounced(q);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const key = useMemo(() => {
    const p = new URLSearchParams({ sort, page: String(page), limit: "25" });
    if (debounced.trim()) p.set("q", debounced.trim());
    if (status) p.set("status", status);
    if (due) p.set("due", due);
    return p.toString();
  }, [debounced, status, due, sort, page]);

  useEffect(() => {
    const ctl = new AbortController();
    apiClient
      .get<ListResult>(`/api/devotee/leads?${key}`, { signal: ctl.signal })
      .then((data) => {
        setResult({ key, data });
        setError(null);
      })
      .catch((e) => {
        if (!isAbort(e)) setError(e instanceof Error ? e.message : "Could not load your leads.");
      });
    return () => ctl.abort();
  }, [key, tick]);

  useEffect(() => {
    const again = () => setTick((t) => t + 1);
    window.addEventListener(LEADS_CHANGED, again);
    return () => window.removeEventListener(LEADS_CHANGED, again);
  }, []);

  const data = result?.data ?? null;
  const loading = result?.key !== key;
  const all = data ? Object.values(data.counts).reduce((a, b) => a + (b ?? 0), 0) : 0;
  const filtered = !!(debounced.trim() || status || due);

  const chooseStatus = (s: string) => {
    setStatus(s);
    setPage(1);
    // Keep the address in step, so Back and a shared link land on the same list.
    router.replace(s ? `/devotee/leads?status=${s}` : "/devotee/leads", { scroll: false });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">My leads</h1>
          <p className="text-sm text-ink-muted">Only you can see these.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" icon="upload" onClick={() => setUploading(true)}>
            Upload
          </Button>
          <LinkButton href="/devotee/map" variant="secondary" icon="mapPin" className="hidden sm:inline-flex">
            Map
          </LinkButton>
          <LinkButton href="/devotee/leads/new" icon="userPlus" className="hidden sm:inline-flex">
            Add lead
          </LinkButton>
        </div>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-1.5">
          {[{ value: "", label: "All", n: all }, ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS[s].label, n: data?.counts[s] ?? 0 }))].map((c) => (
            <button
              key={c.value || "all"}
              type="button"
              data-on={status === c.value}
              onClick={() => chooseStatus(c.value)}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium text-ink-soft ring-1 ring-inset ring-line-soft hover:bg-sunken data-[on=true]:bg-brand-600 data-[on=true]:text-white data-[on=true]:ring-brand-600"
            >
              {c.label}
              <span className="tabular-nums opacity-75">{c.n}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_200px_200px]">
        <SearchInput value={q} onChange={setQ} placeholder="Search name, number or area" aria-label="Search leads" />
        <Select value={due} onChange={(v) => { setDue(v); setPage(1); }} options={DUE_OPTIONS} ariaLabel="Follow-up" placeholder="Any follow-up" />
        <Select value={sort} onChange={(v) => { setSort(v); setPage(1); }} options={SORT_OPTIONS} ariaLabel="Sort by" />
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {!data ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" rounded="rounded-card" />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="users"
            title={filtered ? "No leads match" : "No leads yet"}
            message={filtered ? "Try another search or filter." : "Add the people you meet. You can follow them up, plan visits on the map and record what they give."}
            action={
              filtered ? undefined : (
                <div className="flex flex-wrap justify-center gap-2">
                  <LinkButton href="/devotee/leads/new" icon="userPlus">Add your first lead</LinkButton>
                  <Button variant="secondary" icon="upload" onClick={() => setUploading(true)}>Upload a file</Button>
                </div>
              )
            }
          />
        </Card>
      ) : (
        <>
          <ul className={`space-y-2 transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
            {data.rows.map((l) => (
              <LeadRow key={l.id} lead={l} onLog={setLogging} />
            ))}
          </ul>
          {/* Room for the bar below, so the last lead is never hidden behind it. */}
          <div className="h-16" aria-hidden />
          {/* Fixed to the bottom of the window (above the tab bar on a phone), however short
              or long the list - the page controls are always in the same place. */}
          <div className="fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-20 md:bottom-0">
            <div className="mx-auto max-w-6xl px-4 pb-2 sm:px-6 md:pb-3">
              <div className="overflow-hidden rounded-card border border-line-soft shadow-raised">
            <Pagination
              page={data.page}
              limit={data.limit}
              total={data.total}
              totalPages={data.totalPages}
              onPage={(p) => {
                setPage(p);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              unit="leads"
            />
              </div>
            </div>
          </div>
        </>
      )}

      <Link
        href="/devotee/leads/new"
        aria-label="Add lead"
        className="fixed bottom-[calc(7.5rem+env(safe-area-inset-bottom))] right-4 z-30 grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-white shadow-raised sm:hidden"
      >
        <Icon name="plus" size={24} />
      </Link>

      {logging && <LogFollowUpDialog lead={logging} onClose={() => setLogging(null)} />}
      {uploading && <LeadUploadDialog onClose={() => setUploading(false)} />}
    </div>
  );
}

export default function DevoteeLeadsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full" rounded="rounded-card" />}>
      <LeadsScreen />
    </Suspense>
  );
}
