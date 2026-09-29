"use client";

import { useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { Select } from "@/components/ui";

interface Subscription {
  id: string;
  person_id: string;
  donor_name?: string;
  donor_phone?: string;
  amount: number;
  frequency: string;
  purpose: string;
  status: string;
  next_charge_date?: string;
  created_at: string;
}

const inr = (n: number) => `₹${Number(n).toLocaleString("en-IN")}`;
const statusTone = (status: string) =>
  status === "active" ? "bg-green-50 text-green-700" : status === "paused" ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-700";

const statusTabs = ["active", "paused", "cancelled", "all"] as const;

export default function SubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [total, setTotal] = useState(0);
  const [tab, setTab] = useState<(typeof statusTabs)[number]>("active");
  const [showModal, setShowModal] = useState(false);

  const fetchData = () => {
    const params = new URLSearchParams();
    if (tab !== "all") params.set("status", tab);
    apiClient
      .get<{ subscriptions: Subscription[]; total: number }>(`/api/subscriptions?${params}`)
      .then((res) => {
        setSubscriptions(res.subscriptions);
        setTotal(res.total);
      })
      .catch(console.error);
  };

  useEffect(fetchData, [tab]);

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Recurring Donations</h1>
        <button
          onClick={() => setShowModal(true)}
          className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-lg text-sm font-medium"
        >
          + New Subscription
        </button>
      </div>

      <div className="flex gap-2 mb-6">
        {statusTabs.map((s) => (
          <button
            key={s}
            onClick={() => setTab(s)}
            className={`px-3 py-1.5 rounded-full text-sm capitalize transition-colors ${
              tab === s ? "bg-[var(--accent)] text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-6 py-3 font-medium">Donor</th>
              <th className="px-6 py-3 font-medium">Amount</th>
              <th className="px-6 py-3 font-medium">Frequency</th>
              <th className="px-6 py-3 font-medium">Purpose</th>
              <th className="px-6 py-3 font-medium">Next charge</th>
              <th className="px-6 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {subscriptions.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="px-6 py-3 font-medium text-gray-900">
                  <Link href={`/people/${s.person_id}`} className="hover:underline">
                    {s.donor_name || "—"}
                  </Link>
                  <p className="text-xs text-gray-400">{s.donor_phone}</p>
                </td>
                <td className="px-6 py-3 font-semibold">{inr(s.amount)}</td>
                <td className="px-6 py-3 capitalize">{s.frequency}</td>
                <td className="px-6 py-3 capitalize">{s.purpose.replace("_", " ")}</td>
                <td className="px-6 py-3 text-gray-500">
                  {s.next_charge_date ? new Date(s.next_charge_date).toLocaleDateString() : "—"}
                </td>
                <td className="px-6 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs capitalize ${statusTone(s.status)}`}>{s.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {subscriptions.length === 0 && <div className="p-8 text-center text-gray-500">No subscriptions found</div>}
      </div>
      <p className="mt-4 text-sm text-gray-500">{total} total records</p>

      {showModal && <NewSubscriptionModal onClose={() => setShowModal(false)} onAdded={fetchData} />}
    </div>
  );
}

function NewSubscriptionModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ name: "", phone: "", amount: "", frequency: "monthly", purpose: "general" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // Find or create the donor by phone, same pattern as recording a donation
      const lookup = await apiClient.get<{ found: boolean; person?: { id: string } }>(
        `/api/people/lookup?phone=${form.phone}`
      );
      let personId = lookup.person?.id;
      if (!personId) {
        const person = await apiClient.post<{ id: string }>("/api/people", {
          name: form.name,
          phone: form.phone,
          roles: ["donor"],
        });
        personId = person.id;
      }
      await apiClient.post("/api/subscriptions", {
        person_id: personId,
        amount: Number(form.amount),
        frequency: form.frequency,
        purpose: form.purpose,
      });
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create subscription");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl p-8 w-full max-w-md space-y-4">
        <h2 className="text-xl font-bold">New Recurring Donation</h2>
        {error && <div className="bg-red-50 text-red-600 text-sm p-3 rounded-lg">{error}</div>}
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Donor name *"
          required
          className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
        <input
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          placeholder="Phone number *"
          required
          className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none"
        />
        <input
          type="number"
          step="0.01"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          placeholder="Amount per cycle (₹) *"
          required
          className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none"
        />
        <div className="grid grid-cols-2 gap-3">
          <Select value={form.frequency} onChange={(v) => setForm({ ...form, frequency: v })} className="w-full">
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </Select>
          <Select value={form.purpose} onChange={(v) => setForm({ ...form, purpose: v })} className="w-full">
            <option value="annadan">Annadan</option>
            <option value="temple_maintenance">Temple maintenance</option>
            <option value="festival">Festival</option>
            <option value="general">General</option>
          </Select>
        </div>
        <div className="flex gap-3 pt-2">
          <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 border border-slate-300 rounded-lg hover:bg-gray-50">
            Cancel
          </button>
          <button type="submit" disabled={loading} className="flex-1 px-4 py-2.5 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] disabled:opacity-50">
            {loading ? "Saving..." : "Create Subscription"}
          </button>
        </div>
      </form>
    </div>
  );
}
