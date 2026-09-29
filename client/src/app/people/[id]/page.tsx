"use client";

import { use, useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { Select } from "@/components/ui";

interface Person {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  pan?: string;
  roles: string[];
  date_of_birth?: string;
  anniversary_date?: string;
  prasadam_address?: string;
}

interface Donation {
  id: string;
  amount: number;
  type: string;
  purpose: string;
  payment_mode: string;
  source: string;
  receipt_generated: boolean;
  receipt_number?: string;
  receipt_url?: string;
  receipt_issued_at?: string;
  subscription_id?: string;
  external_ref?: string;
  created_at: string;
}

interface Subscription {
  id: string;
  amount: number;
  frequency: string;
  purpose: string;
  status: string;
  next_charge_date?: string;
  created_at: string;
}

interface PrasadamDelivery {
  id: string;
  address: string;
  status: string;
  courier_name?: string;
  tracking_number?: string;
  dispatched_at?: string;
  delivered_at?: string;
  notes?: string;
  created_at: string;
}

interface PersonNote {
  id: string;
  note: string;
  author_name?: string;
  created_at: string;
}

interface Profile {
  person: Person;
  donations: Donation[];
  subscriptions: Subscription[];
  prasadam_deliveries: PrasadamDelivery[];
  notes: PersonNote[];
  lifetime: { total: number; by_year: { year: string; total: number; count: number }[] };
}

const inr = (n: number) => `₹${Number(n).toLocaleString("en-IN")}`;
const fmtDate = (d?: string) => (d ? new Date(d).toLocaleDateString() : "—");

const badge = (text: string, tone: "brown" | "green" | "amber" | "gray" | "red" = "gray") => {
  const tones: Record<string, string> = {
    brown: "bg-[var(--accent-wash)] text-[var(--accent)]",
    green: "bg-green-50 text-green-700",
    amber: "bg-amber-50 text-amber-700",
    gray: "bg-gray-100 text-gray-600",
    red: "bg-red-50 text-red-700",
  };
  return <span className={`px-2 py-0.5 rounded-full text-xs capitalize ${tones[tone]}`}>{text}</span>;
};

const subscriptionTone = (status: string) => (status === "active" ? "green" : status === "paused" ? "amber" : "red");
const deliveryTone = (status: string) =>
  status === "delivered" ? "green" : status === "shipped" ? "brown" : status === "returned" ? "red" : "amber";

export default function PersonProfilePage({ params }: PageProps<"/people/[id]">) {
  const { id } = use(params);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showReceiptFor, setShowReceiptFor] = useState<Donation | null>(null);
  const [showNewSubscription, setShowNewSubscription] = useState(false);
  const [showNewDelivery, setShowNewDelivery] = useState(false);
  const [updatingDelivery, setUpdatingDelivery] = useState<PrasadamDelivery | null>(null);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");

  const load = () => {
    setLoading(true);
    apiClient
      .get<Profile>(`/api/people/${id}/profile`)
      .then(setProfile)
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  };

  useEffect(load, [id]);

  const updateSubscriptionStatus = async (subId: string, status: string) => {
    await apiClient.put(`/api/subscriptions/${subId}`, { status });
    load();
  };

  const syncFromHkmv = async () => {
    setSyncing(true);
    setSyncMessage("");
    try {
      const result = await apiClient.post<{ donationsSynced: number; subscriptionsSynced: number; deliveriesSynced: number }>(
        `/api/people/${id}/sync-hkmv`,
        {}
      );
      setSyncMessage(
        `Synced ${result.donationsSynced} donation${result.donationsSynced === 1 ? "" : "s"}, ${result.subscriptionsSynced} subscription${result.subscriptionsSynced === 1 ? "" : "s"}, ${result.deliveriesSynced} prasadam ${result.deliveriesSynced === 1 ? "delivery" : "deliveries"} from hkmsite2.0.`
      );
      load();
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  // Ask the originating donation site to re-send its WhatsApp receipt. The
  // receipt template, numbering and PDF all live on that site, so DRM asks
  // rather than composing its own - otherwise donors get two receipts that
  // don't match.
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resendNote, setResendNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const resendReceipt = async (donationId: string) => {
    setResendingId(donationId);
    setResendNote(null);
    try {
      const r = await apiClient.post<{ sentTo?: string; receiptNumber?: string }>(
        `/api/donations/${donationId}/resend-receipt`,
        {}
      );
      setResendNote({
        tone: "ok",
        text: `Receipt ${r.receiptNumber ?? ""} re-sent${r.sentTo ? ` to ${r.sentTo}` : ""}.`,
      });
    } catch (err) {
      setResendNote({
        tone: "err",
        text: err instanceof Error ? err.message : "Could not resend the receipt.",
      });
    } finally {
      setResendingId(null);
    }
  };

  const downloadReceiptFile = async (donationId: string, receiptNumber?: string) => {
    try {
      const blob = await apiClient.getBlob(`/api/donations/${donationId}/receipt-file`);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) {
      alert(err instanceof Error ? err.message : `Could not download receipt${receiptNumber ? ` ${receiptNumber}` : ""}`);
    }
  };

  const addNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      await apiClient.post(`/api/people/${id}/notes`, { note: noteText.trim() });
      setNoteText("");
      load();
    } finally {
      setSavingNote(false);
    }
  };

  if (loading) return <p className="text-gray-500">Loading donor profile...</p>;
  if (notFound || !profile) return <p className="text-red-600">Person not found.</p>;

  const { person, donations, subscriptions, prasadam_deliveries, notes, lifetime } = profile;

  return (
    <div className="space-y-6">
      <Link href="/people" className="text-sm text-gray-500 hover:text-gray-700">
        ← Back to People
      </Link>

      {/* Header / profile card */}
      <div className="bg-white rounded-xl shadow p-6">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{person.name}</h1>
            <p className="text-gray-500 mt-1">{person.phone}{person.email ? ` · ${person.email}` : ""}</p>
            <div className="flex gap-1 mt-3 flex-wrap">
              {person.roles.map((r) => <span key={r}>{badge(r, "brown")}</span>)}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={syncFromHkmv}
              disabled={syncing}
              className="px-4 py-2 border border-[var(--accent)] text-[var(--accent)] rounded-lg text-sm hover:bg-[var(--accent-wash)] disabled:opacity-50"
            >
              {syncing ? "Syncing..." : "Sync from HKMV"}
            </button>
            <button
              onClick={() => setShowEdit(true)}
              className="px-4 py-2 border border-slate-300 rounded-lg text-sm hover:bg-gray-50"
            >
              Edit Profile
            </button>
          </div>
        </div>
        {syncMessage && <p className="text-sm text-gray-500 mt-3">{syncMessage}</p>}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 text-sm">
          <div>
            <p className="text-gray-500">PAN</p>
            <p className="font-medium">{person.pan || "—"}</p>
          </div>
          <div>
            <p className="text-gray-500">Date of birth</p>
            <p className="font-medium">{fmtDate(person.date_of_birth)}</p>
          </div>
          <div>
            <p className="text-gray-500">Anniversary</p>
            <p className="font-medium">{fmtDate(person.anniversary_date)}</p>
          </div>
          <div>
            <p className="text-gray-500">Address</p>
            <p className="font-medium">{person.address || "—"}</p>
          </div>
        </div>
        <div className="mt-4 text-sm">
          <p className="text-gray-500">Prasadam delivery address</p>
          <p className="font-medium">{person.prasadam_address || person.address || "Not set"}</p>
        </div>
      </div>

      {resendNote && (
        <div
          className={`rounded-lg px-4 py-3 text-sm border ${
            resendNote.tone === "ok"
              ? "bg-emerald-50 text-emerald-800 border-emerald-200"
              : "bg-red-50 text-red-700 border-red-200"
          }`}
        >
          {resendNote.text}
        </div>
      )}

      {/* Total donated */}
      <div className="bg-white rounded-xl shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Total Donated</h2>
          <p className="text-2xl font-bold text-[var(--accent)]">{inr(lifetime.total)}</p>
        </div>
        <div className="flex gap-4 flex-wrap">
          {lifetime.by_year.map((y) => (
            <div key={y.year} className="px-4 py-2 bg-gray-50 rounded-lg">
              <p className="text-xs text-gray-500">{new Date(y.year).getFullYear()}</p>
              <p className="font-semibold text-gray-900">{inr(y.total)}</p>
              <p className="text-xs text-gray-400">{y.count} donation{Number(y.count) === 1 ? "" : "s"}</p>
            </div>
          ))}
          {lifetime.by_year.length === 0 && <p className="text-gray-500 text-sm">No donations yet.</p>}
        </div>
      </div>

      {/* Donations & receipts */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Donations &amp; Receipts</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-6 py-3 font-medium">Amount</th>
              <th className="px-6 py-3 font-medium">Purpose</th>
              <th className="px-6 py-3 font-medium">Type</th>
              <th className="px-6 py-3 font-medium">Date</th>
              <th className="px-6 py-3 font-medium">Receipt</th>
              <th className="px-6 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {donations.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50">
                <td className="px-6 py-3 font-semibold">{inr(d.amount)}</td>
                <td className="px-6 py-3 capitalize">{d.purpose.replace("_", " ")}</td>
                <td className="px-6 py-3 capitalize">{d.type.replace("-", " ")}</td>
                <td className="px-6 py-3 text-gray-500">{fmtDate(d.created_at)}</td>
                <td className="px-6 py-3">
                  {d.receipt_generated ? (
                    d.external_ref ? (
                      <button
                        onClick={() => downloadReceiptFile(d.id, d.receipt_number)}
                        className="text-[var(--accent)] hover:underline"
                      >
                        {d.receipt_number || "Download PDF"}
                      </button>
                    ) : d.receipt_url ? (
                      <a href={d.receipt_url} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                        {d.receipt_number || "View"}
                      </a>
                    ) : (
                      badge(d.receipt_number || "issued", "green")
                    )
                  ) : (
                    badge("not issued", "gray")
                  )}
                </td>
                <td className="px-6 py-3 text-right whitespace-nowrap">
                  {!d.receipt_generated && !d.external_ref && (
                    <button
                      onClick={() => setShowReceiptFor(d)}
                      className="text-[var(--accent)] text-sm font-medium hover:underline"
                    >
                      Issue receipt
                    </button>
                  )}
                  {d.receipt_generated && d.external_ref && (
                    <button
                      onClick={() => resendReceipt(d.id)}
                      disabled={resendingId === d.id}
                      className="text-[var(--accent)] text-sm font-medium hover:underline disabled:opacity-50"
                    >
                      {resendingId === d.id ? "Sending…" : "Resend on WhatsApp"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {donations.length === 0 && <div className="p-8 text-center text-gray-500">No donations yet</div>}
      </div>

      {/* Subscriptions */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Recurring Donations</h2>
          <button
            onClick={() => setShowNewSubscription(true)}
            className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3 py-1.5 rounded-lg text-sm font-medium"
          >
            + New Subscription
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-6 py-3 font-medium">Amount</th>
              <th className="px-6 py-3 font-medium">Frequency</th>
              <th className="px-6 py-3 font-medium">Purpose</th>
              <th className="px-6 py-3 font-medium">Next charge</th>
              <th className="px-6 py-3 font-medium">Status</th>
              <th className="px-6 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {subscriptions.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="px-6 py-3 font-semibold">{inr(s.amount)}</td>
                <td className="px-6 py-3 capitalize">{s.frequency}</td>
                <td className="px-6 py-3 capitalize">{s.purpose.replace("_", " ")}</td>
                <td className="px-6 py-3 text-gray-500">{fmtDate(s.next_charge_date)}</td>
                <td className="px-6 py-3">{badge(s.status, subscriptionTone(s.status) as "green" | "amber" | "red")}</td>
                <td className="px-6 py-3 text-right space-x-3">
                  {s.status === "active" && (
                    <button onClick={() => updateSubscriptionStatus(s.id, "paused")} className="text-sm text-amber-700 hover:underline">
                      Pause
                    </button>
                  )}
                  {s.status === "paused" && (
                    <button onClick={() => updateSubscriptionStatus(s.id, "active")} className="text-sm text-green-700 hover:underline">
                      Resume
                    </button>
                  )}
                  {s.status !== "cancelled" && (
                    <button onClick={() => updateSubscriptionStatus(s.id, "cancelled")} className="text-sm text-red-600 hover:underline">
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {subscriptions.length === 0 && <div className="p-8 text-center text-gray-500">No recurring donations</div>}
      </div>

      {/* Prasadam deliveries */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Prasadam Deliveries</h2>
          <button
            onClick={() => setShowNewDelivery(true)}
            className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3 py-1.5 rounded-lg text-sm font-medium"
          >
            + Queue Delivery
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-6 py-3 font-medium">Address</th>
              <th className="px-6 py-3 font-medium">Courier</th>
              <th className="px-6 py-3 font-medium">Tracking</th>
              <th className="px-6 py-3 font-medium">Status</th>
              <th className="px-6 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {prasadam_deliveries.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50">
                <td className="px-6 py-3 max-w-xs truncate" title={d.address}>{d.address}</td>
                <td className="px-6 py-3">{d.courier_name || "—"}</td>
                <td className="px-6 py-3">{d.tracking_number || "—"}</td>
                <td className="px-6 py-3">{badge(d.status, deliveryTone(d.status) as "green" | "amber" | "red" | "brown")}</td>
                <td className="px-6 py-3 text-right">
                  {d.status !== "delivered" && d.status !== "returned" && (
                    <button onClick={() => setUpdatingDelivery(d)} className="text-[var(--accent)] text-sm font-medium hover:underline">
                      Update
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {prasadam_deliveries.length === 0 && <div className="p-8 text-center text-gray-500">No prasadam deliveries queued</div>}
      </div>

      {/* Staff notes */}
      <div className="bg-white rounded-xl shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Staff Notes</h2>
        <form onSubmit={addNote} className="flex gap-3 mb-4">
          <input
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder='e.g. "Called about missing receipt, resent via WhatsApp"'
            className="flex-1 px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          <button
            type="submit"
            disabled={savingNote || !noteText.trim()}
            className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            Add Note
          </button>
        </form>
        <div className="space-y-3">
          {notes.map((n) => (
            <div key={n.id} className="border-b border-gray-100 pb-3 last:border-0">
              <p className="text-gray-900">{n.note}</p>
              <p className="text-xs text-gray-400 mt-1">
                {n.author_name || "Staff"} · {new Date(n.created_at).toLocaleString()}
              </p>
            </div>
          ))}
          {notes.length === 0 && <p className="text-gray-500 text-sm">No notes yet.</p>}
        </div>
      </div>

      {showEdit && (
        <EditProfileModal person={person} onClose={() => setShowEdit(false)} onSaved={load} />
      )}
      {showReceiptFor && (
        <IssueReceiptModal donation={showReceiptFor} onClose={() => setShowReceiptFor(null)} onSaved={load} />
      )}
      {showNewSubscription && (
        <NewSubscriptionModal personId={id} onClose={() => setShowNewSubscription(false)} onSaved={load} />
      )}
      {showNewDelivery && (
        <NewDeliveryModal personId={id} onClose={() => setShowNewDelivery(false)} onSaved={load} />
      )}
      {updatingDelivery && (
        <UpdateDeliveryModal delivery={updatingDelivery} onClose={() => setUpdatingDelivery(null)} onSaved={load} />
      )}
    </div>
  );
}

function ModalShell({ title, children, onClose, onSubmit }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form onSubmit={onSubmit} className="bg-white rounded-2xl p-8 w-full max-w-md space-y-4">
        <h2 className="text-xl font-bold">{title}</h2>
        {children}
        <div className="flex gap-3 pt-2">
          <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 border border-slate-300 rounded-lg hover:bg-gray-50">
            Cancel
          </button>
          <button type="submit" className="flex-1 px-4 py-2.5 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)]">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

const inputClass = "w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent)]";

function EditProfileModal({ person, onClose, onSaved }: { person: Person; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: person.name,
    phone: person.phone,
    email: person.email || "",
    address: person.address || "",
    pan: person.pan || "",
    date_of_birth: person.date_of_birth?.slice(0, 10) || "",
    anniversary_date: person.anniversary_date?.slice(0, 10) || "",
    prasadam_address: person.prasadam_address || "",
  });
  const [roles, setRoles] = useState<string[]>(person.roles);
  const roleOptions = ["donor", "volunteer", "folk", "congregation"];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await apiClient.put(`/api/people/${person.id}`, { ...form, roles });
    onSaved();
    onClose();
  };

  return (
    <ModalShell title="Edit Profile" onClose={onClose} onSubmit={submit}>
      <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name" className={inputClass} />
      <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone" className={inputClass} />
      <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" className={inputClass} />
      <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Address" className={inputClass} />
      <input value={form.pan} onChange={(e) => setForm({ ...form, pan: e.target.value })} placeholder="PAN" className={inputClass} />
      <textarea
        value={form.prasadam_address}
        onChange={(e) => setForm({ ...form, prasadam_address: e.target.value })}
        placeholder="Prasadam delivery address (leave blank to use home address)"
        className={inputClass}
        rows={2}
      />
      <div className="grid grid-cols-2 gap-3">
        <input type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} className={inputClass} />
        <input type="date" value={form.anniversary_date} onChange={(e) => setForm({ ...form, anniversary_date: e.target.value })} className={inputClass} />
      </div>
      <div className="flex gap-2 flex-wrap">
        {roleOptions.map((role) => (
          <button
            key={role}
            type="button"
            onClick={() => setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]))}
            className={`px-3 py-1.5 rounded-full text-sm ${roles.includes(role) ? "bg-[var(--accent)] text-white" : "bg-gray-100 text-gray-700"}`}
          >
            {role}
          </button>
        ))}
      </div>
    </ModalShell>
  );
}

function IssueReceiptModal({ donation, onClose, onSaved }: { donation: Donation; onClose: () => void; onSaved: () => void }) {
  const [receiptNumber, setReceiptNumber] = useState("");
  const [receiptUrl, setReceiptUrl] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await apiClient.patch(`/api/donations/${donation.id}/receipt`, {
      receipt_number: receiptNumber || undefined,
      receipt_url: receiptUrl || undefined,
    });
    onSaved();
    onClose();
  };

  return (
    <ModalShell title={`Issue Receipt — ${inr(donation.amount)}`} onClose={onClose} onSubmit={submit}>
      <input value={receiptNumber} onChange={(e) => setReceiptNumber(e.target.value)} placeholder="Receipt number" className={inputClass} />
      <input value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} placeholder="Receipt PDF URL (optional)" className={inputClass} />
      <p className="text-xs text-gray-500">This marks the receipt as issued and queues a WhatsApp notification to the donor.</p>
    </ModalShell>
  );
}

function NewSubscriptionModal({ personId, onClose, onSaved }: { personId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ amount: "", frequency: "monthly", purpose: "general", next_charge_date: "" });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await apiClient.post("/api/subscriptions", {
      person_id: personId,
      amount: Number(form.amount),
      frequency: form.frequency,
      purpose: form.purpose,
      next_charge_date: form.next_charge_date || undefined,
    });
    onSaved();
    onClose();
  };

  return (
    <ModalShell title="New Recurring Donation" onClose={onClose} onSubmit={submit}>
      <input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="Amount (₹) *" required className={inputClass} />
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
      <input type="date" value={form.next_charge_date} onChange={(e) => setForm({ ...form, next_charge_date: e.target.value })} className={inputClass} />
    </ModalShell>
  );
}

function NewDeliveryModal({ personId, onClose, onSaved }: { personId: string; onClose: () => void; onSaved: () => void }) {
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await apiClient.post("/api/prasadam", { person_id: personId, address: address || undefined, notes: notes || undefined });
    onSaved();
    onClose();
  };

  return (
    <ModalShell title="Queue Prasadam Delivery" onClose={onClose} onSubmit={submit}>
      <textarea
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Delivery address (leave blank to use the donor's saved address)"
        className={inputClass}
        rows={3}
      />
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className={inputClass} />
    </ModalShell>
  );
}

function UpdateDeliveryModal({ delivery, onClose, onSaved }: { delivery: PrasadamDelivery; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState(delivery.status === "pending" ? "packed" : "shipped");
  const [courier, setCourier] = useState(delivery.courier_name || "");
  const [tracking, setTracking] = useState(delivery.tracking_number || "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await apiClient.put(`/api/prasadam/${delivery.id}`, { status, courier_name: courier || undefined, tracking_number: tracking || undefined });
    onSaved();
    onClose();
  };

  return (
    <ModalShell title="Update Delivery" onClose={onClose} onSubmit={submit}>
      <Select value={status} onChange={(v) => setStatus(v)} className="w-full">
        <option value="packed">Packed</option>
        <option value="shipped">Shipped</option>
        <option value="delivered">Delivered</option>
        <option value="returned">Returned</option>
      </Select>
      <input value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="Courier name" className={inputClass} />
      <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Tracking number" className={inputClass} />
    </ModalShell>
  );
}
