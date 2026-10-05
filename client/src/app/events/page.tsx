"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { shortDate } from "@/lib/format";
import { Card, EmptyState, Icon, PageHeader } from "@/components/ui";

interface Event {
  id: string;
  name: string;
  date_start: string;
  date_end: string;
  description?: string;
}

export default function EventsPage() {
  const [events, setEvents] = useState<Event[]>([]);

  useEffect(() => {
    apiClient.get<Event[]>("/api/events?upcoming=true").then(setEvents).catch(console.error);
  }, []);

  return (
    <div>
      <PageHeader
        eyebrow="Fulfilment"
        title="Events"
        subtitle="Upcoming festivals and programmes."
      />

      {events.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            icon="calendar"
            title="No upcoming events"
            message="Upcoming events show here."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {events.map((ev) => (
            <Card key={ev.id}>
              <h2 className="text-base font-semibold text-ink">{ev.name}</h2>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                {shortDate(ev.date_start)}
                <Icon name="arrowRight" size={12} />
                {shortDate(ev.date_end)}
              </p>
              {ev.description && <p className="mt-3 text-sm text-ink-soft">{ev.description}</p>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
