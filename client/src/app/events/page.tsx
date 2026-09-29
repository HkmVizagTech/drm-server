"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";

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
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Events</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {events.map((ev) => (
          <div key={ev.id} className="bg-white rounded-xl shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900">{ev.name}</h2>
            <p className="text-sm text-gray-500 mt-1">
              {new Date(ev.date_start).toLocaleDateString()} → {new Date(ev.date_end).toLocaleDateString()}
            </p>
            {ev.description && <p className="text-sm text-gray-600 mt-3">{ev.description}</p>}
          </div>
        ))}
      </div>

      {events.length === 0 && (
        <div className="bg-white rounded-xl shadow p-8 text-center text-gray-500">
          No upcoming events. Create one soon!
        </div>
      )}
    </div>
  );
}
