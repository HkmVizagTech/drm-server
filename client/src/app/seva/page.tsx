"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";

interface SevaBooking {
  id: string;
  person_name?: string;
  seva_type: string;
  slot_datetime: string;
  slots_booked: number;
  max_slots: number;
  status: string;
}

export default function SevaPage() {
  const [bookings, setBookings] = useState<SevaBooking[]>([]);
  const [types, setTypes] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    apiClient.get<{ id: string; name: string }[]>("/api/seva/types").then(setTypes).catch(console.error);
    apiClient.get<SevaBooking[]>("/api/seva/types/placeholder/slots").then(setBookings).catch(console.error);
  }, []);

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Seva Bookings</h1>
      </div>

      <div className="bg-white rounded-xl shadow p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Seva Types</h2>
        <div className="flex gap-2 flex-wrap">
          {types.map((t) => (
            <span key={t.id} className="px-3 py-1.5 bg-[var(--accent-wash)] text-[var(--accent)] rounded-full text-sm">
              {t.name}
            </span>
          ))}
          {types.length === 0 && <p className="text-gray-500 text-sm">No seva types defined yet.</p>}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-6 py-3 font-medium">Seva Type</th>
              <th className="px-6 py-3 font-medium">Slot</th>
              <th className="px-6 py-3 font-medium">Booked</th>
              <th className="px-6 py-3 font-medium">Capacity</th>
              <th className="px-6 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {bookings.map((b) => (
              <tr key={b.id} className="hover:bg-gray-50">
                <td className="px-6 py-3 font-medium text-gray-900">{b.seva_type}</td>
                <td className="px-6 py-3">{new Date(b.slot_datetime).toLocaleString()}</td>
                <td className="px-6 py-3">{b.slots_booked}</td>
                <td className="px-6 py-3">{b.max_slots}</td>
                <td className="px-6 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs ${b.status === "confirmed" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                    {b.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {bookings.length === 0 && <div className="p-8 text-center text-gray-500">No bookings yet</div>}
      </div>
    </div>
  );
}
