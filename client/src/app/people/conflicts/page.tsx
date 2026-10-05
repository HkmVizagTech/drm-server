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
  Alert,
  Badge,
  Button,
  buttonSecondary,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  SkeletonRows,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
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
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
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
      setError(e instanceof Error ? e.message : "Could not check the sites. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function keep(id: string, which: "current" | "alt") {
    try {
      await apiClient.post(`/api/profiles/${id}/keep-name`, { which });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Donors"
        title="Name mismatches"
        subtitle="Same donor, different names"
        actions={
          <>
            {/* A next/link anchor in the button's clothes rather than
                LinkButton: LinkButton is a plain <a> and would reload the whole
                app to reach a route the client router already has. */}
            <Link href="/people" className={buttonSecondary}>
              All people
            </Link>
            <Button icon="refresh" onClick={() => void runSweep(false)} disabled={busy} loading={busy}>
              {busy ? "Checking…" : "Check both sites"}
            </Button>
          </>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {/* The dry run. Deliberately a separate step from applying: "347 donors
          will be renamed" is a sentence somebody should read before it
          happens, not after. */}
      {sweep && !sweep.applied && (
        <Card tone="brand" className="mb-5">
          <CardHeader title="What will change" icon="refresh" />
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-2xl font-semibold tabular-nums text-ink">{number(sweep.names_to_fix)}</p>
              <p className="text-xs text-ink-soft">names to fix</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-ink">{number(sweep.addresses_to_fill)}</p>
              <p className="text-xs text-ink-soft">addresses to fill</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-ink">{number(sweep.checked)}</p>
              <p className="text-xs text-ink-soft">donors checked</p>
            </div>
          </div>

          {sweep.edited_here_count > 0 && (
            <Alert tone="warn" className="mt-3">
              {number(sweep.edited_here_count)} were typed here by hand. Check the list first.
            </Alert>
          )}

          {sweep.examples.length > 0 && (
            <div className="scroll-slim mt-4 max-h-64 overflow-y-auto rounded-card border border-line-soft bg-surface">
              {/* A plain scrolling table rather than a TableShell: this sits
                  inside a Card, and two bordered, shadowed surfaces stacked on
                  each other draw a double edge. */}
              <table className="w-full text-sm">
                <tbody className="divide-y divide-line-soft">
                  {sweep.examples.map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-2 tabular-nums text-ink-muted">{c.phone}</td>
                      <td className="px-3 py-2 text-ink-muted line-through">{c.from || "—"}</td>
                      <td className="px-3 py-2 font-medium text-ink">{c.to}</td>
                      <td className="px-3 py-2 text-right text-xs text-ink-faint">
                        {siteName(c.site)}
                        {c.edited_here && <span className="ml-1 text-warn">· edited here</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              icon="check"
              onClick={() => void runSweep(true)}
              disabled={busy || !sweep.names_to_fix}
              loading={busy}
            >
              {busy ? "Applying…" : `Fix ${number(sweep.names_to_fix)} name${sweep.names_to_fix === 1 ? "" : "s"}`}
            </Button>
            <Button variant="secondary" onClick={() => setSweep(null)}>
              Not now
            </Button>
          </div>
        </Card>
      )}

      {sweep?.applied && (
        <Alert tone="good" className="mb-5">
          Done. {number(sweep.names_to_fix)} names fixed, {number(sweep.addresses_to_fill)} addresses filled.
        </Alert>
      )}

      <CardHeader
        title={`${rows.length} to check`}
        subtitle="Two names on one mobile number"
      />

      <TableShell>
        <Thead>
          <Th>Mobile Number</Th>
          <Th>Our name</Th>
          <Th>Site name</Th>
          <Th>Found</Th>
          <Th align="right">Keep</Th>
        </Thead>
        {loading ? (
          <SkeletonRows rows={5} cols={5} />
        ) : !rows.length ? (
          <tbody>
            <tr>
              <td colSpan={5}>
                <EmptyState
                  icon="users"
                  title="No mismatches"
                  message="All names match."
                />
              </td>
            </tr>
          </tbody>
        ) : (
          <Tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td className="tabular-nums">
                  <Link href={`/people/${c.id}`} className="hover:text-brand-700">
                    {c.phone}
                  </Link>
                </Td>
                <Td className="font-medium text-ink">
                  {c.name}
                  {c.name_edited_at && (
                    <span className="ml-2 align-middle">
                      <Badge tone="neutral">typed here</Badge>
                    </span>
                  )}
                </Td>
                <Td>
                  {c.name_alt}
                  <span className="block text-2xs text-ink-faint">{siteName(c.name_alt_source)}</span>
                </Td>
                <Td className="text-xs text-ink-muted">{relativeDate(c.name_conflict_at)}</Td>
                <Td align="right">
                  <div className="flex justify-end gap-1">
                    <Button size="xs" variant="ghost" onClick={() => void keep(c.id, "current")}>
                      Keep ours
                    </Button>
                    <Button size="xs" onClick={() => void keep(c.id, "alt")}>
                      Use theirs
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Tbody>
        )}
      </TableShell>

    </div>
  );
}
