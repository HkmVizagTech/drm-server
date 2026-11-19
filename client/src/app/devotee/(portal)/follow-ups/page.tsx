"use client";

// The follow-up board: late first, then today, then what is coming. Each one can be called,
// messaged or logged without leaving the board.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { LEADS_CHANGED, type DevoteeLead } from "@/lib/devotee";
import { Alert, Card, EmptyState, LinkButton, Skeleton } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { LeadRow } from "@/components/devotee/lead-bits";
import { LogFollowUpDialog } from "@/components/devotee/log-follow-up";
import { ReminderCard } from "@/components/devotee/reminder-card";

type Group = "overdue" | "today" | "upcoming";
const GROUPS: { key: Group; title: string; icon: IconName; tone: string; empty: string }[] = [
  { key: "overdue", title: "Overdue", icon: "alert", tone: "text-danger", empty: "Nothing late." },
  { key: "today", title: "Later today", icon: "clock", tone: "text-brand-700", empty: "Nothing else today." },
  { key: "upcoming", title: "Coming up", icon: "calendar", tone: "text-ink-soft", empty: "No follow-ups set for later." },
];

interface Page {
  rows: DevoteeLead[];
  total: number;
}

export default function DevoteeFollowUpsPage() {
  const [data, setData] = useState<Record<Group, Page> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState<DevoteeLead | null>(null);

  const load = useCallback(() => {
    Promise.all(GROUPS.map((g) => apiClient.get<Page>(`/api/devotee/leads?due=${g.key}&sort=due&limit=50`)))
      .then(([overdue, today, upcoming]) => {
        setData({ overdue, today, upcoming });
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(LEADS_CHANGED, load);
    // The board ages while it is open: what was "later today" becomes overdue.
    const t = window.setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    return () => {
      window.removeEventListener(LEADS_CHANGED, load);
      window.clearInterval(t);
    };
  }, [load]);

  const nothing = data && GROUPS.every((g) => data[g.key].total === 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Follow-ups</h1>
        <p className="text-sm text-ink-muted">Who to contact, in the order it is due.</p>
      </div>
      <ReminderCard />
      {error && <Alert tone="danger">{error}</Alert>}

      {!data ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" rounded="rounded-card" />
          ))}
        </div>
      ) : nothing ? (
        <Card>
          <EmptyState
            icon="checkCircle"
            title="No follow-ups set"
            message="When you log a call or add a lead, pick a follow-up time and it will show here, with a reminder when it comes."
            action={<LinkButton href="/devotee/leads">Go to my leads</LinkButton>}
          />
        </Card>
      ) : (
        GROUPS.map((g) => (
          <section key={g.key}>
            <h2 className={`mb-2 flex items-center gap-1.5 text-sm font-semibold ${g.tone}`}>
              <Icon name={g.icon} size={15} />
              {g.title}
              <span className="font-normal text-ink-muted">({data[g.key].total})</span>
            </h2>
            {data[g.key].rows.length === 0 ? (
              <p className="rounded-card border border-dashed border-line-soft px-4 py-3 text-sm text-ink-muted">{g.empty}</p>
            ) : (
              <ul className="space-y-2">
                {data[g.key].rows.map((l) => (
                  <LeadRow key={l.id} lead={l} onLog={setLogging} />
                ))}
              </ul>
            )}
            {data[g.key].total > data[g.key].rows.length && (
              <p className="mt-2 text-xs text-ink-muted">
                Showing the first {data[g.key].rows.length}. See all on <Link className="text-brand-700 hover:underline" href="/devotee/leads">My leads</Link>.
              </p>
            )}
          </section>
        ))
      )}

      {logging && <LogFollowUpDialog lead={logging} onClose={() => setLogging(null)} />}
    </div>
  );
}
