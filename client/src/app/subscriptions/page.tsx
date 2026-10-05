"use client";

import { useCallback, useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { ExportButton } from "@/components/export-button";
import { number, shortDate } from "@/lib/format";
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  MoneyCell,
  PageHeader,
  Select,
  StatusBadge,
  TableShell,
  Tabs,
  Tbody,
  Td,
  Th,
  Thead,
} from "@/components/ui";

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

const statusTabs = ["active", "paused", "cancelled", "all"] as const;

const TABS = statusTabs.map((s) => ({
  key: s,
  label: s === "all" ? "All" : s[0].toUpperCase() + s.slice(1),
}));

export default function SubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [total, setTotal] = useState(0);
  const [tab, setTab] = useState<(typeof statusTabs)[number]>("active");
  const [showModal, setShowModal] = useState(false);

  // The one place the tab becomes query params, so the list request and the
  // download are built from the same value. Rebuilding them separately is how
  // somebody filters to "paused", downloads, and acts on a file that quietly
  // contains every cancelled donor as well.
  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (tab !== "all") params.set("status", tab);
    return params;
  }, [tab]);

  const fetchData = useCallback(() => {
    apiClient
      .get<{ subscriptions: Subscription[]; total: number }>(`/api/subscriptions?${filterParams()}`)
      .then((res) => {
        setSubscriptions(res.subscriptions);
        setTotal(res.total);
      })
      .catch(console.error);
  }, [filterParams]);

  useEffect(fetchData, [fetchData]);

  return (
    <div>
      <PageHeader
        eyebrow="Donors"
        title="Recurring donations"
        subtitle="Monthly, quarterly and yearly donations"
        actions={
          <>
            <ExportButton
              path="/api/subscriptions/export"
              params={filterParams()}
              filename="recurring-donations"
            />
            <Button icon="plus" onClick={() => setShowModal(true)}>
              Add recurring
            </Button>
          </>
        }
      />

      <Tabs
        variant="pill"
        items={TABS}
        value={tab}
        onChange={(key) => setTab(key as (typeof statusTabs)[number])}
        className="mb-4"
      />

      <TableShell>
        <Thead>
          <Th>Donor</Th>
          <Th align="right">Amount</Th>
          <Th>Frequency</Th>
          <Th>Purpose</Th>
          <Th>Next due</Th>
          <Th>Status</Th>
        </Thead>
        {subscriptions.length === 0 ? (
          <tbody>
            <tr>
              <td colSpan={6}>
                <EmptyState
                  icon="refresh"
                  title="No recurring donations"
                  message="Try another tab."
                />
              </td>
            </tr>
          </tbody>
        ) : (
          <Tbody>
            {subscriptions.map((s) => (
              <tr key={s.id}>
                <Td>
                  <Link
                    href={`/people/${s.person_id}`}
                    className="font-medium text-ink hover:text-brand-700 hover:underline"
                  >
                    {s.donor_name || "—"}
                  </Link>
                  <p className="text-xs text-ink-faint">{s.donor_phone}</p>
                </Td>
                <Td align="right">
                  <MoneyCell value={s.amount} />
                </Td>
                <Td className="capitalize">{s.frequency}</Td>
                <Td className="capitalize">{s.purpose.replace("_", " ")}</Td>
                <Td className="text-ink-muted">{shortDate(s.next_charge_date)}</Td>
                <Td>
                  <StatusBadge status={s.status} />
                </Td>
              </tr>
            ))}
          </Tbody>
        )}
      </TableShell>
      <p className="mt-4 text-sm text-ink-muted">{number(total)} total</p>

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
      setError(err instanceof Error ? err.message : "Could not save. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="New recurring donation"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {/* The submit button lives in the dialog's footer rather than in the
              form, so it stays put on a small screen where the fields scroll.
              `form` is what still ties it to the form's submit handler, and
              with it Enter in any field does the same thing the button does. */}
          <Button type="submit" form="new-subscription" loading={loading}>
            Save
          </Button>
        </>
      }
    >
      <form id="new-subscription" onSubmit={handleSubmit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}

        <Field label="Donor Name" htmlFor="sub-name" required>
          <Input
            id="sub-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            placeholder="As on the receipt"
          />
        </Field>

        <Field label="Mobile Number" htmlFor="sub-phone" required>
          <Input
            id="sub-phone"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            required
            placeholder="10 digits"
          />
        </Field>

        <Field label="Amount (₹)" htmlFor="sub-amount" required>
          <Input
            id="sub-amount"
            type="number"
            step="0.01"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            required
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Frequency">
            <Select
              value={form.frequency}
              onChange={(v) => setForm({ ...form, frequency: v })}
              ariaLabel="Frequency"
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </Select>
          </Field>
          <Field label="Purpose">
            <Select
              value={form.purpose}
              onChange={(v) => setForm({ ...form, purpose: v })}
              ariaLabel="Purpose"
            >
              <option value="annadan">Annadan</option>
              <option value="temple_maintenance">Temple maintenance</option>
              <option value="festival">Festival</option>
              <option value="general">General</option>
            </Select>
          </Field>
        </div>
      </form>
    </Modal>
  );
}
