"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { number } from "@/lib/format";
import {
  Card,
  CardHeader,
  EmptyState,
  MoneyCell,
  PageHeader,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
} from "@/components/ui";

interface TopDonor {
  id: string;
  name: string;
  phone: string;
  total_donated: number;
  donation_count: number;
}

interface RoleCount {
  role: string;
  count: number;
}

export default function ReportsPage() {
  const [topDonors, setTopDonors] = useState<TopDonor[]>([]);
  const [roles, setRoles] = useState<RoleCount[]>([]);

  useEffect(() => {
    apiClient.get<TopDonor[]>("/api/reports/donors/top").then(setTopDonors).catch(console.error);
    apiClient.get<RoleCount[]>("/api/reports/people/roles").then(setRoles).catch(console.error);
  }, []);

  return (
    <div>
      <PageHeader
        eyebrow="Insight"
        title="Reports"
        subtitle="Top donors and people by role."
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Top donors"
            subtitle="By total given"
            icon="rupee"
          />
          <TableShell>
            <Thead>
              <Th className="w-12">#</Th>
              <Th>Donor</Th>
              <Th align="right">Given</Th>
            </Thead>
            {topDonors.length === 0 ? (
              <tbody>
                <tr>
                  <td colSpan={3}>
                    <EmptyState
                      icon="rupee"
                      title="No donations yet"
                      message="Top donors show here."
                    />
                  </td>
                </tr>
              </tbody>
            ) : (
              <Tbody>
                {topDonors.map((d, i) => (
                  <tr key={d.id}>
                    <Td>
                      <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-50 text-2xs font-semibold tabular-nums text-brand-700">
                        {i + 1}
                      </span>
                    </Td>
                    <Td>
                      <span className="block font-medium text-ink">{d.name}</span>
                      <span className="block text-xs text-ink-muted">
                        {number(d.donation_count)}{" "}
                        {d.donation_count === 1 ? "donation" : "donations"}
                      </span>
                    </Td>
                    <Td align="right">
                      <MoneyCell value={d.total_donated} />
                    </Td>
                  </tr>
                ))}
              </Tbody>
            )}
          </TableShell>
        </Card>

        <Card>
          <CardHeader
            title="People by role"
            subtitle="Count of people in each role"
            icon="users"
          />
          {roles.length === 0 ? (
            <EmptyState
              icon="users"
              title="No people yet"
              message="Donors, volunteers and devotees show here."
            />
          ) : (
            <ul className="divide-y divide-line-soft">
              {roles.map((r) => (
                <li key={r.role} className="flex items-center justify-between gap-4 py-2.5">
                  <span className="text-sm capitalize text-ink-soft">{r.role}</span>
                  <span className="text-sm font-semibold tabular-nums text-ink">
                    {number(r.count)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
