"use client";

// Donors the sites disagree about.
//
// HOW THEY GOT THIS WAY
// The sync that brings donors into DRM never updated a name once it had one.
// Whichever site reached a donor first named them permanently, and no later
// correction on either site could reach DRM. That is why annadan could call
// somebody "Myakala Srikanth" for a year while DRM said "Myakal Srikanth".
//
// The live sync now takes the newest name and keeps the loser beside it. But
// that only helps donors something changes about. The ones already wrong need
// a sweep, which is what the button at the top does: it walks both sites,
// compares every name, and reports before it writes.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { number, relativeDate } from "@/lib/format";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  TableShell,
  Td,
  Th,
  buttonPrimary,
  buttonSecondary,
} from "@/components/ui";

interface Conflict {
  id: string;
  name: string;
  name_alt: string;
  name_alt_source: string | null;
  name_conflict_at: string | null;
  name_edited_at: string | null;
  phone: string;
  profile_source: string | null;
}

interface Sweep {
  applied: boolean;
  checked: number;
  sites_seen: string[];
  names_to_fix: number;
  addresses_to_fill: number;
  edited_here_count: number;
  examples: { id: string; phone: string; from: string | null; to: string; site: string; edited_here: boolean }[];
}

const siteName = (s: string | null) => (s === "annadan" ? "annadan" : s === "hkmv" ? "harekrishnavizag.org" : s ?? "a site");

export default function ConflictsPage() {
  const [rows, setRows] = useState<Conflict[]>([]);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiClient.get<{ conflicts: Conflict[] }>("/api/profiles/conflicts");
      setRows(d.conflicts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the conflicts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runSweep(apply: boolean) {
    setBusy(true);
    setError(null);
    try {
      const d = await apiClient.post<Sweep>("/api/profiles/reconcile", { apply });
      setSweep(d);
      if (apply) await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check the sites");
    } finally {
      setBusy(false);
    }
  }

  async function keep(id: string, which: "current" | "alt") {
    try {
      await apiClient.post(`/api/profiles/${id}/keep-name`, { which });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that");
    }
  }

  return (
    <div>
      <PageHeader
        title="Name mismatches"
        subtitle="Donors the donation sites and DRM spell differently"
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/people" className={buttonSecondary}>
              All people
            </Link>
            <button onClick={() => void runSweep(false)} disabled={busy} className={buttonPrimary}>
              {busy ? "Checking…" : "Check both sites"}
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {/* The dry run. Deliberately a separate step from applying: "347 donors
          will be renamed" is a sentence somebody should read before it
          happens, not after. */}
      {sweep && !sweep.applied && (
        <Card className="mb-5 border-[var(--accent)]/40 bg-[var(--accent-wash)]">
          <CardHeader title="What a sweep would change" />
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-2xl font-semibold tabular-nums text-slate-900">{number(sweep.names_to_fix)}</p>
              <p className="text-xs text-slate-600">names corrected</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-slate-900">{number(sweep.addresses_to_fill)}</p>
              <p className="text-xs text-slate-600">blank addresses filled in</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-slate-900">{number(sweep.checked)}</p>
              <p className="text-xs text-slate-600">donors checked against {sweep.sites_seen.length} site{sweep.sites_seen.length === 1 ? "" : "s"}</p>
            </div>
          </div>

          {sweep.edited_here_count > 0 && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {number(sweep.edited_here_count)} of these were typed in DRM by hand and would be replaced by what a
              site says. Look at the list below before applying.
            </p>
          )}

          {sweep.examples.length > 0 && (
            <div className="mt-4 max-h-64 overflow-y-auto scroll-slim rounded-lg border border-[var(--line-soft)] bg-white">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {sweep.examples.map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-2 text-slate-500 tabular-nums">{c.phone}</td>
                      <td className="px-3 py-2 text-slate-500 line-through">{c.from || "—"}</td>
                      <td className="px-3 py-2 font-medium text-slate-900">{c.to}</td>
                      <td className="px-3 py-2 text-right text-xs text-slate-400">
                        {siteName(c.site)}
                        {c.edited_here && <span className="ml-1 text-amber-700">· edited here</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => void runSweep(true)} disabled={busy || !sweep.names_to_fix} className={buttonPrimary}>
              {busy ? "Applying…" : `Apply ${number(sweep.names_to_fix)} correction${sweep.names_to_fix === 1 ? "" : "s"}`}
            </button>
            <button onClick={() => setSweep(null)} className={buttonSecondary}>
              Not now
            </button>
          </div>
        </Card>
      )}

      {sweep?.applied && (
        <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Done — {number(sweep.names_to_fix)} names corrected and {number(sweep.addresses_to_fill)} addresses
          filled in.
        </div>
      )}

      <Card padded={false}>
        <div className="px-5 pt-5">
          <CardHeader
            title={`${rows.length} still unsettled`}
            subtitle="Two genuinely different names on one phone number. Often a shared family line — worth a look before choosing."
          />
        </div>

        <TableShell>
          <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
            <tr>
              <Th>Phone</Th>
              <Th>DRM has</Th>
              <Th>The site has</Th>
              <Th>Noticed</Th>
              <Th align="right">Keep</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">Loading…</td></tr>
            ) : !rows.length ? (
              <tr>
                <td colSpan={5}>
                  <EmptyState
                    title="Nothing in dispute"
                    message="No donor has two different names across DRM and the sites. Press “Check both sites” to look again."
                  />
                </td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50/60">
                  <Td className="tabular-nums text-slate-600">
                    <Link href={`/people/${c.id}`} className="hover:text-[var(--accent)]">
                      {c.phone}
                    </Link>
                  </Td>
                  <Td className="font-medium text-slate-900">
                    {c.name}
                    {c.name_edited_at && (
                      <span className="ml-2 align-middle">
                        <Badge tone="neutral">typed here</Badge>
                      </span>
                    )}
                  </Td>
                  <Td className="text-slate-700">
                    {c.name_alt}
                    <span className="block text-[11px] text-slate-400">{siteName(c.name_alt_source)}</span>
                  </Td>
                  <Td className="text-xs text-slate-500">{relativeDate(c.name_conflict_at)}</Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => void keep(c.id, "current")}
                        className="rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                      >
                        Keep ours
                      </button>
                      <button
                        onClick={() => void keep(c.id, "alt")}
                        className="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                      >
                        Use theirs
                      </button>
                    </div>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </TableShell>

        <div className="border-t border-[var(--line-soft)] px-5 py-4">
          <p className="text-xs text-slate-500">
            Whichever you keep is sent back to both sites, so the disagreement is settled everywhere rather than
            coming back on the next sync.
          </p>
        </div>
      </Card>
    </div>
  );
}
