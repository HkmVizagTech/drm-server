"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";

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
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Reports</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Donors</h2>
          <div className="space-y-3">
            {topDonors.map((d, i) => (
              <div key={d.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <div className="flex items-center gap-3">
                  <span className="w-6 h-6 rounded-full bg-[var(--accent-wash)] text-[var(--accent)] flex items-center justify-center text-xs font-bold">
                    {i + 1}
                  </span>
                  <div>
                    <p className="font-medium text-gray-900">{d.name}</p>
                    <p className="text-xs text-gray-500">{d.donation_count} donations</p>
                  </div>
                </div>
                <span className="font-semibold">₹{Number(d.total_donated).toLocaleString("en-IN")}</span>
              </div>
            ))}
            {topDonors.length === 0 && <p className="text-gray-500 text-sm">No data yet</p>}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">People by Role</h2>
          <div className="space-y-3">
            {roles.map((r) => (
              <div key={r.role} className="flex items-center justify-between">
                <span className="capitalize text-gray-700">{r.role}</span>
                <span className="font-semibold">{r.count}</span>
              </div>
            ))}
            {roles.length === 0 && <p className="text-gray-500 text-sm">No data yet</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
