"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { dateTime, number } from "@/lib/format";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  StatusBadge,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
} from "@/components/ui";

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
    // This asks for the slots of a seva type literally named "placeholder",
    // which is not a type anybody created - so the request fails and the list
    // below is empty whatever is actually booked. Left as it stands because
    // choosing a real type here is a decision about how the screen should work
    // rather than a restyle, but it is why there is never anything to show.
    apiClient.get<SevaBooking[]>("/api/seva/types/placeholder/slots").then(setBookings).catch(console.error);
  }, []);

  return (
    <div>
      <PageHeader
        eyebrow="Fulfilment"
        title="Seva bookings"
        subtitle="Sevas and booked slots."
      />

      <Card className="mb-5">
        <CardHeader title="Seva types" subtitle="What can be booked" icon="tag" />
        {types.length === 0 ? (
          <p className="text-sm text-ink-muted">No seva types yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {types.map((t) => (
              <Badge key={t.id} tone="brand">
                {t.name}
              </Badge>
            ))}
          </div>
        )}
      </Card>

      {bookings.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            icon="calendar"
            title="No bookings yet"
            message="Seva bookings are coming soon."
          />
        </Card>
      ) : (
        <TableShell>
          <Thead>
            <Th>Seva type</Th>
            <Th>Slot</Th>
            <Th align="right">Booked</Th>
            <Th align="right">Capacity</Th>
            <Th>Status</Th>
          </Thead>
          <Tbody>
            {bookings.map((b) => (
              <tr key={b.id}>
                <Td className="font-medium text-ink">{b.seva_type}</Td>
                <Td>{dateTime(b.slot_datetime)}</Td>
                <Td align="right" className="tabular-nums">
                  {number(b.slots_booked)}
                </Td>
                <Td align="right" className="tabular-nums">
                  {number(b.max_slots)}
                </Td>
                <Td>
                  <StatusBadge status={b.status} />
                </Td>
              </tr>
            ))}
          </Tbody>
        </TableShell>
      )}
    </div>
  );
}
